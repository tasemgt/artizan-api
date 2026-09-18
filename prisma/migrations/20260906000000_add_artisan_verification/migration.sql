-- CreateEnum
CREATE TYPE "ArtisanVerificationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "categories"
  ADD COLUMN "icon" TEXT;

-- AlterTable
ALTER TABLE "artisans"
  ADD COLUMN "verificationStatus" "ArtisanVerificationStatus" NOT NULL DEFAULT 'PENDING';

-- CreateTable
CREATE TABLE "artisan_documents" (
    "id" TEXT NOT NULL,
    "artisanId" TEXT NOT NULL,
    "fileUrl" TEXT NOT NULL,
    "fileType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "artisan_documents_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "artisan_documents" ADD CONSTRAINT "artisan_documents_artisanId_fkey" FOREIGN KEY ("artisanId") REFERENCES "artisans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
