import { ButtonLink, Eyebrow, Measure } from "../components/primitives";
import { Mine } from "./mine";
import { currentUser, serverClient } from "../../lib/supabase/server";
import { mayOrganize } from "../../lib/organizing";

/**
 * Everything one organizer is running, in one place.
 *
 * Deliberately not gated on the grant. Approval decides who may create an
 * event; this page reports what a key already created, and somebody whose grant
 * was taken back still has an event in flight with hackers waiting on their
 * approvals. Locking them out of it would punish the participants for a decision
 * about the organizer.
 *
 * The grant only decides whether the button to start another one is offered.
 */

export const dynamic = "force-dynamic";

export default async function Manage() {
  const user = await currentUser();
  const db = user === null ? null : await serverClient();
  const allowed = db === null ? false : await mayOrganize(db);

  return (
    <main className="flex-1">
      <section className="border-b border-rule">
        <Measure wide className="py-16 sm:py-20">
          <Eyebrow>Management Panel</Eyebrow>

          <div className="mt-4 flex flex-wrap items-end justify-between gap-6">
            <h1 className="text-[clamp(2rem,4.5vw,3rem)]">Your hackathons</h1>

            {allowed && (
              <ButtonLink href="/create" size="sm">
                Create a hackathon
              </ButtonLink>
            )}
          </div>
        </Measure>
      </section>

      <Measure className="py-16">
        <Mine />
      </Measure>
    </main>
  );
}
