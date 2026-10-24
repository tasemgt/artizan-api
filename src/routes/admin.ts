// src/routes/admin.ts
// Admin dashboard v1 (2026-10-24) - analytics/overview is real. Auth login
// itself lives in auth.admin.ts/auth.community.ts, not here. User/Artisan/
// Category CRUD for the admin dashboard live in their own route files
// (users.ts, artisans.ts, categories.ts) rather than being duplicated here.

import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../server';
import { ok } from '../utils/helpers';
import { requireAdmin } from '../middleware/auth';

const adminRoutes: FastifyPluginAsync = async (app) => {

  app.get('/', async (_req, reply) => {
    return reply.send(ok(null));
  });

  // ── GET /analytics/overview — dashboard KPI tiles ───────────────────
  app.get('/analytics/overview', { preHandler: requireAdmin }, async (_req, reply) => {
    const [totalUsers, totalArtisans, pendingVerifications] = await Promise.all([
      prisma.user.count(),
      prisma.artisan.count(),
      prisma.artisan.count({ where: { verificationStatus: 'PENDING' } }),
    ]);
    return reply.send(ok({ totalUsers, totalArtisans, pendingVerifications }));
  });

};

export default adminRoutes;
