// src/routes/auth.admin.ts
// Super-admin login only - no public registration by design. The first (and
// any further) AdminUser row is created via `npm run db:seed:admin`, not an
// API endpoint, since exposing admin account creation over HTTP has no
// legitimate caller in v1 (artizan-admin has no "create admin" screen).

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../server';
import { verifyPassword, ok, fail } from '../utils/helpers';
import { signTokens, sanitiseUser } from '../services/authService';

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
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

};

export default authAdminRoutes;
