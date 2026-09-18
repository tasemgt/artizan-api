-- Fix: recipientId had two enforced foreign keys at once (to both users and
-- artisans), which no single UUID can ever satisfy — this made it impossible
-- to insert ANY Notification row for either recipient type. recipientId is a
-- polymorphic association (disambiguated by recipientType) and should not
-- carry a real FK constraint at all; validated at the application layer.
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notif_user_fk";
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notif_artisan_fk";
