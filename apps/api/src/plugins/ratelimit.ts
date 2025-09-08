// server/apps/api/src/plugins/ratelimit.ts
import { FastifyInstance } from 'fastify';
import rateLimit, { RateLimitPluginOptions } from '@fastify/rate-limit';

type PerRouteRate = Pick<RateLimitPluginOptions, 'max' | 'timeWindow' | 'allowList' | 'ban' | 'hook'>;

declare module 'fastify' {
  interface FastifyContextConfig {
    rateLimit?: PerRouteRate;
  }
}

export default async function rateLimitPlugin(app: FastifyInstance) {
  // Плагин может быть уже зарегистрирован глобально — @fastify/rate-limit это поддерживает
  // Здесь не задаём глобальные опции, а лишь включаем пер-маршрутную конфигурацию.
  await app.register(rateLimit);

  app.addHook('onRoute', (route) => {
    const rl = (route as any).config?.rateLimit as PerRouteRate | undefined;
    if (!rl) return;
    // Включаем пер-маршрутный лимит, Fastify сам подхватит из config.rateLimit
    (route as any).config = (route as any).config || {};
    (route as any).config.rateLimit = rl;
  });
}


/**
 * Ключ для лимитов:
 * - если пользователь аутентифицирован — по userId
 * - иначе — по IP (учитывает X-Forwarded-For за прокси)
 */
function keyGenerator(req: FastifyRequest): string {
  // @ts-expect-error user будет установлен auth-guard'ом
  const userId = req.user?.id as string | undefined;
  // Fastify сам проксирует req.ip с учётом trustProxy
  return userId ? `u:${userId}` : `ip:${req.ip}`;
}

/**
 * Правила: у разных классов маршрутов разные «ведра».
 * Здесь определяем «auth-ведро» для /api/v1/auth/* и более мягкое «global» для остальных.
 */
function classifyRoute(path?: string): 'auth' | 'global' {
  if (!path) return 'global';
  // сужаем именно на блок аутентификации
  if (path.startsWith('/api/v1/auth/')) return 'auth';
  return 'global';
}

/**
 * Разрешённые без лимита маршруты: health, метрика, openapi, статика UI документации.
 */
function isAllowListed(req: FastifyRequest): boolean {
  const p = req.routerPath || req.url || '';
  if (p === '/health' || p === '/metrics') return true;
  if (p === '/openapi.json' || p.startsWith('/docs')) return true;
  return false;
}

/**
 * Регистрирует rate-limit с Redis-бэкендом и тонкой настройкой.
 */
export async function registerRateLimit(app: FastifyInstance) {
  // Базовая регистрация: плагин сам создаст стор в Redis по URL
  await app.register(rateLimit, {
    redis: env.redis.url,              // распределённые лимиты
    keyGenerator,                      // ключи на пользователя/или IP
    hook: 'onSend',                    // минимальное влияние на latency
    /* Настройки по умолчанию (будут переопределяться динамически в onRoute) */
    max: env.ratelimit.globalPerMin,   // запросов в минуту
    timeWindow: '1 minute',
    addHeadersOnSuccess: true,
    addHeaders: {
      'x-ratelimit-limit': true,
      'x-ratelimit-remaining': true,
      'x-ratelimit-reset': true
    },
    ban: 0, // не баним автоматически, просто режем
    errorResponseBuilder: (req, ctx) => ({
      error: {
        code: 'RATE_LIMIT_EXCEEDED',
        message: 'Too many requests, please slow down.',
        details: {
          limit: ctx.max,
          ttlMs: ctx.ttl,
          key: keyGenerator(req)
        }
      }
    }),
    // Белый список глобально (health/docs/openapi)
    allowList: (req: FastifyRequest) => isAllowListed(req)
  });

  /**
   * Гибкая настройка лимитов «на роут» во время регистрации.
   * Fastify вызовет этот хук для каждого маршрута.
   */
  app.addHook('onRoute', (routeOptions) => {
    const path = routeOptions.url || routeOptions.path;
    const bucket = classifyRoute(path);

    // Пропускаем allow-listed пути
    if (path === '/health' || path === '/metrics' || path === '/openapi.json' || String(path).startsWith('/docs')) {
      routeOptions.config = { ...(routeOptions.config || {}), rateLimit: { allowList: true } };
      return;
    }

    // Меняем лимиты для аутентификационных маршрутов
    if (bucket === 'auth') {
      // Более строгие лимиты на попытки логина/регистрации
      routeOptions.config = {
        ...(routeOptions.config || {}),
        rateLimit: {
          max: env.ratelimit.authPerMin,
          timeWindow: '1 minute',
          keyGenerator
        }
      };
      return;
    }

    // Для остальных — глобальные (могут быть переопределены точечно)
    routeOptions.config = {
      ...(routeOptions.config || {}),
      rateLimit: {
        max: env.ratelimit.globalPerMin,
        timeWindow: '1 minute',
        keyGenerator
      }
    };
  });

  // Лог-подсказка конфигурации (без секретов)
  app.log.info({
    msg: 'rate-limit configured',
    globalPerMin: env.ratelimit.globalPerMin,
    authPerMin: env.ratelimit.authPerMin,
    backend: 'redis',
    window: '1 minute'
  });
}
