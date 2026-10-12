import type { PrismaClient, User } from '../../../generated/prisma/client';
import { NotFoundError } from '@/errors';
import SpaceRepository from '@/repositories/space.repository';
import SubmissionRepository from '@/repositories/submission.repository';
import TrackRepository, { TrackWithContent } from '@/repositories/track.repository';
import {
  ProgressDto,
  progressOf,
  trackProgress,
  visibleCollections,
} from '@/services/track/track.mapper';
import TrackService from '@/services/track/track.service';
import { Role, assertCan } from '@/services/space/space.access';
import { PublicUser, toPublicUser } from '@/services/user/user.mapper';
import UserRepository from '@/repositories/user.repository';

export interface MemberProgressDto {
  user: PublicUser;
  role: Role;
  progress: ProgressDto;
  collections: Array<{ id: string; slug: string; name: string; progress: ProgressDto }>;
}

export interface UserProgressDto {
  user: PublicUser;
  progress: ProgressDto;
  collections: Array<{
    id: string;
    slug: string;
    name: string;
    progress: ProgressDto;
    problems: Array<{ id: string; slug: string; title: string; solved: boolean }>;
  }>;
}

/**
 * Progression (GRD-82): a problem counts as passed when the user has at least
 * one AC on it, on any version, so editing a problem later never takes
 * progress away. Only published problems count, and a problem taken out of a
 * Collection or Track leaves the denominator.
 */
export default class ProgressService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly tracks: TrackRepository,
    private readonly spaces: SpaceRepository,
    private readonly users: UserRepository,
    private readonly submissions: SubmissionRepository,
    private readonly trackService: TrackService
  ) {}

  /** My progress in a Track the caller can see. The staff may ask about another member. */
  async forUser(
    user: User,
    slug: string,
    trackSlug: string,
    username?: string
  ): Promise<UserProgressDto> {
    const { access, track } = await this.trackService.loadForReader(
      this.prisma,
      user,
      slug,
      trackSlug
    );
    let subject: User = user;
    if (username !== undefined && username.toLowerCase() !== user.username) {
      // Only the staff may look at someone else's progress.
      assertCan(user, 'track.view_progress', access);
      const found = await this.users.findByUsername(this.prisma, username.toLowerCase());
      const membership = found
        ? await this.spaces.findMembership(this.prisma, access.space.id, found.id)
        : null;
      if (!found || !membership)
        throw new NotFoundError('That user is not a member of this Space.');
      subject = found;
    }
    const collections = visibleCollections(track, false);
    const ids = problemIdsOf(track);
    const solved = (await this.submissions.solvedBy(this.prisma, [subject.id], ids)).get(
      subject.id
    )!;
    return {
      user: toPublicUser(subject),
      progress: trackProgress(collections, solved)!,
      collections: collections.map((link) => ({
        id: link.collection.id,
        slug: link.collection.slug,
        name: link.collection.name,
        progress: progressOf(link.collection.problems, solved)!,
        problems: link.collection.problems
          .filter((entry) => entry.problem.status === 'published')
          .map((entry) => ({
            id: entry.problem.id,
            slug: entry.problem.slug,
            title: entry.problem.current_version?.title ?? entry.problem.slug,
            solved: solved.has(entry.problem.id),
          })),
      })),
    };
  }

  /** The staff: how far each person who can see the Track has got. */
  async forMembers(
    user: User,
    slug: string,
    trackSlug: string
  ): Promise<{ items: MemberProgressDto[] }> {
    const { access, track } = await this.trackService.loadForProgress(
      this.prisma,
      user,
      slug,
      trackSlug
    );
    const withContent = (await this.tracks.findTrackWithContent(
      this.prisma,
      access.space.id,
      track.slug
    ))!;
    const members = await this.spaces.listMembers(this.prisma, access.space.id);
    const trackMemberIds =
      track.visibility === 'members'
        ? new Set(
            (await this.tracks.listTrackMembers(this.prisma, track.id)).map((row) => row.user_id)
          )
        : null;
    const eligible = members.filter(
      (member) =>
        member.role === 'solver' && (trackMemberIds === null || trackMemberIds.has(member.user_id))
    );
    const collections = visibleCollections(withContent, false);
    const solvedBy = await this.submissions.solvedBy(
      this.prisma,
      eligible.map((member) => member.user_id),
      problemIdsOf(withContent)
    );
    return {
      items: eligible.map((member) => {
        const solved = solvedBy.get(member.user_id)!;
        return {
          user: toPublicUser(member.user),
          role: member.role,
          progress: trackProgress(collections, solved)!,
          collections: collections.map((link) => ({
            id: link.collection.id,
            slug: link.collection.slug,
            name: link.collection.name,
            progress: progressOf(link.collection.problems, solved)!,
          })),
        };
      }),
    };
  }
}

function problemIdsOf(track: TrackWithContent): string[] {
  return [
    ...new Set(
      track.collections.flatMap((link) => link.collection.problems.map((entry) => entry.problem.id))
    ),
  ];
}
