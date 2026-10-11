import { Prisma, PrismaClient } from '../../generated/prisma/client';

/** A plain client or the client inside `$transaction`. Repositories take either. */
export type Db = Prisma.TransactionClient | PrismaClient;

export { Prisma };

/** True for a Prisma unique-constraint violation, optionally on one column. */
export function isUniqueViolation(error: unknown, column?: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  if (!column) return true;
  const target = error.meta?.target;
  return Array.isArray(target) ? target.includes(column) : String(target ?? '').includes(column);
}

/** True when a database CHECK or trigger rejected the write (SQLSTATE 23514). */
export function isCheckViolation(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${JSON.stringify(error)}` : '';
  return text.includes('23514');
}
