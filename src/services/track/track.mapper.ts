import type { Verdict } from '../../../generated/prisma/enums';
import type { CollectionWithProblems, TrackWithContent } from '@/repositories/track.repository';

export interface ProgressDto {
  solved: number;
  total: number;
}

export interface TrackProblemDto {
  id: string;
  slug: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  version_number: number;
  position: number;
  /** Null for a visitor, who has no submissions. */
  solved: boolean | null;
  /** AC once solved, otherwise the verdict of the latest finished submission, or null. */
  my_verdict: Verdict | null;
}

export interface CollectionDto {
  id: string;
  slug: string;
  name: string;
  description: string;
  archived_at: string | null;
  created_at: string;
  problem_count: number;
}

export interface TrackCollectionDto extends CollectionDto {
  /** Order inside the Track. */
  position: number;
  problems: TrackProblemDto[];
  progress: ProgressDto | null;
}

export interface TrackDto {
  id: string;
  slug: string;
  name: string;
  description: string;
  visibility: 'space' | 'members';
  position: number;
  archived_at: string | null;
  created_at: string;
  collection_count: number;
  /** Published problems, each counted once. */
  problem_count: number;
  progress: ProgressDto | null;
}

export interface TrackDetailDto extends TrackDto {
  collections: TrackCollectionDto[];
}

type ProblemLink = CollectionWithProblems['problems'][number];

/** What this viewer sees of a Collection's problems: solvers get published ones only. */
export function visibleLinks(links: ProblemLink[], isWriter: boolean): ProblemLink[] {
  return isWriter ? links : links.filter((link) => link.problem.status === 'published');
}

export function countPublished(links: ProblemLink[]): number {
  return links.filter((link) => link.problem.status === 'published').length;
}

export function toCollectionDto(collection: CollectionWithProblems): CollectionDto {
  return {
    id: collection.id,
    slug: collection.slug,
    name: collection.name,
    description: collection.description,
    archived_at: collection.archived_at?.toISOString() ?? null,
    created_at: collection.created_at.toISOString(),
    problem_count: countPublished(collection.problems),
  };
}

export function progressOf(
  links: ProblemLink[],
  solved: ReadonlySet<string> | null
): ProgressDto | null {
  if (!solved) return null;
  const published = links.filter((link) => link.problem.status === 'published');
  return {
    solved: published.filter((link) => solved.has(link.problem.id)).length,
    total: published.length,
  };
}

export interface ViewerState {
  isWriter: boolean;
  /** Problems the viewer has solved; null for a visitor. */
  solved: ReadonlySet<string> | null;
  verdicts: ReadonlyMap<string, Verdict>;
}

export function toTrackProblemDto(link: ProblemLink, viewer: ViewerState): TrackProblemDto {
  const solved = viewer.solved ? viewer.solved.has(link.problem.id) : null;
  return {
    id: link.problem.id,
    slug: link.problem.slug,
    title: link.problem.current_version?.title ?? link.problem.slug,
    status: link.problem.status,
    version_number: link.problem.current_version?.version_number ?? 1,
    position: link.position,
    solved,
    my_verdict: solved ? 'AC' : (viewer.verdicts.get(link.problem.id) ?? null),
  };
}

/** The Collections a viewer sees inside a Track: archived ones only for owners and editors. */
export function visibleCollections(track: TrackWithContent, isWriter: boolean) {
  return track.collections.filter((link) => isWriter || link.collection.archived_at === null);
}

export function trackProgress(
  collections: TrackWithContent['collections'],
  solved: ReadonlySet<string> | null
): ProgressDto | null {
  if (!solved) return null;
  const published = new Map<string, boolean>();
  for (const link of collections) {
    for (const entry of link.collection.problems) {
      if (entry.problem.status === 'published') published.set(entry.problem.id, true);
    }
  }
  return {
    solved: [...published.keys()].filter((id) => solved.has(id)).length,
    total: published.size,
  };
}

export function toTrackDto(
  track: TrackWithContent,
  viewer: Pick<ViewerState, 'isWriter' | 'solved'>
): TrackDto {
  const collections = visibleCollections(track, viewer.isWriter);
  const problemIds = new Set<string>();
  for (const link of collections) {
    for (const entry of link.collection.problems) {
      if (entry.problem.status === 'published') problemIds.add(entry.problem.id);
    }
  }
  return {
    id: track.id,
    slug: track.slug,
    name: track.name,
    description: track.description,
    visibility: track.visibility,
    position: track.position,
    archived_at: track.archived_at?.toISOString() ?? null,
    created_at: track.created_at.toISOString(),
    collection_count: collections.length,
    problem_count: problemIds.size,
    progress: trackProgress(collections, viewer.solved),
  };
}

export function toTrackDetailDto(track: TrackWithContent, viewer: ViewerState): TrackDetailDto {
  const collections = visibleCollections(track, viewer.isWriter);
  return {
    ...toTrackDto(track, viewer),
    collections: collections.map((link) => {
      const links = visibleLinks(link.collection.problems, viewer.isWriter);
      return {
        ...toCollectionDto(link.collection),
        position: link.position,
        problems: links.map((entry) => toTrackProblemDto(entry, viewer)),
        progress: progressOf(link.collection.problems, viewer.solved),
      };
    }),
  };
}
