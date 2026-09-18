// src/routes/wallets.ts
// GET /me, GET /me/transactions, and the Flutterwave funding flow are all
// real as of 2026-09-06. Test vs live is just whichever FLUTTERWAVE_SECRET_KEY
// is in .env — no code branching. /fund/callback and /fund/webhook are
// intentionally unauthenticated (Flutterwave calls them, not the mobile app)
// — they identify the transaction via tx_ref instead of a JWT.
//
// Role-aware as of 2026-09-06 (was requireUser + prisma.user.findUnique only
// — an artisan calling any of these would 403 before even reaching the
// query, same bug class already found and fixed in notifications.ts).

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../server';
import { ok, fail, parsePagination, paginationMeta } from '../utils/helpers';
import { requireRole } from '../middleware/auth';
import { initiatePayment, verifyTransaction } from '../services/flutterwave';

const requireUserOrArtisan = requireRole('user', 'artisan');

const initiateFundSchema = z.object({
  amount: z.number().positive().max(1_000_000),
});

// Both User and Artisan have the same shape for what's needed here
// (id, email, firstName, lastName, walletId) — one lookup, either table.
async function findOwner(role: string, id: string) {
  return role === 'artisan'
    ? prisma.artisan.findUnique({ where: { id } })
    : prisma.user.findUnique({ where: { id } });
}

// Shared by the redirect callback AND the webhook — always re-verifies
// against Flutterwave directly (never trusts query params/webhook payload at
// face value), and is idempotent so being hit twice for the same tx_ref
// (e.g. both callback and webhook firing) never double-credits.
async function creditWalletIfPending(
  txRef: string,
  transactionId: string,
): Promise<'credited' | 'already_processed' | 'not_found' | 'failed'> {
  const walletTx = await prisma.walletTransaction.findFirst({ where: { referenceId: txRef } });
  if (!walletTx) return 'not_found';
  if (walletTx.status !== 'PENDING') return 'already_processed';

  let verified;
  try {
    verified = await verifyTransaction(transactionId);
  } catch {
    return 'failed';
  }

  const amountOk = Number(verified.amount) >= Number(walletTx.amount);
  if (verified.txRef !== txRef || verified.status !== 'successful' || verified.currency !== 'NGN' || !amountOk) {
    await prisma.walletTransaction.update({ where: { id: walletTx.id }, data: { status: 'FAILED' } });
    return 'failed';
  }

  const wallet = await prisma.wallet.findUnique({ where: { id: walletTx.walletId } });
  if (!wallet) return 'failed';

  const newBalance = Number(wallet.balance) + Number(walletTx.amount);
  await prisma.$transaction([
    prisma.wallet.update({ where: { id: wallet.id }, data: { balance: newBalance } }),
    prisma.walletTransaction.update({
      where: { id: walletTx.id },
      data: { status: 'SUCCESS', balanceBefore: wallet.balance, balanceAfter: newBalance },
    }),
  ]);
  return 'credited';
}

const walletsRoutes: FastifyPluginAsync = async (app) => {

  // ── GET /me — the authenticated user's/artisan's own wallet ─────────
  app.get('/me', { preHandler: requireUserOrArtisan }, async (req, reply) => {
    const wallet = await (async () => {
      const owner = await findOwner(req.authUser.role, req.authUser.id);
      if (!owner) return null;
      return prisma.wallet.findUnique({ where: { id: owner.walletId } });
    })();
    if (!wallet) return reply.status(404).send(fail('NOT_FOUND', 'Wallet not found.'));

    const { id, ownerId, ownerType, balance, xpPoints, currency, isLocked } = wallet;
    return reply.send(ok({
      id, ownerId, ownerType, currency, isLocked,
      balance:  Number(balance),
      xpPoints,
    }));
  });

  // ── GET /me/transactions — paginated ledger for the authenticated user/artisan ──
  app.get<{ Querystring: { page?: string; limit?: string } }>(
    '/me/transactions',
    { preHandler: requireUserOrArtisan },
    async (req, reply) => {
      const owner = await findOwner(req.authUser.role, req.authUser.id);
      if (!owner?.walletId) return reply.status(404).send(fail('NOT_FOUND', 'Wallet not found.'));

      const { page, limit, skip } = parsePagination(req.query);
      const [rows, total] = await Promise.all([
        prisma.walletTransaction.findMany({
          where:   { walletId: owner.walletId },
          orderBy: { createdAt: 'desc' },
          skip, take: limit,
        }),
        prisma.walletTransaction.count({ where: { walletId: owner.walletId } }),
      ]);

      const data = rows.map((t) => ({
        id:               t.id,
        walletId:         t.walletId,
        type:             t.type,
        amount:           Number(t.amount),
        xpAmount:         t.xpAmount,
        balanceBefore:    Number(t.balanceBefore),
        balanceAfter:     Number(t.balanceAfter),
        referenceId:      t.referenceId,
        serviceRequestId: t.serviceRequestId,
        status:           t.status,
        createdAt:        t.createdAt.toISOString(),
      }));

      return reply.send(ok(data, { pagination: paginationMeta(total, page, limit) }));
    },
  );

  // ── POST /fund/initiate — creates a Flutterwave hosted checkout link ──
  app.post('/fund/initiate', { preHandler: requireUserOrArtisan }, async (req, reply) => {
    const parsed = initiateFundSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Enter a valid amount.'));
    }
    const { amount } = parsed.data;

    const owner = await findOwner(req.authUser.role, req.authUser.id);
    if (!owner) return reply.status(404).send(fail('NOT_FOUND', 'Account not found.'));

    const wallet = await prisma.wallet.findUnique({ where: { id: owner.walletId } });
    if (!wallet) return reply.status(404).send(fail('NOT_FOUND', 'Wallet not found.'));

    const txRef = `artizan-fund-${wallet.id}-${Date.now()}`;
    await prisma.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'FUND',
        amount,
        balanceBefore: wallet.balance,
        balanceAfter: wallet.balance, // unchanged until the callback/webhook confirms
        referenceId: txRef,
        status: 'PENDING',
      },
    });

    // Reuses whatever host the phone used to reach this API (LAN IP in dev,
    // real domain once deployed) — this is a BROWSER redirect, not a
    // server-to-server call, so it works fine even on a local LAN address.
    const redirectUrl = `${req.protocol}://${req.headers.host}/api/v1/wallets/fund/callback`;

    let paymentLink: string;
    try {
      paymentLink = await initiatePayment({
        txRef,
        amount,
        redirectUrl,
        customerEmail: owner.email,
        customerName: `${owner.firstName} ${owner.lastName}`,
      });
    } catch (err) {
      req.log.error(err);
      await prisma.walletTransaction.updateMany({
        where: { referenceId: txRef },
        data: { status: 'FAILED' },
      });
      return reply.status(502).send(fail('PAYMENT_INIT_FAILED', 'Could not start payment. Please try again.'));
    }

    return reply.send(ok({ paymentLink, reference: txRef }));
  });

  // ── GET /fund/callback — Flutterwave redirects the user's BROWSER here ──
  // after payment. No auth — identifies the transaction via tx_ref. Renders
  // a plain HTML page since this loads directly in the browser, not consumed
  // by mobile JS.
  app.get<{ Querystring: { status?: string; tx_ref?: string; transaction_id?: string } }>(
    '/fund/callback',
    async (req, reply) => {
      const { status, tx_ref, transaction_id } = req.query;
      let success = false;
      let message = 'Payment was not completed.';

      if (status === 'successful' && tx_ref && transaction_id) {
        const result = await creditWalletIfPending(tx_ref, transaction_id);
        success = result === 'credited' || result === 'already_processed';
        message = success
          ? 'Payment successful! Your wallet has been credited.'
          : 'We could not confirm your payment.';
      }

      return reply.type('text/html').send(`<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Artizan</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;text-align:center;padding:60px 24px;background:#F5F5F5;color:#3A3A3A;}
h1{color:${success ? '#2E7D32' : '#C62828'};}</style></head>
<body><h1>${success ? 'Success!' : 'Payment Failed'}</h1><p>${message}</p>
<p>You can close this window and return to the Artizan app.</p></body></html>`);
    },
  );

  // ── POST /fund/webhook — Flutterwave server-to-server notification ──
  // No auth (verified via the verif-hash signature instead). NOTE: this can't
  // be tested against a local dev server — Flutterwave's servers can't reach
  // a LAN address, only a publicly deployed one. The callback above is what
  // actually confirms payment during local development.
  app.post('/fund/webhook', async (req, reply) => {
    const signature = req.headers['verif-hash'];
    if (!signature || signature !== process.env.FLUTTERWAVE_WEBHOOK_SECRET) {
      return reply.status(401).send();
    }
    const body = req.body as any;
    const txRef = body?.data?.tx_ref;
    const transactionId = body?.data?.id;
    if (txRef && transactionId) {
      await creditWalletIfPending(txRef, String(transactionId));
    }
    return reply.status(200).send(ok(null));
  });

};

export default walletsRoutes;
