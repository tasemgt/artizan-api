// src/routes/auth.community.ts
// Community admin/security login only - no public registration (same
// reasoning as auth.admin.ts). CommunityAdmin rows are created directly by a
// super admin via the (not-yet-built, deferred) admin Communities screen -
// out of scope for v1, so there's no seed script for this one yet either.

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../server';
import { verifyPassword, ok, fail } from '../utils/helpers';
import { signTokens, sanitiseUser } from '../services/authService';

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const authCommunityRoutes: FastifyPluginAsync = async (app) => {

  app.post('/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .status(400)
        .send(fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors));
    }
    const { email, password } = parsed.data;

    const admin = await prisma.communityAdmin.findFirst({ where: { email, isActive: true } });
    if (!admin || !(await verifyPassword(password, admin.passwordHash))) {
      return reply.status(401).send(fail('INVALID_CREDENTIALS', 'Incorrect email or password.'));
    }

    const role = admin.role === 'ADMIN' ? 'community_admin' : 'community_security';
    const { token, refreshToken } = signTokens(app, { id: admin.id, role });
    return reply.send(
      ok({ token, refreshToken, user: { ...sanitiseUser(admin), role } }),
    );
  });

};

export default authCommunityRoutes;
