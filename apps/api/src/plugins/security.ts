// apps/api/src/plugins/security.ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import crypto from 'node:crypto';
import { env } from '@config/index';

/**
 * Проверка разрешённых источников для CORS.
 * Поддерживает точные строки и RegExp.
 */
function isOriginAllowed(origin: string, allowlist: (string | RegExp)[]): boolean {
  if (!origin) return true; // Разрешаем запросы без Origin (например, от серверов)
  for (const entry of allowlist) {
    if (typeof entry === 'string' && entry === origin) return true;
    if (entry instanceof RegExp && entry.test(origin)) return true;
  }
  return false;
}

/**
 * Генерация CSP со встроенным nonce.
 * Возвращает: { headerValue, nonce }
 */
function makeCspHeader(req: FastifyRequest): { headerValue: string; nonce: string } {
  const nonce = crypto.randomBytes(16).toString('base64');

  // Минимальная жёсткая CSP-политика. Для SSR/SPA можно расширять по мере надобности.
  // script-src включает 'nonce-<...>' для инлайновых безопасных скриптов.
  const directives: Record<string, string[]> = {
    "default-src": ["'self'"],
    "base-uri": ["'self'"],
    "frame-ancestors": ["'none'"],
    "img-src": ["'self'", "data:", "blob:"],
    "media-src": ["'self'", "blob:"],
    "font-src": ["'self'", "data:"],
    "style-src": ["'self'", "'unsafe-inline'"], // при необходимости убрать и использовать nonce/hashes
    "script-src": ["'self'", `'nonce-${nonce}'`],
    "connect-src": ["'self'", "https:", "wss:"],
    "object-src": ["'none'"],
    "form-action": ["'self'"],
    "upgrade-insecure-requests": [], // включено — браузер будет апгрейдить http→https
  };

  // Превращаем в строку заголовка
  const headerValue = Object.entries(directives)
    .map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k))
    .join('; ');

  return { headerValue, nonce };
}

/**
 * Ограничение размера JSON-тела на уровне парсера.
 * Fastify позволяет задать bodyLimit для конкретного парсера.
 */
function registerJsonBodyLimit(app: FastifyInstance, limit: string) {
  // Удаляем стандартный парсер JSON и регистрируем свой с лимитом
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: limitToBytes(limit) }, (_req, body, done) => {
    try {
      const json = body && body.length ? JSON.parse(body as string) : {};
      done(null, json);
    } catch (e: any) {
      const err = new Error('Invalid JSON');
      // @ts-ignore mark status for Fastify error handler
      (err as any).statusCode = 400;
      done(err as any);
    }
  });
}

/**
 * Перевод человеко-читаемого лимита в байты: "1mb", "512kb", "200b"
 */
function limitToBytes(limit: string): number {
  const m = /^(\d+)\s*(b|kb|mb|gb)?$/i.exec(limit.trim());
  if (!m) return 1024 * 1024; // 1MB по умолчанию
  const num = Number(m[1]);
  const unit = (m[2] || 'b').toLowerCase();
  const map: Record<string, number> = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Math.max(1, Math.min(num * (map[unit] || 1), 1024 ** 3)); // до 1GB максимум
}

/**
 * Основной регистрационный метод плагина.
 */
export async function registerSecurity(app: FastifyInstance) {
  // CORS: жёсткий allowlist из env.security.allowedOrigins
  await app.register(cors, {
    origin: (origin, cb) => {
      const allowed = isOriginAllowed(origin || '', env.security.allowedOrigins);
      cb(allowed ? null : new Error('CORS: origin not allowed'), allowed);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Idempotency-Key'
    ],
    exposedHeaders: ['ETag', 'Content-Length']
  });

  // Ограничение размера JSON
  registerJsonBodyLimit(app, env.security.maxJsonBody);

  // Глобальные security-заголовки
  app.addHook('onRequest', async (req, reply) => {
    // HSTS: только если включено и мы действительно работаем по HTTPS
    if (env.security.enableHsts && (req.protocol === 'https' || (req.headers['x-forwarded-proto'] || '').toString().includes('https'))) {
      reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains; preload'); // 180 дней
    }

    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-Permitted-Cross-Domain-Policies', 'none');
    // Современные COOP/CORP для изоляции
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-site');
    reply.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), payment=()');

    // CSP (если включено)
    if (env.security.enableCsp) {
      const { headerValue, nonce } = makeCspHeader(req);
      // Сохраняем nonce в локальном хранилище ответа — может понадобиться при SSR/шаблонах
      (reply as any).locals = (reply as any).locals || {};
      (reply as any).locals.cspNonce = nonce;

      reply.header('Content-Security-Policy', headerValue);
    }
  });

  // Единый request-id для трассировки (если не установлен прокси/балансировщиком)
  app.addHook('onRequest', async (req, reply) => {
    const ridHeader = (req.headers['x-request-id'] as string) || crypto.randomUUID();
    reply.header('X-Request-Id', ridHeader);
    // Прокидываем и в логгер Fastify
    (req as any).id = ridHeader;
  });

  // Защита от методов без тела с неправильным Content-Type и пр.
  app.addHook('onRequest', async (req, reply) => {
    // Простая санитарная проверка: запрещаем text/html в запросах
    const ctype = (req.headers['content-type'] || '').toString().toLowerCase();
    if (ctype.startsWith('text/html')) {
      reply.code(415).send({ error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'HTML content is not allowed' } });
      return;
    }
  });

  // Общий post-обработчик: добавим безопасные cache headers по-умолчанию
  app.addHook('onSend', async (_req: FastifyRequest, reply: FastifyReply, payload) => {
    if (!reply.getHeader('Cache-Control')) {
      // По-умолчанию не кэшируем мутирующие/динамические ответы
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });
}

/**
 * Утилита для получения CSP nonce внутри обработчиков/шаблонов.
 * Пример использования:
 *   const nonce = getCspNonce(reply)
 *   reply.type('text/html').send(`<script nonce="${nonce}">...</script>`)
 */
export function getCspNonce(reply: FastifyReply): string | undefined {
  return (reply as any).locals?.cspNonce;
}
