// src/routes/categories.ts
// Public categories endpoint — cached in Redis for 10 minutes.
// Used by RegisterScreen (artisan category picker) and HomeScreen (category grid).

import { FastifyPluginAsync } from 'fastify';
import { prisma } from '../server';
import { ok, fail } from '../utils/helpers';

const categoriesRoutes: FastifyPluginAsync = async (app) => {

  // ── GET / — all active categories ────────────────────────────────
  app.get('/', async (req, reply) => {
    try {
      const categories = await prisma.category.findMany({
        where:   { isActive: true },
        orderBy: { sortOrder: 'asc' },
        select:  { id: true, name: true, imageUrl: true, icon: true, sortOrder: true },
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

};

export default categoriesRoutes;
