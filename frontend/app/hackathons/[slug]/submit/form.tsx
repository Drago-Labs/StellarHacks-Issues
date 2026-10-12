"use client";

import { looksLikeContract } from "../../../../lib/explorer";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Measure } from "../../../components/primitives";
import { CommitButton } from "../../../components/commit-button";
import { ImagePicker } from "../../../create/image-picker";
import { uploadDeck } from "../../../../lib/artwork";
import { SpecHeading } from "../../../components/spec";
import { useWallet } from "../../../components/wallet-context";
import { arg, send, type Sent } from "../../../../lib/send";
import { challengeFor } from "../../../../lib/organizer";
import { metadataHash, standingOf, type Standing } from "../../../../lib/participate";
import { proveAddressHex } from "../../../../lib/wallet";
import type { Track } from "../../../../lib/rules";
import type { FieldRule, SubmissionFields } from "../../../../lib/constitution";
import { titleOf } from "../../../../lib/words";

/**
 * Entering a project, on a page of its own.
 *
 * This was four boxes in a modal, and it asked for the three things the
 * contract needs while quietly implying they were the whole of a submission.
 * They are not: a project is read by judges and by anybody browsing the event,
 * and what it looks like when they arrive is the team's work as much as the
 * repository is.
 *
 * So the page is shaped like the thing it produces. The name, the artwork and
 * the write up are laid out roughly as they will be read, and the links sit
 * under them.
 *
 * What the contract stores is still only a digest and a link. Everything else
 * is written beside it and can be corrected until the deadline, which is the
 * same split the whole product runs on: the chain holds what decides an
 * outcome, we hold what describes it.
 */

/** The column's own limit. Long enough for an architecture, short enough to be read. */
const OVERVIEW_LIMIT = 2000;

export function SubmitForm({
  contractId,
  slug,
  tracks,
  requires,
  userId,
}: {
  contractId: string;
  slug: string;
  /** From the frozen rules, so the choice is the contract's own list. */
  tracks: Track[];
  /**
   * What the organizer asked for, from the frozen rules.
   *
   * This file used to decide: the repository was required and the rest were
   * marked optional in their own placeholders. That is the organizer's call and
   * it was frozen before anybody entered, so it is read rather than assumed.
   *
   * A field they never asked for is not drawn at all. Showing every box to
   * everybody and only moving the word beside it was how a design event ended
   * up with entries judged against an empty repository row.
   */
  requires: SubmissionFields;
  /** Whose folder artwork lands in. Absent when nobody is signed in. */
  userId: string | null;
}) {
  const { wallet, known } = useWallet();
  const router = useRouter();

  const [standing, setStanding] = useState<Standing | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [chainAccepted, setChainAccepted] = useState(false);

  const [track, setTrack] = useState(tracks[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [deployed, setDeployed] = useState("");
  const [about, setAbout] = useState("");
  const [overview, setOverview] = useState("");
  const [logo, setLogo] = useState("");
  const [banner, setBanner] = useState("");
  const [deck, setDeck] = useState("");
  const [repo, setRepo] = useState("");
  const [live, setLive] = useState("");
  const [video, setVideo] = useState("");

  const address = wallet?.address ?? null;

  useEffect(() => {
    let alive = true;

    void (async () => {
      const found = address === null ? null : await standingOf(contractId, address);

      if (alive) {
        setStanding(found);
      }
    })();

    return () => {
      alive = false;
    };
  }, [contractId, address]);

  const team = standing?.teams[0] ?? null;
  /* Demanded and empty is the only thing that holds a submission back. A field
     that was never asked for is not checked at all, and one merely offered
     never was. */
  const missing = (rule: FieldRule, value: string) =>
    rule === "required" && value.trim().length === 0;

  const ready =
    title.trim().length > 0 &&
    track.length > 0 &&
    !missing(requires.repository, repo) &&
    !missing(requires.liveUrl, live) &&
    !missing(requires.demoVideo, video) &&
    !missing(requires.pitchDeck, deck) &&
    !missing(requires.deployedContract, deployed);

  async function saveProject(address: string, teamId: number): Promise<string | null> {
    if (userId === null) {
      return "Your entry is on-chain, but its title, description and artwork need a signed-in StelHacks account before they can be saved.";
    }

    try {
      const issuedAt = Math.floor(Date.now() / 1000);
      const response = await fetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract: contractId,
          teamId,
          title: title.trim(),
          summary: summary.trim(),
          description: about.trim(),
          technical_overview: overview.trim(),
          contract_address: deployed.trim(),
          logo_url: logo,
          banner_url: banner,
          pitch_deck_url: deck,
          repository_url: repo.trim(),
          live_url: live.trim(),
          demo_video_url: video.trim(),
          issuedAt,
          signature: await proveAddressHex(
            address,
            challengeFor(contractId, userId, issuedAt, "team"),
          ),
        }),
      });

      if (response.ok) {
        return null;
      }

      const problem = (await response.json().catch(() => null)) as { error?: unknown } | null;
      const reason =
        typeof problem?.error === "string" && problem.error.length > 0
          ? problem.error
          : `the details service returned ${response.status}`;

      return `Your entry is on-chain, but its project details were not saved: ${reason}`;
    } catch {
      return "Your entry is on-chain, but its project details could not be saved because the details service could not be reached.";
    }
  }

  async function submit() {
    if (address === null || team === null) {
      return;
    }

    setBusy(true);
    setFailed(null);

    if (!chainAccepted) {
      /*
        Hashed from exactly what was typed, in the browser that typed it.

        The contract keeps this digest and nothing else, so anybody can later take
        the text off our side, hash it the same way and see whether it is the text
        that was pinned before the deadline. Fields the person left empty are left
        out rather than hashed as empty strings, so adding an optional field later
        does not change the digest of a project that never used it.
      */
      const pinned = Object.fromEntries(
        Object.entries({
          title: title.trim(),
          summary: summary.trim(),
          description: about.trim(),
          contract_address: deployed.trim(),
          repository: repo.trim(),
          live: live.trim(),
          video: video.trim(),
          /* Pinned now that an organizer can demand one. A field the frozen rules
             can make compulsory has to be covered by the digest, or an event
             could require a deck and have nothing to hold the team to. */
          deck: deck.trim(),
        }).filter(([, value]) => value.length > 0),
      );

      const digest = await metadataHash(pinned);

      /*
        The URI is public contract state, so it must never be the repository or
        another private submission field. It points back to the StelHacks page
        instead; that page reads the write-up through RLS and therefore keeps
        the same Public / Participants / Restricted rule as the gallery.
      */
      const projectUri = new URL(
        `/hackathons/${encodeURIComponent(slug)}/projects/${team}`,
        window.location.origin,
      ).toString();

      const outcome: Sent = await send(
        contractId,
        "submit_project",
        [
          await arg.address(address),
          await arg.u32(team),
          await arg.symbol(track),
          await arg.bytes32(digest),
          await arg.text(projectUri),
        ],
        address,
      );

      if (!outcome.ok) {
        setFailed(outcome.refused ? null : (outcome.why ?? "the contract refused it"));
        setBusy(false);

        return;
      }

      setChainAccepted(true);
    }

    /* A failed description write no longer masquerades as success. The
       on-chain entry is already safe, and the next press retries only this
       off-chain half instead of asking the wallet to submit it again. */
    const saveError = await saveProject(address, team);

    if (saveError !== null) {
      setFailed(saveError);
      setBusy(false);

      return;
    }

    router.push(`/hackathons/${slug}?tab=projects`);
  }

  if (!known) {
    return <Note>Looking for a wallet.</Note>;
  }

  if (address === null) {
    return <Note>Connect the wallet you entered with to submit a project.</Note>;
  }

  if (standing === null) {
    return <Note>Reading the contract.</Note>;
  }

  if (team === null) {
    return (
      <Note>
        You need a team before you can submit. Start one, or join somebody
        else&rsquo;s, from the hackathon page.
      </Note>
    );
  }

  return (
    /* Centred, because a form is a column and this one had nothing beside it.
       Left aligned in a wide measure it sat against one edge of an empty page
       with the fields stopping two thirds of the way across, which reads as a
       layout that lost its other half. */
    <Measure wide className="py-12">
      <div className="mx-auto max-w-[46rem]">
        <SpecHeading>What you built</SpecHeading>

        <p className="mt-5 text-[1rem] leading-relaxed text-ink-soft">
          The chain records a digest of this and the repository link. Everything
          else is how judges and visitors will read it, and you can change any of
          it until submissions close.
        </p>

        <div className="mt-12 grid gap-6">
          <Part number={1} title="Introduction">
            {tracks.length > 1 && (
              <label className="grid gap-2">
                <span className="text-[1rem] font-semibold text-ink">Category</span>

                <select
                  value={track}
                  onChange={(event) => setTrack(event.target.value)}
                  className="h-12 rounded-[0.625rem] bg-paper px-4 text-[1.0625rem] text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-2 focus:ring-ink"
                >
                  {tracks.map((one) => (
                    <option key={one.id} value={one.id}>
                      {titleOf(one.id)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <Field label="Project name" value={title} onChange={setTitle} placeholder="Lumen Split" />

            <Field
              label="Short description"
              hint="at most two sentences"
              value={summary}
              onChange={setSummary}
              placeholder="What it does, and who it is for"
            />
          </Part>

          <Part number={2} title="Presentation">
            {userId === null ? (
              <p className="text-[0.9375rem] text-ink-soft">
                Sign in to upload artwork. A project without it still enters.
              </p>
            ) : (
              <div className="grid gap-6 sm:grid-cols-2">
                <ImagePicker
                  label="Logo"
                  shape="logo"
                  userId={userId}
                  value={logo}
                  onChange={setLogo}
                />

                <ImagePicker
                  label="Banner"
                  shape="banner"
                  userId={userId}
                  value={banner}
                  onChange={setBanner}
                />
              </div>
            )}

          </Part>

          <Part number={3} title="About">
            <label className="grid gap-2">
              <span className="text-[1rem] font-semibold text-ink">Full description</span>

              <textarea
                value={about}
                onChange={(event) => setAbout(event.target.value.slice(0, 20_000))}
                rows={12}
                placeholder="What problem it solves, how it works, what you would do next."
                className="rounded-[0.625rem] bg-paper p-4 text-[1.0625rem] leading-relaxed text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-2 focus:ring-ink"
              />
            </label>

            {/* Kept apart from the description because it answers a different
                question. The description sells the idea; this says what was
                actually built, and it is what a judge and the AI review read
                to tell a working project from a well written one. */}
            <label className="grid gap-2">
              <span className="flex items-baseline justify-between gap-4">
                <span className="text-[1rem] font-semibold text-ink">Technical overview</span>
                <span className="tabular text-[0.8125rem] text-ink-faint">
                  {overview.length} / {OVERVIEW_LIMIT}
                </span>
              </span>

              <span className="text-[0.9375rem] leading-relaxed text-ink-soft">
                How it works under the hood: the architecture, what runs on chain and
                what does not, the contracts and their main functions, and what is
                finished versus planned. Point to files in the repository where you
                can. Claims that the repository does not back up count for little.
              </span>

              <textarea
                value={overview}
                onChange={(event) => setOverview(event.target.value.slice(0, OVERVIEW_LIMIT))}
                rows={8}
                placeholder="A Soroban contract in contracts/split holds the funds and pays out on release(). The Next.js app in web/ builds the transactions…"
                className="rounded-[0.625rem] bg-paper p-4 text-[1.0625rem] leading-relaxed text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-2 focus:ring-ink"
              />
            </label>
          </Part>

          <Part number={4} title="Deliverables">
            {requires.repository !== "unasked" && (
              <Field
                label="Repository"
                value={repo}
                onChange={setRepo}
                placeholder="https://github.com/…"
                icon={<GitHub />}
                optional={requires.repository === "optional"}
              />
            )}

            {requires.liveUrl !== "unasked" && (
              <Field
                label="Live site"
                value={live}
                onChange={setLive}
                placeholder="https://…"
                icon={<Globe />}
                optional={requires.liveUrl === "optional"}
              />
            )}

            {requires.demoVideo !== "unasked" && (
              <Field
                label="Demo video"
                value={video}
                onChange={setVideo}
                placeholder="https://…"
                icon={<YouTube />}
                optional={requires.demoVideo === "optional"}
              />
            )}

            {/* Rarely demanded, and it can be now. A wallet, an indexer or a
                piece of tooling is a whole project at a Stellar hackathon and
                never deploys anything, so an event that wants a contract has to
                say so before anybody enters rather than have every entry
                assumed to carry one. */}
            {requires.deployedContract !== "unasked" && (
              <Field
                label="Contract"
                value={deployed}
                onChange={setDeployed}
                placeholder="C…"
                icon={<Stellar />}
                optional={requires.deployedContract === "optional"}
                note={
                  deployed.trim().length > 0 && !looksLikeContract(deployed.trim())
                    ? "A contract id starts with C and is 56 characters."
                    : undefined
                }
              />
            )}

            {/* Last, because it is the only one that is a file rather than a
                link. It needs somewhere to upload to, so signing out is the one
                thing that can take a demanded field off the form; the note
                below says so rather than leaving a gap. */}
            {requires.pitchDeck !== "unasked" &&
              (userId === null ? (
                <p className="text-[0.9375rem] text-ink-soft">
                  Sign in to attach a pitch deck
                  {requires.pitchDeck === "required" && ", which this event asks for"}.
                </p>
              ) : (
                <DeckPicker
                  userId={userId}
                  value={deck}
                  onChange={setDeck}
                  optional={requires.pitchDeck === "optional"}
                />
              ))}
          </Part>
        </div>

        {/* One control, centred under the column it finishes. "Back" was a
            second thing to consider at the moment somebody has decided, and the
            note beside it repeated what the required marks on the fields
            already say. */}
        <div className="mt-12 flex justify-center border-t border-rule pt-10">
          <CommitButton disabled={busy || !ready} onClick={() => void submit()}>
            {busy
              ? chainAccepted
                ? "Saving details"
                : "Signing"
              : chainAccepted
                ? "Retry saving project details"
                : "Submit the project"}
          </CommitButton>
        </div>

        {failed !== null && (
          <p className="mt-6 max-w-[38rem] text-[0.9375rem] leading-relaxed text-broken">{failed}</p>
        )}
      </div>
    </Measure>
  );
}

/**
 * One band of the form, drawn the way the create wizard draws its own.
 *
 * The two forms are the same job from two sides — an organizer writing rules, a
 * team writing a project — so they are the same object to look at. Copying the
 * shape rather than inventing a second one is what keeps somebody who has filled
 * in one from having to learn the other.
 *
 * Plain digits rather than the padded `01` the chain's rows use. Those are
 * indexes into a specification somebody cross references; these are the order a
 * person fills something in, and nobody counts their own steps in two digits.
 */
function Part({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[1.25rem] bg-paper p-8 ring-1 ring-rule sm:p-10">
      <div className="flex items-center gap-3.5">
        <span className="tabular grid size-9 shrink-0 place-items-center rounded-full bg-paper-sunk text-[1.0625rem] font-semibold text-ink-soft ring-1 ring-inset ring-rule">
          {number}
        </span>

        <h2 className="text-[1.5rem] text-ink">{title}</h2>
      </div>

      <div className="mt-8 grid gap-6">{children}</div>
    </section>
  );
}

/**
 * One field, drawn as the create wizard draws its own.
 *
 * The label is ink rather than grey for the reason given there: a label is the
 * question and the placeholder is an example answer, and at the same weight the
 * form reads as a column of grey with nothing saying which part is somebody's
 * to supply.
 */
function Field({
  label,
  value,
  onChange,
  placeholder,
  hint,
  icon,
  optional = false,
  note,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  /** A limit or a shape, said beside the question rather than inside the box. */
  hint?: string;
  /** Drawn inside the box, for the fields whose destination has a face. */
  icon?: React.ReactNode;
  /**
   * Whether the frozen rules let a team leave this out.
   *
   * Both answers are drawn. Marking only the optional ones left "required" to
   * be inferred from an absence, which is the reading somebody does after they
   * have already been refused.
   */
  optional?: boolean;
  /** What is wrong with what they have typed, once they have typed it. */
  note?: string;
}) {
  return (
    <label className="grid gap-2">
      <span className="flex items-baseline gap-2">
        {/* Sentence case and full weight. Small tracked capitals are how this
            page reports what the chain holds; a question put to a person is
            language, and it was competing with its own placeholder. */}
        <span className="text-[1rem] font-semibold text-ink">{label}</span>

        {hint !== undefined && <span className="text-[0.875rem] text-ink-faint">{hint}</span>}

        {optional !== undefined &&
          (optional ? (
            <span className="text-[0.875rem] text-ink-faint">optional</span>
          ) : (
            <span className="text-[0.875rem] text-signal-deep dark:text-signal">required</span>
          ))}
      </span>

      <span className="flex h-12 items-center rounded-[0.625rem] bg-paper ring-1 ring-inset ring-rule transition-shadow duration-150 ease-settle focus-within:ring-2 focus-within:ring-ink">
        {icon !== undefined && (
          <span aria-hidden className="grid w-11 shrink-0 place-items-center text-ink-faint">
            {icon}
          </span>
        )}

        <input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className={`h-full min-w-0 flex-1 bg-transparent text-[1.0625rem] text-ink outline-none ${
            icon === undefined ? "px-4" : "pr-4"
          }`}
        />
      </span>

      {/* Under the box, in the colour of a refusal, and only once there is
          something to refuse. A shape stated before anybody has typed is a
          hint; the same words after they have are a correction. */}
      {note !== undefined && <span className="text-[0.875rem] text-broken">{note}</span>}
    </label>
  );
}

/* Drawn rather than fetched, so the page ships no extra request for the
   marks that never change. */
/* The Stellar mark: the four pointed star between two arcs. Drawn rather than
   fetched, like every other mark in this form. */
function Stellar() {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className="size-4 shrink-0">
      <path d="M12 1.6a10.4 10.4 0 0 0-9.2 5.6l1.9 1a8.3 8.3 0 0 1 14.1-1.5l1.7-1.3A10.4 10.4 0 0 0 12 1.6Zm0 20.8a10.4 10.4 0 0 0 9.2-5.6l-1.9-1a8.3 8.3 0 0 1-14.1 1.5l-1.7 1.3A10.4 10.4 0 0 0 12 22.4Z" />
      <path d="m12 7.4 1.3 3.3 3.3 1.3-3.3 1.3L12 16.6l-1.3-3.3L7.4 12l3.3-1.3L12 7.4Z" />
    </svg>
  );
}

function GitHub() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="size-4">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function YouTube() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className="size-4">
      <path d="M15.67 4.16c-.18-.7-.72-1.24-1.4-1.42C13.02 2.44 8 2.44 8 2.44s-5.02 0-6.27.3c-.68.18-1.22.72-1.4 1.42C0 5.42 0 8 0 8s0 2.58.33 3.84c.18.7.72 1.24 1.4 1.42 1.25.3 6.27.3 6.27.3s5.02 0 6.27-.3c.68-.18 1.22-.72 1.4-1.42C16 10.58 16 8 16 8s0-2.58-.33-3.84ZM6.4 10.4V5.6L10.6 8l-4.2 2.4Z" />
    </svg>
  );
}

function Globe() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" className="size-4">
      <circle cx="8" cy="8" r="6.4" />
      <path d="M1.6 8h12.8M8 1.6c1.7 1.8 2.6 4 2.6 6.4S9.7 12.6 8 14.4c-1.7-1.8-2.6-4-2.6-6.4S6.3 3.4 8 1.6Z" />
    </svg>
  );
}

/** Why the form is not here, in the column the form would have been in. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <Measure wide className="py-16">
      <p className="mx-auto max-w-[46rem] text-[1rem] leading-relaxed text-ink-soft">
        {children}
      </p>
    </Measure>
  );
}

/**
 * The deck, uploaded rather than linked.
 *
 * A team already has this file; asking them to host it somewhere first is the
 * step that makes people skip it. Whether it is demanded is the organizer's
 * call in the frozen rules, and it is marked here the way every other field is.
 */
function DeckPicker({
  userId,
  value,
  onChange,
  optional,
}: {
  userId: string;
  value: string;
  onChange: (url: string) => void;
  optional: boolean;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  /* What was chosen, remembered here because the upload renames the file to a
     timestamp on the way into the bucket and the URL that comes back carries
     nothing a person would recognise. Absent on a draft reopened later, where
     there is a deck and no memory of what it was called. */
  const [chose, setChose] = useState<{ name: string; size: number } | null>(null);

  async function take(file: File | undefined) {
    if (file === undefined) {
      return;
    }

    setBusy(true);
    setRefused(null);

    const uploaded = await uploadDeck(file, userId);

    setBusy(false);

    if (uploaded.url === null) {
      setRefused(uploaded.message);

      return;
    }

    setChose({ name: file.name, size: file.size });
    onChange(uploaded.url);
  }

  const attached = value.length > 0;

  return (
    <div className="grid gap-2">
      <span className="flex items-baseline gap-2.5">
        <span className="text-[1rem] font-semibold text-ink">Pitch deck</span>
        <span className="text-[0.875rem] text-ink-faint">PDF, up to 20 MB</span>

        {optional ? (
          <span className="text-[0.875rem] text-ink-faint">optional</span>
        ) : attached ? null : (
          <span className="text-[0.875rem] text-signal-deep dark:text-signal">required</span>
        )}
      </span>

      <input
        ref={picker}
        type="file"
        accept="application/pdf"
        className="hidden"
        onChange={(event) => {
          void take(event.target.files?.[0]);
          /* Cleared so choosing the same file twice still fires, which is what
             somebody does after an upload fails. */
          event.target.value = "";
        }}
      />

      {/*
        Attached, and visibly so.

        This was one grey row reading "Uploaded — choose another", which asks
        somebody to notice that four words changed in a control that otherwise
        looks identical either way. A pitch deck is the one thing on this form
        a team cannot check by re-reading it, so the confirmation says the
        file's own name, its size, and offers to open it. Opening it is the
        part that actually proves the upload: the bytes came back.
      */}
      {attached ? (
        <div className="grid gap-2 rounded-[0.625rem] bg-verified/8 p-3 ring-1 ring-inset ring-verified/30">
          <div className="flex items-center gap-3">
            <Ticked />

            <span className="min-w-0 flex-1">
              <span className="block truncate text-[1rem] text-ink">
                {chose?.name ?? "Your pitch deck"}
              </span>

              <span className="block text-[0.8125rem] text-ink-soft">
                {busy
                  ? "Replacing"
                  : chose === null
                    ? "Attached to this submission"
                    : `Attached · ${megabytes(chose.size)}`}
              </span>
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-4 text-[0.875rem]">
            <a
              href={value}
              target="_blank"
              rel="noreferrer noopener"
              className="text-ink underline decoration-rule underline-offset-4 transition-colors duration-150 ease-settle hover:decoration-ink"
            >
              Open it
            </a>

            <button
              type="button"
              disabled={busy}
              onClick={() => picker.current?.click()}
              className="text-ink-soft underline decoration-rule underline-offset-4 transition-colors duration-150 ease-settle hover:text-ink hover:decoration-ink disabled:opacity-40"
            >
              Replace
            </button>

            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setChose(null);
                onChange("");
              }}
              className="text-ink-soft underline decoration-rule underline-offset-4 transition-colors duration-150 ease-settle hover:text-broken hover:decoration-broken disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => picker.current?.click()}
          className="flex h-12 items-center gap-3 rounded-[0.625rem] bg-paper px-4 text-left text-[1rem] ring-1 ring-inset ring-rule transition-shadow duration-150 ease-settle hover:ring-ink disabled:opacity-60"
        >
          <Document />

          <span className="text-ink-faint">{busy ? "Uploading" : "Choose a file"}</span>
        </button>
      )}

      {refused !== null && <span className="text-[0.875rem] text-broken">{refused}</span>}
    </div>
  );
}

/** The size as a person would say it, which is never in bytes. */
function megabytes(size: number): string {
  const mb = size / 1_000_000;

  return mb < 0.1 ? `${Math.max(1, Math.round(size / 1_000))} KB` : `${mb.toFixed(1)} MB`;
}

/** The one mark on this form that says a thing is done rather than pending. */
function Ticked() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-5 shrink-0 text-verified"
    >
      <circle cx="8" cy="8" r="6.4" />
      <path d="m5.4 8.2 1.8 1.8 3.4-3.8" />
    </svg>
  );
}

function Document() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      className="size-4 shrink-0 text-ink-faint"
    >
      <path d="M9.2 1.6H4.4a1.2 1.2 0 0 0-1.2 1.2v10.4a1.2 1.2 0 0 0 1.2 1.2h7.2a1.2 1.2 0 0 0 1.2-1.2V5.2L9.2 1.6Z" />
      <path d="M9.2 1.6v3.6h3.6" />
    </svg>
  );
}
