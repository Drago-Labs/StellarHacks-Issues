"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Button, ButtonLink } from "../../components/primitives";
import { Modal } from "../../components/modal";
import { SpecLabel } from "../../components/spec";
import {
  outOfHundred,
  ranked,
  shortlistOf,
  type AiPanel,
  type AiReview,
  type AiRun,
  type Recommendation,
  type Stage,
} from "../../../lib/ai-review";
import type { Card } from "../../../lib/project";
import type { Rubric } from "../../../lib/rubric";
import type { Entry } from "../../../lib/submissions";
import { titleOf } from "../../../lib/words";

/**
 * The AI review, as one of the two ways a judge can work through the entries.
 *
 * It reads every project first and hands back an ordered list with a reason for
 * every number, so three hundred submissions become somewhere to start rather
 * than a wall. It never removes a project and never scores one on the judge's
 * behalf: the shortlist marks, the judge decides, and every card that counts is
 * still the one the judge signs by hand.
 *
 * Everything the machine wrote is labelled as the machine's. A judge who reads
 * an AI score as a colleague's is no longer an independent signal, and the only
 * thing preventing that is the page never letting the two look alike.
 */

export function AiReviewPanel({
  contractId,
  phase,
  entries,
  cards,
  rubric,
  onScore,
}: {
  contractId: string;
  phase: number | null;
  entries: Entry[];
  cards: Record<number, Card>;
  rubric: Rubric[];
  /** Hands a set of projects to the manual scoresheets. */
  onScore: (teams: Set<number>) => void;
}) {
  const [panel, setPanel] = useState<AiPanel | null>(null);
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [deepAsked, setDeepAsked] = useState<{ teams: number[] | null } | null>(null);

  const load = useCallback(async () => {
    const answer = await fetch(`/api/ai-review?contract=${contractId}`, { cache: "no-store" })
      .then((response) => response.json() as Promise<AiPanel>)
      .catch(() => null);

    if (answer !== null) {
      setPanel(answer);
    }
  }, [contractId]);

  useEffect(() => {
    void load();
  }, [load]);

  const inFlight =
    panel?.access === "granted" &&
    panel.runs.some((run) => run.status === "queued" || run.status === "running");

  /* Only while a run is going, and only while somebody is looking. A quick run
     moves in minutes and a deep one in hours, so a minute is enough to see it
     move. A run queued while the reviewer is not running stays queued, and a
     tab left open on it used to ask four times a minute until somebody closed
     it; a hidden tab now waits and catches up when it is shown again. */
  useEffect(() => {
    if (!inFlight) {
      return;
    }

    const timer = setInterval(() => {
      if (document.visibilityState === "visible") {
        void load();
      }
    }, 60_000);

    const shown = () => {
      if (document.visibilityState === "visible") {
        void load();
      }
    };

    document.addEventListener("visibilitychange", shown);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [inFlight, load]);

  async function start(stage: Stage, teams: number[] | null) {
    setAsking(true);
    setRefused(null);

    const answer = await fetch("/api/ai-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contract: contractId,
        action: "start",
        stage,
        ...(teams === null ? {} : { teams }),
      }),
    }).catch(() => null);

    if (answer === null || !answer.ok) {
      const said = (await answer?.json().catch(() => null)) as { error?: string } | null;

      setRefused(said?.error ?? "The review could not be started.");
    }

    setAsking(false);
    await load();
  }

  async function keepShortlist(size: number | null) {
    setRefused(null);

    const answer = await fetch("/api/ai-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contract: contractId, action: "shortlist", size }),
    }).catch(() => null);

    if (answer === null || !answer.ok) {
      const said = (await answer?.json().catch(() => null)) as { error?: string } | null;

      setRefused(said?.error ?? "The shortlist could not be saved.");
    }

    await load();
  }

  if (panel === null) {
    return <p className="label text-ink-faint">Reading the AI review</p>;
  }

  if (panel.access === "signed-out") {
    return (
      <Box title="Sign in to use the AI review">
        <p>
          The AI review is shown to this hackathon&rsquo;s judges and organizer
          only, so it needs to know who you are. Sign in with the account your
          judge wallet is linked to.
        </p>

        <div className="mt-5">
          <ButtonLink href={`/login?next=${encodeURIComponent(`/judge/${contractId}`)}`}>
            Sign in
          </ButtonLink>
        </div>
      </Box>
    );
  }

  if (panel.access === "denied") {
    return (
      <Box title="Link your judge wallet first">
        <p>
          This account is not linked to a wallet the rules name as a judge of
          this hackathon. Link that wallet on your{" "}
          <Link href="/account" className="text-ink underline underline-offset-4">
            account page
          </Link>{" "}
          and come back.
        </p>
      </Box>
    );
  }

  const open = phase === 3 || phase === 4;
  const valid = entries.filter((entry) => !entry.invalid);
  const latest = panel.runs[0] ?? null;
  const quick = ranked(panel.reviews, "quick");
  const deep = panel.reviews.filter((review) => review.stage === "deep");

  return (
    <div className="space-y-8">
      {latest !== null && (latest.status === "queued" || latest.status === "running") && (
        <Progress run={latest} />
      )}

      {latest?.status === "failed" && (
        <p className="max-w-[46rem] text-[0.9375rem] leading-relaxed text-broken">
          The last {latest.stage} review stopped before it finished
          {latest.error === null ? "." : `: ${latest.error}`} Projects it already
          read are kept. Starting it again reads the rest.
        </p>
      )}

      {quick.length === 0 && deep.length === 0 && !inFlight ? (
        <Start
          open={open}
          count={valid.length}
          asking={asking}
          onQuick={() => void start("quick", null)}
          onDeep={() => setDeepAsked({ teams: null })}
        />
      ) : (
        <Results
          reviews={panel.reviews}
          quick={quick}
          deep={deep}
          shortlistSize={panel.shortlistSize}
          cards={cards}
          entries={entries}
          rubric={rubric}
          busy={asking || inFlight}
          open={open}
          onShortlist={(size) => void keepShortlist(size)}
          onDeep={(teams) => setDeepAsked({ teams })}
          onQuick={() => void start("quick", null)}
          onScore={onScore}
        />
      )}

      {refused !== null && (
        <p className="max-w-[46rem] text-[0.9375rem] leading-relaxed text-broken">{refused}</p>
      )}

      <DeepConfirm
        asked={deepAsked}
        count={deepAsked?.teams?.length ?? valid.length}
        onClose={() => setDeepAsked(null)}
        onConfirm={() => {
          const teams = deepAsked?.teams ?? null;

          setDeepAsked(null);
          void start("deep", teams);
        }}
      />
    </div>
  );
}

/**
 * The first choice, before anything has been read.
 *
 * Two ways in, and the quick one is first because it is what a judge facing
 * hundreds of entries almost always wants: a ranking in minutes, and a deep
 * read of only the projects that earned one.
 */
function Start({
  open,
  count,
  asking,
  onQuick,
  onDeep,
}: {
  open: boolean;
  count: number;
  asking: boolean;
  onQuick: () => void;
  onDeep: () => void;
}) {
  return (
    <div className="space-y-4">
      {!open && (
        <p className="max-w-[46rem] text-[0.9375rem] leading-relaxed text-ink-soft">
          The AI review opens once submissions close, so it reads every project as
          it was entered.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Option
          title="Quick first"
          badge="Recommended"
          body={`Reads the write up, the technical overview, the README and the repository's structure of all ${count === 1 ? "one project" : `${count} projects`}, and ranks them against the rubric. You then choose how many pass the first stage, and send those to a deep review or score them yourself.`}
          action={
            <Button disabled={!open || asking || count === 0} onClick={onQuick}>
              {asking ? "Starting" : "Start quick review"}
            </Button>
          }
        />

        <Option
          title="Deep from the start"
          body="Reads the source code of every project straight away: its structure, smart contracts, tests, dependencies and deployment. The most thorough first read, and the slowest."
          action={
            <Button intent="quiet" disabled={!open || asking || count === 0} onClick={onDeep}>
              Start deep review
            </Button>
          }
        />
      </div>

      <p className="max-w-[46rem] text-[0.875rem] leading-relaxed text-ink-faint">
        Either way the AI does not remove any project or choose a winner. Every
        project stays in the list and every score that counts is one you sign.
      </p>
    </div>
  );
}

function Option({
  title,
  badge,
  body,
  action,
}: {
  title: string;
  badge?: string;
  body: string;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col rounded-[1.25rem] bg-paper p-6 ring-1 ring-rule sm:p-7">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="text-[1.125rem] font-semibold text-ink">{title}</p>
        {badge !== undefined && <span className="label text-verified">{badge}</span>}
      </div>

      <p className="mt-3 flex-1 text-[0.9375rem] leading-relaxed text-ink-soft">{body}</p>

      <div className="mt-5">{action}</div>
    </div>
  );
}

/**
 * The panel a deep run has to go through.
 *
 * It says how long, never how much. What a run costs is the platform's concern;
 * what a judge needs to know is that the list fills in over hours rather than
 * minutes, and that they can keep working while it does.
 */
function DeepConfirm({
  asked,
  count,
  onClose,
  onConfirm,
}: {
  asked: { teams: number[] | null } | null;
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal open={asked !== null} onClose={onClose} title="Start a deep review">
      <p className="label text-ink-faint">Deep review</p>

      <h2 className="mt-2 text-[1.5rem] font-semibold leading-tight text-ink">
        This can take a while
      </h2>

      <div className="mt-4 space-y-3 text-[0.9375rem] leading-relaxed text-ink-soft">
        <p>
          A deep review opens the repository of{" "}
          {count === 1 ? "one project" : `${count} projects`} and reads the code
          itself: its structure, smart contracts, tests, dependencies and
          deployment.
        </p>

        <p>
          {count > 50
            ? "For this many projects it can take several hours."
            : "It usually takes from a few minutes to an hour."}{" "}
          Results appear in the list as each project finishes, and you can close
          this page and keep scoring by hand in the meantime.
        </p>
      </div>

      <div className="mt-7 flex flex-wrap gap-3">
        <Button onClick={onConfirm}>Start deep review</Button>
        <Button intent="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}

function Progress({ run }: { run: AiRun }) {
  const share = run.total === 0 ? 0 : run.done / run.total;

  return (
    <div className="rounded-[1.25rem] bg-paper p-6 ring-1 ring-rule sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <p className="text-[1.125rem] font-semibold text-ink">
          {run.stage === "quick" ? "Quick review" : "Deep review"}{" "}
          {run.status === "queued" ? "is about to start" : "in progress"}
        </p>

        {run.status === "running" && run.total > 0 && (
          <p className="tabular label text-ink-faint">
            {run.done} of {run.total} read
          </p>
        )}
      </div>

      <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-paper-sunk">
        <div
          className="h-full rounded-full bg-ink transition-[width] duration-700 ease-settle"
          style={{ width: `${Math.max(share * 100, run.status === "running" ? 2 : 0)}%` }}
        />
      </div>

      <p className="mt-3 text-[0.9375rem] leading-relaxed text-ink-soft">
        {run.stage === "deep"
          ? "Reading source code takes time, possibly hours. The list fills in as projects finish; you can leave and come back."
          : "Usually a few minutes. The list fills in as projects finish."}
      </p>
    </div>
  );
}

type Order = "total" | string;

/**
 * The ranking, the shortlist, and every reason behind them.
 */
function Results({
  reviews,
  quick,
  deep,
  shortlistSize,
  cards,
  entries,
  rubric,
  busy,
  open,
  onShortlist,
  onDeep,
  onQuick,
  onScore,
}: {
  reviews: AiReview[];
  quick: AiReview[];
  deep: AiReview[];
  shortlistSize: number | null;
  cards: Record<number, Card>;
  entries: Entry[];
  rubric: Rubric[];
  busy: boolean;
  open: boolean;
  onShortlist: (size: number | null) => void;
  onDeep: (teams: number[]) => void;
  onQuick: () => void;
  onScore: (teams: Set<number>) => void;
}) {
  const [typed, setTyped] = useState(shortlistSize === null ? "" : String(shortlistSize));
  const [order, setOrder] = useState<Order>("total");
  const [picked, setPicked] = useState<Set<number>>(new Set());

  useEffect(() => {
    setTyped(shortlistSize === null ? "" : String(shortlistSize));
  }, [shortlistSize]);

  const shortlist = useMemo(() => shortlistOf(reviews, shortlistSize), [reviews, shortlistSize]);
  const deepOf = useMemo(() => new Map(deep.map((review) => [review.team, review])), [deep]);

  /* The quick ranking when there is one. A run that went deep from the start
     has only deep reviews, and those are the ranking instead. */
  const base = quick.length > 0 ? quick : ranked(reviews, "deep");
  const criteria = useMemo(
    () => [...new Set(rubric.flatMap((track) => track.criteria.map((one) => one.id)))],
    [rubric],
  );

  const rows = useMemo(() => {
    if (order === "total") {
      return base;
    }

    const scoreOf = (review: AiReview) =>
      review.criteria.find((one) => one.criterion === order)?.score ?? -1;

    return [...base].sort((a, b) => scoreOf(b) - scoreOf(a) || a.team - b.team);
  }, [base, order]);

  const trackOf = (team: number) => entries.find((entry) => entry.team === team)?.track ?? "";
  const worthOf = (team: number, criterion: string) =>
    (rubric.find((track) => track.track === trackOf(team))?.criteria.find((one) => one.id === criterion)
      ?.weightBps ?? 0) / 100;

  const size = typed.trim() === "" ? null : Number(typed);
  const sizeValid = size === null || (Number.isInteger(size) && size >= 1 && size <= 1000);

  function toggle(team: number) {
    const next = new Set(picked);

    if (next.has(team)) {
      next.delete(team);
    } else {
      next.add(team);
    }

    setPicked(next);
  }

  return (
    <div className="space-y-6">
      {quick.length > 0 && (
        <div className="rounded-[1.25rem] bg-paper p-6 ring-1 ring-rule sm:p-8">
          <SpecLabel>First stage</SpecLabel>

          <p className="mt-3 max-w-[40rem] text-[0.9375rem] leading-relaxed text-ink-soft">
            How many projects pass the first stage? The top that many of the AI
            ranking are marked. Nothing is removed: every other project stays in
            the list and can still be scored.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value.replace(/[^0-9]/g, "").slice(0, 4))}
              inputMode="numeric"
              placeholder="20"
              aria-label="How many projects pass the first stage"
              className="tabular h-11 w-24 rounded-[0.625rem] bg-paper-sunk px-3 text-right text-[1rem] text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-2 focus:ring-ink"
            />

            <Button
              intent="quiet"
              disabled={!sizeValid || size === shortlistSize}
              onClick={() => onShortlist(size)}
            >
              {size === null && shortlistSize !== null ? "Clear" : "Mark the shortlist"}
            </Button>

            <span className="label text-ink-faint">of {quick.length} reviewed</span>
          </div>

          {shortlist.size > 0 && (
            <div className="mt-6 flex flex-wrap gap-3 border-t border-rule pt-5">
              <Button onClick={() => onScore(shortlist)}>
                Score the {shortlist.size} by hand
              </Button>

              <Button intent="quiet" disabled={busy || !open} onClick={() => onDeep([...shortlist])}>
                Deep review the {shortlist.size}
              </Button>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-3">
          <span className="label text-ink-faint">Sort by</span>

          <select
            value={order}
            onChange={(event) => setOrder(event.target.value)}
            className="h-9 rounded-[0.5rem] bg-paper px-3 text-[0.875rem] text-ink ring-1 ring-inset ring-rule outline-none focus:ring-2 focus:ring-ink"
          >
            <option value="total">AI total</option>
            {criteria.map((id) => (
              <option key={id} value={id}>
                {titleOf(id)}
              </option>
            ))}
          </select>
        </label>

        <div className="flex flex-wrap gap-3">
          {picked.size > 0 && (
            <>
              <Button size="sm" intent="quiet" onClick={() => onScore(picked)}>
                Score {picked.size} by hand
              </Button>

              <Button size="sm" intent="quiet" disabled={busy || !open} onClick={() => onDeep([...picked])}>
                Deep review {picked.size}
              </Button>
            </>
          )}

          {quick.length === 0 && (
            <Button size="sm" intent="ghost" disabled={busy || !open} onClick={onQuick}>
              Run a quick review too
            </Button>
          )}
        </div>
      </div>

      <ol className="space-y-3">
        {rows.map((review, at) => (
          <Row
            key={review.team}
            place={at + 1}
            review={review}
            deep={review.stage === "quick" ? deepOf.get(review.team) : undefined}
            card={cards[review.team]}
            track={trackOf(review.team)}
            passed={shortlist.has(review.team)}
            picked={picked.has(review.team)}
            worthOf={(criterion) => worthOf(review.team, criterion)}
            onPick={() => toggle(review.team)}
            onScore={() => onScore(new Set([review.team]))}
          />
        ))}
      </ol>
    </div>
  );
}

function Row({
  place,
  review,
  deep,
  card,
  track,
  passed,
  picked,
  worthOf,
  onPick,
  onScore,
}: {
  place: number;
  review: AiReview;
  /** The deep review of the same project, when there is one beside the quick. */
  deep: AiReview | undefined;
  card: Card | undefined;
  track: string;
  passed: boolean;
  picked: boolean;
  worthOf: (criterion: string) => number;
  onPick: () => void;
  onScore: () => void;
}) {
  const [shown, setShown] = useState(false);
  const [reading, setReading] = useState<Stage>(deep === undefined ? review.stage : "deep");
  const current = reading === "deep" && deep !== undefined ? deep : review;

  return (
    <li
      className={`rounded-[1.25rem] bg-paper ring-1 ${passed ? "ring-verified/60" : "ring-rule"}`}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 p-5 sm:p-6">
        <input
          type="checkbox"
          checked={picked}
          onChange={onPick}
          aria-label={`Select ${card?.title ?? `team ${review.team}`}`}
          className="size-4 accent-ink"
        />

        <span className="tabular w-8 text-[0.9375rem] text-ink-faint">{place}</span>

        <div className="min-w-0 flex-1">
          <p className="truncate text-[1.0625rem] font-semibold text-ink">
            {card?.title ?? `Team ${review.team}`}
          </p>

          <p className="label mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-ink-faint">
            <span>{titleOf(track)}</span>
            {passed && <span className="text-verified">Passed first stage</span>}
            {deep !== undefined && <span>Deep reviewed</span>}
          </p>
        </div>

        <Verdict review={review} />

        <div className="flex gap-2">
          <Button size="sm" intent="ghost" onClick={() => setShown(!shown)}>
            {shown ? "Hide" : "Report"}
          </Button>

          <Button size="sm" intent="quiet" onClick={onScore}>
            Score
          </Button>
        </div>
      </div>

      {shown && (
        <div className="border-t border-rule p-5 sm:p-6">
          {deep !== undefined && (
            <div className="mb-5 flex gap-2">
              {(["quick", "deep"] as const).map((stage) => (
                <button
                  key={stage}
                  type="button"
                  onClick={() => setReading(stage)}
                  className={`label rounded-full px-3 py-1 ring-1 ring-inset ${
                    reading === stage ? "bg-ink text-paper ring-ink" : "text-ink-soft ring-rule"
                  }`}
                >
                  {stage === "quick" ? "Quick review" : "Deep review"}
                </button>
              ))}
            </div>
          )}

          <Report review={current} worthOf={worthOf} />
        </div>
      )}
    </li>
  );
}

/**
 * The machine's number, drawn so it cannot be mistaken for a judge's.
 *
 * Always labelled AI, always beside the recommendation and the confidence, never
 * in the large figure a sealed card uses.
 */
function Verdict({ review }: { review: AiReview }) {
  if (review.status !== "reviewed" || review.totalScore === null) {
    return (
      <span className="label text-ink-faint">
        {review.status === "declined" ? "AI declined, read by hand" : "AI could not review, read by hand"}
      </span>
    );
  }

  return (
    <div className="flex items-center gap-4">
      <span className="label text-ink-faint">{confidenceWord(review.confidence)}</span>

      <span className={`label ${tone(review.recommendation)}`}>
        {recommendationWord(review.recommendation)}
      </span>

      <span className="tabular rounded-[0.5rem] bg-paper-sunk px-2.5 py-1 text-[0.9375rem] text-ink ring-1 ring-inset ring-rule">
        <span className="label mr-1.5 text-ink-faint">AI</span>
        {outOfHundred(review.totalScore)}
      </span>
    </div>
  );
}

function Report({ review, worthOf }: { review: AiReview; worthOf: (criterion: string) => number }) {
  if (review.status !== "reviewed") {
    return (
      <p className="max-w-[46rem] text-[0.9375rem] leading-relaxed text-ink-soft">
        {review.status === "declined"
          ? "The AI declined to review this project."
          : "The AI could not produce a review of this project."}{" "}
        {review.error ?? ""} It is in the list so that it is read by hand rather
        than forgotten.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {review.report !== null && (
        <p className="max-w-[46rem] text-[1rem] leading-relaxed text-ink">{review.report}</p>
      )}

      <div className="border-t border-rule">
        {review.criteria.map((criterion) => {
          const worth = worthOf(criterion.criterion);

          return (
            <div key={criterion.criterion} className="border-b border-rule py-4">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[1rem] text-ink">{titleOf(criterion.criterion)}</span>

                {/* On the judge's own scale, points out of the criterion's
                    weight, so the two can be compared without arithmetic. */}
                <span className="tabular shrink-0 text-[0.9375rem] text-ink">
                  <span className="label mr-1.5 text-ink-faint">AI</span>
                  {figure((criterion.score / 100) * worth)}
                  <span className="label ml-2 text-ink-faint">of {figure(worth)}</span>
                </span>
              </div>

              <p className="mt-2 max-w-[44rem] text-[0.9375rem] leading-relaxed text-ink-soft">
                {criterion.reason}
              </p>

              {criterion.evidence.length > 0 && (
                <List title="Evidence" items={criterion.evidence} quoted />
              )}

              {criterion.concerns.length > 0 && <List title="Concerns" items={criterion.concerns} />}
            </div>
          );
        })}
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <List title="Strengths" items={review.strengths} />
        <List title="Weaknesses" items={review.weaknesses} />
        <List title="Missing information" items={review.missingInformation} />
      </div>

      {review.unread.length > 0 && (
        <details className="text-[0.875rem] text-ink-soft">
          <summary className="cursor-pointer text-ink-faint">
            {review.unread.length} files were too many to read and were not seen by the AI
          </summary>
          <p className="mt-2 break-all font-mono text-[0.8125rem] leading-relaxed">
            {review.unread.join(", ")}
          </p>
        </details>
      )}

      <p className="label text-ink-faint">
        {review.stage === "quick" ? "Quick review" : "Deep review"} by {review.model},{" "}
        <span suppressHydrationWarning>
          {new Date(review.reviewedAt).toLocaleString(undefined, {
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })}
        </span>
        {review.commitSha !== null && <> · commit {review.commitSha.slice(0, 7)}</>}
      </p>
    </div>
  );
}

function List({ title, items, quoted }: { title: string; items: string[]; quoted?: boolean }) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="mt-3">
      <p className="label text-ink-faint">{title}</p>

      <ul className="mt-1.5 space-y-1.5">
        {items.map((item, at) => (
          <li
            key={at}
            className={`text-[0.9375rem] leading-relaxed ${
              quoted ? "border-l-2 border-rule pl-3 text-ink-soft" : "text-ink-soft"
            }`}
          >
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Box({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[1.25rem] bg-paper p-8 ring-1 ring-rule sm:p-10">
      <p className="text-[1.25rem] font-semibold text-ink">{title}</p>
      <div className="mt-3 max-w-[40rem] text-[1rem] leading-relaxed text-ink-soft">{children}</div>
    </div>
  );
}

function recommendationWord(recommendation: Recommendation | null): string {
  switch (recommendation) {
    case "PASS":
      return "Worth a close look";
    case "MANUAL_REVIEW":
      return "Needs a human read";
    case "LOW_PRIORITY":
      return "Low priority";
    default:
      return "";
  }
}

function tone(recommendation: Recommendation | null): string {
  return recommendation === "PASS"
    ? "text-verified"
    : recommendation === "LOW_PRIORITY"
      ? "text-ink-faint"
      : "text-ink-soft";
}

function confidenceWord(confidence: AiReview["confidence"]): string {
  return confidence === null ? "" : `${confidence} confidence`;
}

/** A number as a rubric writes it: no trailing zero where it says nothing. */
function figure(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}
