// src/routes/auth.artisan.ts
// Artisan authentication endpoints — mirrors the real auth.user.ts pattern
// (email OTP via createOtp/verifyOtp/sendOtpEmail). The previous version of
// this file verified phone via Firebase and gated login on phoneVerifiedAt —
// but CLAUDE.md rules out Firebase on the mobile client, so phoneVerifiedAt
// could never be set and no artisan could ever log in. Rewritten 2026-09-06
// to match auth.user.ts exactly, with artisan-specific registration fields.

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../server';
import { hashPassword, verifyPassword, ok, fail } from '../utils/helpers';
import { signTokens, sanitiseUser } from '../services/authService';
import { sendOtpEmail, sendPasswordChangedEmail } from '../utils/email';
import { createOtp, verifyOtp } from '../utils/otp';
import { verifyJwt } from '../middleware/auth';

const registerSchema = z.object({
  firstName:        z.string().min(1).max(50),
  lastName:         z.string().min(1).max(50),
  username:         z.string().min(3).max(30).regex(/^[a-z0-9_]+$/, 'Lowercase letters, numbers and _ only'),
  email:            z.string().email(),
  phoneNumber:      z.string().min(10).max(20),
  password:         z.string().min(8).max(128),
  categoryId:       z.string().uuid(),
  shortDescription: z.string().max(300).optional(),
  certifications:   z.string().max(500).optional(),
  profileImageUrl:  z.string().url().optional(),
});

const loginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

const verifyEmailSchema = z.object({
  email: z.string().email(),
  code:  z.string().length(6),
});

const resendOtpSchema = z.object({
  email:   z.string().email(),
  purpose: z.enum(['verify', 'reset']),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  email:    z.string().email(),
  code:     z.string().length(6),
  password: z.string().min(8).max(128),
});

const refreshSchema = z.object({ refreshToken: z.string().min(1) });

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8).max(128),
});

const authArtisanRoutes: FastifyPluginAsync = async (app) => {

  // ── POST /register ────────────────────────────────────────────────
  app.post('/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors));
    }
    const data = parsed.data;

    const existing = await prisma.artisan.findFirst({
      where: { OR: [{ email: data.email }, { phoneNumber: data.phoneNumber }, { username: data.username }] },
    });
    if (existing) {
      const field = existing.email === data.email ? 'Email'
        : existing.phoneNumber === data.phoneNumber ? 'Phone number'
        : 'Username';
      return reply.status(409).send(fail('DUPLICATE', `${field} is already registered.`));
    }

    const category = await prisma.category.findUnique({ where: { id: data.categoryId } });
    if (!category) return reply.status(400).send(fail('INVALID_CATEGORY', 'Selected category does not exist.'));

    const passwordHash = await hashPassword(data.password);

    const artisan = await prisma.artisan.create({
      data: {
        firstName:        data.firstName,
        lastName:         data.lastName,
        username:         data.username,
        email:            data.email,
        phoneNumber:      data.phoneNumber,
        passwordHash,
        category:         { connect: { id: data.categoryId } },
        shortDescription: data.shortDescription ?? null,
        certifications:   data.certifications ?? null,
        profileImageUrl:  data.profileImageUrl ?? null,
        wallet: {
          create: {
            ownerId:   crypto.randomUUID(),
            ownerType: 'ARTISAN' as const,
            balance:   0,
            xpPoints:  0,
            currency:  'NGN',
          },
        },
      },
    });

    const code = await createOtp(data.email, 'verify');
    await sendOtpEmail(data.email, data.firstName, code, 'verify');

    return reply.status(201).send(ok({
      artisan: sanitiseUser(artisan),
      message: `Verification code sent to ${data.email}`,
    }));
  });

  // ── POST /verify-email ────────────────────────────────────────────
  app.post('/verify-email', async (req, reply) => {
    const parsed = verifyEmailSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Email and 6-digit code required.'));
    }
    const { email, code } = parsed.data;

    const verified = await prisma.$transaction(async (tx) => {
      const valid = await verifyOtp(email, code, 'verify', tx);
      if (!valid) return false;
      await tx.artisan.update({ where: { email }, data: { emailVerifiedAt: new Date() } });
      return true;
    });
    if (!verified) {
      return reply.status(400).send(fail('INVALID_OTP', 'Invalid or expired code. Please try again.'));
    }

    return reply.send(ok({ message: 'Email verified successfully.' }));
  });

  // ── POST /resend-otp ──────────────────────────────────────────────
  app.post('/resend-otp', async (req, reply) => {
    const parsed = resendOtpSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail('VALIDATION_ERROR', 'Email and purpose required.'));
    const { email, purpose } = parsed.data;

    const artisan = await prisma.artisan.findUnique({ where: { email } });
    if (!artisan) {
      return reply.send(ok({ message: 'If that email exists, a code has been sent.' }));
    }

    const code = await createOtp(email, purpose);
    await sendOtpEmail(email, artisan.firstName, code, purpose);

    return reply.send(ok({ message: `New code sent to ${email}` }));
  });

  // ── POST /login ───────────────────────────────────────────────────
  app.post('/login', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail('VALIDATION_ERROR', 'Invalid input.'));

    const { email, password } = parsed.data;
    const artisan = await prisma.artisan.findFirst({ where: { email, isActive: true, deletedAt: null } });
    if (!artisan || !(await verifyPassword(password, artisan.passwordHash))) {
      return reply.status(401).send(fail('INVALID_CREDENTIALS', 'Incorrect email or password.'));
    }

    if (!artisan.emailVerifiedAt) {
      const code = await createOtp(email, 'verify');
      await sendOtpEmail(email, artisan.firstName, code, 'verify');
      return reply.status(403).send(
        fail('EMAIL_NOT_VERIFIED', 'Please verify your email. A new code has been sent.'),
      );
    }

    const { token, refreshToken } = signTokens(app, { id: artisan.id, role: 'artisan' });
    return reply.send(ok({ token, refreshToken, artisan: sanitiseUser(artisan) }));
  });

  // ── POST /logout ──────────────────────────────────────────────────
  app.post('/logout', { preHandler: verifyJwt }, async (_req, reply) => {
    return reply.send(ok({ message: 'Logged out successfully.' }));
  });

  // ── POST /refresh ─────────────────────────────────────────────────
  app.post('/refresh', async (req, reply) => {
    const parsed = refreshSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail('VALIDATION_ERROR', 'Refresh token required.'));
    try {
      const decoded = app.jwt.verify(parsed.data.refreshToken) as any;
      if (decoded.type !== 'refresh') throw new Error('Not a refresh token');
      const artisan = await prisma.artisan.findFirst({ where: { id: decoded.id, isActive: true, deletedAt: null } });
      if (!artisan) return reply.status(401).send(fail('UNAUTHORIZED', 'Invalid session.'));
      const { token, refreshToken } = signTokens(app, { id: artisan.id, role: 'artisan' });
      return reply.send(ok({ token, refreshToken }));
    } catch {
      return reply.status(401).send(fail('UNAUTHORIZED', 'Invalid or expired refresh token.'));
    }
  });

  // ── POST /forgot-password ─────────────────────────────────────────
  app.post('/forgot-password', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async (req, reply) => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send(fail('VALIDATION_ERROR', 'Email required.'));
    const { email } = parsed.data;

    const artisan = await prisma.artisan.findUnique({ where: { email } });
    if (!artisan) {
      return reply.send(ok({ message: 'If that email exists, a reset code has been sent.' }));
    }

    const code = await createOtp(email, 'reset');
    await sendOtpEmail(email, artisan.firstName, code, 'reset');

    return reply.send(ok({ message: 'Reset code sent to your email.' }));
  });

  // ── POST /reset-password ──────────────────────────────────────────
  app.post('/reset-password', async (req, reply) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Email, 6-digit code, and new password required.'));
    }
    const { email, code, password } = parsed.data;
    const passwordHash = await hashPassword(password);

    const artisan = await prisma.$transaction(async (tx) => {
      const valid = await verifyOtp(email, code, 'reset', tx);
      if (!valid) return null;
      return tx.artisan.update({ where: { email }, data: { passwordHash } });
    });
    if (!artisan) return reply.status(400).send(fail('INVALID_OTP', 'Invalid or expired code.'));

    await sendPasswordChangedEmail(email, artisan.firstName);
    const { token, refreshToken } = signTokens(app, { id: artisan.id, role: 'artisan' });
    return reply.send(ok({ token, refreshToken, artisan: sanitiseUser(artisan) }));
  });

  // ── PATCH /change-password (authenticated) ────────────────────────
  app.patch('/change-password', { preHandler: verifyJwt }, async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Current and new password required.'));
    }
    const { currentPassword, newPassword } = parsed.data;

    const artisan = await prisma.artisan.findUnique({ where: { id: req.authUser.id } });
    if (!artisan) return reply.status(404).send(fail('NOT_FOUND', 'Artisan not found.'));

    const valid = await verifyPassword(currentPassword, artisan.passwordHash);
    if (!valid) {
      return reply.status(401).send(fail('INVALID_PASSWORD', 'Current password is incorrect.'));
    }

    const passwordHash = await hashPassword(newPassword);
    await prisma.artisan.update({ where: { id: artisan.id }, data: { passwordHash } });

    await sendPasswordChangedEmail(artisan.email, artisan.firstName);
    return reply.send(ok({ message: 'Password changed successfully.' }));
  });

};

export default authArtisanRoutes;
