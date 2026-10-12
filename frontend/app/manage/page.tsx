import { ButtonLink, Eyebrow, Measure } from "../components/primitives";
import { HackathonCard } from "../components/hackathon-card";
import { Mine } from "./mine";
import { listHackathons } from "../../lib/chain";
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
 *
 * The events are drawn as the same cards the public list uses, so an organizer
 * picks theirs out by the banner they chose. Which wallet is connected is only
 * known in the browser, so `Mine` writes it into the address and this renders
 * the cards for it; an address is public on chain, so nothing is exposed.
 */

export const dynamic = "force-dynamic";

/** Enough for any one organizer; the public list pages at twelve. */
const ALL_OF_THEM = 60;

export default async function Manage({ searchParams }: PageProps<"/manage">) {
  const asked = await searchParams;
  const named = asked["organizer"];
  const organizer =
    typeof named === "string" && /^G[A-Z2-7]{55}$/.test(named) ? named : null;

  const user = await currentUser();
  const db = user === null ? null : await serverClient();

  const [allowed, hackathons] = await Promise.all([
    db === null ? false : mayOrganize(db),
    organizer === null ? [] : listHackathons({ organizer, limit: ALL_OF_THEM }).catch(() => []),
  ]);

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

      <Measure wide className="py-16">
        <Mine organizer={organizer} described={hackathons.map((h) => h.contract_id)}>
          {hackathons.length > 0 && (
            <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
              {hackathons.map((hackathon) => (
                <HackathonCard
                  key={hackathon.contract_id}
                  hackathon={hackathon}
                  href={`/manage/${hackathon.contract_id}`}
                />
              ))}
            </div>
          )}
        </Mine>
      </Measure>
    </main>
  );
}
