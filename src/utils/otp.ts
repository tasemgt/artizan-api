// src/utils/otp.ts
// Generates, stores, and verifies 6-digit email OTP codes.

import { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../server';

const OTP_EXPIRY_MINUTES = 10;

// Accepts either the global client or a `tx` from prisma.$transaction — lets
// callers make "consume the code" and "act on it" (set emailVerifiedAt,
// change the password) atomic. Without this, a failure in the second step
// left real, confusing bricked state: the code shows as used/"expired" on
// retry, but nothing it was supposed to unlock ever actually happened.
type Db = PrismaClient | Prisma.TransactionClient;

// ── Generate and persist a new OTP ───────────────────────────────────
export const createOtp = async (
  email: string,
  purpose: 'verify' | 'reset',
  db: Db = prisma,
): Promise<string> => {
  // Invalidate any existing unused codes for this email + purpose
  await db.otpCode.updateMany({
    where: { email, purpose, usedAt: null },
    data:  { usedAt: new Date() },
  });

  const code      = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  await db.otpCode.create({ data: { email, code, purpose, expiresAt } });

  // Dev convenience — lets you verify/reset without digging through the
  // Mailtrap sandbox. Every createOtp() call site gets this for free.
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[DEV] OTP for ${email} (${purpose}): ${code}`);
  }

  return code;
};

// ── Verify an OTP ─────────────────────────────────────────────────────
// Returns true and marks as used, or returns false if invalid/expired.
// Pass a transaction client when the caller has follow-up writes that must
// succeed or fail together with consuming the code (see Db above).
export const verifyOtp = async (
  email: string,
  code: string,
  purpose: 'verify' | 'reset',
  db: Db = prisma,
): Promise<boolean> => {
  const record = await db.otpCode.findFirst({
    where: {
      email,
      code,
      purpose,
      usedAt:    null,
      expiresAt: { gt: new Date() },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!record) return false;

  await db.otpCode.update({
    where: { id: record.id },
    data:  { usedAt: new Date() },
  });

  return true;
};