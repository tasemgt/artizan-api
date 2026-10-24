// src/routes/admin.ts
// Admin dashboard v1 (2026-10-24) - analytics/overview is real. Auth login
// itself lives in auth.admin.ts/auth.community.ts, not here. User/Artisan/
// Category CRUD for the admin dashboard live in their own route files
// (users.ts, artisans.ts, categories.ts) rather than being duplicated here.

import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';
import { prisma } from '../server';
import { ok, fail } from '../utils/helpers';
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

  // TEMPORARY (2026-10-24) - one-off bootstrap for the first AdminUser row,
  // since local dev can't reach the DB directly (same IPv6/pooler issue
  // fixed for Render's own DATABASE_URL) to run prisma/seedAdmin.ts there.
  // One-time throwaway token, not an env var, specifically so this doesn't
  // need yet another manual Render dashboard round-trip for something
  // that's being deleted within minutes regardless.
  // DELETE this whole route right after running it once.
  const ONE_TIME_SEED_TOKEN = 'artizan-admin-bootstrap-f4a1c9';
  app.post('/_seed-admin', async (req, reply) => {
    const { secret, email, password } = req.body as { secret?: string; email?: string; password?: string };
    if (secret !== ONE_TIME_SEED_TOKEN) {
      return reply.status(403).send(fail('FORBIDDEN', 'Nope.'));
    }
    if (!email || !password) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'email and password required.'));
    }
    const existing = await prisma.adminUser.findUnique({ where: { email } });
    if (existing) return reply.send(ok({ message: 'Already exists.' }));

    const passwordHash = await bcrypt.hash(password, 12);
    await prisma.adminUser.create({
      data: { email, passwordHash, name: 'Super Admin', role: 'SUPER_ADMIN' },
    });
    return reply.send(ok({ message: `Created ${email}.` }));
  });

};

export default adminRoutes;
