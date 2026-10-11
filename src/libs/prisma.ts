import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../../generated/prisma/client';
import type { Configurations } from '@/config';

/**
 * Database access for the running service, over the POOLED connection
 * string. Neon's pooler (PgBouncer in transaction mode) multiplexes many
 * client connections onto few Postgres connections, so keep poolMax small.
 * Migrations use DIRECT_DATABASE_URL instead (prisma.config.ts).
 */
export function createDatabase(config: Configurations) {
  const pool = new pg.Pool({ connectionString: config.database.url, max: config.database.poolMax });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  return {
    prisma,
    async isReachable(): Promise<boolean> {
      try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

export type Database = ReturnType<typeof createDatabase>;
