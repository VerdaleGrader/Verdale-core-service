import { Language, Verdict } from '../../generated/prisma/enums';
import { Db, Prisma } from '@/repositories/db';

/**
 * Read-only queries for the Space-wide submission pages (GRD-93): rows, and
 * counts per member, Track and problem. Every function takes the Space and
 * only looks at its problems. Verdict statistics ignore `ISE` (never the
 * submitter's fault) and submissions that have no verdict yet.
 */

export interface Window {
  from?: Date;
  to?: Date;
}

export interface RowFilter extends Window {
  spaceId: string;
  /** Username of the author. */
  username?: string;
  /** Search in the author's username or display name. */
  q?: string;
  problemSlug?: string;
  /** A Track id, or `null` for "submitted from no Track". */
  trackId?: string | null;
  verdicts?: Verdict[];
  language?: Language;
  version?: number;
}

export type RowSort = 'newest' | 'oldest' | 'member' | 'tests_passed' | 'time';

const ROW_INCLUDE = {
  user: { select: { username: true, display_name: true, avatar_url: true } },
  problem: { select: { slug: true, space_id: true, status: true } },
  version: { select: { title: true, version_number: true } },
  track: { select: { name: true, slug: true } },
} as const;

export interface UserStat {
  user_id: string;
  attempted: number;
  solved: number;
  submissions: number;
  accepted: number;
  last_at: Date | null;
  last_verdict: string | null;
}

export interface ProblemStat {
  problem_id: string;
  tried: number;
  solved: number;
  submissions: number;
  accepted: number;
  last_at: Date | null;
  last_verdict: string | null;
  best_verdict: string | null;
}

export interface TrackStat {
  track_id: string;
  submissions: number;
  accepted: number;
  last_at: Date | null;
}

export interface FailureMode {
  problem_id: string;
  verdict: string;
  /** The first test that failed, or null (compilation error). */
  test_position: number | null;
  count: number;
}

const toInt = (value: unknown) => Number(value ?? 0);

/** SQL fragment: the time window and a Track restriction on alias `s`. */
function conditions(window: Window, trackId?: string | null, userId?: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (window.from) parts.push(Prisma.sql`s.created_at >= ${window.from}`);
  if (window.to) parts.push(Prisma.sql`s.created_at < ${window.to}`);
  if (trackId === null) parts.push(Prisma.sql`s.track_id IS NULL`);
  else if (trackId) parts.push(Prisma.sql`s.track_id = ${trackId}::uuid`);
  if (userId) parts.push(Prisma.sql`s.user_id = ${userId}::uuid`);
  return parts.length > 0 ? Prisma.sql` AND ${Prisma.join(parts, ' AND ')}` : Prisma.empty;
}

const VERDICT_RANK = Prisma.sql`CASE s.verdict::text WHEN 'AC' THEN 0 WHEN 'WA' THEN 1 WHEN 'TLE' THEN 2 WHEN 'MLE' THEN 3 WHEN 'OLE' THEN 4 WHEN 'RE' THEN 5 WHEN 'CE' THEN 6 ELSE 7 END`;

export default class SubmissionReportRepository {
  // --- rows ---------------------------------------------------------------

  private rowWhere(filter: RowFilter): Prisma.SubmissionWhereInput {
    return {
      problem: {
        space_id: filter.spaceId,
        ...(filter.problemSlug ? { slug: filter.problemSlug } : {}),
      },
      ...(filter.username || filter.q
        ? {
            user: {
              ...(filter.username ? { username: filter.username } : {}),
              ...(filter.q
                ? {
                    OR: [
                      { username: { contains: filter.q, mode: 'insensitive' as const } },
                      { display_name: { contains: filter.q, mode: 'insensitive' as const } },
                    ],
                  }
                : {}),
            },
          }
        : {}),
      ...(filter.trackId !== undefined ? { track_id: filter.trackId } : {}),
      ...(filter.verdicts ? { verdict: { in: filter.verdicts } } : {}),
      ...(filter.language ? { language: filter.language } : {}),
      ...(filter.version ? { version: { version_number: filter.version } } : {}),
      ...(filter.from || filter.to
        ? {
            created_at: {
              ...(filter.from ? { gte: filter.from } : {}),
              ...(filter.to ? { lt: filter.to } : {}),
            },
          }
        : {}),
    };
  }

  private rowOrder(sort: RowSort): Prisma.SubmissionOrderByWithRelationInput[] {
    switch (sort) {
      case 'oldest':
        return [{ created_at: 'asc' }, { id: 'asc' }];
      case 'member':
        return [{ user: { username: 'asc' } }, { created_at: 'desc' }, { id: 'desc' }];
      case 'tests_passed':
        return [
          { tests_passed: { sort: 'desc', nulls: 'last' } },
          { created_at: 'desc' },
          { id: 'desc' },
        ];
      case 'time':
        return [
          { time_ms: { sort: 'asc', nulls: 'last' } },
          { created_at: 'desc' },
          { id: 'desc' },
        ];
      default:
        return [{ created_at: 'desc' }, { id: 'desc' }];
    }
  }

  async listRows(db: Db, filter: RowFilter, sort: RowSort, skip: number, take: number) {
    const where = this.rowWhere(filter);
    const [rows, total] = await Promise.all([
      db.submission.findMany({
        where,
        include: ROW_INCLUDE,
        orderBy: this.rowOrder(sort),
        skip,
        take,
      }),
      db.submission.count({ where }),
    ]);
    return { rows, total };
  }

  // --- statistics ---------------------------------------------------------

  /** Per author: how many problems tried and solved, how many submissions, and the last one. */
  async userStats(
    db: Db,
    spaceId: string,
    window: Window,
    trackId?: string | null
  ): Promise<UserStat[]> {
    const rows = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT s.user_id::text AS user_id,
        count(DISTINCT s.problem_id) AS attempted,
        count(DISTINCT s.problem_id) FILTER (WHERE s.verdict::text = 'AC') AS solved,
        count(s.id) AS submissions,
        count(s.id) FILTER (WHERE s.verdict::text = 'AC') AS accepted,
        max(s.created_at) AS last_at,
        (array_agg(s.verdict::text ORDER BY s.created_at DESC, s.id DESC)
           FILTER (WHERE s.verdict IS NOT NULL AND s.verdict::text <> 'ISE'))[1] AS last_verdict
      FROM submissions s
      JOIN problems p ON p.id = s.problem_id
      WHERE p.space_id = ${spaceId}::uuid ${conditions(window, trackId)}
      GROUP BY s.user_id`;
    return rows.map((row) => ({
      user_id: String(row.user_id),
      attempted: toInt(row.attempted),
      solved: toInt(row.solved),
      submissions: toInt(row.submissions),
      accepted: toInt(row.accepted),
      last_at: (row.last_at as Date | null) ?? null,
      last_verdict: (row.last_verdict as string | null) ?? null,
    }));
  }

  /** Per problem: people who tried and solved it, submissions, and the last one. */
  async problemStats(
    db: Db,
    spaceId: string,
    window: Window,
    options: { trackId?: string | null; userId?: string } = {}
  ): Promise<Map<string, ProblemStat>> {
    const rows = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT s.problem_id::text AS problem_id,
        count(DISTINCT s.user_id) AS tried,
        count(DISTINCT s.user_id) FILTER (WHERE s.verdict::text = 'AC') AS solved,
        count(s.id) AS submissions,
        count(s.id) FILTER (WHERE s.verdict::text = 'AC') AS accepted,
        max(s.created_at) AS last_at,
        (array_agg(s.verdict::text ORDER BY s.created_at DESC, s.id DESC)
           FILTER (WHERE s.verdict IS NOT NULL AND s.verdict::text <> 'ISE'))[1] AS last_verdict,
        (array_agg(s.verdict::text ORDER BY ${VERDICT_RANK}, s.created_at DESC)
           FILTER (WHERE s.verdict IS NOT NULL AND s.verdict::text <> 'ISE'))[1] AS best_verdict
      FROM submissions s
      JOIN problems p ON p.id = s.problem_id
      WHERE p.space_id = ${spaceId}::uuid ${conditions(window, options.trackId, options.userId)}
      GROUP BY s.problem_id`;
    return new Map(
      rows.map((row) => [
        String(row.problem_id),
        {
          problem_id: String(row.problem_id),
          tried: toInt(row.tried),
          solved: toInt(row.solved),
          submissions: toInt(row.submissions),
          accepted: toInt(row.accepted),
          last_at: (row.last_at as Date | null) ?? null,
          last_verdict: (row.last_verdict as string | null) ?? null,
          best_verdict: (row.best_verdict as string | null) ?? null,
        },
      ])
    );
  }

  /** Per Track: submissions made from it, how many were accepted, and the last one. */
  async trackStats(db: Db, spaceId: string, window: Window): Promise<Map<string, TrackStat>> {
    const rows = await db.$queryRaw<Record<string, unknown>[]>`
      SELECT s.track_id::text AS track_id,
        count(s.id) AS submissions,
        count(s.id) FILTER (WHERE s.verdict::text = 'AC') AS accepted,
        max(s.created_at) AS last_at
      FROM submissions s
      JOIN problems p ON p.id = s.problem_id
      WHERE p.space_id = ${spaceId}::uuid AND s.track_id IS NOT NULL ${conditions(window)}
      GROUP BY s.track_id`;
    return new Map(
      rows.map((row) => [
        String(row.track_id),
        {
          track_id: String(row.track_id),
          submissions: toInt(row.submissions),
          accepted: toInt(row.accepted),
          last_at: (row.last_at as Date | null) ?? null,
        },
      ])
    );
  }

  /**
   * The most common way each problem fails: the verdict and the first test
   * that failed, with how many times. Accepted, system-error and unfinished
   * submissions are not failures.
   */
  async failureModes(
    db: Db,
    spaceId: string,
    window: Window,
    trackId?: string | null
  ): Promise<Map<string, FailureMode>> {
    const rows = await db.$queryRaw<Record<string, unknown>[]>`
      WITH failed AS (
        SELECT s.problem_id, s.verdict::text AS verdict,
          (SELECT min(r.position) FROM submission_test_results r
            WHERE r.submission_id = s.id AND r.verdict::text NOT IN ('AC', 'SKIPPED')) AS test_position
        FROM submissions s
        JOIN problems p ON p.id = s.problem_id
        WHERE p.space_id = ${spaceId}::uuid
          AND s.verdict IS NOT NULL AND s.verdict::text NOT IN ('AC', 'ISE')
          ${conditions(window, trackId)}
      ), counted AS (
        SELECT problem_id, verdict, test_position, count(*) AS n FROM failed GROUP BY 1, 2, 3
      )
      SELECT DISTINCT ON (problem_id) problem_id::text AS problem_id, verdict, test_position, n
      FROM counted
      ORDER BY problem_id, n DESC, test_position ASC NULLS LAST, verdict ASC`;
    return new Map(
      rows.map((row) => [
        String(row.problem_id),
        {
          problem_id: String(row.problem_id),
          verdict: String(row.verdict),
          test_position: row.test_position === null ? null : toInt(row.test_position),
          count: toInt(row.n),
        },
      ])
    );
  }

  /** Language and version choices that exist in a problem's or Space's submissions, for the filters. */
  async versionsOf(db: Db, spaceId: string, problemSlug?: string) {
    const rows = await db.problemVersion.findMany({
      where: { problem: { space_id: spaceId, ...(problemSlug ? { slug: problemSlug } : {}) } },
      select: { version_number: true },
      distinct: ['version_number'],
      orderBy: { version_number: 'desc' },
    });
    return rows.map((row) => row.version_number);
  }
}

export type SubmissionReportRow = Awaited<
  ReturnType<SubmissionReportRepository['listRows']>
>['rows'][number];
