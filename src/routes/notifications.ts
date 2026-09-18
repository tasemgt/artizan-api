// src/routes/notifications.ts
// GET /, GET /unread-count, PATCH /:id/read, PATCH /read-all are real.
// Adapted from the deprecated Express controller
// (_deprecated/artizan-api-express/src/controllers/notification.controller.js),
// but that one used a boolean `read` field that doesn't exist on the current
// Notification model — this uses the real `readAt` (null = unread) instead.
//
// Role-aware as of 2026-09-06 (was requireUser + recipientType:'USER' only —
// an artisan calling any of these would 403 before even reaching the
// recipientType filter, since requireUser rejects any non-'user' role).
// recipientType is derived from the caller's own JWT role, never a param —
// an artisan can only ever read/mark their OWN (ARTISAN-typed) notifications.

import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../server';
import { ok, parsePagination, paginationMeta } from '../utils/helpers';
import { requireRole } from '../middleware/auth';

const requireUserOrArtisan = requireRole('user', 'artisan');

const notificationsRoutes: FastifyPluginAsync = async (app) => {

  // ── GET / — the authenticated user's own notifications, paginated ──
  app.get<{ Querystring: { page?: string; limit?: string } }>(
    '/',
    { preHandler: requireUserOrArtisan },
    async (req, reply) => {
      const { page, limit, skip } = parsePagination(req.query);
      const where = { recipientId: req.authUser.id, recipientType: req.authUser.role.toUpperCase() };

      const [rows, total] = await Promise.all([
        prisma.notification.findMany({
          where, orderBy: { createdAt: 'desc' }, skip, take: limit,
        }),
        prisma.notification.count({ where }),
      ]);

      return reply.send(ok(rows, { pagination: paginationMeta(total, page, limit) }));
    },
  );

  // ── GET /unread-count — for the bell dot on Home ────────────────────
  app.get('/unread-count', { preHandler: requireUserOrArtisan }, async (req, reply) => {
    const count = await prisma.notification.count({
      where: { recipientId: req.authUser.id, recipientType: req.authUser.role.toUpperCase(), readAt: null },
    });
    return reply.send(ok({ count }));
  });

  // ── PATCH /:id/read ──────────────────────────────────────────────────
  app.patch<{ Params: { id: string } }>(
    '/:id/read',
    { preHandler: requireUserOrArtisan },
    async (req, reply) => {
      await prisma.notification.updateMany({
        where: { id: req.params.id, recipientId: req.authUser.id },
        data: { readAt: new Date() },
      });
      return reply.send(ok(null));
    },
  );

  // ── PATCH /read-all ───────────────────────────────────────────────────
  app.patch('/read-all', { preHandler: requireUserOrArtisan }, async (req, reply) => {
    await prisma.notification.updateMany({
      where: { recipientId: req.authUser.id, recipientType: req.authUser.role.toUpperCase(), readAt: null },
      data: { readAt: new Date() },
    });
    return reply.send(ok(null));
  });

};

export default notificationsRoutes;
