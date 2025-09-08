// apps/api/src/plugins/openapi.ts
import type { FastifyInstance, FastifyRegisterOptions } from 'fastify';
import swagger, { FastifyDynamicSwaggerOptions } from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import { env } from '@config/index';
import { z } from 'zod';

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
      { url: 'http://localhost:' + env.http.port, description: 'Local Dev' }
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }
      }
    },
    security: [{ bearerAuth: [] }]
  };
  return { openapi };
}

export async function registerOpenAPI(app: FastifyInstance) {
  await app.register(swagger, buildSwaggerOptions());
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

  app.get('/openapi.json', async (_req, reply) => {
    // @ts-ignore .swagger is provided by @fastify/swagger
    const spec = await app.swagger();
    reply.send(spec);
  });

  app.log.info({ msg: 'OpenAPI registered', docs: '/docs', spec: '/openapi.json' });
}

export const ExampleUser = z.object({
  id: z.string().describe('User ID'),
  email: z.string().email(),
  nickname: z.string().min(2).max(32)
});
