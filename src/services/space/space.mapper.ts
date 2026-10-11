import type { Space } from '../../../generated/prisma/client';
import type { Role } from '@/services/space/space.access';

export interface SpaceDto {
  id: string;
  name: string;
  slug: string;
  description: string;
  visibility: 'public' | 'private';
  is_personal: boolean;
  archived_at: string | null;
  created_at: string;
  my_role: Role | null;
  member_count?: number;
}

export interface Page<T> {
  items: T[];
  page: number;
  page_size: number;
  total: number;
}

export function toSpaceDto(space: Space, role: Role | null, memberCount?: number): SpaceDto {
  return {
    id: space.id,
    name: space.name,
    slug: space.slug,
    description: space.description,
    visibility: space.visibility,
    is_personal: space.is_personal,
    archived_at: space.archived_at?.toISOString() ?? null,
    created_at: space.created_at.toISOString(),
    my_role: role,
    ...(memberCount !== undefined ? { member_count: memberCount } : {}),
  };
}
