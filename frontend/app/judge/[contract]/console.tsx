"use client";

import { useCallback, useEffect, useState } from "react";

import { Button } from "../../components/primitives";
import { Mark, Web } from "../../components/marks";
import { SpecLabel, SpecRow, SpecRows, SpecValue } from "../../components/spec";
import { useWallet } from "../../components/wallet-context";
import { entriesOf, type Entry } from "../../../lib/submissions";
import { phaseOf } from "../../../lib/running";
import { phaseName } from "../../../lib/phase";
import { rulesFor, type Rules } from "../../../lib/rules";
import { rubricOf, type Rubric } from "../../../lib/rubric";
import { titleOf } from "../../../lib/words";
import type { Card } from "../../../lib/project";
import {
  inclusionOf,
  leafOf,
  payloadFor,
  sealingConfigured,
  submitScorecard,
  type Inclusion,
} from "../../../lib/judge";
import { rememberCard, sealedCardsOf, type SealedCard } from "../../../lib/judged";
import { proveAddress } from "../../../lib/wallet";
import { toHex } from "../../../lib/hex";
import { AiReviewPanel } from "./ai-review";

/**
 * Scoring, in one sitting and at no cost to the judge.
 *
 * A card is signed in the wallet and handed to the collection service, which
 * publishes only a root until the reveal. That service is the one place in this
 * product carrying real trust, and the two things that bound it are both on
 * this page: the signature, so it cannot invent a card, and the receipt, so it
 * cannot quietly drop one.
 *
 * The receipt is the judge's, not ours, and it is what they produce if their
 * card turns out to be missing from the tree. It is kept whole and kept folded:
 * the screen after sealing answers whether the card went in, and the proof is a
 * word away for the day somebody needs it.
 */

export function JudgeConsole({ contractId }: { contractId: string }) {
  const { wallet, known } = useWallet();
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [rubric, setRubric] = useState<Rubric[] | null>(null);
  const [phase, setPhase] = useState<number | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  /* How each project presents itself. The contract pins a digest and a link,
     and a judge asked to mark "team 3" against four criteria is being asked to
     mark a number. The name, the mark and the line under them are written on
     our side and come from the same place the public gallery draws them. */
  const [cards, setCards] = useState<Record<number, Card>>({});
  const [held, setHeld] = useState<Record<number, SealedCard>>({});
  const [busy, setBusy] = useState<number | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  /* How this judge is working through the entries. Manual is the scoresheets
     below; the AI review reads everything first and hands back a ranking. The
     cards that count are signed by hand either way. */
  const [mode, setMode] = useState<"manual" | "ai">("manual");
  /* The projects the AI review sent here to be scored, or every one. */
  const [focus, setFocus] = useState<Set<number> | null>(null);

  const load = useCallback(async () => {
    const [found, tracks, at, frozen, drawn] = await Promise.all([
      entriesOf(contractId, false),
      rubricOf(contractId),
      phaseOf(contractId),
      /* For the window this page lives inside. A judge arriving early or late
         should be told when their turn is, not that the hackathon "is not
         there". */
      rulesFor(contractId).catch(() => null),
      fetch(`/api/cards?contract=${contractId}`)
        .then((answer) => answer.json() as Promise<{ cards: Record<number, Card> }>)
        .then((said) => said.cards)
        /* Artwork and titles are ours rather than the chain's, so losing them
           costs the page its looks and not its work: the entries, the rubric
           and the deadline all still arrived. */
        .catch(() => ({}) as Record<number, Card>),
    ]);

    setEntries(found);
    setRubric(tracks);
    setPhase(at);
    setRules(frozen);
    setCards(drawn);
  }, [contractId]);

  useEffect(() => {
    void load();
  }, [load]);

  /* What this judge already handed in, read back from their own browser. A
     sealed card cannot be asked about — that is what sealing it means — so a
     page with nowhere to look showed an empty form for work already done.
     Cleared when the wallet goes, because the next key to connect is a
     different judge and these are not their marks. */
  const address = wallet?.address ?? null;

  useEffect(() => {
    setHeld(address === null ? {} : sealedCardsOf(contractId, address));
  }, [contractId, address]);

  /*
    The wallet is not waited on.

    Nothing above depends on it: the projects and the rubric come from the
    contract, and only signing needs a key. Holding the whole page until the
    kit has loaded and the extension has answered meant a judge with a wallet
    already connected waited longer than one without, which is backwards.
  */
  if (entries === null || rubric === null) {
    return <p className="label text-ink-faint">Reading the contract</p>;
  }

  if (!sealingConfigured()) {
    return (
      <Standing phase={phase}>
        No collection service is configured for this deployment, so there is
        nowhere to hand a scorecard.
      </Standing>
    );
  }

  const scoreable = entries.filter((entry) => !entry.invalid);
  const sealed = scoreable.filter((entry) => held[entry.team] !== undefined).length;
  const shown = focus === null ? scoreable : scoreable.filter((entry) => focus.has(entry.team));

  /* This judge's own cards, highest first. Read from what the browser kept of
     each signed card, so it is only ever this judge's marks: everybody's cards
     stay sealed until the reveal, and the combined ranking is the contract's. */
  const board = (
    <Scoreboard
      rows={scoreable
        .filter((entry) => held[entry.team] !== undefined)
        .map((entry) => ({
          team: entry.team,
          track: entry.track,
          card: cards[entry.team],
          total: (rubric.find((track) => track.track === entry.track)?.criteria ?? []).reduce(
            (sum, criterion) => sum + (held[entry.team]?.marks?.[criterion.id] ?? 0),
            0,
          ),
        }))}
    />
  );

  /* Cards are only collected while the judging window is open. Outside it the
     service refuses them, so the page says when the window is rather than
     offering a form that cannot be handed in. */
  const manual =
    phase === null || phase < 4 ? (
      <Standing phase={phase}>
        {phase !== null && phase < 4 ? (
          <>
            Scoring has not opened yet. It starts when the entry check ends
            {rules !== null && rules.schedule.screeningCloses > 0 && (
              <>
                , <Moment at={rules.schedule.screeningCloses} />
              </>
            )}
            , and closes
            {rules !== null && rules.schedule.judgingCloses > 0 ? (
              <>
                {" "}
                <Moment at={rules.schedule.judgingCloses} />.
              </>
            ) : (
              " at the deadline the rules named."
            )}
          </>
        ) : (
          "Scoring is over. The results are announced at the reveal."
        )}
      </Standing>
    ) : phase > 4 ? (
      <div className="space-y-8">
        <Standing phase={phase}>The results are announced at the reveal.</Standing>
        {board}
      </div>
    ) : (
      <div className="space-y-8">
        {scoreable.length === 0 ? (
          <p className="max-w-[38rem] text-[1rem] leading-relaxed text-ink-soft">
            No projects to score.
          </p>
        ) : (
          <>
            {focus !== null && (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[0.75rem] bg-paper-sunk px-5 py-3 ring-1 ring-inset ring-rule">
                <p className="text-[0.9375rem] text-ink-soft">
                  {shown.length === 1
                    ? "Showing the one project you picked from the AI review."
                    : `Showing the ${shown.length} projects you picked from the AI review.`}
                </p>

                <Button size="sm" intent="ghost" onClick={() => setFocus(null)}>
                  Show all {scoreable.length}
                </Button>
              </div>
            )}

            {shown.map((entry) => (
              <Scoresheet
                key={entry.team}
                entry={entry}
                card={cards[entry.team]}
                criteria={rubric.find((track) => track.track === entry.track)?.criteria ?? []}
                judge={address}
                ready={known && rules !== null}
                contractId={contractId}
                revealAt={rules?.schedule.judgingCloses ?? null}
                held={held[entry.team]}
                busy={busy === entry.team}
                onBusy={(going) => setBusy(going ? entry.team : null)}
                onHeld={(next) => setHeld({ ...held, [entry.team]: next })}
                onRefused={setRefused}
              />
            ))}
          </>
        )}

        {refused !== null && (
          <p className="max-w-[46rem] text-[0.9375rem] leading-relaxed text-broken">{refused}</p>
        )}

        {scoreable.length > 0 && sealed === scoreable.length && board}
      </div>
    );

  /* The AI review opens with the entry check, so a judge can have a ranking
     in hand before scoring starts. Outside both windows there is nothing for
     either way of working to do. */
  if (phase !== 3 && phase !== 4) {
    return manual;
  }

  return (
    <div className="space-y-8">
      <Ways mode={mode} onMode={setMode} />

      {mode === "ai" ? (
        <AiReviewPanel
          contractId={contractId}
          phase={phase}
          entries={entries}
          cards={cards}
          rubric={rubric}
          onScore={(teams) => {
            setFocus(teams);
            setMode("manual");
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
        />
      ) : (
        manual
      )}
    </div>
  );
}

/**
 * The two ways to work through the entries, chosen at the top of the desk.
 *
 * Side by side rather than as a setting, because they are equal: scoring each
 * project by hand is not the fallback for somebody who did not want the AI, and
 * the AI review is not a shortcut past the scoring. Both end at the same signed
 * cards.
 */
function Ways({
  mode,
  onMode,
}: {
  mode: "manual" | "ai";
  onMode: (mode: "manual" | "ai") => void;
}) {
  const ways = [
    {
      key: "manual" as const,
      title: "Manual review",
      body: "Open each project and score it yourself on each criterion.",
    },
    {
      key: "ai" as const,
      title: "AI review",
      body: "The AI reads every project first and ranks them on the same criteria. You still decide each score.",
    },
  ];

  return (
    <div role="radiogroup" aria-label="How to review" className="grid gap-3 sm:grid-cols-2">
      {ways.map((way) => {
        const chosen = mode === way.key;

        return (
          <button
            key={way.key}
            type="button"
            role="radio"
            aria-checked={chosen}
            onClick={() => onMode(way.key)}
            className={`rounded-[1.25rem] p-5 text-left transition-shadow duration-150 ease-settle sm:p-6 ${
              chosen ? "bg-paper ring-2 ring-ink" : "bg-paper-sunk ring-1 ring-rule hover:ring-rule-strong"
            }`}
          >
            <span className="flex items-center gap-2.5">
              <span
                aria-hidden
                className={`grid size-4 place-items-center rounded-full ring-1 ${
                  chosen ? "ring-ink" : "ring-rule-strong"
                }`}
              >
                {chosen && <span className="size-2 rounded-full bg-ink" />}
              </span>

              <span className="text-[1.0625rem] font-semibold text-ink">{way.title}</span>
            </span>

            <span className="mt-2 block text-[0.9375rem] leading-relaxed text-ink-soft">
              {way.body}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * Why there is nothing to do, in the same card the work would have been in.
 *
 * A bare sentence on an empty page reads as a surface that failed to load. The
 * phase is named beside it for the same reason the organizer's panel names it:
 * it is the one fact that explains every other thing on the screen.
 */
/**
 * The judge's own cards as a table, highest total first.
 *
 * Only what this browser signed. The scores everybody handed in are sealed
 * until the reveal, so a combined table here would be either empty or a leak;
 * the ranking that decides anything is on the results page once it opens.
 */
function Scoreboard({
  rows,
}: {
  rows: { team: number; track: string; card: Card | undefined; total: number }[];
}) {
  if (rows.length === 0) {
    return null;
  }

  const ranked = [...rows].sort((a, b) => b.total - a.total || a.team - b.team);

  return (
    <section className="rounded-[1.25rem] bg-paper p-6 ring-1 ring-rule sm:p-8">
      <h2 className="text-[1.5rem] font-semibold text-ink">Your scores</h2>

      <ol className="mt-5 border-t border-rule">
        {ranked.map((row, at) => (
          <li key={row.team} className="flex items-center gap-4 border-b border-rule py-3.5">
            <span className="tabular w-7 shrink-0 text-[1rem] font-semibold text-ink-faint">
              {at + 1}
            </span>

            {row.card?.logoUrl ? (
              <img
                src={row.card.logoUrl}
                alt=""
                className="size-9 shrink-0 rounded-[0.4rem] object-cover ring-1 ring-rule"
              />
            ) : (
              <span aria-hidden className="size-9 shrink-0 rounded-[0.4rem] bg-paper-sunk ring-1 ring-rule" />
            )}

            <span className="min-w-0 flex-1">
              <span className="block truncate text-[1rem] font-semibold text-ink">
                {row.card?.title ?? row.card?.teamName ?? `Team ${row.team}`}
              </span>
              <span className="label text-[0.75rem] text-ink-faint">{titleOf(row.track)}</span>
            </span>

            <span className="tabular shrink-0 text-[1.125rem] font-semibold text-ink">
              {figure(row.total)}
              <span className="text-[0.875rem] font-normal text-ink-faint"> / 100</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Standing({ phase, children }: { phase: number | null; children: React.ReactNode }) {
  return (
    <div className="rounded-[1.25rem] bg-paper p-8 ring-1 ring-rule sm:p-10">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-[1.25rem] font-semibold text-ink">
          {phase !== null && phase > 4 ? "Scoring is over" : "Nothing to score yet"}
        </p>

        <p className="label text-ink-faint">{phaseName(phase)}</p>
      </div>

      <p className="mt-3 max-w-[40rem] text-[1rem] leading-relaxed text-ink-soft">{children}</p>
    </div>
  );
}

/** A moment in the reader's own clock, which is the one a deadline is read in. */
function Moment({ at }: { at: number }) {
  return (
    <span suppressHydrationWarning className="text-ink">
      {new Date(at * 1000).toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })}
    </span>
  );
}

/**
 * One project, and the marks it is being given.
 *
 * The project on the left and the rubric on the right, because that is the
 * order the work happens in: a judge looks at what was built and then decides
 * what it was worth. It used to be a track name, a team number and a link,
 * which asked somebody to score an entry they could not see.
 */
function Scoresheet({
  entry,
  card,
  criteria,
  judge,
  ready,
  contractId,
  revealAt,
  held,
  busy,
  onBusy,
  onHeld,
  onRefused,
}: {
  entry: Entry;
  /** How the project presents itself, absent when nobody wrote anything. */
  card: Card | undefined;
  criteria: { id: string; weightBps: number }[];
  judge: string | null;
  ready: boolean;
  contractId: string;
  revealAt: number | null;
  held: SealedCard | undefined;
  busy: boolean;
  onBusy: (going: boolean) => void;
  onHeld: (next: SealedCard) => void;
  onRefused: (why: string | null) => void;
}) {
  const [scores, setScores] = useState<Record<string, string>>({});

  const filled =
    criteria.length > 0 &&
    criteria.every((criterion) => (scores[criterion.id] ?? "").length > 0);

  /* What the card adds up to so far. The weights total ten thousand basis
     points by the contract's own rule, so the marks total a hundred and the
     running figure needs no scaling to be read. */
  const given = criteria.reduce(
    (sum, criterion) => sum + (Number(scores[criterion.id] ?? 0) || 0),
    0,
  );

  /* What the sealed card came to. Read from what was kept rather than from the
     form, because after a reload the form is empty and the card is not. */
  const marked = criteria.reduce(
    (sum, criterion) => sum + (held?.marks?.[criterion.id] ?? 0),
    0,
  );

  async function submit() {
    if (judge === null || revealAt === null) {
      return;
    }

    onBusy(true);
    onRefused(null);

    try {
      const scorecard = {
        judge,
        team: entry.team,
        scores: criteria.map((criterion) => ({
          criterion: criterion.id,
          /* The form marks out of the criterion's own weight, because that is
             how a rubric is read: forty percent is forty of the hundred. The
             contract keeps every criterion on its own nought to a hundred
             scale and applies the weight itself, so the two are reconciled
             here, at the last moment before the leaf is hashed. */
          score: rawOf(Number(scores[criterion.id] ?? 0) || 0, worthOf(criterion)),
        })),
      };

      const leaf = await leafOf(scorecard);

      /* The wallet signs the leaf's hexadecimal text. Nothing about the card
         itself is handed to the wallet, so what a judge approves is a digest
         rather than a form they would have to reread. */
      const signature = await proveAddress(judge, payloadFor(leaf));
      const receipt = await submitScorecard(
        contractId,
        scorecard,
        leaf,
        hexFrom(signature),
        revealAt,
      );

      /* The marks kept alongside the receipt, on the rubric's own scale rather
         than the contract's. They are what this judge typed, and typing them
         is the one thing reopening the page used to undo. */
      const marks = Object.fromEntries(
        criteria.map((criterion) => [criterion.id, Number(scores[criterion.id] ?? 0) || 0]),
      );
      const sealed = { receipt, leaf: toHex(leaf), marks };

      rememberCard(contractId, judge, entry.team, sealed);
      onHeld(sealed);
    } catch (error) {
      /* A browser that cannot reach the service at all says only "Failed to
         fetch", which tells a judge nothing about what to do. */
      const said = error instanceof Error ? error.message : "";

      onRefused(
        said.includes("Failed to fetch") || said.length === 0
          ? "Could not reach the collection service. It may not be running."
          : said,
      );
    } finally {
      onBusy(false);
    }
  }

  /* The same card the create form and the organizer's panel are built from,
     split down the middle: what was built on the left, what it is being given
     on the right. */
  return (
    <section className="rounded-[1.25rem] bg-paper p-6 ring-1 ring-rule sm:p-8">
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] lg:gap-12">
        <div>
          <SpecLabel index={String(entry.team)}>{titleOf(entry.track)}</SpecLabel>

          <div className="relative mt-4 aspect-[16/7] overflow-hidden rounded-[0.75rem] bg-paper-sunk">
            {card?.bannerUrl == null ? (
              <div className="hatch size-full" aria-hidden />
            ) : (
              <img src={card.bannerUrl} alt="" className="size-full object-cover" />
            )}
          </div>

          <div className="relative z-10 -mt-7 mb-3 ml-1 size-12 overflow-hidden rounded-full border border-rule bg-paper">
            {card?.logoUrl == null ? (
              <div className="hatch size-full" aria-hidden />
            ) : (
              <img src={card.logoUrl} alt="" className="size-full object-cover" />
            )}
          </div>

          {/* The name, at the size a name is read at. A judge scoring six
              projects in a sitting needs to know which one is in front of
              them without reading a team number off a label. */}
          <h2 className="text-[1.375rem] font-semibold leading-tight text-ink">
            {card?.title ?? `Team ${entry.team}`}
          </h2>

          {card?.summary != null && (
            <p className="mt-2 text-[0.9375rem] leading-relaxed text-ink-soft">
              {card.summary}
            </p>
          )}

          {card?.teamName != null && (
            <p className="mt-2 text-[0.8125rem] text-ink-faint">by {card.teamName}</p>
          )}

          {/* Everything the team pinned, in one row. The entry's own link is
              the chain's and is always there; the rest are ours and appear
              only when the team filled them in. */}
          <div className="mt-4 flex flex-wrap gap-2">
            {/* The project's own page here, which is the address the team
                pinned on chain when they entered. */}
            <Visit href={entry.uri}>Project</Visit>

            {card?.repositoryUrl != null && (
              <Visit href={card.repositoryUrl} icon={<Mark where="github" />}>
                GitHub
              </Visit>
            )}

            {card?.liveUrl != null && (
              <Visit href={card.liveUrl} icon={<Web />}>
                Live
              </Visit>
            )}

            {card?.demoVideoUrl != null && (
              <Visit href={card.demoVideoUrl} icon={<Mark where="youtube" />}>
                Demo
              </Visit>
            )}
          </div>
        </div>

        {held === undefined ? (
          <div>
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <SpecLabel>Your marks</SpecLabel>

              {/* What the card comes to, kept in view while it is filled in.
                  The weights add up to a hundred, so this is the project's
                  score out of a hundred and not an arbitrary sum. */}
              <p className="tabular text-[0.875rem] text-ink-faint">
                {figure(given)} / 100
              </p>
            </div>

            {criteria.length === 0 ? (
              <p className="mt-4 text-[0.9375rem] leading-relaxed text-ink-soft">
                The frozen rules name no criteria for this category, so there is
                nothing to mark against.
              </p>
            ) : (
              <div className="mt-3 border-t border-rule">
                {criteria.map((criterion) => {
                  const worth = worthOf(criterion);

                  return (
                    <label
                      key={criterion.id}
                      className="flex items-center justify-between gap-4 border-b border-rule py-3.5"
                    >
                      <span className="min-w-0">
                        <span className="block text-[1rem] leading-tight text-ink">
                          {titleOf(criterion.id)}
                        </span>

                        {/* The weight said as points rather than as a
                            percentage, because points is what is being typed
                            into the box beside it. */}
                        <span className="label mt-1 block text-ink-faint">
                          worth {figure(worth)} of the 100
                        </span>
                      </span>

                      <span className="flex shrink-0 items-center gap-2">
                        <input
                          value={scores[criterion.id] ?? ""}
                          onChange={(event) =>
                            setScores({
                              ...scores,
                              [criterion.id]: within(event.target.value, worth),
                            })
                          }
                          inputMode="decimal"
                          placeholder="0"
                          aria-label={`${titleOf(criterion.id)}, out of ${figure(worth)}`}
                          className="tabular h-10 w-20 rounded-[0.5rem] bg-paper-sunk px-3 text-right text-[1rem] text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-2 focus:ring-ink"
                        />

                        <span className="label w-12 text-ink-faint">
                          of {figure(worth)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-4">
              <Button
                disabled={busy || !filled || judge === null}
                onClick={() => void submit()}
              >
                {busy ? "Confirm in your wallet" : "Submit score"}
              </Button>

              {/* Only the button waits on the wallet, and it says why rather
                  than sitting there greyed out for a reason nobody can see. */}
              {judge === null && (
                <p className="text-[0.9375rem] leading-relaxed text-ink-soft">
                  {ready
                    ? "Connect your judge wallet to submit."
                    : "Checking your wallet"}
                </p>
              )}
            </div>
          </div>
        ) : (
          /* What a judge came here to find out: that the card went in, and what
             was on it. It used to be three runs of hexadecimal and a button to
             ask a service about a fourth — all of it true, none of it an
             answer — and after a reload it was an empty form. */
          <div>
            <p className="label flex items-center gap-2 text-verified">
              <span aria-hidden className="size-1.5 rounded-full bg-verified" />
              Score submitted
            </p>

            <div className="mt-3 border-t border-rule">
              {criteria.map((criterion) => (
                <div
                  key={criterion.id}
                  className="flex items-baseline justify-between gap-4 border-b border-rule py-3"
                >
                  <span className="min-w-0 text-[1rem] text-ink">
                    {titleOf(criterion.id)}
                  </span>

                  <span className="tabular shrink-0 text-[1rem] text-ink">
                    {figure(held.marks?.[criterion.id] ?? 0)}
                    <span className="label ml-2 text-ink-faint">
                      of {figure(worthOf(criterion))}
                    </span>
                  </span>
                </div>
              ))}
            </div>

            <p className="tabular mt-4 text-[2rem] font-bold leading-none text-ink">
              {figure(marked)}
              <span className="ml-1 text-[1rem] font-normal text-ink-faint">/ 100</span>
            </p>

            <p className="mt-3 max-w-[34rem] text-[0.9375rem] leading-relaxed text-ink-soft">
              Hidden from everyone until the results are announced.
            </p>

            <Kept contractId={contractId} held={held} />
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The judge's recourse, folded away.
 *
 * Every line of it is worth keeping — the leaf is what their card hashes to,
 * the signature is what the service cannot forge, and the inclusion check is
 * how they find out whether the card reached the tree. None of it is what
 * somebody wants in front of them the moment they finish scoring, and putting
 * it there meant the one fact they were waiting for arrived buried in ninety
 * characters of hexadecimal.
 *
 * So it is behind a word rather than gone. A receipt nobody can act on proves
 * nothing, which is why the check came with it instead of being dropped.
 */
function Kept({ contractId, held }: { contractId: string; held: SealedCard }) {
  const [shown, setShown] = useState(false);
  const [included, setIncluded] = useState<Inclusion | null>(null);
  const [checking, setChecking] = useState(false);
  const [copied, setCopied] = useState(false);

  async function check() {
    setChecking(true);
    setIncluded(await inclusionOf(contractId, held.leaf));
    setChecking(false);
  }

  if (!shown) {
    return (
      <button
        type="button"
        onClick={() => setShown(true)}
        className="mt-5 text-[0.875rem] text-ink-faint underline-offset-4 transition-colors hover:text-ink-soft hover:underline"
      >
        Proof of submission
      </button>
    );
  }

  /* One block on the clipboard rather than three runs to select by hand. What
     a judge does with a receipt is keep it somewhere else. */
  const written = `leaf: ${held.leaf}\nsealer: ${held.receipt.sealer}\nsignature: ${held.receipt.signature}`;

  return (
    <div className="mt-5 border-t border-rule pt-4">
      <SpecRows>
        <SpecRow index="1" label="Score fingerprint" mark>
          <SpecValue>{held.leaf}</SpecValue>
        </SpecRow>

        <SpecRow index="2" label="Received by">
          <SpecValue>{held.receipt.sealer}</SpecValue>
        </SpecRow>

        <SpecRow index="3" label="Confirmation">
          <SpecValue>{held.receipt.signature}</SpecValue>
        </SpecRow>

        <SpecRow index="4" label="Counted" mark={included?.at === "omitted"}>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`label ${tone(included)}`}>
                {checking ? "asking" : verdict(included)}
              </span>

              <Button size="sm" intent="quiet" disabled={checking} onClick={() => void check()}>
                {checking ? "Checking" : "Check now"}
              </Button>
            </div>

            {included?.at === "disagrees" && (
              <p className="max-w-[34rem] text-[0.875rem] leading-relaxed text-broken">
                Your score does not match what was published. Keep this proof
                and tell the organizer.
              </p>
            )}

            {included?.at === "omitted" && (
              <p className="max-w-[34rem] text-[0.875rem] leading-relaxed text-broken">
                Your score is missing from the published results. Keep this
                proof and tell the organizer.
              </p>
            )}
          </div>
        </SpecRow>
      </SpecRows>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(written).then(() => setCopied(true));
          }}
          className="text-[0.875rem] text-ink-faint underline-offset-4 transition-colors hover:text-ink-soft hover:underline"
        >
          {copied ? "Copied" : "Copy proof"}
        </button>

        <button
          type="button"
          onClick={() => setShown(false)}
          className="text-[0.875rem] text-ink-faint underline-offset-4 transition-colors hover:text-ink-soft hover:underline"
        >
          Hide
        </button>
      </div>

      <p className="mt-4 max-w-[34rem] text-[0.875rem] leading-relaxed text-ink-faint">
        Once the results are published, this shows your score was counted.
      </p>
    </div>
  );
}

/** Somewhere the team pinned something, opened where it will not lose the form. */
function Visit({
  href,
  icon,
  children,
}: {
  href: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-[0.875rem] font-semibold text-ink ring-1 ring-inset ring-rule transition-colors duration-150 ease-settle hover:bg-paper-sunk"
    >
      {icon}
      {children}
    </a>
  );
}

/** What one criterion is worth on a hundred point card. */
function worthOf(criterion: { weightBps: number }): number {
  return criterion.weightBps / 100;
}

/**
 * A mark out of the criterion's weight, as the contract wants it.
 *
 * Every criterion is nought to a hundred on chain and the weight is applied
 * there, so a thirty seven out of forty is a ninety two and a half out of a
 * hundred. The contract takes whole numbers, which puts the finest mark this
 * form can express at a hundredth of the criterion's weight — four tenths of a
 * point on a forty point criterion. Rounding here is the interface rounding,
 * which is the only place in this product allowed to.
 */
function rawOf(points: number, worth: number): number {
  if (worth <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((points / worth) * 100)));
}

/**
 * What was typed, kept inside the criterion.
 *
 * A mark above the weight is not a stricter judge, it is a card the rubric
 * cannot hold, so it is clamped as it is typed rather than refused at the end.
 * A decimal point is allowed through because a criterion worth forty is not
 * marked in whole numbers by everybody.
 */
function within(typed: string, worth: number): string {
  const kept = typed.replace(/[^0-9.]/g, "").replace(/(\.[^.]*)\./g, "$1");

  if (kept.length === 0) {
    return "";
  }

  const value = Number(kept);

  return Number.isFinite(value) && value > worth ? figure(worth) : kept.slice(0, 5);
}

/** A number as a rubric writes it: no trailing zero where it says nothing. */
function figure(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}

/**
 * What the check found, in a word.
 *
 * Nothing until it has been run. A page that says "no root yet" before anybody
 * asked is answering a question that was never put, and is wrong as often as it
 * is right.
 */
function verdict(found: Inclusion | null): string {
  if (found === null) {
    return "not checked yet";
  }

  switch (found.at) {
    case "included":
      return "yes, counted";
    case "omitted":
      return "missing";
    case "disagrees":
      return "does not match";
    case "waiting":
      return "results not published yet";
    case "unreachable":
      return found.why;
  }
}

function tone(found: Inclusion | null): string {
  if (found === null) {
    return "text-ink-faint";
  }

  return found.at === "included"
    ? "text-verified"
    : found.at === "omitted" || found.at === "disagrees"
      ? "text-broken"
      : "text-ink-faint";
}

/**
 * The service wants the signature as hex; a wallet returns base64.
 *
 * Converted here rather than at either end, because the wallet's format is the
 * wallet's business and the service's is the service's.
 */
function hexFrom(base64: string): string {
  const raw = atob(base64);
  let out = "";

  for (let index = 0; index < raw.length; index += 1) {
    out += raw.charCodeAt(index).toString(16).padStart(2, "0");
  }

  return out;
}
