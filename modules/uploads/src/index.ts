/**
 * UploadService
 * Функции:
 *  - initiateMultipart: завести media_files, создать S3 multipart upload
 *  - signPartUrls: выдать пресайны для списка parts
 *  - completeMultipart: завершить upload, обновить media_files, поставить задачи в очереди
 *  - abortMultipart: отменить upload и откатить запись
 *
 * Хранилище:
 *  - S3: оригиналы кладём в ключи original/<mediaId>
 *  - DB: media_files(id uuid PK, owner_id, storage_key, mime, size_bytes,
 *                    antivirus_status enum('pending','clean','infected','error') DEFAULT 'pending',
 *                    quarantined boolean DEFAULT true,
 *                    created_at, updated_at, antivirus_scanned_at)
 *
 * Очереди (Redis Streams):
 *  - q:antivirus.media  (после завершения загрузки)
 *  - q:metadata.media   (можно сразу после antivirus, либо параллельно; здесь — сразу, но файл в карантине)
 *  - q:variants.image   (только для image/* и только после antivirus=clean → это обеспечит сам воркер: он проверит статус)
 *  - q:transcode.video  (только для video/*; воркер сам проверит статус antivirus)
 */

import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import Redis from 'ioredis';
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export type InitiateInput = {
  ownerId: string;
  filename: string;
  mime: string;
  sizeBytes: number;
};

export type InitiateOutput = {
  mediaId: string;
  key: string;
  uploadId: string;
  partSize: number; // клиенту рекомендованный размер части
};

export class UploadService {
  private partSize = 5 * 1024 * 1024; // 5MB минимум S3; можно увеличить до 32-64MB для крупных файлов
  constructor(
    private pool: Pool,
    private redis: Redis,
    private s3: S3Client,
    private cfg = {
      bucket: process.env.S3_BUCKET_PRIVATE || 'media',
      presignTtlSec: Number(process.env.UPLOAD_PRESIGN_TTL_SEC || 900), // 15m
    }
  ) {}

  // ────────────────────────────────────────────────────────────────────────────
  // INIT
  // ────────────────────────────────────────────────────────────────────────────
  async initiateMultipart(input: InitiateInput): Promise<InitiateOutput> {
    this.ensureUuid(input.ownerId);
    const mediaId = randomUUID();
    const key = `original/${mediaId}`;
    const mime = String(input.mime || 'application/octet-stream');
    const sizeBytes = Number(input.sizeBytes || 0);

    // 1) S3: create MPU
    const create = await this.s3.send(new CreateMultipartUploadCommand({
      Bucket: this.cfg.bucket,
      Key: key,
      ContentType: mime,
      ACL: undefined as any,
    }));
    const uploadId = String(create.UploadId);

    // 2) DB: insert media_files (карантин включен до AV)
    await this.pool.query(
      `INSERT INTO media_files (id, owner_id, storage_key, mime, size_bytes, antivirus_status, quarantined)
       VALUES ($1, $2, $3, $4, $5, 'pending', true)`,
      [mediaId, input.ownerId, key, mime, sizeBytes]
    );

    // 3) Вернуть клиенту параметры
    return { mediaId, key, uploadId, partSize: this.partSize };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // SIGN PART URLS
  // ────────────────────────────────────────────────────────────────────────────
  async signPartUrls(opts: { key: string; uploadId: string; partNumbers: number[]; contentType?: string }) {
    const { key, uploadId } = opts;
    const out: Array<{ partNumber: number; url: string }> = [];
    // выдаём индивидуальный presigned URL на каждую часть
    for (const n of opts.partNumbers) {
      if (!Number.isFinite(n) || n < 1) throw this.err(400, 'invalid_part_number');
      const cmd = new UploadPartCommand({
        Bucket: this.cfg.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: n,
        ContentLength: this.partSize, // S3 не требует точного размера при пресайне, но ок
      });
      const url = await getSignedUrl(this.s3, cmd, { expiresIn: this.cfg.presignTtlSec });
      out.push({ partNumber: n, url });
    }
    return out;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // COMPLETE
  // ────────────────────────────────────────────────────────────────────────────
  async completeMultipart(opts: {
    mediaId: string;
    key: string;
    uploadId: string;
    parts: Array<{ partNumber: number; etag: string }>;
  }) {
    this.ensureUuid(opts.mediaId);
    // Закрываем MPU
    const sorted = [...opts.parts].sort((a, b) => a.partNumber - b.partNumber);
    await this.s3.send(new CompleteMultipartUploadCommand({
      Bucket: this.cfg.bucket,
      Key: opts.key,
      UploadId: opts.uploadId,
      MultipartUpload: {
        Parts: sorted.map(p => ({ ETag: p.etag, PartNumber: p.partNumber })),
      },
    }));

    // Проверим что объект существует и узнаем фактический размер
    const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.cfg.bucket, Key: opts.key }));
    const bytes = Number(head.ContentLength || 0);

    // Обновим размер в media_files (если изначально был не точный)
    await this.pool.query(
      `UPDATE media_files SET size_bytes = $2, updated_at = now_utc() WHERE id = $1`,
      [opts.mediaId, bytes]
    );

    // Поставим задачи в очереди
    await this.enqueueAfterUpload(opts.mediaId, opts.key);

    return { ok: true as const, bytes };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // ABORT
  // ────────────────────────────────────────────────────────────────────────────
  async abortMultipart(opts: { mediaId: string; key: string; uploadId: string }) {
    this.ensureUuid(opts.mediaId);
    await this.s3.send(new AbortMultipartUploadCommand({
      Bucket: this.cfg.bucket,
      Key: opts.key,
      UploadId: opts.uploadId,
    })).catch(() => {});
    // Разрешено не удалять запись (можно повторить init), но чаще — удаляем незавершённый объект
    await this.pool.query(`DELETE FROM media_files WHERE id = $1`, [opts.mediaId]).catch(() => {});
    return { ok: true as const };
  }

  // ────────────────────────────────────────────────────────────────────────────
  // INTERNAL
  // ────────────────────────────────────────────────────────────────────────────
  private async enqueueAfterUpload(mediaId: string, storageKey: string) {
    // Узнаем MIME для роутинга задач
    const q = await this.pool.query(
      `SELECT mime FROM media_files WHERE id = $1 LIMIT 1`,
      [mediaId]
    );
    const mime = String(q.rows[0]?.mime || 'application/octet-stream');

    // antivirus — всегда
    await this.xadd('q:antivirus.media', { mediaId, storageKey, mime });

    // metadata — сразу (можно до/после AV; файл в карантине — это ок)
    await this.xadd('q:metadata.media', { mediaId, storageKey, mime });

    // Варианты: картинки → image-variants; видео → transcode.video
    if (/^image\//i.test(mime)) {
      await this.xadd('q:variants.image', { mediaId, storageKey, mime });
    } else if (/^video\//i.test(mime)) {
      await this.xadd('q:transcode.video', { mediaId, storageKey, mime });
    }
  }

  private async xadd(stream: string, payload: Record<string, any>) {
    await this.redis.xadd(stream, '*', 'data', JSON.stringify(payload));
  }

  private ensureUuid(id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw this.err(400, 'invalid_uuid');
  }
  private err(status: number, code: string): any {
    const e: any = new Error(code); e.statusCode = status; return e;
  }
}
