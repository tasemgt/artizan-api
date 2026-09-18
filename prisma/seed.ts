// prisma/seed.ts
// Seeds the `categories` table for the artisan trade picker (Your Trade step
// of signup). Names + icon keys are copied from artizan-app's
// src/constants/categories.ts (DUMMY_CATEGORIES) so real DB rows render with
// the same icons the User side's local dummy list already uses — the two
// lists are NOT otherwise linked (different ids), that reconciliation is
// future work once the User side's matching flow moves off local dummy data.
// Run with: npx tsx prisma/seed.ts

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CATEGORIES: { name: string; icon: string; sortOrder: number }[] = [
  { name: 'Tailors',              icon: 'tailor',          sortOrder: 0 },
  { name: 'Carpenters',           icon: 'carpenter',       sortOrder: 1 },
  { name: 'Mechanics',            icon: 'mechanic',        sortOrder: 2 },
  { name: 'Cleaners',             icon: 'cleaner',         sortOrder: 3 },
  { name: 'Electricians',         icon: 'electrician',     sortOrder: 4 },
  { name: 'Painters',             icon: 'painter',         sortOrder: 5 },
  { name: 'Barbers',              icon: 'barber',          sortOrder: 6 },
  { name: 'Makeup Artists',       icon: 'makeup',          sortOrder: 7 },
  { name: 'Plumbers',             icon: 'plumber',         sortOrder: 8 },
  { name: 'Hairstylists',         icon: 'hairstylist',     sortOrder: 9 },
  { name: 'Nail Technicians',     icon: 'nailtech',        sortOrder: 10 },
  { name: 'Masseuse',             icon: 'masseuse',        sortOrder: 11 },
  { name: 'Dry Cleaners',         icon: 'drycleaner',      sortOrder: 12 },
  { name: 'Caterers',             icon: 'caterer',         sortOrder: 13 },
  { name: 'Engineer',             icon: 'engineer',        sortOrder: 14 },
  { name: 'Interior Decorators',  icon: 'interior',        sortOrder: 15 },
  { name: 'Stylists',             icon: 'stylist',         sortOrder: 16 },
  { name: 'Personal Shoppers',    icon: 'personalshopper', sortOrder: 17 },
  { name: 'Shoe Makers',          icon: 'shoemaker',       sortOrder: 18 },
  { name: 'Drivers',              icon: 'driver',          sortOrder: 19 },
  { name: 'Escorts',              icon: 'escort',          sortOrder: 20 },
  { name: 'Technicians',          icon: 'technician',      sortOrder: 21 },
  { name: 'Photographers',        icon: 'photographer',    sortOrder: 22 },
  { name: 'Event Planners',       icon: 'eventplanner',    sortOrder: 23 },
  { name: 'DSTV Technicians',     icon: 'dstv',            sortOrder: 24 },
  { name: 'Fashion Designers',    icon: 'fashiondesigner', sortOrder: 25 },
  { name: 'Nannys',               icon: 'nanny',           sortOrder: 26 },
  { name: 'Doctors',              icon: 'doctor',          sortOrder: 27 },
  { name: 'Psychologists',        icon: 'psychologist',    sortOrder: 28 },
  { name: 'Veterinarians',        icon: 'vet',             sortOrder: 29 },
  { name: 'Pharmacists',          icon: 'pharmacist',      sortOrder: 30 },
];

async function main() {
  for (const cat of CATEGORIES) {
    const existing = await prisma.category.findFirst({ where: { name: cat.name } });
    if (existing) {
      await prisma.category.update({
        where: { id: existing.id },
        data: { icon: cat.icon, sortOrder: cat.sortOrder },
      });
    } else {
      await prisma.category.create({ data: cat });
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
