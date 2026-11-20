// src/routes/artisans.ts
// /search and /nearby are stubs — mobile uses generateDummyArtisans() locally
// instead, and artisan mode has no UI at all yet beyond the tab shell (see
// CLAUDE.md), so nothing calls /me/photo yet either — but the backend
// capability is real, mirroring the user-side upload in users.ts.

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../server';
import { ok, fail, parsePagination, paginationMeta, haversineKm } from '../utils/helpers';
import { sanitiseUser } from '../services/authService';
import { requireArtisan, requireAdmin, requireUser } from '../middleware/auth';
import { uploadProfileImage, uploadVerificationDocument } from '../services/supabaseStorage';

const verificationSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED']),
});

const availabilitySchema = z.object({
  isAvailable: z.boolean(),
  // Required when going available - optional/ignored when going offline.
  latitude:  z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
});

const nearbyQuerySchema = z.object({
  categoryId: z.string().uuid(),
  latitude:   z.coerce.number().min(-90).max(90),
  longitude:  z.coerce.number().min(-180).max(180),
});

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

  // ── GET /nearby — real: available, active, APPROVED artisans in a
  // category, within FAR_ARTISAN_RADIUS_KM of the given point, nearest
  // first. Distance filtering happens in app code via haversineKm rather
  // than a PostGIS query - fine at this scale, revisit if artisan volume
  // ever makes an in-DB candidate pool worth it.
  app.get('/nearby', { preHandler: requireUser }, async (req, reply) => {
    const parsed = nearbyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.status(400).send(
        fail('VALIDATION_ERROR', 'categoryId, latitude, and longitude are required.', parsed.error.flatten().fieldErrors),
      );
    }
    const { categoryId, latitude, longitude } = parsed.data;
    const radiusKm = parseFloat(process.env.FAR_ARTISAN_RADIUS_KM ?? '10');

    const candidates = await prisma.artisan.findMany({
      where: {
        categoryId,
        isAvailable: true,
        isActive: true,
        verificationStatus: 'APPROVED',
        geoLocation: { not: Prisma.JsonNull },
      },
      include: { category: true },
    });

    const nearby = candidates
      .map((artisan) => {
        const geo = artisan.geoLocation as { coordinates?: [number, number] } | null;
        if (!geo?.coordinates) return null;
        const [lng, lat] = geo.coordinates;
        return { artisan, distanceKm: haversineKm(latitude, longitude, lat, lng) };
      })
      .filter((x): x is { artisan: (typeof candidates)[number]; distanceKm: number } => x !== null && x.distanceKm <= radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm)
      .map(({ artisan, distanceKm }) => ({
        ...sanitiseUser(artisan),
        distanceKm: Math.round(distanceKm * 10) / 10,
      }));

    return reply.send(ok(nearby));
  });

  // ── GET / — admin: paginated/searchable/filterable artisan list ────
  app.get('/', { preHandler: requireAdmin }, async (req, reply) => {
    const { page, limit, skip } = parsePagination(req.query);
    const query = req.query as { search?: string; verificationStatus?: string };
    const search = query.search?.trim();
    const verificationStatus = query.verificationStatus;

    const where = {
      ...(verificationStatus ? { verificationStatus: verificationStatus as any } : {}),
      ...(search
        ? {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' as const } },
              { lastName:  { contains: search, mode: 'insensitive' as const } },
              { email:     { contains: search, mode: 'insensitive' as const } },
              { username:  { contains: search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [artisans, total] = await Promise.all([
      prisma.artisan.findMany({
        where, skip, take: limit, orderBy: { createdAt: 'desc' },
        include: { category: true },
      }),
      prisma.artisan.count({ where }),
    ]);

    return reply.send(ok(artisans.map(sanitiseUser), paginationMeta(total, page, limit)));
  });

  // ── GET /:id — admin: single artisan + uploaded verification docs ──
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const artisan = await prisma.artisan.findUnique({
      where: { id: req.params.id },
      include: { category: true },
    });
    if (!artisan) return reply.status(404).send(fail('NOT_FOUND', 'Artisan not found.'));

    const documents = await prisma.artisanDocument.findMany({
      where:   { artisanId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });

    return reply.send(ok({ ...sanitiseUser(artisan), documents }));
  });

  // ── PATCH /:id/verification — admin: approve/reject an artisan ─────
  app.patch<{ Params: { id: string } }>('/:id/verification', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = verificationSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors));
    }

    const artisan = await prisma.artisan.findUnique({ where: { id: req.params.id } });
    if (!artisan) return reply.status(404).send(fail('NOT_FOUND', 'Artisan not found.'));

    const updated = await prisma.artisan.update({
      where: { id: req.params.id },
      data:  { verificationStatus: parsed.data.status },
      include: { category: true },
    });
    return reply.send(ok(sanitiseUser(updated)));
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

  // ── PATCH /me/availability — go online/offline + report live location.
  // Location is captured once per toggle, not continuously tracked in the
  // background - it'll go stale if the artisan leaves the app idle while
  // "available." Acceptable v1 limitation; real-time position wiring is
  // deferred to the websocket pass once service-requests are real.
  app.patch('/me/availability', { preHandler: requireArtisan }, async (req, reply) => {
    const parsed = availabilitySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors));
    }
    const { isAvailable, latitude, longitude } = parsed.data;

    if (isAvailable && (latitude === undefined || longitude === undefined)) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'latitude and longitude are required to go available.'));
    }

    const artisan = await prisma.artisan.update({
      where: { id: req.authUser.id },
      data: {
        isAvailable,
        // GeoJSON Point ([longitude, latitude], not [lat, lng]) - matches
        // the shape artizan-app's ApiArtisan.geoLocation type already
        // expects. Left untouched when going offline - no reason to
        // discard the last known position.
        ...(isAvailable
          ? { geoLocation: { type: 'Point', coordinates: [longitude!, latitude!] } }
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
