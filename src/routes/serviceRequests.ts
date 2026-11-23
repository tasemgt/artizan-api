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
// Richer include for the USER's own GET /mine (real, DB-backed history) —
// needs the artisan's own details (with their category, for the icon) and
// the real Rating row, neither of which any other endpoint needs.
const includeForUserHistory = {
  category: true,
  artisan: { include: { category: true } },
  rating: true,
} as const;
function serialize(sr: any) {
  return {
    ...sr,
    user: sr.user ? sanitiseUser(sr.user) : sr.user,
    artisan: sr.artisan ? sanitiseUser(sr.artisan) : sr.artisan,
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

  // ── GET /mine — real, DB-backed history/inbox for EITHER side. Mobile
  // does its own client-side filtering per screen (Home: PENDING/
  // ACCEPTED-ish, History: COMPLETED/CANCELLED/REJECTED/EXPIRED-ish) off
  // this same list, same pattern already established on the artisan side.
  //
  // - ARTISAN: every request addressed to them, any status EXCEPT
  //   EXPIRED. EXPIRED (the artisan never responded in time) is
  //   deliberately excluded here, not just filtered client-side — the
  //   artisan should never see a request that timed out on them.
  // - USER: every request THEY created, every status INCLUDING EXPIRED —
  //   from the user's own point of view, a request that timed out while
  //   waiting for a response is still part of their own history. Also
  //   includes the artisan's own details + the real Rating row, which the
  //   artisan's side never needs.
  app.get('/mine', { preHandler: requireRole('user', 'artisan') }, async (req, reply) => {
    const isArtisan = req.authUser.role === 'artisan';
    const requests = await prisma.serviceRequest.findMany({
      where: isArtisan
        ? { artisanId: req.authUser.id, deletedAt: null, status: { not: 'EXPIRED' } }
        : { userId: req.authUser.id, deletedAt: null },
      include: isArtisan ? include : includeForUserHistory,
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
        acceptedAt: new Date(),
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
  // Also where the platform fee gets ESCROWED (held, not yet deducted) —
  // see Wallet.lockedAmount. The artisan receives no part of this fee, by
  // explicit decision — no credit to their wallet anywhere in this flow.
  app.patch<{ Params: { id: string } }>('/:id/arrive', { preHandler: requireArtisan }, async (req, reply) => {
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));
    if (sr.artisanId !== req.authUser.id) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));
    if (sr.status !== 'ARTISAN_ACCEPTED') {
      return reply.status(409).send(fail('INVALID_STATUS', `Cannot mark arrived from status ${sr.status}.`));
    }

    const expiryHours = parseInt(process.env.ACCESS_CODE_EXPIRY_HOURS ?? '4', 10);
    const fee = sr.platformFeeUser;

    const updated = await prisma.$transaction(async (tx) => {
      // Best-effort hold — insufficient available funds here doesn't block
      // a real-world arrival. feeStatus just stays PENDING instead of
      // HELD, and /confirm falls back to attempting a direct capture.
      // Known gap: no retry/notification path if that also fails — see
      // CLAUDE.md.
      let feeFields: { feeHeldAt?: Date; feeStatus?: 'HELD' } = {};
      if (fee != null) {
        const user = await tx.user.findUnique({ where: { id: sr.userId } });
        const wallet = user ? await tx.wallet.findUnique({ where: { id: user.walletId } }) : null;
        if (wallet) {
          const available = Number(wallet.balance) - Number(wallet.lockedAmount);
          if (available >= Number(fee)) {
            await tx.wallet.update({
              where: { id: wallet.id },
              data: { lockedAmount: { increment: fee } },
            });
            // Raw balance is untouched by a hold — only lockedAmount moves.
            // status PENDING here means "held, not yet captured", updated
            // to SUCCESS on /confirm (see below) rather than creating a
            // second transaction row for the same fee.
            await tx.walletTransaction.create({
              data: {
                walletId: wallet.id,
                type: 'PLATFORM_FEE',
                amount: fee,
                balanceBefore: wallet.balance,
                balanceAfter: wallet.balance,
                status: 'PENDING',
                serviceRequestId: sr.id,
              },
            });
            feeFields = { feeHeldAt: new Date(), feeStatus: 'HELD' };
          }
        }
      }

      return tx.serviceRequest.update({
        where: { id: sr.id },
        data: {
          status: 'ARTISAN_ARRIVED',
          arrivedAt: new Date(),
          ...feeFields,
          ...(sr.requestType === 'COMMUNITY'
            ? {
                accessCode: generateAccessCode(),
                accessCodeExpiresAt: new Date(Date.now() + expiryHours * 60 * 60 * 1000),
              }
            : {}),
        },
        include,
      });
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
  // The only path to the final COMPLETED status in this pass. Also where
  // the held fee gets CAPTURED — released from escrow and actually
  // deducted, in the same operation. The artisan gets no part of it
  // (explicit decision for this cycle) - there's no corresponding credit
  // anywhere in this handler.
  app.patch<{ Params: { id: string } }>('/:id/confirm', { preHandler: requireUser }, async (req, reply) => {
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));
    if (sr.userId !== req.authUser.id) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));
    if (sr.status !== 'ARTISAN_COMPLETED') {
      return reply.status(409).send(fail('INVALID_STATUS', `Cannot confirm from status ${sr.status}.`));
    }

    const fee = sr.platformFeeUser;

    const updated = await prisma.$transaction(async (tx) => {
      let feeFields: { feeDeductedAt?: Date; feeStatus?: 'DEDUCTED' | 'FAILED' } = {};

      if (fee != null) {
        // Resolved via the user row (wallet id lives there), not a direct
        // lookup by authUser.id (that's the User's own id, not the wallet's).
        const user = await tx.user.findUnique({ where: { id: sr.userId } });
        const realWallet = user ? await tx.wallet.findUnique({ where: { id: user.walletId } }) : null;

        if (realWallet && sr.feeStatus === 'HELD') {
          // Happy path — release the escrow and spend it in one step.
          await tx.wallet.update({
            where: { id: realWallet.id },
            data: {
              balance:      { decrement: fee },
              lockedAmount: { decrement: fee },
            },
          });
          const pendingTx = await tx.walletTransaction.findFirst({
            where: { serviceRequestId: sr.id, type: 'PLATFORM_FEE', status: 'PENDING' },
          });
          if (pendingTx) {
            await tx.walletTransaction.update({
              where: { id: pendingTx.id },
              data: {
                status: 'SUCCESS',
                balanceBefore: realWallet.balance,
                balanceAfter:  Number(realWallet.balance) - Number(fee),
              },
            });
          }
          feeFields = { feeDeductedAt: new Date(), feeStatus: 'DEDUCTED' };
        } else if (realWallet) {
          // No hold was ever placed (insufficient funds at arrival time) —
          // attempt a direct capture now instead of silently giving up.
          const available = Number(realWallet.balance) - Number(realWallet.lockedAmount);
          if (available >= Number(fee)) {
            const newBalance = Number(realWallet.balance) - Number(fee);
            await tx.wallet.update({ where: { id: realWallet.id }, data: { balance: newBalance } });
            await tx.walletTransaction.create({
              data: {
                walletId: realWallet.id,
                type: 'PLATFORM_FEE',
                amount: fee,
                balanceBefore: realWallet.balance,
                balanceAfter: newBalance,
                status: 'SUCCESS',
                serviceRequestId: sr.id,
              },
            });
            feeFields = { feeDeductedAt: new Date(), feeStatus: 'DEDUCTED' };
          } else {
            // Still insufficient — don't block the service completion
            // itself over a billing problem. Flagged as a known gap: no
            // collections/follow-up flow exists yet for a FAILED fee.
            feeFields = { feeStatus: 'FAILED' };
          }
        }
      }

      return tx.serviceRequest.update({
        where: { id: sr.id },
        data: { status: 'COMPLETED', completedAt: new Date(), ...feeFields },
        include,
      });
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
  //
  // Deliberately does NOT touch Wallet.lockedAmount or feeStatus at all,
  // even if a hold was already placed (sr.feeStatus === 'HELD' from
  // PATCH .../arrive) — the escrowed amount stays locked indefinitely.
  // Explicit decision: a cancellation after the artisan has arrived needs
  // a human admin to review why before funds are released, not an
  // automatic refund. No admin-facing release endpoint exists yet — flagged
  // for later (see CLAUDE.md). The query such an endpoint would need:
  // ServiceRequest where status IN (USER_CANCELLED, ARTISAN_CANCELLED) AND
  // feeStatus = HELD.
  app.patch<{ Params: { id: string } }>('/:id/cancel', { preHandler: requireRole('user', 'artisan') }, async (req, reply) => {
    const parsed = reasonSchema.safeParse(req.body);
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));

    const isUser    = req.authUser.role === 'user'    && sr.userId === req.authUser.id;
    const isArtisan = req.authUser.role === 'artisan' && sr.artisanId === req.authUser.id;
    if (!isUser && !isArtisan) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));

    if (['COMPLETED', 'USER_CANCELLED', 'ARTISAN_CANCELLED', 'ARTISAN_REJECTED', 'EXPIRED'].includes(sr.status)) {
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

  // ── PATCH /:id/expire — user: the artisan never responded within the
  // client-side 90s waiting window. Distinct from /cancel (USER_CANCELLED)
  // — only valid from PENDING, since once the artisan has acted (accepted/
  // rejected) a timeout is no longer the relevant outcome. Requests landing
  // here are excluded from GET /service-requests/mine, so the artisan never
  // sees them at all.
  app.patch<{ Params: { id: string } }>('/:id/expire', { preHandler: requireUser }, async (req, reply) => {
    const sr = await prisma.serviceRequest.findUnique({ where: { id: req.params.id } });
    if (!sr || sr.deletedAt) return reply.status(404).send(fail('NOT_FOUND', 'Request not found.'));
    if (sr.userId !== req.authUser.id) return reply.status(403).send(fail('FORBIDDEN', 'Not your request.'));
    if (sr.status !== 'PENDING') {
      return reply.status(409).send(fail('INVALID_STATUS', `Cannot expire a request in status ${sr.status}.`));
    }

    const updated = await prisma.serviceRequest.update({
      where: { id: sr.id },
      data: { status: 'EXPIRED' },
      include,
    });
    return reply.send(ok(serialize(updated)));
  });

};

export default serviceRequestsRoutes;
