// prisma/seed.ts
// Seeds the `categories` table for the artisan trade picker (Your Trade step
// of signup) AND, as of 2026-11-20, the User side's real matching flow
// (MatchingAreaScreen moved off local DUMMY_CATEGORIES entirely - see
// CLAUDE.md). Names + icon keys + fee are copied from artizan-app's
// src/constants/categories.ts (DUMMY_CATEGORIES) so real DB rows match
// exactly what that local list already had. ids are still NOT the same
// between the two lists (DUMMY_CATEGORIES uses string slugs like
// 'cat_carpenters', these use real uuids) - DUMMY_CATEGORIES is dead weight
// now on the User side specifically, kept only because two already-orphaned
// screens still import it.
// Run with: npx tsx prisma/seed.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORIES: { name: string; icon: string; sortOrder: number; fee: number }[] = [
  { name: 'Tailors',              icon: 'tailor',          sortOrder: 0,  fee: 500 },
  { name: 'Carpenters',           icon: 'carpenter',       sortOrder: 1,  fee: 500 },
  { name: 'Mechanics',            icon: 'mechanic',        sortOrder: 2,  fee: 500 },
  { name: 'Cleaners',             icon: 'cleaner',         sortOrder: 3,  fee: 1000 },
  { name: 'Electricians',         icon: 'electrician',     sortOrder: 4,  fee: 500 },
  { name: 'Painters',             icon: 'painter',         sortOrder: 5,  fee: 500 },
  { name: 'Barbers',              icon: 'barber',          sortOrder: 6,  fee: 500 },
  { name: 'Makeup Artists',       icon: 'makeup',          sortOrder: 7,  fee: 1000 },
  { name: 'Plumbers',             icon: 'plumber',         sortOrder: 8,  fee: 500 },
  { name: 'Hairstylists',         icon: 'hairstylist',     sortOrder: 9,  fee: 500 },
  { name: 'Nail Technicians',     icon: 'nailtech',        sortOrder: 10, fee: 500 },
  { name: 'Masseuse',             icon: 'masseuse',        sortOrder: 11, fee: 500 },
  { name: 'Dry Cleaners',         icon: 'drycleaner',      sortOrder: 12, fee: 500 },
  { name: 'Caterers',             icon: 'caterer',         sortOrder: 13, fee: 1000 },
  { name: 'Engineer',             icon: 'engineer',        sortOrder: 14, fee: 1000 },
  { name: 'Interior Decorators',  icon: 'interior',        sortOrder: 15, fee: 700 },
  { name: 'Stylists',             icon: 'stylist',         sortOrder: 16, fee: 1000 },
  { name: 'Personal Shoppers',    icon: 'personalshopper', sortOrder: 17, fee: 500 },
  { name: 'Shoe Makers',          icon: 'shoemaker',       sortOrder: 18, fee: 500 },
  { name: 'Drivers',              icon: 'driver',          sortOrder: 19, fee: 500 },
  { name: 'Escorts',              icon: 'escort',          sortOrder: 20, fee: 1000 },
  { name: 'Technicians',          icon: 'technician',      sortOrder: 21, fee: 500 },
  { name: 'Photographers',        icon: 'photographer',    sortOrder: 22, fee: 700 },
  { name: 'Event Planners',       icon: 'eventplanner',    sortOrder: 23, fee: 1000 },
  { name: 'DSTV Technicians',     icon: 'dstv',            sortOrder: 24, fee: 500 },
  { name: 'Fashion Designers',    icon: 'fashiondesigner', sortOrder: 25, fee: 1000 },
  { name: 'Nannys',               icon: 'nanny',           sortOrder: 26, fee: 1000 },
  { name: 'Doctors',              icon: 'doctor',          sortOrder: 27, fee: 1000 },
  { name: 'Psychologists',        icon: 'psychologist',    sortOrder: 28, fee: 1000 },
  { name: 'Veterinarians',        icon: 'vet',             sortOrder: 29, fee: 500 },
  { name: 'Pharmacists',          icon: 'pharmacist',      sortOrder: 30, fee: 1000 },
];

async function main() {
  for (const cat of CATEGORIES) {
    const existing = await prisma.category.findFirst({ where: { name: cat.name } });
    if (existing) {
      await prisma.category.update({
        where: { id: existing.id },
        data: { icon: cat.icon, sortOrder: cat.sortOrder, platformFeeNgn: cat.fee },
      });
    } else {
      await prisma.category.create({
        data: { name: cat.name, icon: cat.icon, sortOrder: cat.sortOrder, platformFeeNgn: cat.fee },
      });
    }
  }
  console.log(`Seeded ${CATEGORIES.length} categories.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
