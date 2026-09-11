// lib/slug.ts
//
// Public, URL-safe game slugs, e.g. playloop.app/play/xK3fQ2mN. Short,
// unguessable enough to sit on a public path, stable once minted.
//
// This module only knows how to mint a candidate — uniqueness against
// existing games is enforced by the caller (lib/db/queries.ts publishGame),
// which retries generateSlug() on collision.

import { nanoid } from "nanoid";

const DEFAULT_SLUG_LENGTH = 8;

/** nanoid's default alphabet (A-Za-z0-9_-) is already URL-safe, so this is
 * a thin, intention-revealing wrapper rather than a custom alphabet. */
export function generateSlug(length: number = DEFAULT_SLUG_LENGTH): string {
  return nanoid(length);
}
