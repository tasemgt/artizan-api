// src/jobs/queue.ts
// BullMQ queue definitions. All job processors are wired here.
// Workers are started separately — import this file to add jobs.

import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';

// ── Redis connection ──────────────────────────────────────────────────
const redisConnection = new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null, // Required by BullMQ
});

// ── Queue names ───────────────────────────────────────────────────────
export const QUEUES = {
  FEE_DEDUCT:          'fee.deduct',
  XP_AWARD:            'xp.award',
  NOTIFICATION:        'notification.dispatch',
  ACCESS_CODE_EXPIRE:  'accesscode.expire',
  LOCATION_SYNC:       'artisan.location-sync',
  REQUEST_TIMEOUT:     'request.timeout',
  CHAT_PERSIST:        'chat.persist',
  FIREBASE_CLEANUP:    'cleanup.firebase',
  STRIKES_RESET:       'strikes.reset',
} as const;

// ── Queues ────────────────────────────────────────────────────────────
export const feeDeductQueue       = new Queue(QUEUES.FEE_DEDUCT,       { connection: redisConnection });
export const xpAwardQueue         = new Queue(QUEUES.XP_AWARD,         { connection: redisConnection });
export const notificationQueue    = new Queue(QUEUES.NOTIFICATION,     { connection: redisConnection });
export const accessCodeExpireQueue= new Queue(QUEUES.ACCESS_CODE_EXPIRE,{ connection: redisConnection });
export const requestTimeoutQueue  = new Queue(QUEUES.REQUEST_TIMEOUT,  { connection: redisConnection });
export const chatPersistQueue     = new Queue(QUEUES.CHAT_PERSIST,     { connection: redisConnection });
export const firebaseCleanupQueue = new Queue(QUEUES.FIREBASE_CLEANUP, { connection: redisConnection });

// ── Job helpers ───────────────────────────────────────────────────────

// Called when a service request reaches ARTISAN_ARRIVED
export const scheduleFeeDuduction = (requestId: string) =>
  feeDeductQueue.add('deduct', { requestId }, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });

// Called when request reaches COMPLETED
export const scheduleXpAward = (requestId: string, userId: string, artisanId: string) =>
  xpAwardQueue.add('award', { requestId, userId, artisanId });

// Called when a rating is submitted (5-star bonus)
export const scheduleHighRatingXp = (artisanId: string, serviceRequestId: string) =>
  xpAwardQueue.add('high-rating', { artisanId, serviceRequestId });

// Called when COMMUNITY request is accepted (4hr delay)
export const scheduleAccessCodeExpiry = (requestId: string) =>
  accessCodeExpireQueue.add(
    'expire',
    { requestId },
    { delay: 4 * 60 * 60 * 1000, attempts: 1 },
  );

// Called when request is created (90s delay)
export const scheduleRequestTimeout = (requestId: string) =>
  requestTimeoutQueue.add(
    'timeout',
    { requestId },
    { delay: 90_000, attempts: 1 },
  );

// Called when request is COMPLETED (1hr delay)
export const scheduleFirebaseCleanup = (firebasePath: string) =>
  firebaseCleanupQueue.add(
    'cleanup',
    { firebasePath },
    { delay: 60 * 60 * 1000, attempts: 2 },
  );

// Push notification
export const dispatchNotification = (payload: {
  recipientId:   string;
  recipientType: 'USER' | 'ARTISAN';
  fcmToken:      string | null;
  title:         string;
  body:          string;
  data?:         Record<string, string>;
}) => notificationQueue.add('push', payload, { attempts: 2, backoff: { type: 'fixed', delay: 3000 } });

export { redisConnection };
