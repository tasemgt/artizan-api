// src/routes/admin.ts
// Stub. No admin auth or logic implemented in Fastify yet. The deprecated
// Express backend had a working admin login (see
// _deprecated/artizan-api-express/src/routes/auth.admin.routes.js) that was
// never ported — worth revisiting rather than rebuilding from scratch.
// Phase 2+.

import { FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';
import { prisma } from '../server';
import { ok, fail } from '../utils/helpers';

const adminRoutes: FastifyPluginAsync = async (app) => {

  app.get('/', async (_req, reply) => {
    return reply.send(ok(null));
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
