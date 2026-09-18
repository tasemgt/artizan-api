-- AlterTable
ALTER TABLE "users"
  ADD COLUMN "passwordChangedAt" TIMESTAMP(3),
  ADD COLUMN "address" TEXT,
  ADD COLUMN "gender" TEXT,
  ADD COLUMN "dateOfBirth" TIMESTAMP(3);
