// src/middleware/auth.ts
// Fastify preHandler hooks for JWT verification and role-based access control.

import { FastifyRequest, FastifyReply } from 'fastify';

// Extend FastifyRequest to include the decoded JWT payload
declare module 'fastify' {
  interface FastifyRequest {
    authUser: {
      id:   string;
      role: 'user' | 'artisan' | 'admin' | 'community_admin' | 'community_security';
    };
  }
}

// ── Verify JWT ────────────────────────────────────────────────────────
export async function verifyJwt(request: FastifyRequest, reply: FastifyReply) {
  try {
    await request.jwtVerify();
    request.authUser = (request.user as any);
  } catch {
    reply.status(401).send({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired token.' },
    });
  }
}

// ── Role guards (factory) ─────────────────────────────────────────────
export const requireRole = (...roles: string[]) =>
  async (request: FastifyRequest, reply: FastifyReply) => {
    await verifyJwt(request, reply);
    if (!roles.includes(request.authUser?.role)) {
      reply.status(403).send({
        success: false,
        error: { code: 'FORBIDDEN', message: 'You do not have access to this resource.' },
      });
    }
  };

export const requireUser    = requireRole('user');
export const requireArtisan = requireRole('artisan');
export const requireAdmin   = requireRole('admin');
export const requireCommunityStaff = requireRole('community_admin', 'community_security');
export const requireCommunityAdmin = requireRole('community_admin');
