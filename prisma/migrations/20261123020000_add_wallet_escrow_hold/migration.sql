-- Escrow/hold-then-capture wallet fee model: the fee is locked on
-- PATCH /service-requests/:id/arrive (not deducted yet), then released and
-- actually deducted together on /confirm. A cancelled request that already
-- had a hold placed stays locked indefinitely pending manual admin review —
-- no automated release path exists yet (explicit decision, flagged for
-- later). The artisan receives no part of this fee for now either.
ALTER TABLE "wallets" ADD COLUMN "lockedAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
ALTER TABLE "service_requests" ADD COLUMN "feeHeldAt" TIMESTAMP(3);
ALTER TYPE "FeeStatus" ADD VALUE 'HELD';
