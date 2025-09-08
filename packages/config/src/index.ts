// packages/config/src/index.ts
import { z } from 'zod';

type WorkerCfg = {
  concurrency?: number;
  batch?: number;
  blockMs?: number;
  maxAttempts?: number;
  lockTtlSec?: number;
  sharpConcurrency?: number;
  maxInputMB?: number;
};

const num = (def: number) =>
  z
    .preprocess(v => (v === undefined ? undefined : Number(v)), z.number())
    .default(def);

const bool = (def: boolean) =>
  z
    .preprocess(
      v =>
        v === undefined
          ? undefined
          : v === '1' || v === 'true'
          ? true
          : v === '0' || v === 'false'
          ? false
          : v,
      z.boolean()
    )
    .default(def);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  HTTP_HOST: z.string().default('0.0.0.0'),
  HTTP_PORT: num(3000),
  CORS_ORIGIN: z.string().default('*'),

  DATABASE_URL: z.string().url().default('postgres://postgres:postgres@localhost:5432/app'),
  PG_MAX: num(20),
  PG_IDLE_TIMEOUT_MS: num(30000),

  REDIS_URL: z.string().url().default('redis://localhost:6379/0'),

  MAX_JSON_BODY: z.string().default('1mb'),
  SEC_ENABLE_HSTS: bool(true),
  SEC_ENABLE_CSP: bool(false),

  S3_ENDPOINT: z.string().url().default('https://storage.yandexcloud.net'),
  S3_REGION: z.string().default('ru-central1'),
  S3_BUCKET: z.string().default('app-bucket'),
  S3_ACCESS_KEY: z.string().min(1, 'S3_ACCESS_KEY is required'),
  S3_SECRET_KEY: z.string().min(1, 'S3_SECRET_KEY is required'),
  S3_FORCE_PATH_STYLE: bool(false),
  S3_PUBLIC_BASE_URL: z.string().url().optional(),

  AUTH_JWT_ISSUER: z.string().url().default('https://auth.local/'),
  AUTH_JWT_AUDIENCE: z.string().default('app-api'),
  AUTH_SIGN_ALG: z.string().optional(),
  AUTH_JWT_PRIVATE_KEY: z.string().optional(),
  AUTH_JWT_PUBLIC_KEY: z.string().optional(),
  AUTH_JWT_SECRET: z.string().optional(),
  AUTH_LEEWAY_SEC: num(60),

  RL_GLOBAL_PER_MIN: num(120),
  RL_AUTH_PER_MIN: num(30),

  FFMPEG_PATH: z.string().default('ffmpeg'),
  FFPROBE_PATH: z.string().default('ffprobe'),
  FFMPEG_CRF_DEFAULT: num(23),
  FFMPEG_PRESET: z.string().default('medium'),

  CLAMAV_HOST: z.string().default('localhost'),
  CLAMAV_PORT: num(3310),
  CLAMAV_TIMEOUT_MS: num(120000),

  GC_CONCURRENCY: num(2),
  GC_BATCH: num(16),
  GC_BLOCK_MS: num(2000),
  GC_MAX_ATTEMPTS: num(5),
  GC_LOCK_TTL: num(120),

  META_CONCURRENCY: num(2),
  META_BATCH: num(16),
  META_BLOCK_MS: num(2000),
  META_MAX_ATTEMPTS: num(5),

  IMG_CONCURRENCY: num(2),
  IMG_BATCH: num(8),
  IMG_BLOCK_MS: num(2000),
  IMG_MAX_ATTEMPTS: num(5),
  IMG_SHARP_CONCURRENCY: num(2),
  IMG_MAX_INPUT_MB: num(80),

  VID_CONCURRENCY: num(1),
  VID_BATCH: num(4),
  VID_BLOCK_MS: num(2000),
  VID_LOCK_TTL: num(300),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment variables:');
  for (const issue of parsed.error.issues) {
    console.error(`  ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}
const e = parsed.data;

export const env = {
  nodeEnv: e.NODE_ENV,

  // HTTP/API
  http: {
    host: e.HTTP_HOST,
    port: e.HTTP_PORT,
    cors: {
      origin: e.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean),
    },
  },

  // PostgreSQL
  db: {
    url: e.DATABASE_URL,
    max: e.PG_MAX,
    idleTimeoutMs: e.PG_IDLE_TIMEOUT_MS,  
  },

  // Redis
  redis: {
    url: e.REDIS_URL,
  },

  // Security (for API plugins)
  security: {
    allowedOrigins: e.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean),
    maxJsonBody: e.MAX_JSON_BODY,
    enableHsts: e.SEC_ENABLE_HSTS,
    enableCsp: e.SEC_ENABLE_CSP,
  },

  // S3 (Yandex Object Storage совместимый)
  s3: {
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    bucket: e.S3_BUCKET,
    accessKeyId: e.S3_ACCESS_KEY,
    secretAccessKey: e.S3_SECRET_KEY,
    forcePathStyle: e.S3_FORCE_PATH_STYLE,
    publicBaseUrl: e.S3_PUBLIC_BASE_URL ?? null,
  },

  // JWT / Auth
  auth: {
    issuer: e.AUTH_JWT_ISSUER,
    audience: e.AUTH_JWT_AUDIENCE,
    signAlg: e.AUTH_SIGN_ALG?.toUpperCase(),
    privateKey: e.AUTH_JWT_PRIVATE_KEY,
    publicKey: e.AUTH_JWT_PUBLIC_KEY,
    secret: e.AUTH_JWT_SECRET,
    clockLeewaySec: e.AUTH_LEEWAY_SEC,
  },

  // Rate limit (requests per minute)
  ratelimit: {
    globalPerMin: e.RL_GLOBAL_PER_MIN,
    authPerMin: e.RL_AUTH_PER_MIN,
  },

  // FFMPEG
  ffmpeg: {
    ffmpegPath: e.FFMPEG_PATH,
    ffprobePath: e.FFPROBE_PATH,
    crfDefault: e.FFMPEG_CRF_DEFAULT,
    preset: e.FFMPEG_PRESET,
  },

  // ClamAV (clamd)
  clamav: {
    host: e.CLAMAV_HOST,
    port: e.CLAMAV_PORT,
    timeoutMs: e.CLAMAV_TIMEOUT_MS,
  },

  // Воркеры
  workers: {
    gc: {
      concurrency: e.GC_CONCURRENCY,
      batch: e.GC_BATCH,
      blockMs: e.GC_BLOCK_MS,
      maxAttempts: e.GC_MAX_ATTEMPTS,
      lockTtlSec: e.GC_LOCK_TTL,
    } as WorkerCfg,
    metadata: {
      concurrency: e.META_CONCURRENCY,
      batch: e.META_BATCH,
      blockMs: e.META_BLOCK_MS,
      maxAttempts: e.META_MAX_ATTEMPTS,
    } as WorkerCfg,
    image: {
      concurrency: e.IMG_CONCURRENCY,
      batch: e.IMG_BATCH,
      blockMs: e.IMG_BLOCK_MS,
      maxAttempts: e.IMG_MAX_ATTEMPTS,
      sharpConcurrency: e.IMG_SHARP_CONCURRENCY,
      maxInputMB: e.IMG_MAX_INPUT_MB,
    } as WorkerCfg,
    video: {
      concurrency: e.VID_CONCURRENCY,
      batch: e.VID_BATCH,
      blockMs: e.VID_BLOCK_MS,
      lockTtlSec: e.VID_LOCK_TTL,
    } as WorkerCfg,
  },
};

export default env;
