import type { SupabaseClient } from "@supabase/supabase-js";

import { db as anon } from "./chain";
import { isCountry } from "./countries";

/**
 * The part of a person this product stores, as opposed to the part it derives.
 *
 * Everything here is typed by the person and means nothing on chain. A name, a
 * handle, three links to places they are already found. None of it can sign,
 * none of it is checked, and a hackathon's result does not consult any of it.
 * That is the whole distinction the product is built on and it is why this file
 * knows nothing about wallets: what somebody holds is read from the chain, and
 * a page that let a profile claim an address would be inventing evidence.
 *
 * The row exists from the first session, written by a trigger, so every read
 * here is a read. Nothing in the interface may create one.
 */

export interface Profile {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarUrl: string | null;
  github: string | null;
  linkedin: string | null;
  x: string | null;
  /** ISO 3166-1 alpha-2, or absent. The name is a display decision. */
  country: string | null;
  city: string | null;
}

/** The columns as the schema spells them, in one place because two queries use them. */
const COLUMNS = "id, username, display_name, bio, avatar_url, github_username, linkedin_url";

/*
  The later columns, asked for together and dropped together.

  Code and schema do not deploy at the same instant, and asking for a column
  that is not there yet fails the whole select: a profile page that renders
  empty because one field is missing loses the other six as well. The list page
  learned this first and this is the same lesson.

  The fallback keeps `x_username`, which shipped a migration earlier than the
  location pair. A single step back to the original columns would drop a field
  that is certainly there to survive two that might not be.
*/
const WITH_LATER = `${COLUMNS}, x_username, country, city`;
const WITH_X = `${COLUMNS}, x_username`;

export async function profileOf(db: SupabaseClient, userId: string): Promise<Profile | null> {
  return read(db, "id", userId);
}

/**
 * The same profile, found the way a link to it finds one.
 *
 * Read with the anonymous key rather than the session, because a profile is
 * public and a page that needed somebody to be signed in to show one would be
 * a profile nobody could share. The policy in the schema already says so; this
 * only declines to ask for more than it needs.
 */
export async function profileNamed(username: string): Promise<Profile | null> {
  return anon === null ? null : read(anon, "username", username);
}

async function read(
  db: SupabaseClient,
  column: string,
  value: string,
): Promise<Profile | null> {
  const answer = await db
    .from("profiles")
    .select(WITH_LATER)
    .eq(column, value)
    .maybeSingle()
    .then((first) =>
      first.error === null
        ? first
        : db.from("profiles").select(WITH_X).eq(column, value).maybeSingle(),
    )
    .then((second) =>
      second.error === null
        ? second
        : db.from("profiles").select(COLUMNS).eq(column, value).maybeSingle(),
    );

  const row = answer.data as Record<string, unknown> | null;

  if (row === null) {
    return null;
  }

  return {
    id: String(row["id"] ?? ""),
    username: String(row["username"] ?? ""),
    displayName: text(row["display_name"]),
    bio: text(row["bio"]),
    avatarUrl: text(row["avatar_url"]),
    github: text(row["github_username"]),
    linkedin: text(row["linkedin_url"]),
    x: text(row["x_username"]),
    country: text(row["country"]),
    city: text(row["city"]),
  };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

/**
 * What a profile is allowed to be, checked here rather than only in the form.
 *
 * The same rules are constraints in the schema, and that is the belt this is
 * the braces for: the database is what actually holds the line, and this exists
 * so somebody who mistypes a handle is told which field and why instead of
 * being handed a Postgres constraint name.
 */
export const SHAPES = {
  username: /^[a-z0-9][a-z0-9_-]{2,29}$/,
  github: /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/,
  x: /^[A-Za-z0-9_]{1,15}$/,
  linkedin: /^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/.{1,180}$/,
} as const;

export interface ProfileEdit {
  username: string;
  displayName: string;
  bio: string;
  github: string;
  linkedin: string;
  x: string;
  country: string;
  city: string;
}

/** The first thing wrong with an edit, said the way the person would say it. */
export function whatIsWrong(edit: ProfileEdit): string | null {
  if (!SHAPES.username.test(edit.username)) {
    return "A username is three to thirty characters, lower case, and can hold digits, hyphens and underscores.";
  }

  if (edit.displayName.length > 60) {
    return "A display name is at most sixty characters.";
  }

  if (edit.bio.length > 500) {
    return "A bio is at most five hundred characters.";
  }

  if (edit.github.length > 0 && !SHAPES.github.test(edit.github)) {
    return "A GitHub username is the handle on its own, without the @ or the address around it.";
  }

  if (edit.x.length > 0 && !SHAPES.x.test(edit.x)) {
    return "An X handle is up to fifteen letters, digits or underscores, without the @.";
  }

  if (edit.linkedin.length > 0 && !SHAPES.linkedin.test(edit.linkedin)) {
    return "A LinkedIn link is the full https://linkedin.com/… address.";
  }

  /* The form offers a list, so anything else arrived by other means and is
     refused rather than stored as a country nothing can render. */
  if (edit.country.length > 0 && !isCountry(edit.country)) {
    return "That is not a country we know.";
  }

  if (edit.city.length > 60) {
    return "A city is at most sixty characters.";
  }

  return null;
}

/**
 * Somebody's name, whatever we have to make one out of.
 *
 * Order matters. What they typed beats what Google told us, which beats the
 * handle the trigger generated, because each step is more theirs than the one
 * after it.
 */
export function nameOf(profile: Profile | null, fromProvider: string | null): string {
  return profile?.displayName ?? fromProvider ?? profile?.username ?? "Your account";
}

/**
 * The picture the sign in provider handed over, for somebody who has not
 * uploaded one. Google sends it as `avatar_url` and also as `picture`.
 *
 * Sign up copies it into the profile, so this only matters for an account the
 * copy has not reached; it keeps the header and the settings page showing the
 * same face either way.
 */
export function providerPicture(meta: Record<string, unknown> | undefined): string | null {
  for (const field of ["avatar_url", "picture"]) {
    const value = meta?.[field];

    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }

  return null;
}
