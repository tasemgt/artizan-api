// src/services/authService.ts
// Shared auth business logic used by both user and artisan auth routes.

import { FastifyInstance } from 'fastify';
import { prisma } from '../server';
import { hashPassword, verifyPassword, ok, fail } from '../utils/helpers';

// ── Token helpers ─────────────────────────────────────────────────────
export function signTokens(
  app: FastifyInstance,
  payload: { id: string; role: string },
) {
  const token = app.jwt.sign(payload, {
    expiresIn: process.env.JWT_EXPIRES_IN ?? '15m',
  });
  const refreshToken = app.jwt.sign(
    { ...payload, type: 'refresh' },
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d' },
  );
  return { token, refreshToken };
}

// ── Sanitise user (strip password hash) ──────────────────────────────
export function sanitiseUser(user: any) {
  const { passwordHash, ...safe } = user;
  return safe;
}

// ── Create wallet for new user/artisan ───────────────────────────────
export async function createWallet(ownerId: string, ownerType: 'USER' | 'ARTISAN') {
  return prisma.wallet.create({
    data: {
      ownerId,
      ownerType,
      balance: 0,
      xpPoints: 0,
      currency: 'NGN',
    },
  });
}
