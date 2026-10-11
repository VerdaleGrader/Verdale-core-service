import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma CLI (migrate, studio) uses the DIRECT connection: Neon's pooled
// endpoint (PgBouncer, transaction mode) cannot run migrations. The running
// service uses the pooled DATABASE_URL instead (src/libs/prisma.ts).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node --require tsconfig-paths/register prisma/seed.ts',
  },
  datasource: {
    url: process.env['DIRECT_DATABASE_URL'] ?? '',
  },
});
