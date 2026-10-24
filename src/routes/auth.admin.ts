// src/routes/auth.admin.ts
// Super-admin login only - no public registration by design. The first (and
// any further) AdminUser row is created via `npm run db:seed:admin`, not an
// API endpoint, since exposing admin account creation over HTTP has no
// legitimate caller in v1 (artizan-admin has no "create admin" screen).

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../server';
import { hashPassword, verifyPassword, ok, fail } from '../utils/helpers';
import { signTokens, sanitiseUser } from '../services/authService';
import { requireAdmin } from '../middleware/auth';

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8).max(128),
});

const authAdminRoutes: FastifyPluginAsync = async (app) => {

  app.post('/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors));
    }
    const { email, password } = parsed.data;

    const admin = await prisma.adminUser.findFirst({ where: { email, isActive: true } });
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      return reply.status(401).send(fail('INVALID_CREDENTIALS', 'Incorrect email or password.'));
    }

    const { token, refreshToken } = signTokens(app, { id: admin.id, role: 'super_admin' });
    return reply.send(
      ok({ token, refreshToken, user: { ...sanitiseUser(admin), role: 'super_admin' } }),
    );
  });

  // ── PATCH /change-password (authenticated) ─────────────────────────
  app.patch('/change-password', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Current and new password required.'));
    }
    const { currentPassword, newPassword } = parsed.data;

    const admin = await prisma.adminUser.findUnique({ where: { id: req.authUser.id } });
    if (!admin) return reply.status(404).send(fail('NOT_FOUND', 'Admin not found.'));

    const valid = await verifyPassword(currentPassword, admin.passwordHash);
    if (!valid) {
      return reply.status(401).send(fail('INVALID_PASSWORD', 'Current password is incorrect.'));
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.adminUser.update({ where: { id: admin.id }, data: { passwordHash } });

    return reply.send(ok({ message: 'Password changed successfully.' }));
  });

};

export default authAdminRoutes;
