// packages/s3/src/index.ts
import {
  S3Client, HeadObjectCommand, PutObjectCommand, GetObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@aws-sdk/node-http-handler';
import { env } from '@config/index';

export const s3 = new S3Client({
  region: env.s3.region,
  endpoint: env.s3.endpoint,
  forcePathStyle: env.s3.forcePathStyle,
  credentials: {
    accessKeyId: env.s3.accessKeyId,
    secretAccessKey: env.s3.secretAccessKey
  },
  requestHandler: new NodeHttpHandler({ connectionTimeout: 5000, socketTimeout: 120000 })
});

export function buildStorageKey(input: { sha256: string; filename: string }): string {
  const safeName = input.filename.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 140);
  const prefix = input.sha256.slice(0, 2);
  return `media/${prefix}/${input.sha256}/${safeName}`;
}

export async function getPresignedUploadUrl(params: { sha256: string; filename: string; mime: string; ttlSeconds?: number }) {
  const Key = buildStorageKey(params);
  const put = new PutObjectCommand({
    Bucket: env.s3.bucket,
    Key,
    ContentType: params.mime,
    ACL: 'private'
  });
  const url = await getSignedUrl(s3, put, { expiresIn: params.ttlSeconds ?? 900 });
  return { key: Key, url };
}

export async function presignGetObject(key: string, opts?: { ttlSeconds?: number }) {
  const get = new GetObjectCommand({ Bucket: env.s3.bucket, Key: key });
  return getSignedUrl(s3, get, { expiresIn: opts?.ttlSeconds ?? 600 });
}

export async function headObject(key: string): Promise<{ exists: boolean; size?: number; contentType?: string | null }> {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: env.s3.bucket, Key: key }));
    return { exists: true, size: res.ContentLength, contentType: res.ContentType || null };
  } catch (e: any) {
    const msg = String(e?.name || e?.Code || e?.message || '');
    if (msg.includes('NotFound') || msg.includes('NoSuchKey')) {
      return { exists: false };
    }
    throw e;
  }
}
