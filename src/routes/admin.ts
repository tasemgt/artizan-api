// src/routes/admin.ts
// Stub. No admin auth or logic implemented in Fastify yet. The deprecated
// Express backend had a working admin login (see
// _deprecated/artizan-api-express/src/routes/auth.admin.routes.js) that was
// never ported — worth revisiting rather than rebuilding from scratch.
// Phase 2+.

import { FastifyPluginAsync } from 'fastify';
import { ok } from '../utils/helpers';

const adminRoutes: FastifyPluginAsync = async (app) => {

  app.get('/', async (_req, reply) => {
    return reply.send(ok(null));
  });

};

export default adminRoutes;
