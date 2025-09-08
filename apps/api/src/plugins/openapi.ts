// apps/api/src/plugins/openapi.ts
import type { FastifyInstance, FastifyRegisterOptions, FastifyRouteSchemaDef } from 'fastify';
import swagger, { FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { env } from '@config/index';
import type { ZodTypeAny } from 'zod';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * Проверка: является ли объект Zod-схемой
 */
function isZodSchema(s: unknown): s is ZodTypeAny {
  return !!s && typeof s === 'object' && typeof (s as any)._def === 'object' && typeof (s as any).parse === 'function';
}

/**
 * Конвертирует Zod-схемы Fastify в JSON Schema (body, params, querystring, headers, response).
 * Если уже JSON Schema — возвращает как есть.
 */
function normalizeRouteSchema(schema: FastifyRouteSchemaDef | undefined): FastifyRouteSchemaDef | undefined {
  if (!schema) return schema;

  const convert = (v: any, title?: string) => {
    if (!v) return v;
    if (isZodSchema(v)) {
      // Присваиваем title, чтобы компонент красиво назывался в OpenAPI
      const json = zodToJsonSchema(v, { name: title || undefined, $refStrategy: 'none' });
      return json.definitions ? { ...json, $defs: json.definitions } : json;
    }
    if (typeof v === 'object') return v; // уже JSON Schema
    return v;
  };

  const out: any = { ...schema };

  // Обычные секции
  if ((schema as any).body) out.body = convert((schema as any).body, 'RequestBody');
  if ((schema as any).querystring) out.querystring = convert((schema as any).querystring, 'QueryString');
  if ((schema as any).params) out.params = convert((schema as any).params, 'PathParams');
  if ((schema as any).headers) out.headers = convert((schema as any).headers, 'Headers');

  // Ответы по кодам
  if ((schema as any).response) {
    const resp = (schema as any).response;
    const converted: Record<string, any> = {};
    for (const [code, sch] of Object.entries(resp)) {
      converted[code] = convert(sch as any, `Response_${code}`);
    }
    out.response = converted;
  }

  // Теги и summary/description — без изменений
  return out;
}

/**
 * Регистрирует хук для автоконвертации Zod → JSON Schema на всех маршрутах.
 */
function registerZodAutoTransform(app: FastifyInstance) {
  app.addHook('onRoute', (route) => {
    if (route.schema) {
      route.schema = normalizeRouteSchema(route.schema);
    }
  });
}

/**
 * Опции OpenAPI/Swagger
 */
function buildSwaggerOptions(): FastifyRegisterOptions<FastifyDynamicSwaggerOptions> {
  const openapi: any = {
    openapi: '3.1.0',
    info: {
      title: 'Dooble API',
      description: 'CRUD API for apps, site and external integrations',
      version: '1.0.0'
    },
    servers: [
      { url: 'https://api.yourdomain.tld', description: 'Production' },
      { url: 'http://localhost:' + env.port, description: 'Local Dev' }
    ],
    tags: [
      { name: 'auth', description: 'Authentication & sessions' },
      { name: 'users', description: 'Users CRUD' },
      { name: 'uploads', description: 'Dedup & presigned uploads' },
      { name: 'media', description: 'Media metadata & variants' },
      { name: 'channels', description: 'Channels & posts' },
      { name: 'groups', description: 'Groups' },
      { name: 'messages', description: 'Messages & threads' },
      { name: 'moderation', description: 'Reports & actions' },
      { name: 'billing', description: 'Donations & subscriptions' }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    },
    security: [{ bearerAuth: [] }]
  };

  return { openapi };
}

/**
 * Регистрация Swagger + Swagger UI и авто-конвертера Zod.
 */
export async function registerOpenAPI(app: FastifyInstance) {
  // Прежде чем Fastify начнёт регистрировать маршруты, подключаем автоконвертер
  registerZodAutoTransform(app);

  // Swagger JSON (динамический, собирается с учётом onRoute-хука)
  await app.register(swagger, buildSwaggerOptions());

  // UI по адресу /docs (с кэшем ассетов)
  await app.register(swaggerUI, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      displayOperationId: false,
      tryItOutEnabled: true
    },
    staticCSP: true
  });

  // Удобный алиас /openapi.json
  app.get('/openapi.json', async (_req, reply) => {
    // @ts-ignore getOpenapiDocument — метод плагина swagger
    const spec = await app.swagger();
    reply.send(spec);
  });

  app.log.info({ msg: 'OpenAPI registered', docs: '/docs', spec: '/openapi.json' });
}

/* ────────────────────────────────────────────────────────────────────────────
 * Пример как описывать схемы прямо здесь (если нужно общие типы).
 * Лучше держать отдельные файлы в apps/api/src/schemas/*
 * Ниже просто пример валидного Zod-схемы → она автоматически конвертируется.
 * ──────────────────────────────────────────────────────────────────────────── */
export const ExampleUser = z.object({
  id: z.string().describe('User ID'),
  email: z.string().email(),
  nickname: z.string().min(2).max(32)
});
