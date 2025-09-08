/**
 * Realtime Publisher helper
 *
 * Использование:
 *   import { rt } from '../lib/realtime';
 *   await rt.postPublished(postId, channelId, { title, authorId });
 *   await rt.messageNew(conversationId, { messageId, senderId });
 *
 * Реализация:
 *   — тонкая обёртка над Redis PUBLISH с единым форматом событий.
 */

import Redis from 'ioredis';

const {
  REDIS_URL = 'redis://redis:6379',
  RT_PREFIX = 'rt', // на случай шардирования
} = process.env;

const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: 3 });

// Общая форма события
type EventPayload = Record<string, any>;
type RTEvent = {
  event: string;
  topic: string;
  ts: number;
  data: EventPayload;
};

function topicUser(userId: string) { return `${RT_PREFIX}:user:${userId}`; }
function topicConv(conversationId: string) { return `${RT_PREFIX}:conv:${conversationId}`; }
function topicChannel(channelId: string) { return `${RT_PREFIX}:channel:${channelId}`; }
function topicFeed() { return `${RT_PREFIX}:feed`; }

async function publish(topic: string, event: string, data: EventPayload) {
  const msg: RTEvent = { event, topic, ts: Date.now(), data };
  await redis.publish(topic, JSON.stringify(msg));
}

// ────────────────────────────────────────────────────────────────────────────
// Высокоуровневые события
// ────────────────────────────────────────────────────────────────────────────
export const rt = {
  // Сообщения / беседы
  async messageNew(conversationId: string, data: { messageId: string; senderId: string }) {
    await publish(topicConv(conversationId), 'message:new', data);
  },
  async messageRead(conversationId: string, data: { readerId: string; messageIds: string[] }) {
    await publish(topicConv(conversationId), 'message:read', data);
  },
  async conversationUpdated(conversationId: string, data: Record<string, any> = {}) {
    await publish(topicConv(conversationId), 'conversation:updated', data);
  },
  async conversationMembers(conversationId: string, data: { action: 'added'|'removed'|'role'; userId: string; role?: string }) {
    await publish(topicConv(conversationId), 'conversation:members', data);
  },

  // Каналы / посты
  async postPublished(postId: string, channelId: string, data: Record<string, any> = {}) {
    await publish(topicChannel(channelId), 'post:published', { postId, channelId, ...data });
    await publish(topicFeed(), 'post:published', { postId, channelId, ...data }); // в общую ленту
  },
  async postLiked(postId: string, channelId: string, data: { userId: string; liked: boolean }) {
    await publish(topicChannel(channelId), 'post:liked', { postId, channelId, ...data });
  },
  async channelUpdated(channelId: string, data: Record<string, any> = {}) {
    await publish(topicChannel(channelId), 'channel:updated', { channelId, ...data });
  },
  async channelFollow(channelId: string, data: { userId: string; following: boolean }) {
    await publish(topicChannel(channelId), 'channel:follow', { channelId, ...data });
  },

  // Персональные нотификации
  async notifyUser(userId: string, data: { kind: string; title?: string; body?: string; meta?: any }) {
    await publish(topicUser(userId), 'user:notification', data);
  },
};

export default rt;
