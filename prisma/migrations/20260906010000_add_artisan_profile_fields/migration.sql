-- AlterTable
ALTER TABLE "artisans"
  ADD COLUMN "portfolioLink" TEXT,
  ADD COLUMN "gender" TEXT,
  ADD COLUMN "dateOfBirth" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "artisan_documents"
  ADD COLUMN "fileName" TEXT;
