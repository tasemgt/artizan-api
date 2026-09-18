// src/routes/serviceRequests.ts
// Stub — not implemented yet. MatchingAreaScreen simulates the entire request
// lifecycle (create, accept, arrive, complete) client-side with timers.
// Phase 2+.

import { FastifyPluginAsync } from 'fastify';
import { ok } from '../utils/helpers';

const serviceRequestsRoutes: FastifyPluginAsync = async (app) => {

  app.get('/', async (_req, reply) => {
    return reply.send(ok([]));
  });

};

export default serviceRequestsRoutes;
