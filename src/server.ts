import 'dotenv/config';
import Fastify, { FastifyError } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import compress from '@fastify/compress';
import multipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { ensureProfileImageBucket, ensureVerificationDocumentsBucket } from './services/supabaseStorage';

// ── Logger ────────────────────────────────────────────────────────────
const logger = pino({
  transport: process.env.NODE_ENV !== 'production'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
});

// ── Prisma ────────────────────────────────────────────────────────────
export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error'] : ['error'],
});

// ── Fastify ───────────────────────────────────────────────────────────
const app = Fastify({ loggerInstance: logger });

// ── Plugins ───────────────────────────────────────────────────────────
app.register(cors, {
  origin: process.env.ALLOWED_ORIGINS?.split(',') ?? ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
});

app.register(jwt, {
  secret: process.env.JWT_SECRET ?? 'artizan-dev-secret-change-in-production',
});

app.register(helmet);

app.register(compress);

app.register(rateLimit, {
  max: 500,
  timeWindow: '1 hour',
});

app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB — matches the Supabase bucket's own limit
});

// ── Health check ──────────────────────────────────────────────────────
app.get('/health', async () => ({
  status:    'ok',
  version:   '1.0.0',
  timestamp: new Date().toISOString(),
}));

// ── Routes ────────────────────────────────────────────────────────────
// Phase 1
app.register(import('./routes/auth.user'),    { prefix: '/api/v1/auth/user' });
app.register(import('./routes/auth.artisan'), { prefix: '/api/v1/auth/artisan' });
app.register(import('./routes/categories'),   { prefix: '/api/v1/categories' });

// Phase 2+ — stubs, see each file's header comment
app.register(import('./routes/users'),           { prefix: '/api/v1/users' });
app.register(import('./routes/artisans'),         { prefix: '/api/v1/artisans' });
app.register(import('./routes/communities'),      { prefix: '/api/v1/communities' });
app.register(import('./routes/serviceRequests'),  { prefix: '/api/v1/service-requests' });
app.register(import('./routes/wallets'),          { prefix: '/api/v1/wallets' });
app.register(import('./routes/notifications'),    { prefix: '/api/v1/notifications' });
app.register(import('./routes/admin'),            { prefix: '/api/v1/admin' });

// ── Error handler ─────────────────────────────────────────────────────
app.setErrorHandler((error: FastifyError, request, reply) => {
  logger.error(error);
  const statusCode = error.statusCode ?? 500;
  reply.status(statusCode).send({
    success: false,
    error: {
      code:    error.code ?? 'INTERNAL_ERROR',
      // TEMPORARY (2026-09-19): unmasking real 500 messages to diagnose a
      // live registration failure without dashboard log access. Revert to
      // the generic message before this is exposed to real users.
      message: error.message,
    },
  });
});

// ── Start ─────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000', 10);

async function start() {
  try {
    await prisma.$connect();
    logger.info('Database connected');
    await ensureProfileImageBucket();
    await ensureVerificationDocumentsBucket();
    await app.listen({ port: PORT, host: '0.0.0.0' });
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
}

start();

