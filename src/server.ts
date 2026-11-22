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
  // @fastify/cors defaults methods to 'GET,HEAD,POST' only - PATCH/DELETE
  // were silently blocked at the browser preflight stage for every write
  // endpoint the admin dashboard uses (change-password, artisan
  // verification, category edit/delete) that isn't a plain POST. The
  // request never reached this server at all, so the frontend's error
  // handling (which does try to read the real backend error message) had
  // nothing to read - axios only ever saw a bare network error.
  methods: ['GET', 'HEAD', 'POST', 'PATCH', 'PUT', 'DELETE'],
});

app.register(jwt, {
  secret: process.env.JWT_SECRET ?? 'artizan-dev-secret-change-in-production',
});

app.register(helmet);

app.register(compress);

// 500/hour (the original default) was set before the real /service-requests
// polling existed - MatchingAreaScreen alone polls every 3.5s while
// waiting/enRoute/arrived (~1029 req/hour on its own), and ArtisanHomeScreen
// polls every 8s while focused (~450 req/hour) - both easily blow past 500
// well within an hour, especially from one shared IP (e.g. two simulators on
// the same WiFi hitting the deployed Render API). A 1-hour window also means
// a 1-hour lockout once hit - far too punishing for legitimate polling.
// Raised with headroom and switched to a 1-minute window so a brief spike
// recovers in a minute, not an hour.
app.register(rateLimit, {
  max: 300,
  timeWindow: '1 minute',
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
app.register(import('./routes/auth.user'),      { prefix: '/api/v1/auth/user' });
app.register(import('./routes/auth.artisan'),   { prefix: '/api/v1/auth/artisan' });
app.register(import('./routes/auth.admin'),     { prefix: '/api/v1/auth/admin' });
app.register(import('./routes/auth.community'), { prefix: '/api/v1/auth/community' });
app.register(import('./routes/categories'),     { prefix: '/api/v1/categories' });

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
      message: statusCode === 500 ? 'An unexpected error occurred.' : error.message,
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

