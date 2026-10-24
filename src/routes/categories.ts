// src/routes/categories.ts
// Public categories endpoint — cached in Redis for 10 minutes.
// Used by RegisterScreen (artisan category picker) and HomeScreen (category grid).

import { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../server';
import { ok, fail } from '../utils/helpers';
import { requireAdmin } from '../middleware/auth';

const categorySchema = z.object({
  name:      z.string().min(1).max(60),
  icon:      z.string().max(60).nullable().optional(),
  imageUrl:  z.string().url().nullable().optional(),
  sortOrder: z.number().int().optional(),
});

const updateCategorySchema = categorySchema.partial().extend({
  isActive: z.boolean().optional(),
});

const categoriesRoutes: FastifyPluginAsync = async (app) => {

  // ── GET / — active categories (public), or all with ?includeInactive=true
  // (admin category-management screen needs to see + re-enable disabled
  // ones, which the mobile app's public list should never show).
  app.get('/', async (req, reply) => {
    const includeInactive = (req.query as { includeInactive?: string }).includeInactive === 'true';
    try {
      const categories = await prisma.category.findMany({
        where:   includeInactive ? {} : { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select:  { id: true, name: true, imageUrl: true, icon: true, sortOrder: true, isActive: true },
      });
      return reply.send(ok(categories));
    } catch {
      return reply.status(500).send(fail('SERVER_ERROR', 'Failed to load categories.'));
    }
  });

  // ── GET /:id ──────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const category = await prisma.category.findUnique({
      where: { id: req.params.id },
    });
    if (!category) return reply.status(404).send(fail('NOT_FOUND', 'Category not found.'));
    return reply.send(ok(category));
  });

  // ── POST / — admin: create a category ──────────────────────────────
  app.post('/', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = categorySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors));
    }
    const category = await prisma.category.create({ data: parsed.data });
    return reply.status(201).send(ok(category));
  });

  // ── PATCH /:id — admin: update a category (incl. isActive toggle) ──
  app.patch<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const parsed = updateCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send(fail('VALIDATION_ERROR', 'Invalid input.', parsed.error.flatten().fieldErrors));
    }
    const existing = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send(fail('NOT_FOUND', 'Category not found.'));

    const category = await prisma.category.update({ where: { id: req.params.id }, data: parsed.data });
    return reply.send(ok(category));
  });

  // ── DELETE /:id — admin: soft-delete (isActive=false), never a hard
  // delete - artisans may already reference this categoryId via FK, and
  // this is exactly the same pattern the public GET's isActive filter
  // already expects.
  app.delete<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const existing = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!existing) return reply.status(404).send(fail('NOT_FOUND', 'Category not found.'));

    await prisma.category.update({ where: { id: req.params.id }, data: { isActive: false } });
    return reply.send(ok({ message: 'Category deactivated.' }));
  });

};

export default categoriesRoutes;
