// src/routes/users.ts
// GET/PATCH /me are real. Email and phone are intentionally excluded from the
// PATCH — changing either has verification implications not designed yet, so
// only the fields ui_screens/user/4.user_profile_notifications.pdf page 2
// actually lets the user edit inline (name, address, gender, dob) are here.
// profileImageUrl is set separately via POST /me/photo (multipart upload to
// Supabase Storage), not through this JSON PATCH — see supabaseStorage.ts.

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../server';
import { ok, fail } from '../utils/helpers';
import { sanitiseUser } from '../services/authService';
import { requireUser } from '../middleware/auth';
import { uploadProfileImage } from '../services/supabaseStorage';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

const updateProfileSchema = z.object({
  firstName:   z.string().min(1).max(50).optional(),
  lastName:    z.string().min(1).max(50).optional(),
  address:     z.string().max(255).nullable().optional(),
  gender:      z.string().max(30).nullable().optional(),
  dateOfBirth: z.string().datetime().nullable().optional(),
});

const usersRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /me — the authenticated user's own profile ────────────────
  app.get('/me', { preHandler: requireUser }, async (req, reply) => {
    const user = await prisma.user.findUnique({ where: { id: req.authUser.id } });
    if (!user) return reply.status(404).send(fail('NOT_FOUND', 'User not found.'));
    return reply.send(ok(sanitiseUser(user)));
  });

  // ── PATCH /me — update editable profile fields ─────────────────────
  app.patch('/me', { preHandler: requireUser }, async (req, reply) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(
        fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors),
      );
    }
    const { dateOfBirth, ...rest } = parsed.data;

    const user = await prisma.user.update({
      where: { id: req.authUser.id },
      data: {
        ...rest,
        ...(dateOfBirth !== undefined
          ? { dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null }
          : {}),
      },
    });
    return reply.send(ok(sanitiseUser(user)));
  });

  // ── POST /me/photo — multipart upload, replaces profileImageUrl ────
  app.post('/me/photo', { preHandler: requireUser }, async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.status(400).send(fail('VALIDATION_ERROR', 'No file uploaded.'));
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Only JPEG, PNG, or WEBP images are allowed.'));
    }

    const buffer = await file.toBuffer();
    if (buffer.length > 5 * 1024 * 1024) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Image must be 5MB or smaller.'));
    }

    let profileImageUrl: string;
    try {
      profileImageUrl = await uploadProfileImage({
        buffer, contentType: file.mimetype, ownerType: 'user', ownerId: req.authUser.id,
      });
    } catch (err) {
      req.log.error(err);
      return reply.status(502).send(fail('UPLOAD_FAILED', 'Could not upload image.'));
    }

    const user = await prisma.user.update({
      where: { id: req.authUser.id },
      data: { profileImageUrl },
    });
    return reply.send(ok(sanitiseUser(user)));
  });

};

export default usersRoutes;
