/**
 * Development seed data. Idempotent: safe to run again.
 *
 * Users with their personal Spaces, plus one public Space where the sample
 * users are owner / editor / solver. Problems arrive in M3; add their sample
 * rows here in the same stories. Seed users cannot log in (login is OAuth
 * only); they exist to have data to look at.
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
    await prisma.$transaction(async (tx) => {
      const saved = new Map<string, string>();
      for (const user of users) {
        const row = await tx.user.upsert({
          where: { email: user.email },
          update: {},
          create: user,
        });
        saved.set(user.username, row.id);
        // Everyone has a personal Space they own (the signup transaction does this in Core).
        const personal = await tx.space.upsert({
          where: { slug: user.username },
          update: {},
          create: {
            created_by_id: row.id,
            name: user.username,
            slug: user.username,
            visibility: 'private',
            is_personal: true,
          },
        });
        await tx.membership.upsert({
          where: { space_id_user_id: { space_id: personal.id, user_id: row.id } },
          update: {},
          create: { space_id: personal.id, user_id: row.id, role: 'owner' },
        });
      }

      const shared = await tx.space.upsert({
        where: { slug: 'sample-space' },
        update: {},
        create: {
          created_by_id: saved.get('owner')!,
          name: 'Sample Space',
          slug: 'sample-space',
          description: 'A public Space with one member of each role.',
          visibility: 'public',
        },
      });
      for (const [username, role] of [
        ['owner', 'owner'],
        ['editor', 'editor'],
        ['solver', 'solver'],
      ] as const) {
        await tx.membership.upsert({
          where: { space_id_user_id: { space_id: shared.id, user_id: saved.get(username)! } },
          update: {},
          create: { space_id: shared.id, user_id: saved.get(username)!, role },
        });
      }
    });
    process.stdout.write(
      `Seeded ${users.length} users, their personal Spaces and a sample Space\n`
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error}\n`);
  process.exit(1);
});
