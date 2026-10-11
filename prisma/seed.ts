/**
 * Development seed data. Idempotent: safe to run again.
 *
 * Only users exist in the schema so far (GRD-9). Spaces arrive in M2 and
 * problems in M3; add their sample rows here in the same stories.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client';

const users = [
  { email: 'owner@verdale.local', username: 'owner', display_name: 'Space Owner' },
  { email: 'editor@verdale.local', username: 'editor', display_name: 'Problem Editor' },
  { email: 'solver@verdale.local', username: 'solver', display_name: 'Problem Solver' },
];

async function main() {
  const url = process.env.DIRECT_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Set DIRECT_DATABASE_URL (or DATABASE_URL) to seed');
  if (process.env.ENV === 'production') throw new Error('Refusing to seed production');

  const pool = new pg.Pool({ connectionString: url });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    for (const user of users) {
      await prisma.user.upsert({ where: { email: user.email }, update: {}, create: user });
    }
    process.stdout.write(`Seeded ${users.length} users\n`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
