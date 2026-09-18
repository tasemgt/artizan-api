// src/routes/communities.ts
// Stub — not implemented yet. Mobile uses DUMMY_COMMUNITIES locally instead.
// Phase 2+.

import { FastifyPluginAsync } from 'fastify';
import { ok } from '../utils/helpers';

const communitiesRoutes: FastifyPluginAsync = async (app) => {

  app.get('/', async (_req, reply) => {
    return reply.send(ok([]));
  });

};

export default communitiesRoutes;
