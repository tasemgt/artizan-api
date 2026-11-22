// src/routes/serviceRequests.ts
// Real as of 2026-11-22 - replaces the entire client-simulated lifecycle on
// both artizan-app sides (MatchingAreaScreen's setTimeout-driven auto-accept/
// arrive/complete, and artisanRequestSlice.ts's AsyncStorage-only inbox).
//
// Deliberately out of scope for this pass (see CLAUDE.md):
// - Live GPS tracking: artisan movement toward the user stays a client-side
//   simulated animation on both sides. Only the accept/reject/arrive/
//   complete DECISIONS are real now, driven by the artisan's own actions
//   and polled by the user - not continuous position streaming.
// - Wallet fee hold/capture: platformFeeUser/platformFeeArtisan are set
//   from the category's fee at creation time, but nothing debits a wallet
//   anywhere in this file. That's its own later step.
// - Community real-matching: requestType can be COMMUNITY with a
//   communityId, but nothing here validates membership/community rules -
//   communities themselves are still a separate, not-yet-real concept.

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../server';
import { ok, fail, generateAccessCode } from '../utils/helpers';
import { sanitiseUser } from '../services/authService';
import { requireUser, requireArtisan, requireRole } from '../middleware/auth';

const createSchema = z.object({
  artisanId:             z.string().uuid(),
  categoryId:            z.string().uuid(),
  latitude:              z.number(),
  longitude:             z.number(),
  requestType:           z.enum(['COMMUNITY', 'INDEPENDENT']).default('INDEPENDENT'),
  // .nullish() (not .optional()) — the mobile client sends explicit `null`
  // for an INDEPENDENT request (communityId/communityNameFreeText are both
  // `null`, not omitted), which .optional() alone rejects as "Expected
  // string, received null".
  communityId:           z.string().uuid().nullish(),
  communityNameFreeText: z.string().max(255).nullish(),
  // Human-readable address for where the user is requesting FROM — set by
  // the mobile client (community name, or a reverse-geocoded address), NOT
  // derived from the user's registered profile address here.
  requestAddress:        z.string().max(500).nullish(),
});

const reasonSchema = z.object({ reason: z.string().max(500).nullish() });
const acceptSchema = z.object({ latitude: z.number(), longitude: z.number() });
const ratingSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(500).nullish(),
});

// Shared across GET /:id and every PATCH action - the mobile side maps this
// into its own ArtisanServiceRequest/local shape at the fetch boundary
// (same mapApiArtisanToDummy-style pattern already used for /artisans/nearby),
// so this just returns the real row with its relations, nothing bespoke.
const include = { user: true, category: true } as const;
function serialize(sr: any) {
  return {
    ...sr,
    user: sr.user ? sanitiseUser(sr.user) : null,
    // Prisma Decimal serializes to a string by default - the mobile
    // ApiServiceRequest type declares these as `number | null`.
    platformFeeUser: sr.platformFeeUser != null ? Number(sr.platformFeeUser) : null,
    platformFeeArtisan: sr.platformFeeArtisan != null ? Number(sr.platformFeeArtisan) : null,
  };
}

// GeoJSON Point, matching the convention already used by artisans.ts's
// geoLocation field (and the mobile GeoPoint type) - [longitude, latitude]
// order, not {latitude, longitude}.
const toGeoPoint = (latitude: number, longitude: number) => ({
  type: 'Point' as const,
  coordinates: [longitude, latitude] as [number, number],
});

const serviceRequestsRoutes: FastifyPluginAsync = async (app) => {

  app.get('/', async (_req, reply) => {
    return reply.send(ok([]));
  });

  // ── POST / — user: create a request addressed to a specific artisan ──
  // (one targeted artisan, not a broadcast - matches the existing nearby-
  // matching UX where the user already picked one before firing).
  app.post('/', { preHandler: requireUser }, async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors));
    }
    const {
      artisanId, categoryId, latitude, longitude, requestType,
      communityId, communityNameFreeText, requestAddress,
    } = parsed.data;

    const artisan = await prisma.artisan.findUnique({ where: { id: artisanId } });
    if (!artisan) return reply.status(404).send(fail('NOT_FOUND', 'Artisan not found.'));

    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) return reply.status(400).send(fail('INVALID_CATEGORY', 'Category does not exist.'));

    const serviceRequest = await prisma.serviceRequest.create({
      data: {
        userId:    req.authUser.id,
        artisanId,
        categoryId,
        requestType,
        communityId:           communityId ?? null,
        communityNameFreeText: communityNameFreeText ?? null,
        requestAddress:        requestAddress ?? null,
        userCoords:            toGeoPoint(latitude, longitude),
        // Same value on both sides for now - no fee-split logic exists yet
        // (that's the wallet-fee-capture step, still separately deferred).
        platformFeeUser:    category.platformFeeNgn,
        platformFeeArtisan: category.platformFeeNgn,
      },
      include,
    });

    return reply.status(201).send(ok(serialize(serviceRequest)));
  });

  // ── GET /mine — artisan: every request addressed to them, any status.
  // Mobile does its own client-side filtering per screen (Home: PENDING/
  // ACCEPTED-ish, History: COMPLETED/CANCELLED-ish) exactly like it already
  // did against the local AsyncStorage array - this just swaps the source.
  app.get('/mine', { preHandler: requireArtisan }, async (req, reply) => {
    const requests = await prisma.serviceRequest.findMany({
      where:   { artisanId: req.authUser.id, deletedAt: null },
      include,
      orderBy: { createdAt: 'desc' },
    });
    return reply.send(ok(requests.map(serialize)));
  });

  // ── GET /:id — poll target for both sides. Ownership-checked manually
  // (not requireRole) since EITHER the creating user or the addressed
  // artisan may read it, but no one else.
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireRole('user', 'artisan') }, async (req, reply) => {
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id }, include });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));

    const isOwner =
      (req.authUser.role === 'user' && sr.userId === req.authUser.id) ||
      (req.authUser.role === 'artisan' && sr.artisanId === req.authUser.id);
    if (!isOwner) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));

    return reply.send(ok(serialize(sr)));
  });

  // ── PATCH /:id/accept — artisan ────────────────────────────────────
  app.patch<{ Params: { id: string } }>('/:id/accept', { preHandler: requireArtisan }, async (req, reply) => {
    const parsed = acceptSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'latitude and longitude are required.', parsed.error.flatten().fieldErrors));
    }
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));
    if (sr.artisanId !== req.authUser.id) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));
    if (sr.status !== 'PENDING') {
      return reply.status(409).send(fail('INVALID_STATUS', `Cannot accept a request in status ${sr.status}.`));
    }

    const updated = await prisma.serviceRequest.update({
      where: { id: sr.id },
      data: {
        status: 'ARTISAN_ACCEPTED',
        artisanAcceptedCoords: toGeoPoint(parsed.data.latitude, parsed.data.longitude),
      },
      include,
    });
    return reply.send(ok(serialize(updated)));
  });

  // ── PATCH /:id/reject — artisan, pre-accept only. Mirrors
  // RejectRequestScreen.tsx's existing reason-capture UI, which already
  // exists and just needed a real endpoint to call.
  app.patch<{ Params: { id: string } }>('/:id/reject', { preHandler: requireArtisan }, async (req, reply) => {
    const parsed = reasonSchema.safeParse(req.body);
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));
    if (sr.artisanId !== req.authUser.id) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));
    if (sr.status !== 'PENDING') {
      return reply.status(409).send(fail('INVALID_STATUS', `Cannot reject a request in status ${sr.status}.`));
    }

    const updated = await prisma.serviceRequest.update({
      where: { id: sr.id },
      data: {
        status: 'ARTISAN_REJECTED',
        cancelledBy: 'ARTISAN',
        cancellationReason: parsed.success ? (parsed.data.reason ?? null) : null,
      },
      include,
    });
    return reply.send(ok(serialize(updated)));
  });

  // ── PATCH /:id/arrive — artisan. Generates the access code here for
  // COMMUNITY requests, matching the exact moment the old simulation did.
  app.patch<{ Params: { id: string } }>('/:id/arrive', { preHandler: requireArtisan }, async (req, reply) => {
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));
    if (sr.artisanId !== req.authUser.id) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));
    if (sr.status !== 'ARTISAN_ACCEPTED') {
      return reply.status(409).send(fail('INVALID_STATUS', `Cannot mark arrived from status ${sr.status}.`));
    }

    const expiryHours = parseInt(process.env.ACCESS_CODE_EXPIRY_HOURS ?? '4', 10);
    const updated = await prisma.serviceRequest.update({
      where: { id: sr.id },
      data: {
        status: 'ARTISAN_ARRIVED',
        ...(sr.requestType === 'COMMUNITY'
          ? {
              accessCode: generateAccessCode(),
              accessCodeExpiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
            }
          : {}),
      },
      include,
    });
    return reply.send(ok(serialize(updated)));
  });

  // ── PATCH /:id/complete — artisan marks the job done. NOT the final
  // state - the user still has to confirm (see /confirm below). This is
  // deliberately different from the old simulation, which treated the
  // artisan's own "complete" tap as instantly final.
  app.patch<{ Params: { id: string } }>('/:id/complete', { preHandler: requireArtisan }, async (req, reply) => {
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));
    if (sr.artisanId !== req.authUser.id) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));
    if (sr.status !== 'ARTISAN_ARRIVED') {
      return reply.status(409).send(fail('INVALID_STATUS', `Cannot complete from status ${sr.status}.`));
    }

    const updated = await prisma.serviceRequest.update({
      where: { id: sr.id },
      data: { status: 'ARTISAN_COMPLETED' },
      include,
    });
    return reply.send(ok(serialize(updated)));
  });

  // ── PATCH /:id/confirm — user confirms the artisan's completion claim.
  // The only path to the final COMPLETED status in this pass.
  app.patch<{ Params: { id: string } }>('/:id/confirm', { preHandler: requireUser }, async (req, reply) => {
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));
    if (sr.userId !== req.authUser.id) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));
    if (sr.status !== 'ARTISAN_COMPLETED') {
      return reply.status(409).send(fail('INVALID_STATUS', `Cannot confirm from status ${sr.status}.`));
    }

    const updated = await prisma.serviceRequest.update({
      where: { id: sr.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
      include,
    });
    return reply.send(ok(serialize(updated)));
  });

  // ── POST /:id/rating — user rates the artisan after a COMPLETED request.
  // Also rolls the score into the artisan's aggregate rating/totalRatings
  // (already displayed on ArtisanCard during matching, previously always
  // 0 since nothing ever wrote to it) — both in one transaction so the
  // Rating row and the aggregate never drift apart.
  app.post<{ Params: { id: string } }>('/:id/rating', { preHandler: requireUser }, async (req, reply) => {
    const parsed = ratingSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors));
    }
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));
    if (sr.userId !== req.authUser.id) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));
    if (sr.status !== 'COMPLETED') {
      return reply.status(409).send(fail('INVALID_STATUS', 'Can only rate a completed request.'));
    }
    if (!sr.artisanId) {
      return reply.status(409).send(fail('INVALID_STATUS', 'This request has no artisan to rate.'));
    }

    const alreadyRated = await prisma.rating.findUnique({ where: { serviceRequestId: sr.id } });
    if (alreadyRated) return reply.status(409).send(fail('ALREADY_RATED', 'You already rated this request.'));

    const { score, comment } = parsed.data;

    const rating = await prisma.$transaction(async (tx) => {
      const created = await tx.rating.create({
        data: {
          serviceRequestId: sr.id,
          userId: req.authUser.id,
          artisanId: sr.artisanId!,
          score,
          comment: comment ?? null,
        },
      });

      const artisan = await tx.artisan.findUnique({ where: { id: sr.artisanId! } });
      if (artisan) {
        const newTotal = artisan.totalRatings + 1;
        const newAverage = (artisan.rating * artisan.totalRatings + score) / newTotal;
        await tx.artisan.update({
          where: { id: artisan.id },
          data: { rating: newAverage, totalRatings: newTotal },
        });
      }

      return created;
    });

    return reply.status(201).send(ok(rating));
  });

  // ── PATCH /:id/cancel — either side. Covers every cancel path at once:
  // user backing out before/after pairing, user rejecting the artisan's
  // completion claim (same minimal-placeholder behavior as before - no
  // dedicated reason-capture screen for THIS path, see CLAUDE.md), and the
  // artisan cancelling after having already accepted.
  app.patch<{ Params: { id: string } }>('/:id/cancel', { preHandler: requireRole('user', 'artisan') }, async (req, reply) => {
    const parsed = reasonSchema.safeParse(req.body);
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));

    const isUser    = req.authUser.role === 'user'    && sr.userId === req.authUser.id;
    const isArtisan = req.authUser.role === 'artisan' && sr.artisanId === req.authUser.id;
    if (!isUser && !isArtisan) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));

    if (['COMPLETED', 'USER_CANCELLED', 'ARTISAN_CANCELLED', 'ARTISAN_REJECTED'].includes(sr.status)) {
      return reply.status(409).send(fail('INVALID_STATUS', `Cannot cancel a request already in status ${sr.status}.`));
    }

    const updated = await prisma.serviceRequest.update({
      where: { id: sr.id },
      data: {
        status: isUser ? 'USER_CANCELLED' : 'ARTISAN_CANCELLED',
        cancelledBy: isUser ? 'USER' : 'ARTISAN',
        cancellationReason: parsed.success ? (parsed.data.reason ?? null) : null,
      },
      include,
    });
    return reply.send(ok(serialize(updated)));
  });

};

export default serviceRequestsRoutes;
