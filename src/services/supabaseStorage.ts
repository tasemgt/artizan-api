// src/services/supabaseStorage.ts
// Profile image storage — Supabase Storage (same project as the Postgres DB,
// no new vendor to manage). Uses the SERVICE ROLE key, so this client must
// only ever be used server-side — never send this key to the mobile app.

import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const BUCKET = 'profile-images';
const DOCUMENTS_BUCKET = 'verification-documents';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null;

// Idempotent — safe to call on every startup. Creates the bucket as public
// (profile photos are meant to be publicly viewable, like any avatar) if it
// doesn't already exist.
export async function ensureProfileImageBucket(): Promise<void> {
  if (!supabase) return;
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    console.error('[supabaseStorage] Could not list buckets:', listError.message);
    return;
  }
  if (buckets?.some((b) => b.name === BUCKET)) return;

  const { error: createError } = await supabase.storage.createBucket(BUCKET, {
    public: true,
    fileSizeLimit: '5MB',
    allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp'],
  });
  if (createError) {
    console.error('[supabaseStorage] Could not create bucket:', createError.message);
  }
}

interface UploadProfileImageInput {
  buffer: Buffer;
  contentType: string;
  ownerType: 'user' | 'artisan';
  ownerId: string;
}

// Uploads and returns the public URL. Throws on failure — callers should
// catch and respond with a normal error, this isn't meant to fail silently.
export async function uploadProfileImage({
  buffer, contentType, ownerType, ownerId,
}: UploadProfileImageInput): Promise<string> {
  if (!supabase) {
    throw new Error('Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
  }
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  const path = `${ownerType}/${ownerId}/${Date.now()}.${extension}`;

  const { error } = await supabase.storage.from(BUCKET).upload(path, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(path);
  return data.publicUrl;
}

// Idempotent — safe to call on every startup. Unlike profile-images, this
// bucket is PRIVATE — artisan verification documents (IDs, certifications)
// are not meant to be publicly readable. The future admin dashboard will
// generate short-lived signed URLs to review them instead.
export async function ensureVerificationDocumentsBucket(): Promise<void> {
  if (!supabase) return;
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  if (listError) {
    console.error('[supabaseStorage] Could not list buckets:', listError.message);
    return;
  }
  if (buckets?.some((b) => b.name === DOCUMENTS_BUCKET)) return;

  const { error: createError } = await supabase.storage.createBucket(DOCUMENTS_BUCKET, {
    public: false,
    fileSizeLimit: '500KB',
    allowedMimeTypes: ['image/jpeg', 'application/pdf'],
  });
  if (createError) {
    console.error('[supabaseStorage] Could not create documents bucket:', createError.message);
  }
}

interface UploadVerificationDocumentInput {
  buffer: Buffer;
  contentType: 'image/jpeg' | 'application/pdf';
  artisanId: string;
}

// Uploads and returns the storage PATH (not a public URL — bucket is
// private). Throws on failure — callers should catch and respond normally.
export async function uploadVerificationDocument({
  buffer, contentType, artisanId,
}: UploadVerificationDocumentInput): Promise<string> {
  if (!supabase) {
    throw new Error('Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing).');
  }
  const extension = contentType === 'application/pdf' ? 'pdf' : 'jpg';
  const path = `${artisanId}/${Date.now()}-${crypto.randomUUID()}.${extension}`;

  const { error } = await supabase.storage.from(DOCUMENTS_BUCKET).upload(path, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw new Error(`Upload failed: ${error.message}`);

  return path;
}
