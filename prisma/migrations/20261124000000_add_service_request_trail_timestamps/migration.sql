-- Real Service Trail timestamps, set on the real PATCH /:id/accept and
-- /:id/arrive transitions — previously only tracked client-side (on both
-- mobile apps, never persisted), so the "Service Trail" in history was
-- reconstructed from whatever the device happened to have in memory, not
-- a real fact backed by the database.
ALTER TABLE "service_requests" ADD COLUMN "acceptedAt" TIMESTAMP(3);
ALTER TABLE "service_requests" ADD COLUMN "arrivedAt" TIMESTAMP(3);
