// src/utils/helpers.ts
import bcrypt from 'bcrypt';
import crypto from 'crypto';

// ── Password ──────────────────────────────────────────────────────────
export const hashPassword = (plain: string) => bcrypt.hash(plain, 12);
export const verifyPassword = (plain: string, hash: string) => bcrypt.compare(plain, hash);

// ── Access codes ──────────────────────────────────────────────────────
// Generates a 6-character alphanumeric code — uppercase only, no ambiguous chars (0/O, 1/I/L)
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateAccessCode(): string {
  let code = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return code;
}

// ── Haversine distance (km) ───────────────────────────────────────────
// Used for "nearby artisans" query and far-artisan warning.
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R  = 6371;
  const dL = ((lat2 - lat1) * Math.PI) / 180;
  const dG = ((lng2 - lng1) * Math.PI) / 180;
  const a  =
    Math.sin(dL / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dG / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Slug generation ───────────────────────────────────────────────────
export function toSlug(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
}

// ── Pagination helpers ────────────────────────────────────────────────
export function parsePagination(query: any) {
  const page  = Math.max(1, parseInt(query.page  ?? '1',  10));
  const limit = Math.min(50, parseInt(query.limit ?? '20', 10));
  return { page, limit, skip: (page - 1) * limit };
}

export function paginationMeta(total: number, page: number, limit: number) {
  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
  };
}

// ── Standard response helpers ─────────────────────────────────────────
export const ok   = (data: any, meta?: any) => ({ success: true,  data, ...(meta ? { meta } : {}) });
export const fail = (code: string, message: string, details?: any) =>
  ({ success: false, error: { code, message, ...(details ? { details } : {}) } });
