// prisma/seedAdmin.ts
// Creates the first AdminUser row - there's no public registration endpoint
// for admins by design (see auth.admin.ts), so this is the only way to get
// a super admin account to log into artizan-admin with at all. Idempotent:
// safe to re-run, skips if the email already exists rather than erroring.
// Run with: npx tsx prisma/seedAdmin.ts
//
// Reads credentials from ADMIN_SEED_EMAIL/ADMIN_SEED_PASSWORD so the real
// password never has to be written into this file or committed - falls back
// to a known default only so this is still runnable without extra setup in
// a throwaway/local dev DB.

import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

const email    = process.env.ADMIN_SEED_EMAIL    ?? 'admin@artizan.app';
const password = process.env.ADMIN_SEED_PASSWORD ?? 'ChangeMe123!';
const name     = process.env.ADMIN_SEED_NAME     ?? 'Super Admin';

async function main() {
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    console.log(`AdminUser ${email} already exists - nothing to do.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.adminUser.create({
    data: { email, passwordHash, name, role: 'SUPER_ADMIN' },
  });

  console.log(`Created AdminUser ${email}.`);
  if (!process.env.ADMIN_SEED_PASSWORD) {
    console.log(`Using the default password - set ADMIN_SEED_PASSWORD and re-run against a fresh DB to pick your own, or change it after first login once that screen exists.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
