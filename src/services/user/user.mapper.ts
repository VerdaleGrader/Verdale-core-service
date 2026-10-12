import type { User } from '../../../generated/prisma/client';

/** What the owner of an account sees about themselves. */
export interface SessionUser {
  id: string;
  email: string;
  username: string;
  display_name: string;
  /** The provider's picture, or null (the web app shows initials). */
  avatar_url: string | null;
  created_at: string;
}

/** What anyone else sees: no e-mail, no id (GRD-12). */
export interface PublicUser {
  username: string;
  display_name: string;
  avatar_url: string | null;
}

export function toSessionUser(user: User): SessionUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    display_name: user.display_name,
    avatar_url: user.avatar_url,
    created_at: user.created_at.toISOString(),
  };
}

export function toPublicUser(user: {
  username: string;
  display_name: string;
  avatar_url?: string | null;
}): PublicUser {
  return {
    username: user.username,
    display_name: user.display_name,
    avatar_url: user.avatar_url ?? null,
  };
}
