/**
 * Gives and takes away the platform administrator role (GRD-58). There is no API for it on
 * purpose: nobody can become an administrator through a request, only a person who can run
 * this on the Core machine (or against its database).
 *
 *   npm run platform:grant -- <username>
 *   npm run platform:revoke -- <username>
 *   npm run platform:list
 *
 * In a deployed container: node build/src/cli/platform-admin.js grant <username>
 */
import 'dotenv/config';
import { loadConfig } from '@/config';
import { createDatabase } from '@/libs/prisma';
import PlatformRepository from '@/repositories/platform.repository';
import PlatformAdminService from '@/services/platform/platform-admin.service';
import { NotFoundError } from '@/errors';
import type { PrismaClient } from '../../generated/prisma/client';

const USAGE = 'usage: platform-admin grant <username> | revoke <username> | list';

/** Runs one command; returns the lines to print. Throws on a mistake the operator should see. */
export async function runPlatformAdminCli(argv: string[], prisma: PrismaClient): Promise<string[]> {
  const [command, username] = argv;
  const service = new PlatformAdminService(prisma, new PlatformRepository());
  switch (command) {
    case 'grant':
    case 'revoke': {
      if (!username) throw new Error(USAGE);
      try {
        const result = await service.setPlatformRole(
          username,
          command === 'grant' ? 'admin' : 'user'
        );
        if (!result.changed) {
          return [`${result.username} already has the role "${result.role}"; nothing changed.`];
        }
        return [
          command === 'grant'
            ? `${result.username} is now a platform administrator.`
            : `${result.username} is no longer a platform administrator.`,
        ];
      } catch (error) {
        if (error instanceof NotFoundError) throw new Error(`No user named "${username}".`);
        throw error;
      }
    }
    case 'list': {
      const admins = await prisma.user.findMany({
        where: { platform_role: 'admin' },
        orderBy: { username: 'asc' },
        select: { username: true, email: true, suspended_at: true },
      });
      if (admins.length === 0) return ['There are no platform administrators.'];
      return admins.map(
        (admin) => `${admin.username} <${admin.email}>${admin.suspended_at ? ' (suspended)' : ''}`
      );
    }
    default:
      throw new Error(USAGE);
  }
}

async function main() {
  const config = loadConfig(process.env);
  const database = createDatabase(config);
  try {
    for (const line of await runPlatformAdminCli(process.argv.slice(2), database.prisma)) {
      process.stdout.write(`${line}\n`);
    }
  } finally {
    await database.close();
  }
}

if (require.main === module) {
  main().catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  });
}
