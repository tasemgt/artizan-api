-- Human-readable address for where the user is requesting FROM (community
-- name, or a reverse-geocoded address) — distinct from User.address (the
-- user's registered address), which was being shown to the artisan
-- incorrectly even though it may be nowhere near the actual request.
ALTER TABLE "service_requests" ADD COLUMN "requestAddress" TEXT;
