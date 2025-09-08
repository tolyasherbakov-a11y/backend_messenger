// packages/config/src/index.ts
type WorkerCfg = {
  concurrency?: number;
  batch?: number;
  blockMs?: number;
  maxAttempts?: number;
  lockTtlSec?: number;
  sharpConcurrency?: number;
  maxInputMB?: number;
};

const num = (v: any, d: number) => (v !== undefined && v !== null && !Number.isNaN(Number(v)) ? Number(v) : d);
const bool = (v: any, d: boolean) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : d);

export const env = {
  nodeEnv: process.env.NODE_ENV || 'development',

  // HTTP/API
  http: {
    host: process.env.HTTP_HOST || '0.0.0.0',
    port: num(process.env.HTTP_PORT, 3000),
    cors: {
      origin: (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean),
    }
  },

  // PostgreSQL
  db: {
    url: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/app',
    max: num(process.env.PG_MAX, 20),
    idleTimeoutMs: num(process.env.PG_IDLE_TIMEOUT_MS, 30000)
  },

  // Redis
  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379/0',
  },

  // S3 (Yandex Object Storage совместимый)
  s3: {
    endpoint: process.env.S3_ENDPOINT || 'https://storage.yandexcloud.net',
    region: process.env.S3_REGION || 'ru-central1',
    bucket: process.env.S3_BUCKET || 'app-bucket',
    accessKeyId: process.env.S3_ACCESS_KEY || '',
    secretAccessKey: process.env.S3_SECRET_KEY || '',
    forcePathStyle: bool(process.env.S3_FORCE_PATH_STYLE, false), // для MinIO=true
    publicBaseUrl: process.env.S3_PUBLIC_BASE_URL || null
  },

  // JWT / Auth
  auth: {
    issuer: process.env.AUTH_JWT_ISSUER || 'https://auth.local/',
    audience: process.env.AUTH_JWT_AUDIENCE || 'app-api',
    signAlg: (process.env.AUTH_SIGN_ALG || '').toUpperCase() || undefined,
    privateKey: process.env.AUTH_JWT_PRIVATE_KEY || undefined, // PKCS8
    publicKey: process.env.AUTH_JWT_PUBLIC_KEY || undefined,   // SPKI/PEM
    secret: process.env.AUTH_JWT_SECRET || undefined,          // HS256
    clockLeewaySec: num(process.env.AUTH_LEEWAY_SEC, 60)
  },

  // FFMPEG
  ffmpeg: {
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',
    crfDefault: num(process.env.FFMPEG_CRF_DEFAULT, 23),
    preset: process.env.FFMPEG_PRESET || 'medium'
  },

  // ClamAV (clamd)
  clamav: {
    host: process.env.CLAMAV_HOST || 'localhost',
    port: num(process.env.CLAMAV_PORT, 3310),
    timeoutMs: num(process.env.CLAMAV_TIMEOUT_MS, 120000)
  },

  // Воркеры
  workers: {
    gc: {
      concurrency: num(process.env.GC_CONCURRENCY, 2),
      batch: num(process.env.GC_BATCH, 16),
      blockMs: num(process.env.GC_BLOCK_MS, 2000),
      maxAttempts: num(process.env.GC_MAX_ATTEMPTS, 5),
      lockTtlSec: num(process.env.GC_LOCK_TTL, 120)
    } as WorkerCfg,
    metadata: {
      concurrency: num(process.env.META_CONCURRENCY, 2),
      batch: num(process.env.META_BATCH, 16),
      blockMs: num(process.env.META_BLOCK_MS, 2000),
      maxAttempts: num(process.env.META_MAX_ATTEMPTS, 5)
    } as WorkerCfg,
    image: {
      concurrency: num(process.env.IMG_CONCURRENCY, 2),
      batch: num(process.env.IMG_BATCH, 8),
      blockMs: num(process.env.IMG_BLOCK_MS, 2000),
      maxAttempts: num(process.env.IMG_MAX_ATTEMPTS, 5),
      sharpConcurrency: num(process.env.IMG_SHARP_CONCURRENCY, 2),
      maxInputMB: num(process.env.IMG_MAX_INPUT_MB, 80)
    } as WorkerCfg,
    video: {
      concurrency: num(process.env.VID_CONCURRENCY, 1),
      batch: num(process.env.VID_BATCH, 4),
      blockMs: num(process.env.VID_BLOCK_MS, 2000),
      lockTtlSec: num(process.env.VID_LOCK_TTL, 300)
    } as WorkerCfg
  }
};

export default env;
