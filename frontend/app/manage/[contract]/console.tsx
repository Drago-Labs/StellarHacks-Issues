"use client";

import { useCallback, useEffect, useState } from "react";

import { Button, ButtonLink } from "../../components/primitives";
import { CommitButton } from "../../components/commit-button";
import { useWallet } from "../../components/wallet-context";
import { arg, send, type Sent } from "../../../lib/send";
import { rootHeldFor } from "../../../lib/judge";
import { runningOf, type Running } from "../../../lib/running";
import { JOURNEY, PHASES, phaseName, stepOf } from "../../../lib/phase";
import { PRIZE_ASSETS, units } from "../../../lib/money";
import { Applications } from "./applications";
import { BackerQueue } from "./backer-queue";
import { SponsorQueue } from "./sponsor-queue";
import { Masthead } from "./masthead";
import { applicantsOf, type Applicant } from "../../../lib/applications";
import { entriesOf, type Entry } from "../../../lib/submissions";
import { Details } from "./details";
import { Schedule } from "./schedule";
import { Panel, type View } from "./panel";
import { Screening } from "./screening";
import { rulesFor, type Rules } from "../../../lib/rules";
import { rootsOf } from "../../../lib/roots";

/**
 * Getting a hackathon from written to open, one legal call at a time.
 *
 * The contract allows exactly one thing at each point and refuses everything
 * else, so this offers exactly one thing. A console of buttons that mostly fail
 * would be faster to build and would teach an organizer to distrust all of
 * them.
 *
 * What is shown comes from the contract rather than from our database, for the
 * same reason the participant flow does: a button that is wrong here costs a
 * signature and a fee to find out.
 */

export function Console({
  contractId,
  written,
  userId,
}: {
  contractId: string;
  /** How the hackathon presents itself, or nothing when it never saved. */
  written: {
    name: string;
    slug: string;
    tagline: string | null;
    description: string | null;
    logo: string | null;
    banner: string | null;
    location: string | null;
    tags: string[];
    createdAt: string | null;
  } | null;
  /** Whose folder artwork lands in, for the details tab. Null when signed out. */
  userId: string | null;
}) {
  const { wallet, known } = useWallet();
  const [running, setRunning] = useState<Running | null>(null);
  const [rules, setRules] = useState<Rules | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<(Sent & { contractId?: string }) | null>(null);
  const [view, setView] = useState<View>("overview");

  /*
    The queue and the entries, read once and shared.

    Both are counts on the masthead and lists inside their own tabs, and both
    used to be read twice: once here for the number and again by the tab when it
    opened. The applications read is the expensive one — it walks the contract's
    event log in passes of ten thousand ledgers, which is twelve round trips on
    testnet — so doing it twice meant the page paid for it on load and the
    organizer paid for it again, watching "reading the log" every time they
    pressed the tab.

    Held here, the tab opens on data that is already in hand.
  */
  const [applicants, setApplicants] = useState<Applicant[] | null>(null);
  const [entries, setEntries] = useState<Entry[] | null>(null);

  /*
    Whether judging has been sealed, which is the one thing standing between
    this panel and a hackathon nobody can ever rank.

    A root can only be published while the contract is in Judging. Leaving that
    phase without one is not a stage ending early, it is a door closing: the
    cards stay in the collection service with nowhere on chain to put them. The
    clock service already refuses to advance past Judging for this reason, and
    this panel offers the same call by hand — so it has to know the same fact,
    or the manual button quietly does what the automatic one is written to
    prevent.
  */
  const [sealed, setSealed] = useState<boolean | null>(null);

  const reread = useCallback(async () => {
    /* All three together. The setup screen reads what is about to be frozen off
       the rules and what is still owed off the state, and showing one against a
       stale copy of the other is how a deposit figure ends up disagreeing with
       the prize table beside it. */
    const [state, written, roots] = await Promise.all([
      runningOf(contractId),
      rulesFor(contractId),
      rootsOf(contractId).catch(() => ({ scores: null, ballots: null })),
    ]);

    setRunning(state);
    setRules(written);
    /* Ballots only when the rules run a community vote at all, the same
       condition the clock applies. Waiting on a root that was never going to
       exist would hold every event that scores the ordinary way. */
    setSealed(
      roots.scores !== null &&
        ((written?.communityBps ?? 0) === 0 || roots.ballots !== null),
    );
  }, [contractId]);

  useEffect(() => {
    void reread();
  }, [reread]);

  /*
    Looking again while a deadline is behind us, and only then.

    A phase now moves on without anybody on this page having done it, so a panel
    that read the contract once would sit on a stage that ended minutes ago. The
    rest of the time nothing here changes except through this page, which is
    already followed by a reread, so there is nothing to poll for.
  */
  useEffect(() => {
    const tick = window.setInterval(() => {
      const waiting = running?.phase == null ? null : waitsFor(running.phase, rules);

      if (waiting !== null && Math.floor(Date.now() / 1000) >= waiting) {
        void reread();
      }
    }, 15_000);

    return () => window.clearInterval(tick);
  }, [running, rules, reread]);

  const recount = useCallback(async () => {
    const [applied, entered] = await Promise.all([
      applicantsOf(contractId, written?.createdAt).catch(() => []),
      /* With the roster, because the screening tab is fed from here and says
         how many people are behind each entry. Read without it, every card in
         that tab said "0 members" about a team that plainly had one. */
      entriesOf(contractId).catch(() => []),
    ]);

    setApplicants(applied);
    setEntries(entered);
  }, [contractId, written?.createdAt]);

  useEffect(() => {
    void recount();
  }, [recount]);

  async function run(work: () => Promise<Sent & { contractId?: string }>) {
    setBusy(true);
    setResult(null);

    const outcome = await work();

    setResult(outcome.ok || !outcome.refused ? outcome : null);
    setBusy(false);

    if (outcome.ok) {
      await reread();
    }
  }

  if (!known || running === null) {
    return <p className="label text-ink-faint">Reading the contract</p>;
  }

  if (running.phase === null) {
    return (
      <p className="max-w-[38rem] text-[1rem] leading-relaxed text-ink-soft">
        Nothing has been created at this address yet. A hackathon starts on the
        create page, and this is where it continues afterwards.
      </p>
    );
  }

  /* Past the check above the phase is known, and saying so once here saves
     every reader below from re-establishing it.

     The prize asset comes from the rules. `runningOf` asks the contract seven
     cheap questions and the asset is not one of them, so it leaves the field
     null and this page was reading that null as an asset it did not recognise:
     every figure on the console printed as a bare number with no ticker beside
     it. The document names it and has already been read. */
  const state = {
    ...running,
    phase: running.phase,
    prizeAsset: running.prizeAsset ?? rules?.prizeAsset ?? null,
  };

  const mine = wallet !== null && wallet.address === state.organizer;
  const funded = state.held >= state.required && state.required > BigInt(0);

  /* Setting up is a page of its own, reached before this one, so nothing here
     offers it. What is left for an unopened event is the reading, which stays
     because a stranger may be looking at a hackathon that is not open yet. */
  const live = state.phase >= 2;

  /* The ticker the prize is denominated in, so every amount on this page says
     what it is an amount of. Empty rather than guessed when the asset is not
     one we know: a wrong ticker beside a real balance is worse than none. */
  const code =
    PRIZE_ASSETS.find((asset) => asset.contract === state.prizeAsset)?.code ?? "";

  /* Nothing has been entered before the event opens, so the two review tabs are
     shown but empty rather than hidden. An organizer who cannot see where the
     queue will be does not know there is one. */
  const reviewable = state.phase >= 2;

  return (
    <div className="space-y-8">
      {/* What this page is, said once. Everything below it is about one event,
          so an organizer arriving from a form, a menu or a link lands knowing
          which of the product's rooms they are standing in. */}
      {/* Spelled out rather than reaching for `.label`, which fixes the weight
          at 600. This is the page's own title and carries more than a label
          does. */}
      <p className="text-[1.375rem] font-bold tracking-[0.1em] text-ink uppercase">
        Hackathon management panel
      </p>

      <Masthead
        contractId={contractId}
        organizer={mine ? state.organizer : null}
        name={written?.name ?? "Your hackathon"}
        tagline={written?.tagline ?? null}
        logo={written?.logo ?? null}
        banner={written?.banner ?? null}
        location={written?.location ?? null}
        tags={written?.tags ?? []}
        slug={written?.slug ?? null}
        phase={phaseName(state.phase)}
        applications={applicants?.length ?? null}
        submissions={entries?.length ?? null}
        /* The prize table, not what the vault holds. The two differ by the
           platform fee, which is deposited into the same vault and paid to us
           rather than to a winner, so quoting the balance advertised a prize
           nobody will ever be given. */
        prize={rules === null ? null : units(rules.total)}
        prizeCode={code.length > 0 ? code : null}
        live={live}
      />

      {/* Where the event has got to, above the tabs and unchanged by them. The
          tabs are questions about one event; what identifies the event does not
          move when the question does. */}
      <Stages at={stepOf(state.phase)} />

      <Panel
        at={view}
        counts={{
          applications: applicants?.length ?? null,
          submissions: entries?.length ?? null,
        }}
        onChange={setView}
      />

      {view === "schedule" ? (
        <Schedule contractId={contractId} organizer={mine ? state.organizer : null} />
      ) : view === "details" ? (
        <Details contractId={contractId} userId={userId} mine={mine} />
      ) : view === "applications" ? (
        reviewable ? (
          <Applications
            contractId={contractId}
            reviewer={mine ? (wallet?.address ?? null) : null}
            applicants={applicants}
            reread={recount}
            /* Nothing to decide when the rules admit everybody. The tab still
               exists, because who came is worth reading whether or not anybody
               had to let them in. */
            reviewed={rules === null || !rules.openRegistration}
          />
        ) : (
          <Empty>
            Nobody can apply until the hackathon is open. The queue appears here
            when it is.
          </Empty>
        )
      ) : view === "submissions" ? (
        reviewable ? (
          <Screening
            contractId={contractId}
            organizer={mine ? (wallet?.address ?? null) : null}
            entries={entries}
            phase={state.phase}
            reread={recount}
          />
        ) : (
          <Empty>
            Teams enter once the hackathon is open, and what they send lands
            here.
          </Empty>
        )
      ) : (
        <Overview>
        {/* Above the facts, because it is the only thing here that somebody
            else is waiting on. It draws nothing at all when no sponsor has
            asked, which is most events. */}
        <SponsorQueue
          contractId={contractId}
          organizer={mine ? (wallet?.address ?? null) : null}
          code={code}
        />

        {/* Beside the track queue because it is the same kind of thing: a
            sponsor waiting on the organizer. It asks for less — a name rather
            than a category — and it costs the reader nothing when empty. */}
        <BackerQueue
          contractId={contractId}
          organizer={mine ? (wallet?.address ?? null) : null}
          code={code}
        />

        {/* The facts somebody comes back to check, before the one thing they
            can do about them. The tab was a single action card on an empty
            page, which does not read as an overview of anything. */}
        {rules !== null && (
          <Card>
            <dl className="grid gap-x-10 gap-y-5 sm:grid-cols-3">
              {/* What the winners share, which is the prize table rather than
                  the vault's balance: the platform fee sits in the same vault
                  and goes to us. A shortfall is still said, because an
                  underfunded vault is the organizer's problem and the figure
                  above it would otherwise look settled. */}
              <Fact name="Prize pot">
                {units(rules.total)}
                {code.length > 0 && ` ${code}`}
                {state.held < state.required && (
                  <span className="text-broken">
                    {" "}
                    — {units(state.required - state.held)} still to deposit
                  </span>
                )}
              </Fact>

              {/* Named rather than counted. "2 categories" is a number an
                  organizer already knows and the names are what they came to
                  check, since a track is what every prize and every scorecard
                  is filed under. */}
              <Fact name="Categories">
                {rules.tracks.length === 0
                  ? "None"
                  : rules.tracks.map((track) => track.id).join(", ")}
              </Fact>

              <Fact name="Judges">
                {rules.judges === 1 ? "One judge" : `${rules.judges} judges`}
              </Fact>

              <Fact name="Sign-ups close">
                <Moment at={rules.schedule.registrationCloses} />
              </Fact>

              <Fact name="Build deadline">
                <Moment at={rules.schedule.submissionCloses} />
              </Fact>

              <Fact name="Judging ends">
                <Moment at={rules.schedule.judgingCloses} />
              </Fact>
            </dl>
          </Card>
        )}

        <Card>
        <h2 className="text-[1.75rem] font-semibold text-ink">
          {headline(state, funded)}
        </h2>

        <div className="mt-7">
          {!live && mine ? (
            /* Sent rather than offered, because opening is irreversible and
               belongs on the page built for it. */
            <div className="flex flex-wrap items-center gap-5">
              <ButtonLink href={`/manage/${contractId}/open`}>Open the hackathon</ButtonLink>

              <p className="max-w-[32rem] text-[0.9375rem] leading-relaxed text-ink-soft">
                One signature, and nothing here is public until it lands.
              </p>
            </div>
          ) : !live ? (
            <p className="max-w-[38rem] text-[1rem] leading-relaxed text-ink-soft">
              Only the organizer can open this, and that is{" "}
              <span className="tabular text-[0.875rem]">{state.organizer}</span>. Connect
              that wallet to continue.
            </p>
          ) : (
            <Next
              running={state}
              rules={rules}
              applications={applicants?.length ?? null}
              contractId={contractId}
              address={wallet?.address ?? null}
              sealed={sealed}
              busy={busy}
              run={run}
            />
          )}
        </div>

        {/*
          The organizer's own scoring, when the rules named them a judge too.

          Small events are run by the people judging them, and for those the
          panel was a dead end: it says judging is open, offers the button that
          ends it, and says nothing about the one job still outstanding. The
          card below it is the organizer's; this is the same wallet's other hat,
          so it is offered here rather than left in a menu.

          Only while the window is open. Once the phase moves the console
          refuses cards anyway, and a link to a room that turns somebody away is
          worse than no link.
        */}
        {state.phase === 4 &&
          wallet !== null &&
          (rules?.judgeAddresses ?? []).includes(wallet.address) && (
            <div className="mt-7 flex flex-wrap items-center gap-5 border-t border-rule pt-7">
              <ButtonLink href={`/judge/${contractId}`}>Score the projects</ButtonLink>

              <p className="max-w-[32rem] text-[0.9375rem] leading-relaxed text-ink-soft">
                The rules name this wallet as a judge. Your cards are wanted
                before you close the window above.
              </p>
            </div>
          )}
      </Card>

        </Overview>
      )}

      {result !== null && (
        <p
          className={`max-w-[46rem] text-[0.9375rem] leading-relaxed ${
            result.ok ? "text-verified" : "text-broken"
          }`}
        >
          {result.ok
            ? result.contractId === undefined
              ? "Done."
              : "The vault is on chain and bound to this hackathon."
            : result.why}
        </p>
      )}

    </div>
  );
}

/**
 * What is still running, said as the thing it is rather than as "this stage".
 *
 * A disabled button with a date beside it reads as a fault. What it is is a
 * window somebody else is still inside: teams are still entering, or the
 * judges are still scoring, and moving on would cut them off.
 */
function holding(phase: number): string {
  switch (phase) {
    case 2:
      return "Teams can still enter";
    case 3:
      return "You can check the entries";
    default:
      return "Judges can still score";
  }
}

/**
 * How long a passed deadline is allowed to sit before the page offers to move
 * it on by hand.
 *
 * Two minutes, and it is the sum of two waits rather than a round number: the
 * clock service laps every thirty seconds, and this page reads its own clock on
 * the same interval, so a deadline can be a minute behind with everything
 * working. Anything past that is the service being down.
 */
const STUCK = 120;

/**
 * The window that has just closed, in the words the organizer would use.
 *
 * Entries rather than sign-ups for the open stage. Both close inside it, and
 * the deadline this stage actually ends on is the submission one; sign-ups shut
 * earlier, so saying they had just closed would be wrong by however long the
 * rules put between the two.
 */
function over(phase: number): string {
  switch (phase) {
    case 2:
      return "Entries are closed.";
    case 3:
      return "The entry check is over.";
    default:
      return "Judging is over.";
  }
}

/**
 * What opens next, named by what happens in it.
 *
 * Not the contract's name for the phase. "Move to Screening" was on this button
 * for a while and it told an organizer nothing: it is the vocabulary the wasm
 * compiled, and reading it needs you to already know the sequence.
 */
function opens(phase: number): string {
  switch (phase) {
    case 2:
      return "The entry check opens next.";
    case 3:
      return "Judging opens next.";
    default:
      return "The scores are revealed next.";
  }
}

/**
 * The same move as a button, which only ever appears when the clock is down.
 *
 * Named after the stage it closes rather than after the call underneath it.
 * "Next stage" was on this button and reads as the end of the hackathon to
 * somebody who has not memorised the sequence; there are three of these and
 * each one ends a different thing.
 */
function moves(phase: number): string {
  switch (phase) {
    case 2:
      return "Close entries";
    case 3:
      return "Open judging";
    default:
      return "Close judging";
  }
}

/**
 * How long is left, in the largest unit that still says something.
 *
 * "in 13 minutes" is what somebody wants at a deadline they are waiting on; a
 * timestamp on its own leaves them doing the subtraction against a clock in
 * another corner of the screen.
 */
function left(seconds: number): string {
  if (seconds < 60) {
    return "under a minute";
  }

  const minutes = Math.round(seconds / 60);

  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.round(minutes / 60);

  if (hours < 48) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  return `${Math.round(hours / 24)} days`;
}

/**
 * The deadline a stage ends on, or nothing when it ends on an action instead.
 *
 * Only three stages close on the clock. The reveal ends when the ranking is
 * computed and settlement ends when everything owed is paid, so neither has a
 * moment to wait for and neither should have a button held shut against one.
 */
function waitsFor(phase: number, rules: Rules | null): number | null {
  if (rules === null) {
    return null;
  }

  switch (phase) {
    case 2:
      return rules.schedule.submissionCloses;
    case 3:
      return rules.schedule.screeningCloses;
    case 4:
      return rules.schedule.judgingCloses;
    default:
      return null;
  }
}

/**
 * A moment in the reader's own clock.
 *
 * Suppressed for hydration because that is exactly what differs: the server
 * formats in its timezone and the browser in the visitor's, and the browser is
 * the one that is right.
 */
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
 * The whole run, named, with the one it is on marked.
 *
 * Bars under a counter said "step 3 of 6" and left somebody to guess what the
 * six were. The names are the same length as the counter and answer the
 * question the counter raised, so they replaced it: a stage you can read is a
 * position you do not have to work out.
 */
function Stages({ at }: { at: number }) {
  return (
    <ol className="-mx-6 flex gap-x-6 gap-y-3 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {JOURNEY.map((stage, index) => {
        const done = index + 1 < at;
        const here = index + 1 === at;

        return (
          <li key={stage.title} className="min-w-0 shrink-0 grow">
            <span
              aria-hidden
              className={`block h-1 rounded-full ${
                done ? "bg-verified" : here ? "bg-signal" : "bg-rule"
              }`}
            />

            <span
              className={`label mt-2 block whitespace-nowrap ${
                here ? "text-ink" : done ? "text-verified" : "text-ink-faint"
              }`}
            >
              {stage.title}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** One fact, labelled, in the grid the overview opens with. */
function Fact({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1">
      <dt className="label text-[0.8125rem] font-semibold text-ink">{name}</dt>
      <dd className="text-[1rem] text-ink-soft">{children}</dd>
    </div>
  );
}

/** The overview's own column, so its parts space like the other tabs' do. */
/**
 * Judging is over and no root is on chain, which is two different situations.
 *
 * The panel used to call both of them "your judges have not handed their cards
 * in yet", from evidence that says nothing of the sort: a missing root means
 * only that nothing has been published, and the service that holds the cards
 * was never asked. An organizer whose judge had scored an hour earlier was
 * being told their judge had not turned up.
 *
 * So the service is asked. It answers with the root it would publish, or with
 * nothing when it truly holds no cards, and those two get different sentences.
 *
 * The button exists for the events frozen before the constitution named the
 * service as their sealer. The contract asks the named address to authorize the
 * root, so on those the service cannot publish it and the organizer can — but
 * only this page can put the two halves together, because the root is the
 * service's and the key is theirs.
 */
function Sealing({
  contractId,
  rules,
  address,
}: {
  contractId: string;
  rules: Rules | null;
  address: string | null;
}) {
  const [root, setRoot] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    void rootHeldFor(contractId).then((found) => alive && setRoot(found));

    return () => {
      alive = false;
    };
  }, [contractId]);

  /* Only the wallet the document names. Offering it to anybody else would be
     offering a call the contract refuses, on the one stage where a refusal is
     hard to tell from a hackathon that is simply not ready. */
  const ours = address !== null && rules?.sealer === address;

  async function publish() {
    if (root === null || root === undefined || address === null) {
      return;
    }

    setBusy(true);
    setWhy(null);

    const bytes = Uint8Array.from(root.match(/../g)!.map((pair) => parseInt(pair, 16)));
    const outcome = await send(
      contractId,
      "publish_score_root",
      [await arg.bytes32(bytes)],
      address,
    );

    setBusy(false);

    if (!outcome.ok) {
      setWhy(outcome.why ?? "The wallet refused it.");
    }
  }

  return (
    <div className="grid gap-3">
      <p className="text-[1.125rem] text-ink">
        {root === undefined
          ? "The judging deadline has passed."
          : root === null
            ? "The judging deadline has passed, and no cards have been handed in."
            : "The judging deadline has passed. The cards are in and their root is not on chain yet."}
      </p>

      <p className="max-w-[40rem] text-[1rem] leading-relaxed text-ink-soft">
        Nothing moves on until it is, and that is deliberate: the scores can only
        be put on chain while this stage is open, so closing it now would leave
        the hackathon with no way to ever be ranked. The window stays open for as
        long as it takes.{" "}
        {root === null &&
          (rules !== null && rules.judges === 1
            ? "Your judge has not handed a card in yet."
            : "Your judges have not handed their cards in yet.")}
        {root !== null &&
          root !== undefined &&
          (ours
            ? "This hackathon named your wallet as its sealer, so publishing it is your signature."
            : "The collection service publishes it on its own, usually within a minute.")}
      </p>

      {root !== null && root !== undefined && ours && (
        <div className="mt-1">
          <Button disabled={busy} onClick={() => void publish()}>
            {busy ? "Signing" : "Publish the score root"}
          </Button>
        </div>
      )}

      {why !== null && (
        <p className="max-w-[40rem] text-[1rem] leading-relaxed text-broken">{why}</p>
      )}
    </div>
  );
}

function Overview({ children }: { children: React.ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}

/** A tab that will have something in it later, saying so rather than nothing. */
function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="max-w-[38rem] text-[1rem] leading-relaxed text-ink-soft">{children}</p>
  );
}

/** A card, the same one the create form is built from. */
function Card({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-[1.25rem] bg-paper p-8 ring-1 ring-rule sm:p-10">{children}</section>
  );
}

/**
 * One move, offered to the organizer and explained to everybody else.
 *
 * The sentence is the same either way, because it describes the hackathon
 * rather than the button: somebody watching an event they entered is owed the
 * same account of where it has got to as the person running it. What changes is
 * whether there is anything to press, and who they are waiting on if not.
 */
function Move({
  mine,
  organizer,
  busy,
  label,
  onPress,
  children,
}: {
  mine: boolean;
  /**
   * The address the move belongs to, named so the reader knows who to expect.
   * Absent while the contract has not been read, which is a moment rather than
   * a state: the sentence stands without the address and gains it a beat later.
   */
  organizer: string | null;
  busy: boolean;
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  if (!mine) {
    return (
      <div className="grid gap-3">
        <p className="max-w-[38rem] text-[1rem] leading-relaxed text-ink-soft">{children}</p>

        <p className="max-w-[38rem] text-[0.9375rem] leading-relaxed text-ink-faint">
          This one is the organizer's to make
          {organizer !== null && (
            <>
              , and that is <span className="tabular text-[0.875rem]">{organizer}</span>
            </>
          )}
          .
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-5">
      <Button disabled={busy} onClick={onPress}>
        {busy ? "Signing" : label}
      </Button>

      <p className="max-w-[34rem] text-[0.9375rem] leading-relaxed text-ink-soft">{children}</p>
    </div>
  );
}

/** The single thing that can be done right now, and nothing else. */
function Next({
  running,
  rules,
  applications,
  contractId,
  address,
  sealed,
  busy,
  run,
}: {
  running: Running & { phase: number };
  /** The frozen rules, for the deadline this stage is waiting on. */
  rules: Rules | null;
  /** How many have applied, or null while it is still being counted. */
  applications: number | null;
  contractId: string;
  /** The connected wallet, which is what decides whether a move is offered. */
  address: string | null;
  /** Whether judging's roots are on chain, or null while that is still unread. */
  sealed: boolean | null;
  busy: boolean;
  run: (work: () => Promise<Sent & { contractId?: string }>) => Promise<void>;
}) {
  /* Its own clock, so a stage whose deadline passes while somebody is looking
     at the page unlocks without them reloading it. Half a minute is finer than
     any deadline here needs and coarse enough to cost nothing. */
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);

    return () => window.clearInterval(tick);
  }, []);

  /*
    Whose panel this is.

    The contract reserves none of the calls below to the organizer, and that is
    on purpose: each one is mechanical, so making it theirs alone would only let
    them sit on a result that is already decided. This page still offers them to
    the organizer and nobody else. A stranger holding the address is not an
    argument for putting the button in front of them, and every one of these is
    irreversible enough that finding it on somebody else's hackathon is a worse
    surprise than waiting.

    What a visitor sees instead is the same sentence without the button, and who
    to expect it from. Nothing is hidden: the stage, its deadline, and the fact
    that it is the organizer's move are all still on the page.
  */
  const mine = address !== null && address === running.organizer;

  /* A move is only ever offered to the organizer, so by the time one is pressed
     the address is theirs and known. */
  const press = (method: string) => () => {
    if (address !== null) {
      void run(() => send(contractId, method, [], address));
    }
  };

  /*
    Reveal, and nothing to press.

    This was the organizer's one remaining move, on the argument that nothing on
    chain knows whether the judges are finished. The collection service does: it
    holds every sealed card, no more can arrive once the root is published, and
    it ranks as soon as it has put them all on chain. Asking the organizer to
    confirm that was asking them to agree with a service they cannot see.
  */
  if (running.phase === 5) {
    return (
      <p className="max-w-[40rem] text-[1rem] leading-relaxed text-ink-soft">
        The scores are being opened and the contract ranks from them using the
        formula that was locked. It takes a minute or so, and it will not accept
        a ranking from anywhere else.
      </p>
    );
  }

  /*
    Finalization, and then settlement. Two stages with nothing to press in
    either.

    Both had a button here and neither deserved one. Opening the payouts waits
    on the safety window announced before the lock, which is a timestamp; closing
    the event waits on the vault owing nobody anything, which is arithmetic the
    contract already does. Asking the organizer to agree with either was asking
    them to confirm a fact, and the clock service sends both the moment they
    become true.

    The platform's cut went the same way. It was a button here, which made the
    organizer run our errand: they deposited the fee with the prize money and the
    rate was frozen before any of it, so there was nothing for them to decide. It
    leaves with the prizes now, last in the same run on the results page.
  */
  if (running.phase === 6) {
    return (
      <p className="max-w-[40rem] text-[1rem] leading-relaxed text-ink-soft">
        The ranking is settled. Paying opens by itself once the safety window in
        the rules has run out, and the winners are paid from the results page.
      </p>
    );
  }

  if (running.phase === 7) {
    return (
      <p className="max-w-[40rem] text-[1rem] leading-relaxed text-ink-soft">
        Hand the prizes out from the results page. The hackathon closes itself
        once the vault is empty, so this is the last thing anybody has to do.
      </p>
    );
  }

  /* Running. The phase only moves when its deadline has passed, and the
     contract is the one that decides that. */
  if (running.phase < PHASES.length - 2) {
    /* The moment the contract is waiting for, so the button can be held shut
       until then rather than offered and refused. It was offered: pressing it
       early came back as a contract error code, which reads as a fault rather
       than as a stage that has not finished. */
    const waiting = waitsFor(running.phase, rules);

    /*
      Nothing at all while the window is open.

      A greyed button with a date beside it says "your next move, but not yet",
      and there is no move: the event is running and the organizer's part of it
      is over until something arrives. `advance_phase` takes no address and
      calls no `require_auth`, so whoever is first past the deadline moves it
      on, which may well be a participant refreshing the public page. Sitting
      here was never the job.
    */
    if (waiting !== null && now < waiting) {
      return (
        <div className="grid gap-3">
          {/* What is in the queue, before the clock. An organizer opening this
              while sign-ups run is asking whether anybody came, and a card that
              opened with a deadline answered a question they had not asked. */}
          {running.phase === 2 && (
            <p className="text-[1.125rem] text-ink">
              {applications === null
                ? "Counting who has applied."
                : applications === 0
                  ? "Nobody has applied yet."
                  : applications === 1
                    ? "One application."
                    : `${applications} applications.`}
            </p>
          )}

          <p className="max-w-[40rem] text-[1rem] leading-relaxed text-ink-soft">
            {holding(running.phase)} until <Moment at={waiting} />,{" "}
            {left(waiting - now)} from now. It moves on by itself at that point,
            so you do not have to be here for it.
          </p>
        </div>
      );
    }

    /*
      Past the deadline, and still nothing to do.

      A contract cannot wake itself, so somebody has to send `advance_phase`,
      and the clock service is what does. That makes a passed deadline a short
      wait rather than a decision: a button here would be asking the organizer
      to agree with a timestamp, which is what this page used to do.
    */
    if (waiting !== null && now - waiting < STUCK) {
      return (
        <div className="grid gap-3">
          <p className="text-[1.125rem] text-ink">{over(running.phase)}</p>

          <p className="max-w-[40rem] text-[1rem] leading-relaxed text-ink-soft">
            {opens(running.phase)} That happens on its own within a minute or so
            of the deadline, and this page will catch up when it does.
          </p>
        </div>
      );
    }

    /*
      Judging, with nothing sealed.

      This is the one deadline whose passing is not a cue to move on. A root can
      only be published while the contract is in Judging, so advancing without
      one strands the hackathon for good: the cards sit in the collection
      service with nowhere to put them, and nothing can ever be ranked. The
      contract does not stop it — until a clock existed, the only party sending
      this call was the one who knew whether the sealing had happened.

      So the button is withheld rather than disabled. The organizer is not
      waiting on a service here, they are waiting on judges who have not handed
      their cards in, and the honest thing to show is who.
    */
    if (running.phase === 4 && sealed === false) {
      return <Sealing contractId={contractId} rules={rules} address={address} />;
    }

    /*
      Long enough past it that nothing is coming.

      Which means the clock service is down, and the call is still open to
      anybody, so the way out is to send it from here. Kept as a fallback rather
      than removed: the whole reason `advance_phase` asks for no signature is
      that no single party should be able to strand a hackathon, and a page that
      only ever waited for one service would hand that power straight back.
    */
    return (
      <Move
        mine={mine}
        organizer={running.organizer}
        busy={busy}
        label={moves(running.phase)}
        onPress={press("advance_phase")}
      >
        {waiting === null
          ? "The stage is over and nothing has moved it on."
          : `The deadline passed ${left(now - waiting)} ago and nothing has moved it on.`}{" "}
        That usually means the service that does it is down, and somebody has to
        send the call itself.
      </Move>
    );
  }

  return (
    <p className="max-w-[38rem] text-[1rem] leading-relaxed text-ink-soft">
      This hackathon has come to rest. Nothing can change it now.
    </p>
  );
}

/**
 * What is happening right now, in the organizer's words.
 *
 * A step covers more than one phase, so the step's name is too coarse to be the
 * heading: "Sign-ups and entries" stayed on screen through the screening round,
 * when sign-ups were over and the job was reading what arrived. The counter
 * above says how far along this is; this says what it is.
 */
function headline(running: Running & { phase: number }, funded: boolean): string {
  switch (running.phase) {
    case 0:
      return "Open the hackathon";
    case 1:
      return funded ? "Open the hackathon" : "Fund the prize pot";
    case 2:
      return "Applications";
    case 3:
      return "Entry check";
    case 4:
      return "Judging";
    case 5:
      return "Work out who won";
    case 6:
      return "Open settlement";
    case 7:
      return "Pay and close";
    default:
      return running.phase === PHASES.length - 1 ? "Cancelled" : "Finished";
  }
}

