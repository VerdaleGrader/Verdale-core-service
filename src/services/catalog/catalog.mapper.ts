import type { Track, Collection } from '../../../generated/prisma/client';

/** Solved problems out of the problems that count (published, in the Collections of the Track). */
export interface ProgressDto {
  solved: number;
  total: number;
}

export interface ProblemRefDto {
  slug: string;
  title: string;
  status: 'draft' | 'published' | 'archived';
  /** The signed-in person's own result; null for a visitor. */
  my_result: { solved: boolean; last_verdict: string | null } | null;
}

export interface TrackDto {
  id: string;
  name: string;
  slug: string;
  description: string;
  privacy: 'space' | 'members';
  position: number;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export interface CollectionDto {
  id: string;
  name: string;
  slug: string;
  description: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export function toTrackDto(track: Track): TrackDto {
  return {
    id: track.id,
    name: track.name,
    slug: track.slug,
    description: track.description,
    privacy: track.privacy,
    position: track.position,
    archived: track.archived_at !== null,
    created_at: track.created_at.toISOString(),
    updated_at: track.updated_at.toISOString(),
  };
}

export function toCollectionDto(collection: Collection): CollectionDto {
  return {
    id: collection.id,
    name: collection.name,
    slug: collection.slug,
    description: collection.description,
    archived: collection.archived_at !== null,
    created_at: collection.created_at.toISOString(),
    updated_at: collection.updated_at.toISOString(),
  };
}

const NAME_REPLACEMENTS = /[^a-z0-9_-]+/g;

/** "Intro to Graphs!" -> "intro-to-graphs". Empty for names with no latin letters or digits. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(NAME_REPLACEMENTS, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 64)
    .replace(/[-_]+$/g, '');
}
