import { JudgeConsole } from "./console";
import { nameOf } from "../../../lib/chain";

/**
 * The judge's one visit.
 *
 * Keyed on the contract rather than on a name, for the same reason the
 * organizer's console is: a judge is given an address by the organizer, and
 * making them wait for our indexer to have caught up before they can score is
 * the wrong thing to make anybody wait for.
 *
 * Laid out as the organizer's panel is, because it is the same kind of room: a
 * desk somebody was sent to with a job on it. It used to open with a display
 * heading that said "Score" and a hatched band under it, which is the language
 * the marketing pages use to introduce the product to somebody who has not
 * decided yet. A judge has decided.
 */

export const dynamic = "force-dynamic";

export default async function Judge({ params }: PageProps<"/judge/[contract]">) {
  const { contract } = await params;
  const written = await nameOf(contract);

  return (
    <main className="flex-1">
      <div className="mx-auto w-full max-w-[60rem] px-6 py-10 sm:py-12">
        <p className="label text-[0.8125rem] tracking-[0.16em] text-ink-faint">Judging Panel</p>

        <h1 className="mt-2 text-[clamp(1.75rem,3.5vw,2.5rem)]">
          {written?.name ?? "Scoring"}
        </h1>
      </div>

      <div className="mx-auto w-full max-w-[60rem] px-6 pb-24">
        <JudgeConsole contractId={contract} />
      </div>
    </main>
  );
}
