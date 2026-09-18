// src/routes/artisans.ts
// /search and /nearby are stubs — mobile uses generateDummyArtisans() locally
// instead, and artisan mode has no UI at all yet beyond the tab shell (see
// CLAUDE.md), so nothing calls /me/photo yet either — but the backend
// capability is real, mirroring the user-side upload in users.ts.

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../server';
import { ok, fail } from '../utils/helpers';
import { sanitiseUser } from '../services/authService';
import { requireArtisan } from '../middleware/auth';
import { uploadProfileImage, uploadVerificationDocument } from '../services/supabaseStorage';

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const ALLOWED_DOCUMENT_TYPES = new Set(['image/jpeg', 'application/pdf']);
const MAX_DOCUMENT_BYTES = 500 * 1024;
const MAX_DOCUMENTS_PER_ARTISAN = 6;

// Email and phone intentionally excluded — same reasoning as users.ts.
const updateProfileSchema = z.object({
  firstName:     z.string().min(1).max(50).optional(),
  lastName:      z.string().min(1).max(50).optional(),
  address:       z.string().max(255).nullable().optional(),
  gender:        z.string().max(30).nullable().optional(),
  dateOfBirth:   z.string().datetime().nullable().optional(),
  portfolioLink: z.string().url().max(300).nullable().optional(),
  categoryId:    z.string().uuid().optional(),
});

const artisansRoutes: FastifyPluginAsync = async (app) => {

  app.get('/search', async (_req, reply) => {
    return reply.send(ok([]));
  });

  app.get('/nearby', async (_req, reply) => {
    return reply.send(ok([]));
  });

  // ── GET /me — the authenticated artisan's own profile ──────────────
  app.get('/me', { preHandler: requireArtisan }, async (req, reply) => {
    const artisan = await prisma.artisan.findUnique({
      where: { id: req.authUser.id },
      include: { category: true },
    });
    if (!artisan) return reply.status(404).send(fail('NOT_FOUND', 'Artisan not found.'));
    return reply.send(ok(sanitiseUser(artisan)));
  });

  // ── PATCH /me — update editable profile fields ─────────────────────
  app.patch('/me', { preHandler: requireArtisan }, async (req, reply) => {
    const parsed = updateProfileSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(
        fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors),
      );
    }
    const { dateOfBirth, categoryId, ...rest } = parsed.data;

    if (categoryId) {
      const category = await prisma.category.findUnique({ where: { id: categoryId } });
      if (!category) return reply.status(400).send(fail('INVALID_CATEGORY', 'Selected category does not exist.'));
    }

    const artisan = await prisma.artisan.update({
      where: { id: req.authUser.id },
      data: {
        ...rest,
        ...(categoryId ? { categoryId } : {}),
        ...(dateOfBirth !== undefined
          ? { dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null }
          : {}),
      },
      include: { category: true },
    });
    return reply.send(ok(sanitiseUser(artisan)));
  });

  // ── POST /me/photo — multipart upload, replaces profileImageUrl ────
  app.post('/me/photo', { preHandler: requireArtisan }, async (req, reply) => {
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
        buffer, contentType: file.mimetype, ownerType: 'artisan', ownerId: req.authUser.id,
      });
    } catch (err) {
      req.log.error(err);
      return reply.status(502).send(fail('UPLOAD_FAILED', 'Could not upload image.'));
    }

    const artisan = await prisma.artisan.update({
      where: { id: req.authUser.id },
      data: { profileImageUrl },
    });
    return reply.send(ok(sanitiseUser(artisan)));
  });

  // ── GET /me/documents — list this artisan's verification documents ─
  app.get('/me/documents', { preHandler: requireArtisan }, async (req, reply) => {
    const documents = await prisma.artisanDocument.findMany({
      where:   { artisanId: req.authUser.id },
      orderBy: { createdAt: 'asc' },
      select:  { id: true, fileName: true, fileType: true, fileSizeBytes: true, createdAt: true },
    });
    return reply.send(ok(documents));
  });

  // ── POST /me/documents — multipart upload, up to 6 total, jpg/pdf only,
  // 500KB each. Not compulsory (see mobile signup flow) — this endpoint
  // just persists whatever the artisan chooses to attach. Reviewed later
  // by the (not-yet-built) admin dashboard against verificationStatus.
  app.post('/me/documents', { preHandler: requireArtisan }, async (req, reply) => {
    const existingCount = await prisma.artisanDocument.count({ where: { artisanId: req.authUser.id } });
    let remaining = MAX_DOCUMENTS_PER_ARTISAN - existingCount;
    if (remaining <= 0) {
      return reply.status(400).send(fail('LIMIT_REACHED', `You can only have up to ${MAX_DOCUMENTS_PER_ARTISAN} documents.`));
    }

    const created: { id: string; fileName: string | null; fileType: string; fileSizeBytes: number }[] = [];

    for await (const part of req.files()) {
      if (remaining <= 0) break;

      if (!ALLOWED_DOCUMENT_TYPES.has(part.mimetype)) {
        return reply.status(400).send(fail('VALIDATION_ERROR', 'Only JPEG images or PDFs are allowed.'));
      }

      const buffer = await part.toBuffer();
      if (buffer.length > MAX_DOCUMENT_BYTES) {
        return reply.status(400).send(fail('VALIDATION_ERROR', 'Each document must be 500KB or smaller.'));
      }

      let fileUrl: string;
      try {
        fileUrl = await uploadVerificationDocument({
          buffer,
          contentType: part.mimetype as 'image/jpeg' | 'application/pdf',
          artisanId: req.authUser.id,
        });
      } catch (err) {
        req.log.error(err);
        return reply.status(502).send(fail('UPLOAD_FAILED', 'Could not upload one of the documents.'));
      }

      const doc = await prisma.artisanDocument.create({
        data: {
          artisanId:     req.authUser.id,
          fileUrl,
          fileType:      part.mimetype,
          fileSizeBytes: buffer.length,
          fileName:      part.filename ?? null,
        },
        select: { id: true, fileName: true, fileType: true, fileSizeBytes: true },
      });
      created.push(doc);
      remaining -= 1;
    }

    if (created.length === 0) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'No files uploaded.'));
    }

    return reply.status(201).send(ok(created));
  });

};

export default artisansRoutes;
