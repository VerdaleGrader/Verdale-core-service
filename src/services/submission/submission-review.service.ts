import type { PrismaClient, User } from '../../../generated/prisma/client';
import type { Language, Verdict } from '../../../generated/prisma/enums';
import { NotFoundError, ServiceUnavailableError } from '@/errors';
import { StorageNotFoundError, StorageUnavailableError, testFileKey } from '@/libs/storage';
import type { FileStorage } from '@/libs/storage';
import { SLICE_LIMITS, TextSlice, sliceString, sliceText } from '@/libs/text-slice';
import { STARTER_TRACK } from '@/constants/identifiers';
import { can } from '@/permissions/can';
import SpaceRepository from '@/repositories/space.repository';
import SubmissionReportRepository, {
  FailureMode,
  ProblemStat,
  RowFilter,
  RowSort,
  UserStat,
  Window,
} from '@/repositories/submission-report.repository';
import SubmissionRepository from '@/repositories/submission.repository';
import TestCaseRepository from '@/repositories/test-case.repository';
import TrackRepository, { TrackWithContent } from '@/repositories/track.repository';
import { SpaceAccess, actorOf, assertCan, resourceOf } from '@/services/space/space.access';
import { Page } from '@/services/space/space.mapper';
import SpaceService from '@/services/space/space.service';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';
import { VerdictName } from '@/services/submission/submission.mapper';
import { visibleCollections, visibleLinks } from '@/services/track/track.mapper';

/**
 * What owners, administrators, editors and observers see of a Space's
 * submissions (GRD-93): one list, rollups per member, Track and problem, and
 * the full detail of one test. Solvers never reach any of it.
 */

export type WindowName = 'any' | '7d' | '30d';

export interface SubmissionRowDto {
  id: string;
  created_at: string;
  member: PublicUser;
  problem: { slug: string; title: string };
  track: { name: string; slug: string } | null;
  version: number;
  language: Language;
  status: 'queued' | 'running' | 'completed';
  verdict: VerdictName | null;
  tests_passed: number | null;
  tests_total: number | null;
  time_ms: number | null;
  memory_kb: number | null;
}

export interface MemberRollupDto {
  user: PublicUser;
  /** Their role in the Space; null for someone who submitted without being a member. */
  role: string | null;
  attempted: number;
  solved: number;
  submissions: number;
  /** Accepted submissions out of all of them, 0 to 1; null when there are none. */
  ac_rate: number | null;
  last_verdict: VerdictName | null;
  last_submission_at: string | null;
}

export interface ProblemRefDto {
  slug: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
}

export interface TrackRefDto {
  name: string;
  slug: string;
}

export interface FailureDto {
  verdict: VerdictName;
  /** The first test that failed (1-based), or null for a compilation error. */
  test_position: number | null;
  count: number;
}

export interface TrackRollupDto {
  track: TrackRefDto & { visibility: 'space' | 'members'; is_default: boolean };
  problems: number;
  members: number;
  submissions: number;
  accepted: number;
  members_finished: number;
  last_submission_at: string | null;
}

export interface TrackProblemRollupDto {
  problem: ProblemRefDto;
  collections: { name: string; slug: string }[];
  tried: number;
  solved: number;
  submissions: number;
  most_common_failure: FailureDto | null;
  last_submission_at: string | null;
}

export interface ProblemRollupDto {
  problem: ProblemRefDto;
  tracks: TrackRefDto[];
  tried: number;
  solved: number;
  submissions: number;
  last_verdict: VerdictName | null;
  last_submission_at: string | null;
}

export interface MemberProblemDto {
  problem: ProblemRefDto;
  /** The Track of the member's latest submission of the problem. */
  track: TrackRefDto | null;
  attempts: number;
  solved: boolean;
  best_verdict: VerdictName | null;
  last_verdict: VerdictName | null;
  last_submission_at: string | null;
}

export interface TestDetailDto {
  submission_id: string;
  position: number;
  verdict: string;
  is_sample: boolean;
  time_ms: number;
  memory_kb: number;
  exit_code: number | null;
  signal: number | null;
  /** The test's input, the expected output, what the program printed and its standard error. */
  input: FilePartDto | null;
  expected: FilePartDto | null;
  output: FilePartDto | null;
  stderr: FilePartDto | null;
}

/** A window of a text with the facts needed to say "showing 10 of 4,203 lines". */
export interface FilePartDto extends TextSlice {
  /** The text kept of a program's output was shorter than what it printed. */
  cut: boolean;
  /** The file could not be read (never stored, or removed). */
  unavailable?: boolean;
}

export interface RowQuery {
  member?: string;
  q?: string;
  problem?: string;
  track?: string;
  verdict?: Verdict[];
  language?: Language;
  version?: number;
  from?: Date;
  to?: Date;
  sort: RowSort;
  page: number;
  page_size: number;
}

const WINDOW_DAYS: Record<WindowName, number | null> = { any: null, '7d': 7, '30d': 30 };

function windowFrom(name: WindowName, now: Date): Window {
  const days = WINDOW_DAYS[name];
  return days === null ? {} : { from: new Date(now.getTime() - days * 24 * 60 * 60 * 1000) };
}

const iso = (date: Date | null) => date?.toISOString() ?? null;

function paginate<T>(items: T[], page: number, pageSize: number): Page<T> {
  return {
    items: items.slice((page - 1) * pageSize, page * pageSize),
    page,
    page_size: pageSize,
    total: items.length,
  };
}

export default class SubmissionReviewService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly report: SubmissionReportRepository,
    private readonly submissions: SubmissionRepository,
    private readonly tracks: TrackRepository,
    private readonly spaces: SpaceRepository,
    private readonly tests: TestCaseRepository,
    private readonly spaceService: SpaceService,
    private readonly testStorage: FileStorage,
    private readonly now: () => Date = () => new Date()
  ) {}

  // --- the list -----------------------------------------------------------

  async rows(user: User, slug: string, query: RowQuery): Promise<Page<SubmissionRowDto>> {
    const access = await this.load(user, slug);
    const filter: RowFilter = {
      spaceId: access.space.id,
      username: query.member?.toLowerCase(),
      q: query.q,
      problemSlug: query.problem?.toLowerCase(),
      trackId: await this.trackFilter(access, query.track),
      verdicts: query.verdict,
      language: query.language,
      version: query.version,
      from: query.from,
      to: query.to,
    };
    const { rows, total } = await this.report.listRows(
      this.prisma,
      filter,
      query.sort,
      (query.page - 1) * query.page_size,
      query.page_size
    );
    return {
      items: rows.map((row) => ({
        id: row.id,
        created_at: row.created_at.toISOString(),
        member: toPublicUser(row.user),
        problem: { slug: row.problem.slug, title: row.version.title },
        track: row.track ? { name: row.track.name, slug: row.track.slug } : null,
        version: row.version.version_number,
        language: row.language,
        status: row.status,
        verdict: row.verdict,
        tests_passed: row.tests_passed,
        tests_total: row.tests_total,
        time_ms: row.time_ms,
        memory_kb: row.memory_kb,
      })),
      page: query.page,
      page_size: query.page_size,
      total,
    };
  }

  // --- by member ----------------------------------------------------------

  async byMember(
    user: User,
    slug: string,
    query: {
      q?: string;
      role?: string;
      track?: string;
      window: WindowName;
      sort: 'last_submission' | 'solved' | 'name';
      hide_empty: boolean;
      page: number;
      page_size: number;
    }
  ): Promise<Page<MemberRollupDto> & { totals: { members: number; submissions: number } }> {
    const access = await this.load(user, slug);
    const trackId = await this.trackFilter(access, query.track);
    const [stats, members] = await Promise.all([
      this.report.userStats(
        this.prisma,
        access.space.id,
        windowFrom(query.window, this.now()),
        trackId
      ),
      this.spaces.listMembers(this.prisma, access.space.id),
    ]);
    const roles = new Map(members.map((member) => [member.user_id, member.role as string]));
    const byUser = new Map(stats.map((stat) => [stat.user_id, stat]));
    const people = new Map(members.map((member) => [member.user_id, toPublicUser(member.user)]));
    // Someone may have submitted to a public Space without ever joining it.
    const strangers = stats.filter((stat) => !people.has(stat.user_id)).map((stat) => stat.user_id);
    if (strangers.length > 0) {
      for (const stranger of await this.prisma.user.findMany({
        where: { id: { in: strangers } },
        select: { id: true, username: true, display_name: true, avatar_url: true },
      })) {
        people.set(stranger.id, toPublicUser(stranger));
      }
    }

    const needle = query.q?.toLowerCase();
    let rollups = [...people.entries()].map(([id, person]) => {
      const stat: UserStat | undefined = byUser.get(id);
      return {
        id,
        dto: <MemberRollupDto>{
          user: person,
          role: roles.get(id) ?? null,
          attempted: stat?.attempted ?? 0,
          solved: stat?.solved ?? 0,
          submissions: stat?.submissions ?? 0,
          ac_rate: stat && stat.submissions > 0 ? stat.accepted / stat.submissions : null,
          last_verdict: (stat?.last_verdict as VerdictName | null) ?? null,
          last_submission_at: iso(stat?.last_at ?? null),
        },
      };
    });
    rollups = rollups.filter(({ dto }) => {
      if (query.hide_empty && dto.submissions === 0) return false;
      if (query.role && (query.role === 'none' ? dto.role !== null : dto.role !== query.role)) {
        return false;
      }
      if (needle) {
        return (
          dto.user.username.toLowerCase().includes(needle) ||
          dto.user.display_name.toLowerCase().includes(needle)
        );
      }
      return true;
    });
    const sorted = rollups
      .map(({ dto }) => dto)
      .sort((a, b) => {
        if (query.sort === 'name') {
          return (
            a.user.display_name.localeCompare(b.user.display_name) ||
            a.user.username.localeCompare(b.user.username)
          );
        }
        if (query.sort === 'solved') {
          return (
            b.solved - a.solved ||
            b.submissions - a.submissions ||
            a.user.username.localeCompare(b.user.username)
          );
        }
        return (
          (b.last_submission_at ?? '').localeCompare(a.last_submission_at ?? '') ||
          a.user.username.localeCompare(b.user.username)
        );
      });
    return {
      ...paginate(sorted, query.page, query.page_size),
      totals: {
        members: sorted.length,
        submissions: sorted.reduce((sum, item) => sum + item.submissions, 0),
      },
    };
  }

  /** The problems one member tried (page 2 of "by member"). */
  async memberProblems(
    user: User,
    slug: string,
    username: string,
    query: {
      q?: string;
      track?: string;
      status: 'all' | 'solved' | 'unsolved';
      sort: 'last_submission' | 'attempts' | 'name';
      page: number;
      page_size: number;
    }
  ): Promise<Page<MemberProblemDto> & { member: MemberRollupDto }> {
    const access = await this.load(user, slug);
    const member = await this.prisma.user.findUnique({
      where: { username: username.toLowerCase() },
      select: { id: true, username: true, display_name: true, avatar_url: true },
    });
    if (!member) throw new NotFoundError('Member not found.');
    const trackId = await this.trackFilter(access, query.track);
    const [stats, overall, membership, latest] = await Promise.all([
      this.report.problemStats(this.prisma, access.space.id, {}, { trackId, userId: member.id }),
      this.report.userStats(this.prisma, access.space.id, {}),
      this.spaces.findMembership(this.prisma, access.space.id, member.id),
      this.prisma.submission.findMany({
        where: { user_id: member.id, problem: { space_id: access.space.id } },
        select: { problem_id: true, track: { select: { name: true, slug: true } } },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        distinct: ['problem_id'],
      }),
    ]);
    const mine = overall.find((stat) => stat.user_id === member.id);
    if (!membership && !mine) throw new NotFoundError('Member not found.');
    const trackOf = new Map(latest.map((row) => [row.problem_id, row.track]));

    const problems = await this.prisma.problem.findMany({
      where: { id: { in: [...stats.keys()] } },
      select: { id: true, slug: true, status: true, current_version: { select: { title: true } } },
    });
    const needle = query.q?.toLowerCase();
    const items = problems
      .map((problem) => {
        const stat = stats.get(problem.id)!;
        return <MemberProblemDto>{
          problem: {
            slug: problem.slug,
            title: problem.current_version?.title ?? problem.slug,
            status: problem.status,
          },
          track: trackOf.get(problem.id) ?? null,
          attempts: stat.submissions,
          solved: stat.solved > 0,
          best_verdict: stat.best_verdict as VerdictName | null,
          last_verdict: stat.last_verdict as VerdictName | null,
          last_submission_at: iso(stat.last_at),
        };
      })
      .filter((item) => {
        if (query.status === 'solved' && !item.solved) return false;
        if (query.status === 'unsolved' && item.solved) return false;
        if (!needle) return true;
        return (
          item.problem.slug.includes(needle) || item.problem.title.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        if (query.sort === 'name') return a.problem.title.localeCompare(b.problem.title);
        if (query.sort === 'attempts')
          return b.attempts - a.attempts || a.problem.slug.localeCompare(b.problem.slug);
        return (b.last_submission_at ?? '').localeCompare(a.last_submission_at ?? '');
      });
    return {
      ...paginate(items, query.page, query.page_size),
      member: {
        user: toPublicUser(member),
        role: membership?.role ?? null,
        attempted: mine?.attempted ?? 0,
        solved: mine?.solved ?? 0,
        submissions: mine?.submissions ?? 0,
        ac_rate: mine && mine.submissions > 0 ? mine.accepted / mine.submissions : null,
        last_verdict: (mine?.last_verdict as VerdictName | null) ?? null,
        last_submission_at: iso(mine?.last_at ?? null),
      },
    };
  }

  // --- by track -----------------------------------------------------------

  async byTrack(
    user: User,
    slug: string,
    query: {
      q?: string;
      visibility?: 'space' | 'members';
      window: WindowName;
      sort: 'track_order' | 'last_submission' | 'submissions';
    }
  ): Promise<{ items: TrackRollupDto[] }> {
    const access = await this.load(user, slug);
    const [allTracks, stats, memberRows] = await Promise.all([
      this.tracks.listTracksWithContent(this.prisma, access.space.id, 'writer'),
      this.report.trackStats(this.prisma, access.space.id, windowFrom(query.window, this.now())),
      this.spaces.listMembers(this.prisma, access.space.id),
    ]);
    const needle = query.q?.toLowerCase();
    const chosen = allTracks.filter(
      (track) =>
        track.archived_at === null &&
        (!query.visibility || track.visibility === query.visibility) &&
        (!needle || track.name.toLowerCase().includes(needle) || track.slug.includes(needle))
    );
    const items = await Promise.all(
      chosen.map(async (track) => {
        const audience = await this.audience(track, memberRows);
        const problemIds = publishedProblemIds(track);
        const solved = await this.submissions.solvedBy(this.prisma, audience, problemIds);
        const stat = stats.get(track.id);
        return <TrackRollupDto>{
          track: {
            name: track.name,
            slug: track.slug,
            visibility: track.visibility,
            is_default: track.slug === STARTER_TRACK.slug,
          },
          problems: problemIds.length,
          members: audience.length,
          submissions: stat?.submissions ?? 0,
          accepted: stat?.accepted ?? 0,
          members_finished:
            problemIds.length === 0
              ? 0
              : audience.filter((id) => (solved.get(id)?.size ?? 0) >= problemIds.length).length,
          last_submission_at: iso(stat?.last_at ?? null),
        };
      })
    );
    const order = new Map(chosen.map((track, index) => [track.slug, index]));
    items.sort((a, b) => {
      if (query.sort === 'submissions') return b.submissions - a.submissions;
      if (query.sort === 'last_submission') {
        return (b.last_submission_at ?? '').localeCompare(a.last_submission_at ?? '');
      }
      return order.get(a.track.slug)! - order.get(b.track.slug)!;
    });
    return { items };
  }

  /** The problems of a Track with how people got on, drafts included (staff see them). */
  async trackProblems(
    user: User,
    slug: string,
    trackSlug: string,
    query: {
      q?: string;
      collection?: string;
      status: 'all' | 'published' | 'draft' | 'archived';
      sort: 'track_order' | 'solved_fewest' | 'last_submission';
    }
  ) {
    const access = await this.load(user, slug);
    const track = await this.tracks.findTrackWithContent(
      this.prisma,
      access.space.id,
      trackSlug.toLowerCase()
    );
    if (!track) throw new NotFoundError('Track not found.');
    // Collections that are not archived; the staff see every problem in them, drafts included.
    const links = visibleCollections(track, false);
    const [stats, failures, memberRows] = await Promise.all([
      this.report.problemStats(this.prisma, access.space.id, {}, { trackId: track.id }),
      this.report.failureModes(this.prisma, access.space.id, {}, track.id),
      this.spaces.listMembers(this.prisma, access.space.id),
    ]);
    const problemIds = publishedProblemIds(track);

    const rows = new Map<string, TrackProblemRollupDto>();
    for (const link of links) {
      const collection = { name: link.collection.name, slug: link.collection.slug };
      for (const entry of visibleLinks(link.collection.problems, true)) {
        const existing = rows.get(entry.problem_id);
        if (existing) {
          existing.collections.push(collection);
          continue;
        }
        const stat: ProblemStat | undefined = stats.get(entry.problem_id);
        const failure: FailureMode | undefined = failures.get(entry.problem_id);
        rows.set(entry.problem_id, {
          problem: {
            slug: entry.problem.slug,
            title: entry.problem.current_version?.title ?? entry.problem.slug,
            status: entry.problem.status,
          },
          collections: [collection],
          tried: stat?.tried ?? 0,
          solved: stat?.solved ?? 0,
          submissions: stat?.submissions ?? 0,
          most_common_failure: failure
            ? {
                verdict: failure.verdict as VerdictName,
                test_position: failure.test_position,
                count: failure.count,
              }
            : null,
          last_submission_at: iso(stat?.last_at ?? null),
        });
      }
    }
    const needle = query.q?.toLowerCase();
    const items = [...rows.values()]
      .filter(
        (row) =>
          (query.status === 'all' || row.problem.status === query.status) &&
          (!query.collection || row.collections.some((c) => c.slug === query.collection)) &&
          (!needle ||
            row.problem.slug.includes(needle) ||
            row.problem.title.toLowerCase().includes(needle))
      )
      .sort((a, b) => {
        if (query.sort === 'solved_fewest') return a.solved - b.solved;
        if (query.sort === 'last_submission') {
          return (b.last_submission_at ?? '').localeCompare(a.last_submission_at ?? '');
        }
        return 0; // keep the order of the Track
      });

    const audience = await this.audience(track, memberRows);
    const solved = await this.submissions.solvedBy(this.prisma, audience, problemIds);
    const trackTotals = [...stats.values()].reduce(
      (sum, stat) => ({
        submissions: sum.submissions + stat.submissions,
        accepted: sum.accepted + stat.accepted,
      }),
      { submissions: 0, accepted: 0 }
    );
    return {
      track: {
        name: track.name,
        slug: track.slug,
        visibility: track.visibility,
        collections: links.length,
        problems: rows.size,
        members: audience.length,
        submissions: trackTotals.submissions,
        accepted: trackTotals.accepted,
        finished:
          problemIds.length === 0
            ? 0
            : audience.filter((id) => (solved.get(id)?.size ?? 0) >= problemIds.length).length,
      },
      collections: links.map((link) => ({
        name: link.collection.name,
        slug: link.collection.slug,
      })),
      items,
    };
  }

  // --- by problem ---------------------------------------------------------

  async byProblem(
    user: User,
    slug: string,
    query: {
      q?: string;
      track?: string;
      status: 'all' | 'published' | 'draft' | 'archived';
      sort: 'last_submission' | 'submissions' | 'solved_fewest' | 'name';
      page: number;
      page_size: number;
    }
  ): Promise<Page<ProblemRollupDto>> {
    const access = await this.load(user, slug);
    const [stats, problems, tracksWithContent] = await Promise.all([
      this.report.problemStats(this.prisma, access.space.id, {}),
      this.prisma.problem.findMany({
        where: {
          space_id: access.space.id,
          ...(query.status === 'all' ? {} : { status: query.status }),
        },
        select: {
          id: true,
          slug: true,
          status: true,
          current_version: { select: { title: true } },
        },
      }),
      this.tracks.listTracksWithContent(this.prisma, access.space.id, 'writer'),
    ]);
    // Which active Tracks reach each problem, through Collections that are not archived.
    const tracksOf = new Map<string, Map<string, TrackRefDto & { position: number }>>();
    for (const track of tracksWithContent) {
      if (track.archived_at !== null) continue;
      for (const link of visibleCollections(track, false)) {
        for (const entry of link.collection.problems) {
          const reached = tracksOf.get(entry.problem_id) ?? new Map();
          reached.set(track.slug, { name: track.name, slug: track.slug, position: track.position });
          tracksOf.set(entry.problem_id, reached);
        }
      }
    }
    const needle = query.q?.toLowerCase();
    const items = problems
      .map((problem) => {
        const tracks =
          tracksOf.get(problem.id) ?? new Map<string, TrackRefDto & { position: number }>();
        const stat: ProblemStat | undefined = stats.get(problem.id);
        return {
          dto: <ProblemRollupDto>{
            problem: {
              slug: problem.slug,
              title: problem.current_version?.title ?? problem.slug,
              status: problem.status,
            },
            tracks: [...tracks.values()]
              .sort((a, b) => a.position - b.position)
              .map(({ name, slug: trackSlug }) => ({ name, slug: trackSlug })),
            tried: stat?.tried ?? 0,
            solved: stat?.solved ?? 0,
            submissions: stat?.submissions ?? 0,
            last_verdict: (stat?.last_verdict as VerdictName | null) ?? null,
            last_submission_at: iso(stat?.last_at ?? null),
          },
        };
      })
      .map(({ dto }) => dto)
      .filter((dto) => {
        if (query.track === 'none' && dto.tracks.length > 0) return false;
        if (
          query.track &&
          query.track !== 'none' &&
          !dto.tracks.some((t) => t.slug === query.track)
        ) {
          return false;
        }
        if (!needle) return true;
        return (
          dto.problem.slug.includes(needle) || dto.problem.title.toLowerCase().includes(needle)
        );
      })
      .sort((a, b) => {
        if (query.sort === 'name') return a.problem.title.localeCompare(b.problem.title);
        if (query.sort === 'submissions') return b.submissions - a.submissions;
        if (query.sort === 'solved_fewest') return a.solved - b.solved || b.tried - a.tried;
        return (b.last_submission_at ?? '').localeCompare(a.last_submission_at ?? '');
      });
    return paginate(items, query.page, query.page_size);
  }

  /** Versions that exist, for the version filter of the lists. */
  async versions(user: User, slug: string, problemSlug?: string): Promise<number[]> {
    const access = await this.load(user, slug);
    return this.report.versionsOf(this.prisma, access.space.id, problemSlug?.toLowerCase());
  }

  // --- one test -----------------------------------------------------------

  /**
   * Everything about one test of a submission, hidden tests too: the input,
   * the expected output, what the program printed and its standard error, as a
   * window of lines. Only people who may read hidden tests reach it; anyone
   * else, the author included, gets 404 (the author reads samples in the
   * ordinary submission response).
   */
  async testDetail(
    user: User,
    submissionId: string,
    position: number,
    window: {
      fromLine: number;
      maxLines: number;
      part?: 'input' | 'expected' | 'output' | 'stderr';
    }
  ): Promise<TestDetailDto> {
    const submission = await this.submissions.findById(this.prisma, submissionId);
    if (!submission) throw new NotFoundError('Submission not found.');
    const space = await this.spaces.findById(this.prisma, submission.problem.space_id);
    if (!space) throw new NotFoundError('Submission not found.');
    const membership = await this.spaces.findMembership(this.prisma, space.id, user.id);
    const access: SpaceAccess = { space, role: (membership?.role as SpaceAccess['role']) ?? null };
    if (!can(actorOf(user), 'problem.view_private', resourceOf(access))) {
      throw new NotFoundError('Submission not found.');
    }
    const result = await this.prisma.submissionTestResult.findUnique({
      where: { submission_id_position: { submission_id: submission.id, position } },
      include: { output: true },
    });
    if (!result) throw new NotFoundError('Test result not found.');

    const caseRow = result.test_case_id
      ? await this.prisma.testCase.findUnique({ where: { id: result.test_case_id } })
      : null;
    const options = {
      fromLine: window.fromLine,
      maxLines: window.maxLines,
      maxLineChars: SLICE_LIMITS.max_line_chars,
    };
    const want = (part: NonNullable<typeof window.part>) => !window.part || window.part === part;
    const fromStorage = async (sha: string | undefined): Promise<FilePartDto | null> => {
      if (!sha) return { ...emptySlice(options.fromLine), cut: false, unavailable: true };
      try {
        const stored = await this.testStorage.get(testFileKey(sha));
        return { ...(await sliceText(stored.body, options)), cut: false };
      } catch (error) {
        if (error instanceof StorageNotFoundError) {
          return { ...emptySlice(options.fromLine), cut: false, unavailable: true };
        }
        if (error instanceof StorageUnavailableError) throw new ServiceUnavailableError();
        throw error;
      }
    };
    const fromText = async (
      text: string | null | undefined,
      fullSize: bigint | null | undefined
    ): Promise<FilePartDto | null> => {
      if (text === null || text === undefined) return null;
      const slice = await sliceString(text, options);
      return {
        ...slice,
        cut: fullSize !== null && fullSize !== undefined && Number(fullSize) > slice.size_bytes,
      };
    };

    return {
      submission_id: submission.id,
      position: result.position,
      verdict: result.verdict,
      is_sample: result.is_sample,
      time_ms: result.time_ms,
      memory_kb: result.memory_kb,
      exit_code: result.exit_code,
      signal: result.signal,
      input: want('input') ? await fromStorage(caseRow?.input_sha256) : null,
      expected: want('expected') ? await fromStorage(caseRow?.output_sha256 ?? undefined) : null,
      output: want('output')
        ? await fromText(result.output?.stdout, result.output?.stdout_size_bytes)
        : null,
      stderr: want('stderr')
        ? await fromText(result.output?.stderr, result.output?.stderr_size_bytes)
        : null,
    };
  }

  // --- internals ----------------------------------------------------------

  private async load(user: User, slug: string): Promise<SpaceAccess> {
    const access = await this.spaceService.load(this.prisma, slug, user);
    assertCan(user, 'submission.view_all', access);
    return access;
  }

  /** A Track slug as the Track id to filter by; `none` is "from no Track"; unknown is 404. */
  private async trackFilter(
    access: SpaceAccess,
    trackSlug?: string
  ): Promise<string | null | undefined> {
    if (!trackSlug) return undefined;
    if (trackSlug === 'none') return null;
    const track = await this.tracks.findTrackBySlug(
      this.prisma,
      access.space.id,
      trackSlug.toLowerCase()
    );
    if (!track) throw new NotFoundError('Track not found.');
    return track.id;
  }

  /**
   * The people a Track is for, the way progress counts them (GRD-82): solvers of the Space,
   * all of them when the Track is open to the Space, otherwise those added to the Track.
   */
  private async audience(
    track: { id: string; visibility: 'space' | 'members' },
    spaceMembers: { user_id: string; role: string }[]
  ): Promise<string[]> {
    const solvers = spaceMembers.filter((member) => member.role === 'solver');
    if (track.visibility === 'space') return solvers.map((member) => member.user_id);
    const added = new Set(
      (await this.tracks.listTrackMembers(this.prisma, track.id)).map((row) => row.user_id)
    );
    return solvers.filter((member) => added.has(member.user_id)).map((member) => member.user_id);
  }
}

/** Published problems in the Collections of a Track that are not archived, each once (as progress counts). */
function publishedProblemIds(track: TrackWithContent): string[] {
  const ids = new Set<string>();
  for (const link of visibleCollections(track, false)) {
    for (const entry of visibleLinks(link.collection.problems, false)) ids.add(entry.problem_id);
  }
  return [...ids];
}

function emptySlice(fromLine: number): TextSlice {
  return {
    lines: [],
    from_line: fromLine,
    to_line: fromLine - 1,
    total_lines: 0,
    size_bytes: 0,
    line_truncated: false,
  };
}
