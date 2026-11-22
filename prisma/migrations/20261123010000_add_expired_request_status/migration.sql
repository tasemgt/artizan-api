-- EXPIRED: the artisan never responded within the client-side 90s window,
-- distinct from USER_CANCELLED (an explicit user cancel). Requests in this
-- status are deliberately excluded from GET /service-requests/mine.
ALTER TYPE "RequestStatus" ADD VALUE 'EXPIRED';
