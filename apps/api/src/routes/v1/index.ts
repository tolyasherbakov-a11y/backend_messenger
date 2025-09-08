/**
 * V1 API aggregator
 * Собирает и регистрирует все роуты версии v1 под единым префиксом.
 * Подключает: uploads.
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';

// Роуты v1
import uploadsRoutes from './uploads.route';
import mediaRoutes from './media.route';
import authRoutes from './auth.route';
import conversationsRoutes from './conversations.route';
import messagesRoutes from './messages.route';
import channelsRoutes from './channels.route';
import postsRoutes from './posts.route';
import searchRoutes from './search.route';

export interface V1RoutesOpts {
  // можно добавить флаги/опции для отдельных модулей здесь при необходимости
}

export const v1Routes: FastifyPluginAsync<V1RoutesOpts> = async (app: FastifyInstance) => {
  // uploads
  await app.register(uploadsRoutes);
  await app.register(mediaRoutes);
  await app.register(authRoutes);
  await app.register(conversationsRoutes);
  await app.register(messagesRoutes);
  await app.register(channelsRoutes);
  await app.register(postsRoutes);
  await app.register(searchRoutes);

  // Здесь же можно регистрировать следующие модули:
  // await app.register(authRoutes);
  // await app.register(conversationsRoutes);
  // await app.register(messagesRoutes);
  // await app.register(channelsRoutes);
  // await app.register(postsRoutes);
};

export default v1Routes;
