import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AvatarPicker } from "./avatar-picker";
import { Prizes } from "./prizes";
import { WalletLink } from "./wallet-link";
import { Measure } from "../components/primitives";
import { countriesByName } from "../../lib/countries";
import { ProfileForm } from "./profile-form";
import { SignOut } from "../components/session";
import { currentUser, serverClient } from "../../lib/supabase/server";
import { nameOf, profileOf, providerPicture, type Profile } from "../../lib/profile";

/**
 * Everything about the account somebody can change.
 *
 * This was the profile for a while and it was two pages wearing one name. A
 * profile is read: it shows what has been filled in and nothing else, and
 * `/u/[username]` is where that lives now. Settings is worked: every field is a
 * box whether or not it holds anything, the empty ones are the point, and the
 * page ends in a save.
 *
 * The wallet is not on it. It was, at the top, on the argument that it is the
 * only thing that decides what somebody can do — but the header carries it on
 * every page including this one, and two controls for one connection is one of
 * them showing a stale answer eventually.
 */

/** Read fresh. A page that shows a stale session is showing somebody else's. */
export const dynamic = "force-dynamic";

export default async function Account() {
  const user = await currentUser();

  /* One door, and it is `/login`. This page used to draw its own sign in form,
     which meant two surfaces could disagree about what signing in looks like
     and one of them would eventually be the stale one. */
  if (user === null) {
    redirect("/login?next=%2Faccount");
  }

  const db = await serverClient();

  /* Created by a trigger the moment the account exists, so this is a read
     rather than an upsert. A page that had to create a profile would be a
     second, weaker place where identity begins. */
  const profile = db === null ? null : await profileOf(db, user.id);

  /*
    What the provider told us about them. The name is offered as a default and
    never written, because a field that fills itself in is a field nobody knows
    they can change. The picture is the exception: it is copied to the profile
    at sign up so other people see a face, and it is replaced here like any
    other. The fallback below covers an account from before that.
  */
  const meta = user.user_metadata as Record<string, unknown> | undefined;
  const suggestedName = pick(meta, "full_name") ?? pick(meta, "name");
  const suggestedAvatar = providerPicture(meta);

  const name = nameOf(profile, suggestedName);
  const avatar = profile?.avatarUrl ?? suggestedAvatar;

  return (
    <main className="flex-1">
      <section className="border-b border-rule">
        <Measure wide className="py-12 sm:py-14">
          {/* The title on its own line, above everything it titles. Beside the
              portrait it was competing with a face for the top left corner and
              no amount of nudging it up made it read as the name of the page
              rather than as a label on the picture. */}
          <h1 className="text-[clamp(2rem,4.5vw,3rem)]">Settings</h1>

          <div className="mt-9 flex min-w-0 items-center gap-4">
            <AvatarPicker userId={user.id} src={avatar} name={name} />

            <p className="min-w-0 truncate text-[1.1875rem] text-ink">{name}</p>
          </div>
        </Measure>
      </section>

      <Measure wide className="py-14">
        <div className="grid max-w-[52rem] gap-14">
          {profile === null ? (
            <p className="text-[1rem] leading-relaxed text-ink-soft">
              Your profile could not be read on this deployment, so there is
              nothing to edit here yet.
            </p>
          ) : (
            <ProfileForm
              profile={profile}
              email={user.email ?? null}
              countries={countriesByName()}
              suggestedName={suggestedName}
            />
          )}

          {/* Above the sign out, because it is the last thing somebody sets up
              rather than the last thing they do. */}
          <Block title="Wallet">
            <WalletLink />
          </Block>

          {/* Under the wallet, because it is the wallet's contents. A person
              with no prizes sees one sentence saying so rather than nothing,
              which would read as a section that failed to load. */}
          <Block title="Prizes">
            <Prizes />
          </Block>

          <Block title="Session">
            <SignOut />
          </Block>
        </div>
      </Measure>
    </main>
  );
}

/**
 * A section, named and nothing else.
 *
 * Each of these carried a line of grey explanation under its heading and all of
 * them said something the section below already showed. A page that explains
 * itself twice reads as a page that does not trust the reader to look.
 */
function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-[1.4375rem]">{title}</h2>

      <div className="mt-6">{children}</div>
    </section>
  );
}

function pick(meta: Record<string, unknown> | undefined, field: string): string | null {
  const value = meta?.[field];

  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
