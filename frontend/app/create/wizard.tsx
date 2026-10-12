"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { Button, ButtonLink } from "../components/primitives";
import { SubRosaSeal } from "../components/sub-rosa";
import { TagField } from "../components/tag-field";
import { ImagePicker } from "./image-picker";
import { useWallet } from "../components/wallet-context";
import { deploy, send, type Sent } from "../../lib/send";
import { PRIZE_ASSETS } from "../../lib/money";
import { feeBpsForPrize } from "../../lib/organizing";
import { proveAddressHex } from "../../lib/wallet";
import { rulesFor } from "../../lib/rules";
import { symbolOf, titleOf } from "../../lib/words";
import {
  OPEN_TO_SPONSORS,
  WEIGHT_TOTAL_BPS,
  configureArgs,
  createArgs,
  feeFor,
  toSmallestUnit,
  totalPrize,
  type Draft,
  type FieldRule,
  type SubmissionFields,
  type Track,
} from "../../lib/constitution";

/**
 * Writing the rules, before they are frozen.
 *
 * Everything on this form ends up inside one hashed object. After the lock it
 * cannot be edited, only cancelled, so the form's job is not to be quick: it is
 * to make the two things that decide an outcome impossible to get wrong without
 * noticing. Those are the prize table, which the vault has to match exactly,
 * and the rubric weights, which have to add up.
 *
 * Both are shown as running totals rather than validated on submit. A number
 * that goes wrong should look wrong while it is being typed.
 */

/**
 * The core wasm already uploaded to the network, from `docs/deployments.md`.
 *
 * This form used to ask for a contract address and note that it was "the
 * hackathon contract you deployed", which put a command line step in the middle
 * of a web form and asked for its output. Every event deploys its own instance
 * anyway, so the form deploys one: the address is a consequence of pressing the
 * button, not a prerequisite for it.
 */
/*
  The core wasm this build deploys, from `docs/deployments.md`.

  It has to be the build that understands the constitution this file writes. The
  document is at version six and the contract checks that field before reading
  anything else, so deploying the version five wasm would leave an organizer
  watching a deploy succeed and the very next call refuse, with nothing on
  screen to connect the two.

  Changing the contract therefore means uploading the new wasm and changing this
  line, in that order. Until the upload lands the deploy fails outright, which
  is the failure worth having: it names the missing step instead of appearing
  three calls later as a rejected document.
*/
const CORE_WASM = "4bf32e95b0758cc6af291bf4e91f86dba1bad8c7e81926479f6404af73c7ec1c";

export function Wizard({
  feeBps: grantedFeeBps,
  userId,
  editing = null,
}: {
  feeBps: number;
  userId: string;
  /**
   * The hackathon whose draft rules are being rewritten, or nothing when this
   * is a new one.
   *
   * The same form either way, because it is the same document. A separate edit
   * screen would be a second place for the rules to be described and the two
   * would drift, which on a form whose output gets hashed and frozen is the
   * kind of drift nobody finds until it is permanent.
   */
  editing?: string | null;
}) {
  const { wallet, known, wrongNetwork } = useWallet();
  const router = useRouter();

  const [asset, setAsset] = useState("");
  const [tracks, setTracks] = useState<Track[]>([blankTrack()]);
  const [judges, setJudges] = useState<string[]>([""]);

  /* How the final score is split. The standard answer is the judges alone; the
     other two exist because a hackathon whose crowd was let in one approval at
     a time can be decided by that crowd without it being a popularity contest
     between strangers. */
  const [communityBps, setCommunityBps] = useState(0);
  /* Public is the discoverable default. The organizer must deliberately close
     the gallery, and the choice is then frozen into the constitution. */
  const [visibility, setVisibility] = useState<0 | 1 | 2>(0);
  const [dates, setDates] = useState(defaultDates);
  const [settlementDelay, setSettlementDelay] = useState(86_400);
  /* A week across two moves. Enough for the thing that actually happens — a
     build window slipping once because half the field asked — without turning
     a published schedule into a suggestion. */
  const [allowance, setAllowance] = useState(2);
  /*
    Reviewed by default, and that is the cautious end rather than the common
    one. An organizer who meant an open event and left this alone signs once per
    applicant; one who meant to screen and left it open finds strangers already
    admitted to rules they never agreed to, and cannot take it back.
  */
  const [openRegistration, setOpenRegistration] = useState(false);
  /* Open by default. A hackathon nobody can help fund is the outcome of
     nobody thinking about this field, and there is no way back from it once
     the rules freeze. Taking money costs a participant nothing: the prize
     table only ever grows, and every contribution lands on a position that
     was announced before they entered. */
  const [sponsorship, setSponsorship] = useState<"closed" | "money" | "categories">("money");

  /* What a submission has to carry. The default is the one most events mean:
     show the code, everything else offered and nothing else demanded. */
  const [requires, setRequires] = useState<SubmissionFields>({
    repository: "required",
    demoVideo: "optional",
    liveUrl: "optional",
    pitchDeck: "optional",
    deployedContract: "optional",
  });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Sent | null>(null);

  /* The address of a hackathon that reached the chain but whose description did
     not save. Its presence is what turns the form into a way out. */
  const [made, setMade] = useState<string | null>(null);

  /* What the hackathon looks like. None of it decides anything, so none of it
     is in the constitution and none of it is frozen; it is written beside the
     contract afterwards and can be corrected. */
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [location, setLocation] = useState("");
  const [tags, setTags] = useState("");
  const [logo, setLogo] = useState("");
  const [banner, setBanner] = useState("");

  /* The ticker for whichever token was picked, so an amount typed three cards
     further down says what it is an amount of. Empty until one is chosen, which
     is also when the prize boxes are still meaningless. */
  const assetCode = PRIZE_ASSETS.find((choice) => choice.contract === asset)?.code ?? "";

  /*
    What a lumen costs, read once when lumens are what this event pays in.

    Prizes are typed in dollars, because that is the unit an organizer has a
    budget in and the unit a participant compares two hackathons in. The
    contract holds tokens, so the two have to be reconciled somewhere, and the
    honest place is here, in the open, at a rate that is shown before anybody
    signs. Read through our own route rather than straight from the price feed:
    the answer is the same for everybody, and this is the one number on the form
    that decides how much money is committed.
  */
  const [rate, setRate] = useState<number | null>(null);
  const [rateFailed, setRateFailed] = useState(false);
  const [draftFeeBps, setDraftFeeBps] = useState<number | null>(null);

  useEffect(() => {
    if (assetCode !== "XLM") {
      return;
    }

    let live = true;

    void fetch("/api/rate")
      .then((answer) => answer.json() as Promise<{ price: number | null }>)
      .then((said) => {
        if (!live) {
          return;
        }

        setRate(said.price);
        setRateFailed(said.price === null);
      })
      .catch(() => live && setRateFailed(true));

    return () => {
      live = false;
    };
  }, [assetCode]);

  /* One dollar is one USDC by definition, so the stablecoin needs no quote and
     must not wait for one. */
  const quote = assetCode === "USDC" ? 1 : rate;

  /*
    Editing takes the amounts in the token, not in dollars.

    A new hackathon is budgeted in dollars, because that is the unit an
    organizer thinks in. An existing one already has a prize table in the token,
    frozen into a draft on chain, and showing it back in dollars would mean
    converting out at one rate and back in at another. Opening the form and
    saving it untouched would then change every prize, which is the one thing an
    edit screen must never do.
  */
  const inTokens = editing !== null;

  /* One is the identity here: an amount already in the token converts to
     itself, so the same pipeline serves both modes without a second path. */
  const priceOfOne = inTokens ? 1 : quote;

  /*
    The approval tier is only the starting rate. Once the prize table crosses
    five thousand dollars the standard five percent is the minimum, including
    for an organizer originally approved for a smaller community event.

    Existing drafts keep the rate already written into their constitution. The
    fields there are token amounts rather than dollars, so reapplying a dollar
    threshold here would compare unlike units and could silently change a fee
    merely because somebody opened the edit form.
  */
  const statedPrizeDollars = useMemo(() => totalPrize(tracks), [tracks]);
  const feeBps =
    editing === null
      ? feeBpsForPrize(grantedFeeBps, statedPrizeDollars)
      : (draftFeeBps ?? grantedFeeBps);

  /*
    The prize table as the contract will hold it.

    Everything typed above this line is in whichever unit the mode asks for.
    Everything below it, including the figure the vault is asked for and the
    amounts written into the frozen rules, is in the token. Converting once,
    here, is what keeps a form that reads in dollars from ever encoding a dollar
    into a field that means lumens.
  */
  const priced = useMemo(
    () =>
      tracks.map((track) => ({
        ...track,
        /* The one place a name becomes the contract's identifier. What is held
           in the form is what somebody typed; what is hashed into the
           constitution is its symbol, and everything that shows one back turns
           it into words again. */
        id: symbolOf(track.id),
        criteria: track.criteria.map((criterion) => ({
          ...criterion,
          id: symbolOf(criterion.id),
        })),
        prizes: track.prizes.map((prize) => ({
          ...prize,
          amount: inAsset(prize.amount, priceOfOne),
        })),
      })),
    [tracks, priceOfOne],
  );

  const total = useMemo(() => totalPrize(priced), [priced]);

  /* Rounded down, the way the contract rounds it, so the number on screen is
     the number the vault will be asked for rather than one a rounding rule
     later disagrees with by a stroop. */
  const fee = (total * BigInt(feeBps)) / BigInt(10_000);
  const deposit = total + fee;

  /*
    One figure per line of the card below, in the token.

    Each line used to carry the same money twice, once in each unit, which is
    six numbers for three amounts and leaves the reader working out which two
    of them are the same. The token is the one worth showing: it is what the
    vault is asked for and what the frozen rules encode, and in dollar mode it
    is what the typed dollars came to at today's rate.

    A dash rather than zero when a dollar figure has no rate to convert at. The
    amounts are genuinely unknown then, and zero is a number somebody could
    read as a free event.
  */
  const figure = (units: bigint): string =>
    !inTokens && quote === null
      ? "—"
      : `${format(units)}${assetCode.length > 0 ? ` ${assetCode}` : ""}`;

  /* Null when this deployment was told to charge and has nowhere to send it,
     which is a misconfiguration rather than a free event. Creation is blocked
     rather than quietly turned into a free one. */
  const platformFee = wallet === null ? null : feeFor(feeBps, wallet.address);

  /*
    The draft as it stands, put back into the form.

    Read from the contract rather than from our tables, because the contract is
    what holds the rules and what `configure` will be checked against. The
    presentation columns come from our side, since the chain has never heard of
    a tagline.

    Loading is its own state rather than an empty form that fills in. A form
    that appears blank and then repopulates is one somebody starts typing into,
    and every keystroke before the answer arrives is lost.
  */
  const [loading, setLoading] = useState(editing !== null);

  useEffect(() => {
    if (editing === null) {
      return;
    }

    let live = true;

    void (async () => {
      const [rules, written] = await Promise.all([
        rulesFor(editing).catch(() => null),
        fetch(`/api/hackathon?contract=${editing}`)
          .then((answer) => (answer.ok ? answer.json() : null))
          .catch(() => null),
      ]);

      if (!live) {
        return;
      }

      if (rules !== null) {
        setAsset(rules.prizeAsset ?? "");
        setJudges(rules.judgeAddresses.length > 0 ? rules.judgeAddresses : [""]);
        setDates({
          opens: momentAt(rules.schedule.registrationOpens),
          registrationCloses: momentAt(rules.schedule.registrationCloses),
          submissionCloses: momentAt(rules.schedule.submissionCloses),
          screeningCloses: momentAt(rules.schedule.screeningCloses),
          judgingCloses: momentAt(rules.schedule.judgingCloses),
        });
        setSettlementDelay(rules.settlementDelay);
        setDraftFeeBps(rules.platformFeeBps);
        setAllowance(closestAllowance(rules.extensions));
        setRequires(rules.requires);
        setOpenRegistration(rules.openRegistration);
        setCommunityBps(rules.communityBps);
        setVisibility(asVisibility(rules.visibility));

        setTracks(
          rules.tracks.map((track) => ({
            /* Back into the words it was written as, for the same reason the
               criteria below are: reopening a draft should show "Smart
               Contracts" rather than the symbol it was frozen as. */
            id: titleOf(track.id),
            noAwardAllowed: track.noAwardAllowed,
            criteria: track.criteria.map((criterion) => ({
              /* Back into the words it was written as, so reopening a draft
                 shows "Clean Code" rather than the symbol it was frozen as. */
              id: titleOf(criterion.id),
              weightBps: criterion.weightBps,
            })),
            /* Ranked, because the contract stores the tiers as a flat list
               across every track and the order it returns them in is its own
               business rather than a promise. */
            prizes: rules.tiers
              .filter((tier) => tier.track === track.id)
              .sort((a, b) => a.rank - b.rank)
              .map((tier) => ({ rank: tier.rank, amount: unitsToString(tier.amount) })),
          })),
        );
      }

      if (written !== null) {
        setName(String(written.name ?? ""));
        setTagline(String(written.tagline ?? ""));
        setLocation(String(written.location ?? ""));
        setLogo(String(written.logo_url ?? ""));
        setBanner(String(written.banner_url ?? ""));
        setTags(Array.isArray(written.tags) ? written.tags.join(", ") : "");
      }

      setLoading(false);
    })();

    return () => {
      live = false;
    };
  }, [editing]);

  /*
    What was typed, kept on this machine until it is signed.

    The form is long, it sits in front of a wallet prompt, and everything on it
    ends up inside one hashed document, so it is not a thing anybody wants to
    fill in twice. A reload used to empty it.

    The browser's own storage rather than a row in our tables: a draft nobody
    has signed is not ours to hold, and holding it would mean a half written
    prize table living on a server before its author decided it was real.

    New hackathons only. An edit reads the frozen rules off the chain, and
    restoring a local copy over them would show somebody rules the contract does
    not hold.
  */
  const kept = `stelhacks.create.draft.${userId}`;
  const [restored, setRestored] = useState(editing !== null);

  useEffect(() => {
    if (editing !== null) {
      return;
    }

    try {
      const held = window.localStorage.getItem(kept);

      if (held !== null) {
        const was = JSON.parse(held) as Partial<Kept>;

        /* Every field checked on the way in. This came from disk, which means
           it could be a draft written by an older build of this form, and a
           shape that no longer matches must read as no draft rather than as a
           form that throws while somebody is looking at it. */
        text(was.asset, setAsset);
        text(was.name, setName);
        text(was.tagline, setTagline);
        text(was.location, setLocation);
        text(was.tags, setTags);
        text(was.logo, setLogo);
        text(was.banner, setBanner);

        if (Array.isArray(was.tracks) && was.tracks.length > 0) {
          setTracks(was.tracks);
        }

        if (Array.isArray(was.judges) && was.judges.length > 0) {
          setJudges(was.judges);
        }

        /* Order only. A draft left on this machine overnight has an opening
           moment in the past through no fault of its own, and throwing it away
           for that would lose everything else somebody typed. */
        if (was.dates !== undefined && disordered(was.dates, false) === null) {
          setDates(was.dates);
        }

        if (typeof was.settlementDelay === "number") {
          setSettlementDelay(was.settlementDelay);
        }

        const kept = was.allowance;

        if (typeof kept === "number" && EXTENSION_ALLOWANCES[kept] !== undefined) {
          setAllowance(kept);
        }

        if (was.requires !== undefined) {
          setRequires(was.requires);
        }

        if (typeof was.openRegistration === "boolean") {
          setOpenRegistration(was.openRegistration);
        }

        if (typeof was.communityBps === "number") {
          setCommunityBps(was.communityBps);
        }

        if (typeof was.visibility === "number") {
          setVisibility(asVisibility(was.visibility));
        }
      }
    } catch {
      /* A draft that cannot be read is a draft that is gone. Nothing in here is
         worth failing a page load over. */
    }

    setRestored(true);
  }, [editing, kept]);

  useEffect(() => {
    /* Not before the restore has run, or the first render would write the empty
       defaults over the draft it is about to load. */
    if (!restored || editing !== null) {
      return;
    }

    try {
      window.localStorage.setItem(
        kept,
        JSON.stringify({
          asset,
          tracks,
          judges,
          dates,
          settlementDelay,
          allowance,
          requires,
          openRegistration,
          communityBps,
          visibility,
          name,
          tagline,
          location,
          tags,
          logo,
          banner,
        } satisfies Kept),
      );
    } catch {
      /* Storage full, or refused by the browser. The form still works; it just
         stops surviving a reload. */
    }
  }, [
    restored,
    editing,
    kept,
    asset,
    tracks,
    judges,
    dates,
    settlementDelay,
    requires,
    openRegistration,
    communityBps,
    visibility,
    name,
    tagline,
    location,
    tags,
    logo,
    banner,
  ]);

  /* Said as a sentence rather than only greying the button out, because a form
     this long has an off screen reason for being unsubmittable more often than
     not. */
  const outOfOrder = disordered(dates, editing === null);

  /* Two names that reduce to one symbol are one track as far as the contract
     is concerned, and the prize table built from them would carry the same
     position twice. Caught here rather than at the lock, where the refusal
     arrives after a deployment and a signature. */
  const collides = new Set(priced.map((track) => track.id)).size !== priced.length;
  const visibilityConflictsWithVote = visibility === 2 && communityBps > 0;

  const ready =
    platformFee !== null &&
    name.trim().length > 0 &&
    asset.length === 56 &&
    /* No rate, no creation. Guessing one would write a prize table that pays a
       number nobody agreed to, into a document that cannot be corrected. */
    priceOfOne !== null &&
    wallet !== null &&
    /* Not while the extension is pointed somewhere else. Both signatures would
       be refused by the wallet itself, and the refusal arrives looking like a
       fault in this form rather than a setting in theirs. */
    wrongNetwork === null &&
    outOfOrder === null &&
    !collides &&
    !visibilityConflictsWithVote &&
    priced.every(complete) &&
    /* A crowd decided event asks for no judges, so there is nothing here to
       wait for: the organizer's own address stands in below. */
    (communityBps === WEIGHT_TOTAL_BPS || judges.some((judge) => judge.length === 56));

  async function create() {
    /* The fee is checked here as well as in `ready`, because this is the guard
       that makes the draft below well typed rather than the one that greys out
       a button. */
    if (wallet === null || platformFee === null) {
      return;
    }

    setBusy(true);
    setResult(null);

    /* Local wall clock in, seconds since the epoch out. The organizer picked
       these against their own clock and the contract keeps time in UTC, so the
       conversion happens once, here, rather than at five call sites. */
    const opensAt = secondsAt(dates.opens);

    const draft: Draft = {
      metadataHash: new Uint8Array(32),
      prizeAsset: asset,
      /* The converted table, never the typed one. The contract has no notion of
         a dollar and would read 3000 as three thousand lumens. */
      tracks: priced,
      /* The organizer stands in when the crowd decides, because the contract
         will not take a hackathon with nobody able to sign a disqualification
         and the form stopped asking for one. Anything typed before the switch
         is still honoured, so changing your mind twice loses nothing. */
      judges: (() => {
        const named = judges
          .filter((judge) => judge.length === 56)
          .map((address) => ({ address, tracks: [] }));

        return named.length > 0 ? named : [{ address: wallet.address, tracks: [] }];
      })(),
      judgeQuorum: 1,
      communityBps,
      visibility,
      schedule: {
        registrationOpensAt: opensAt,
        registrationClosesAt: secondsAt(dates.registrationCloses),
        submissionOpensAt: opensAt,
        submissionClosesAt: secondsAt(dates.submissionCloses),
        screeningClosesAt: secondsAt(dates.screeningCloses),
        judgingClosesAt: secondsAt(dates.judgingCloses),
      },
      /* One person, one project. The contract can allow more and says so in the
         constitution either way, but the default is the rule most events mean
         and the one somebody would be surprised to find switched off. */
      requires,
      openRegistration,
      multiTeamAllowed: false,
      maxTeamSize: 5,
      settlementDelay,
      extensions: {
        times: EXTENSION_ALLOWANCES[allowance]!.times,
        seconds: EXTENSION_ALLOWANCES[allowance]!.seconds,
      },
      platformFee,
      /* Whether anybody else may put money into these prizes. Frozen with the
         rest, so this is the last moment it can be decided at all. */
      sponsorship: {
        ...OPEN_TO_SPONSORS,
        topUps: sponsorship !== "closed",
        /* Two rather than one, because a sponsor who is welcome at all is
           rarely the only one, and the allowance cannot be raised afterwards
           any more than it can be lowered. */
        maxNewTracks: sponsorship === "categories" ? 2 : 0,
      },
    };

    /*
      Editing an existing draft replaces its rules in place.

      One signature rather than three, no deployment, and the same hackathon at
      the same address afterwards. The contract refuses this once the rules are
      locked, which is what keeps the edit path from being a way around the
      freeze rather than something the freeze has to be defended from here.
    */
    if (editing !== null) {
      const outcome = await send(
        editing,
        "configure",
        (await configureArgs(wallet.address, draft)).map((value) => ({ value })),
        wallet.address,
      );

      setResult(outcome);
      setBusy(false);

      if (!outcome.ok) {
        return;
      }

      await describe(editing);
      router.push(`/manage/${editing}`);

      return;
    }

    /* The organizer is the connected wallet, not the signed in account. The
       contract knows nothing about an email address; what it records as the
       organizer is the address that will later lock the rules and move the
       phase. */
    const args = await createArgs(wallet.address, draft);

    /*
      Two signatures, in this order, because the second needs the first.

      The instance is deployed empty: `create` is an ordinary entry point rather
      than a constructor, so passing the constitution to the deployment would
      fail inside the wasm with a missing value. The same shape the vault has,
      and for the same reason.
    */
    const built = await deploy(CORE_WASM, [], wallet.address);

    if (!built.ok || built.contractId === undefined) {
      setResult(built.ok ? { ok: false, why: "the contract deployed but did not report its address", refused: false } : built);
      setBusy(false);
      return;
    }

    const contractId = built.contractId;

    const outcome = await send(
      contractId,
      "create",
      args.map((value) => ({ value })),
      wallet.address,
    );

    setResult(outcome);
    setBusy(false);

    if (!outcome.ok) {
      return;
    }

    /* The look is written after the contract exists, because the handler that
       takes it asks the chain who the organizer is and there is nobody to ask
       about until then. A failure here does not undo the hackathon: the rules
       are on chain and the description can be written again.

       It is reported, though. This used to be swallowed whole, and a hackathon
       whose name never saved is invisible: no row means no listing, no title on
       the panel, and nothing for the judging page to find. Silence turned a
       recoverable miss into an event that looked broken everywhere at once. */
    const described = await describe(contractId);

    if (!described) {
      /* Stopped here rather than carried on. The hackathon exists and pressing
         the button again would make a second one, so the button is replaced by
         the way into the panel and the draft on this machine is left alone: the
         name that failed to save is still in it. */
      setMade(contractId);

      return;
    }

    /* The rules are on chain now, so the copy on this machine is a stale answer
       to a question already settled. Left behind, it would reappear in the form
       the next time somebody came to create their second hackathon. */
    try {
      window.localStorage.removeItem(kept);
    } catch {
      /* Nothing to do, and nothing lost: the hackathon exists either way. */
    }

    /* Straight on to the one thing left, rather than a page that says "done"
       and leaves somebody wondering what happens now. The hackathon exists and
       is a draft; opening it is its own page and its own signature. */
    router.push(`/manage/${contractId}/open`);
  }

  /**
   * Hand the presentation columns over, signing only if we have to.
   *
   * The handler takes either a signature over its challenge or a wallet already
   * linked to this account, because a link is a signature it checked and kept.
   * Almost every organizer has linked theirs — it is how the account page shows
   * their events — so the usual path is no prompt at all.
   *
   * This was a third wallet prompt on top of the two that create the hackathon,
   * and it arrived after the work was done, asking to sign a line of text
   * nobody could read. Asking first and signing only on a refusal keeps the
   * proof exactly as strong and costs nothing when it is already held.
   */
  async function describe(contractId: string): Promise<boolean> {
    if (wallet === null) {
      return false;
    }

    const account = await accountId();

    if (account === null) {
      return false;
    }

    if (await send(null)) {
      return true;
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const message = `stelhacks.v1.metadata:${contractId}:${account}:${issuedAt}`;
    const signature = await proveAddressHex(wallet.address, message).catch(() => null);

    return signature === null ? false : await send({ issuedAt, signature });

    async function send(proof: { issuedAt: number; signature: string } | null): Promise<boolean> {
      const written = await fetch("/api/hackathon", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract: contractId,
          ...(proof ?? {}),
          name: name.trim(),
          tagline: tagline.trim(),
          location: location.trim(),
          logo_url: logo.trim(),
          banner_url: banner.trim(),
          /* The field writes them with a hash because that is how everyone
             writes a tag, so the hash has to come off here. Stored with it, the
             same tag typed both ways would be two tags and the filter list on
             the listing would show both. */
          tags: tags
            .split(",")
            .map((tag) => tag.trim().replace(/^#+/, "").trim().toLowerCase())
            .filter((tag) => tag.length > 0)
            .slice(0, 8),
        }),
      }).catch(() => null);

      return written !== null && written.ok;
    }
  }

  if (!known) {
    return <p className="label text-ink-faint">Checking your wallet</p>;
  }

  if (loading) {
    return <p className="label text-ink-faint">Reading the draft</p>;
  }

  if (wallet === null) {
    return (
      <p className="max-w-[38rem] text-[1rem] leading-relaxed text-ink-soft">
        Connect a wallet first. The address you connect is the one the contract
        will record as the organizer, and it is the only address that can lock
        these rules or move the event on afterwards.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <Section index={1} title="What it is">
        <Grid>
          <Field
            label="Hackathon name"
            value={name}
            onChange={setName}
            placeholder="Open House"
          />
          <Field label="Location" value={location} onChange={setLocation} placeholder="Virtual" />
        </Grid>

        <div className="mt-6 space-y-6">
          {/* "Tagline" is a word from a brand deck. What it is asking for is
              the sentence under the name on a card, so it says that. */}
          <Field
            label="Short description"
            value={tagline}
            onChange={setTagline}
            placeholder="Build payments that settle in five seconds"
          />

          <TagField value={tags} onChange={setTags} />

          {/* Files rather than links. Both used to ask for a URL, which is a
              question an organizer with a picture on their laptop cannot
              answer.

              One under the other rather than side by side, because the two
              frames are different shapes and a pair of columns has one width to
              give them. Half the row made the banner a hundred pixels tall
              beside a logo twice its height, which is too small to tell whether
              a picture survives being cropped to it, and left the column under
              it empty. Down the page each frame gets the width its own ratio
              wants. */}
          <ImagePicker label="Logo" shape="logo" userId={userId} value={logo} onChange={setLogo} />

          <ImagePicker
            label="Banner"
            shape="banner"
            userId={userId}
            value={banner}
            onChange={setBanner}
          />
        </div>
      </Section>

      <Section
        index={2}
        title="Prize currency"
      >
        <div className="flex flex-wrap gap-3">
          {PRIZE_ASSETS.map((choice) => {
            const picked = asset === choice.contract;

            return (
              <button
                key={choice.contract}
                type="button"
                onClick={() => setAsset(choice.contract)}
                className={`flex min-w-[12rem] flex-1 items-center gap-3.5 rounded-[0.875rem] px-5 py-4 text-left transition-colors duration-150 ease-settle ${
                  picked
                    ? "bg-ink text-paper ring-2 ring-inset ring-ink"
                    : "bg-paper text-ink ring-1 ring-inset ring-rule hover:bg-paper-sunk"
                }`}
              >
                <AssetMark code={choice.code} onDark={picked} />

                <span className="grid gap-0.5">
                  <span className="text-[1.1875rem] leading-none">{choice.code}</span>

                  <span
                    className={`text-[0.875rem] ${picked ? "text-paper/70" : "text-ink-faint"}`}
                  >
                    {choice.name}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {/*
          The rate, and what it means, said before anything is signed.

          A prize written in dollars becomes a fixed number of lumens the moment
          this is created, and the contract pays that number however the price
          moves afterwards. That is not a footnote: it is the difference between
          what the organizer budgeted and what a winner receives, and somebody
          who was not told would reasonably assume otherwise.
        */}
        {assetCode === "XLM" && !inTokens && (
          <div className="mt-5 rounded-[0.75rem] bg-paper-sunk px-5 py-4">
            {rateFailed ? (
              <p className="text-[0.9375rem] leading-relaxed text-broken">
                The lumen price could not be read, so a dollar amount cannot be
                turned into lumens. Nothing can be created until it can. Reload,
                or pay in USDC instead.
              </p>
            ) : rate === null ? (
              <p className="label text-ink-faint">Reading the lumen price</p>
            ) : (
              <>
                <p className="text-[0.9375rem] leading-relaxed text-ink">
                  1 XLM is ${rate.toFixed(4)} right now.
                </p>
              </>
            )}
          </div>
        )}
      </Section>

      <Section
        index={3}
        title="Tracks and prizes"
      >
        <div className="space-y-10">
          {tracks.map((track, index) => (
            <TrackForm
              key={index}
              track={track}
              index={index}
              code={assetCode}
              price={priceOfOne}
              usd={quote}
              inTokens={inTokens}
              removable={tracks.length > 1}
              onChange={(next) => setTracks(tracks.map((t, i) => (i === index ? next : t)))}
              onRemove={() => setTracks(tracks.filter((_, i) => i !== index))}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={() => setTracks([...tracks, blankTrack()])}
          className="label mt-8 flex h-10 items-center gap-2 rounded-full px-4 text-ink ring-1 ring-inset ring-rule transition-colors duration-150 ease-settle hover:bg-paper-sunk"
        >
          <span aria-hidden className="text-[1.0625rem] leading-none">+</span>
          Add a track
        </button>
      </Section>

      <Section index={4} title="Judges">
        {/*
          Who decides, before who the judges are.

          Every hackathon here admits its participants by application, so the
          crowd casting ballots is a list somebody vetted rather than whoever
          found the page. That is why the crowd's share has no ceiling: it can
          be none of the result, all of it, or anything between.

          Judges are named either way. Even in a crowd decided event they score
          for the written feedback and they hold the say over a
          disqualification; what changes is whether their scorecards move the
          ranking.
        */}
        <div className="border-b border-rule pb-7">
          <p className="label text-[0.875rem] font-semibold text-ink">Who decides the ranking</p>

          <div className="mt-4 flex flex-wrap gap-2">
            {VOTING.map((choice) => (
              <button
                key={choice.label}
                type="button"
                onClick={() => setCommunityBps(choice.bps)}
                aria-pressed={choice.holds(communityBps)}
                className={`rounded-full px-4 py-2.5 text-[0.9375rem] transition-colors duration-150 ease-settle ${
                  choice.holds(communityBps)
                    ? "bg-ink text-paper"
                    : "text-ink-soft ring-1 ring-inset ring-rule hover:text-ink hover:ring-ink"
                }`}
              >
                {choice.label}
              </button>
            ))}
          </div>

          {communityBps > 0 && communityBps < WEIGHT_TOTAL_BPS && (
            <label className="mt-5 flex flex-wrap items-center gap-4">
              <span className="text-[0.9375rem] text-ink-soft">The crowd decides</span>

              <span className="flex items-center gap-2">
                <input
                  value={String(communityBps / 100)}
                  onChange={(event) =>
                    setCommunityBps(
                      Math.min(
                        9_900,
                        Math.max(
                          100,
                          Math.round(
                            Number(event.target.value.replace(/[^0-9]/g, "") || 0) * 100,
                          ),
                        ),
                      ),
                    )
                  }
                  inputMode="numeric"
                  className="tabular h-11 w-20 rounded-[0.625rem] bg-paper px-3 text-center text-[1rem] text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-2 focus:ring-ink"
                />

                <span className="text-[0.9375rem] text-ink-soft">
                  %, the judges the other {100 - communityBps / 100}%
                </span>
              </span>
            </label>
          )}
        </div>

        {/*
          Nobody is asked for a judge when the judges decide nothing.

          The contract still wants one name, and that is not a formality: judges
          hold the say over a disqualification whatever the ranking is built
          from. So the organizer's own address stands in, the way it stands in
          for the fee collector on a free event, and the form says so rather
          than asking for an address whose purpose it has just finished
          explaining away.
        */}
        {communityBps === WEIGHT_TOTAL_BPS ? (
          <p className="mt-7 max-w-[42rem] text-[1rem] leading-relaxed text-ink-soft">
            The crowd decides the ranking, so no scorecard moves it. The
            contract still needs one judge for disqualifications, and your own
            wallet is used for that. Switch to a split above to name judges.
          </p>
        ) : (
          <>
        <div className="mt-7 space-y-4">
          {judges.map((judge, index) => (
            <div key={index} className="flex items-end gap-3">
              <div className="flex-1">
                <Field
                  label={`Judge ${index + 1}`}
                  value={judge}
                  onChange={(next) => setJudges(judges.map((j, i) => (i === index ? next : j)))}
                  placeholder="G…"
                  mono
                />
              </div>

              {judges.length > 1 && (
                <Remove onClick={() => setJudges(judges.filter((_, i) => i !== index))} />
              )}
            </div>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setJudges([...judges, ""])}
          className="label mt-6 flex h-10 items-center gap-2 rounded-full px-4 text-ink ring-1 ring-inset ring-rule transition-colors duration-150 ease-settle hover:bg-paper-sunk"
        >
          <span aria-hidden className="text-[1.0625rem] leading-none">+</span>
          Add a judge
        </button>
        </>
        )}

        {/* Both branches end here, because both of them seal something: the
            scorecards when judges decide, the ballots when the crowd does. */}
        <div className="mt-10 flex justify-end border-t border-rule pt-5">
          <SubRosaSeal />
        </div>
      </Section>

      {/*
        Five instants, in order, as a list.

        Two revisions got here. It asked for four numbers of days and derived
        the dates from whenever the form happened to be submitted, so an
        organizer who knew their event ran the twelfth to the twenty sixth had
        to do that arithmetic backwards. Then it took dates, which meant every
        deadline landed at one minute to midnight and a hackathon closing at
        five in the afternoon could not be expressed at all.

        A list rather than a grid of eight cells. These are one sequence and
        each is only meaningful against the one above it, so they are read down
        a column with their times in a single tab stop, which is what makes a
        gap or an inversion visible without doing the subtraction.
      */}
      <Section
        index={5}
        title="Schedule"
      >
        <div className="border-t border-rule">
          <Moment
            label="Opens"
            value={dates.opens}
            onChange={(v) => setDates({ ...dates, opens: v })}
          />

          <Moment
            label="Registration closes"
            value={dates.registrationCloses}
            onChange={(v) => setDates({ ...dates, registrationCloses: v })}
          />

          <Moment
            label="Submissions close"
            value={dates.submissionCloses}
            onChange={(v) => setDates({ ...dates, submissionCloses: v })}
          />

          <Moment
            label="Entry check ends"
            value={dates.screeningCloses}
            onChange={(v) => setDates({ ...dates, screeningCloses: v })}
          />

          <Moment
            label="Judging ends"
            value={dates.judgingCloses}
            onChange={(v) => setDates({ ...dates, judgingCloses: v })}
          />

          {/*
            What a submission has to carry, decided here rather than assumed.

            This was fixed in code at "a repository, and nothing else", which is
            the common answer and was nobody's choice. It is frozen with
            everything else, so a team reads it before they build and the
            submission form holds them to it.

            The contract does not enforce it: `submit_project` takes one link
            and a digest and never reads these flags. That is why they are worth
            announcing well — screening is where a breach is acted on, and an
            organizer striking out an entry should be pointing at a rule that
            was on the page from the start.
          */}
          {/* Before what a submission carries, because it comes first in the
              event: who is in the room, then what they hand in. */}
          <div className="border-b border-rule py-4">
            <p className="label text-[0.875rem] text-ink">Who gets in</p>

            <div className="mt-4 grid gap-1">
              <Admission
                label="Anybody who applies"
                chosen={openRegistration}
                onChoose={() => setOpenRegistration(true)}
              />

              <Admission
                label="Only the people you approve"
                chosen={!openRegistration}
                onChoose={() => setOpenRegistration(false)}
              />
            </div>
          </div>

          <div className="border-b border-rule py-4">
            <p className="label text-[0.875rem] text-ink">Who can see submitted projects</p>

            <div className="mt-4 grid gap-1">
              <Admission
                label="Public — anyone, even without an account"
                chosen={visibility === 0}
                onChoose={() => setVisibility(0)}
              />

              <Admission
                label="Participants — approved participants, organizers and judges"
                chosen={visibility === 1}
                onChoose={() => setVisibility(1)}
              />

              <Admission
                label="Restricted — only organizers and judges"
                chosen={visibility === 2}
                onChoose={() => setVisibility(2)}
              />
            </div>

            {visibilityConflictsWithVote && (
              <p className="mt-3 text-[0.875rem] leading-relaxed text-broken">
                A community vote needs participants to read the projects. Choose Public or Participants,
                or turn the community share off.
              </p>
            )}
          </div>

          {/* Beside who gets in, because it is the same kind of decision: a
              door that is open or shut before anybody arrives and cannot be
              touched afterwards. */}
          <div className="border-b border-rule py-4">
            <p className="label text-[0.875rem] text-ink">Can other people add to the prize</p>

            <div className="mt-4 grid gap-1">
              <Admission
                label="Yes, anyone can add to a prize"
                chosen={sponsorship === "money"}
                onChoose={() => setSponsorship("money")}
              />

              <Admission
                label="Yes, and they can ask for a category of their own"
                chosen={sponsorship === "categories"}
                onChoose={() => setSponsorship("categories")}
              />

              <Admission
                label="No, only what you fund"
                chosen={sponsorship === "closed"}
                onChoose={() => setSponsorship("closed")}
              />
            </div>
          </div>

          <div className="border-b border-rule py-4">
            <p className="label text-[0.875rem] text-ink">What a submission carries</p>

            <div className="mt-4 grid gap-1">
              {/* Named the way the submission form names each field. A rule
                  under a word the team never sees leaves an organizer setting
                  something they cannot picture. */}
              <Requirement
                label="A repository"
                rule={requires.repository}
                onChange={(next) => setRequires({ ...requires, repository: next })}
              />

              <Requirement
                label="A demo video"
                rule={requires.demoVideo}
                onChange={(next) => setRequires({ ...requires, demoVideo: next })}
              />

              <Requirement
                label="A live site"
                rule={requires.liveUrl}
                onChange={(next) => setRequires({ ...requires, liveUrl: next })}
              />

              <Requirement
                label="A pitch deck"
                rule={requires.pitchDeck}
                onChange={(next) => setRequires({ ...requires, pitchDeck: next })}
              />

              <Requirement
                label="A deployed contract"
                rule={requires.deployedContract}
                onChange={(next) => setRequires({ ...requires, deployedContract: next })}
              />
            </div>
          </div>

          {/* A duration rather than a moment, because it is counted from the
              ranking and nobody knows when that will be until it happens. */}
          <label className="grid gap-2">
            <span className="label text-ink-soft">Payments open</span>

            <select
              value={String(settlementDelay)}
              onChange={(event) => setSettlementDelay(Number(event.target.value))}
              className="w-full rounded-[0.75rem] border border-rule bg-paper px-4 py-3 text-[1rem] text-ink outline-none transition-colors duration-150 ease-settle focus:border-ink"
            >
              {SETTLEMENT_DELAYS.map((choice) => (
                <option key={choice.seconds} value={choice.seconds}>
                  {choice.label}
                </option>
              ))}
            </select>

            <span className="text-[0.875rem] text-ink-faint">
              How long after the ranking before the vault may pay. A gap gives
              you time to catch a mistake while the money is still in the vault.
            </span>
          </label>
        </div>

        {outOfOrder !== null && (
          <p className="mt-5 text-[0.9375rem] leading-relaxed text-broken">{outOfOrder}</p>
        )}
      </Section>

      {/*
        What the vault will have to hold, as one object.

        Three lines that only mean anything together: the prizes, the cut on top
        of them, and the sum somebody actually deposits. They were a hatched band
        running the full width of the window while the form beside them was
        capped, so the one figure on this page carrying real money was also the
        only thing not aligned with anything.

        Inverted, because it is the last thing read before signing and the only
        card here that is a consequence rather than a question.
      */}
      <section className="rounded-[1.25rem] bg-night p-7 text-night-ink sm:p-9">
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <div>
            {/* Bigger and white, all three of them. They were the same grey as
                the sentence under each one, so the card read as six lines of
                explanation with figures beside them rather than three things
                being told to you. */}
            <p className="label text-[1.0625rem] text-night-ink">Total prize</p>

            {/* Said, because the figure is a sum of things typed far apart. A
                number this size with a bare label reads as one prize rather
                than as every place in every track added together. */}
            <p className="mt-1 text-[0.875rem] text-night-ink-soft">
              Every place in every track, added up
            </p>
          </div>

          <p className="tabular text-right text-[clamp(2rem,5vw,3rem)]">{figure(total)}</p>
        </div>

        {/* Shown even at zero, because "no fee" is worth reading once and is
            otherwise indistinguishable from a line somebody forgot to look
            for. */}
        <div className="mt-5 flex flex-wrap items-baseline justify-between gap-4 border-t border-night-rule pt-5">
          <p className="label text-[1.0625rem] text-night-ink">
            Platform fee {(feeBps / 100).toFixed(feeBps % 100 === 0 ? 0 : 2)}%
          </p>

          <p className="tabular text-[1.375rem] text-night-ink-soft">{figure(fee)}</p>
        </div>

        <div className="mt-4 flex flex-wrap items-baseline justify-between gap-4 border-t border-night-rule pt-4">
          <div>
            <p className="label text-[1.0625rem] text-night-ink">You deposit</p>

            <p className="mt-1 text-[0.875rem] text-night-ink-soft">
              What the vault has to hold before the event can open
            </p>
          </div>

          {/* The figure the vault is asked for, to the stroop. */}
          <p className="tabular text-right text-[1.75rem]">{figure(deposit)}</p>
        </div>
      </section>

      {/* Centred under the column rather than pinned to its left edge, so the
          last thing on a long centred form is where the eye already is. */}
      <div className="flex flex-col items-center gap-4 pb-4 text-center">
        {made !== null ? (
          <>
            <ButtonLink href={`/manage/${made}/open`}>Carry on</ButtonLink>

            <p className="max-w-[34rem] text-[0.9375rem] leading-relaxed text-broken">
              The rules are on chain, but the name and artwork did not save.
              Everything you typed is still in this form; write them again from
              the panel.
            </p>
          </>
        ) : (
        <Button disabled={!ready || busy} onClick={() => void create()}>
          {busy ? "Signing" : inTokens ? "Save the changes" : "Create the hackathon"}
        </Button>
        )}

        {/* Only what stops the button working. The line that used to be here
            counted the wallet prompts and promised nothing was frozen, which is
            the form explaining itself at the moment somebody has finished
            reading it; the count went out of date the first time the contract
            changed, and the reassurance was answering a question nobody at this
            point is still asking. */}
        {(wrongNetwork !== null ||
          collides ||
          visibilityConflictsWithVote ||
          (platformFee === null && wallet !== null)) && (
          <p className="max-w-[32rem] text-[0.9375rem] leading-relaxed text-ink-soft">
            {wrongNetwork !== null
              ? "Your wallet is on another network, so nothing here can be signed until you switch it."
              : collides
                ? "Two of your tracks come down to the same name on chain. Capitals and spaces are not part of it, so \"Smart Contracts\" and \"smart contracts\" are one track — give them different words."
                : visibilityConflictsWithVote
                  ? "Restricted projects cannot be used with a community vote, because participants would be asked to vote on work they cannot read."
                : "This deployment is set to charge a fee but has no collector address configured, so nothing can be created until it does."}
          </p>
        )}

        {/* Only the refusals. "Created." was a line that appeared for the
            instant before the page moved on, telling somebody something the
            next screen was about to show them anyway. */}
        {result !== null && !result.ok && (
          <p className="max-w-[36rem] text-[0.9375rem] leading-relaxed text-broken">
            {result.why}
          </p>
        )}
      </div>
    </div>
  );
}

function TrackForm({
  track,
  index,
  code,
  price,
  usd,
  inTokens,
  removable,
  onChange,
  onRemove,
}: {
  track: Track;
  index: number;
  /** The ticker picked above, printed beside every amount. Empty until then. */
  code: string;
  /** What the boxes below are divided by to reach the token. One in edit mode. */
  price: number | null;
  /** What one token costs in dollars, for the line under each box. */
  usd: number | null;
  /** Whether the boxes below are token amounts rather than dollars. */
  inTokens: boolean;
  removable: boolean;
  onChange: (next: Track) => void;
  onRemove: () => void;
}) {
  const weight = track.criteria.reduce((sum, c) => sum + c.weightBps, 0);
  const balanced = weight === WEIGHT_TOTAL_BPS;

  return (
    <div className="border-l-2 border-rule pl-6">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0 flex-1 max-w-[24rem]">
          {/* Typed as words, the way criteria already are.

              This used to lowercase and underscore every keystroke, so
              somebody typing "Smart Contracts" watched it turn into
              "smart_contracts" under their hands and every page afterwards
              printed it that way. What the contract needs is a symbol and
              what a person writes is a name; `symbolOf` turns one into the
              other at the moment the constitution is built, and `titleOf`
              turns it back wherever it is shown. */}
          <Field
            label={`Track ${index + 1} name`}
            value={track.id}
            onChange={(id) => onChange({ ...track, id: id.slice(0, 40) })}
            placeholder="Smart Contracts"
            /* The symbol shown rather than promised. A `Symbol` holds no
               capitals and no spaces, so "DeFi" is stored as `defi` and comes
               back as "Defi" — small, but it is the sort of thing somebody
               should find out here rather than on their own event page after
               the rules are frozen. */
          />
        </div>

        {removable && <Remove onClick={onRemove} />}
      </div>

      <div className="mt-6 grid gap-8 lg:grid-cols-2">
        <div>
          <p className="label text-[0.875rem] text-ink">Prizes</p>

          <div className="mt-3 space-y-2">
            {track.prizes.map((prize, at) => {
              /* The same amount in the other unit, under the box rather than
                 replacing what was typed. What somebody entered stays theirs;
                 this is what it comes to, and which way round that runs is the
                 only thing the two modes disagree about. */
              const other = inTokens
                ? usd === null
                  ? ""
                  : `$${dollarsOf(toSmallestUnit(prize.amount), usd)}`
                : (() => {
                    const converted = inAsset(prize.amount, price);
                    return converted.length === 0 || code.length === 0
                      ? ""
                      : `${format(toSmallestUnit(converted))} ${code}`;
                  })();

              return (
                <div key={prize.rank}>
                  <div className="flex items-center gap-3">
                    <span className="label w-12 text-ink-faint">{ordinal(prize.rank)}</span>

                    <div className="flex h-10 flex-1 items-center bg-paper ring-1 ring-inset ring-rule transition-shadow duration-150 ease-settle focus-within:ring-ink">
                      {!inTokens && <span className="label pl-3 text-ink-faint">$</span>}

                      <input
                        value={prize.amount}
                        onChange={(event) =>
                          onChange({
                            ...track,
                            prizes: track.prizes.map((p, i) =>
                              i === at
                                ? { ...p, amount: event.target.value.replace(/[^0-9.]/g, "") }
                                : p,
                            ),
                          })
                        }
                        inputMode="decimal"
                        placeholder="0"
                        className="tabular h-full min-w-0 flex-1 bg-transparent px-2.5 text-[1rem] text-ink outline-none"
                      />

                      {inTokens && code.length > 0 && (
                        <span className="label pr-3 text-ink-faint">{code}</span>
                      )}
                    </div>

                    {track.prizes.length > 1 && (
                      <Remove
                        onClick={() =>
                          onChange({
                            ...track,
                            prizes: track.prizes
                              .filter((_, i) => i !== at)
                              .map((p, i) => ({ ...p, rank: i + 1 })),
                          })
                        }
                      />
                    )}
                  </div>

                  {other.length > 0 && (
                    <p className="tabular mt-1 pl-[3.75rem] text-[0.8125rem] text-ink-faint">
                      {other}
                    </p>
                  )}
                </div>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() =>
              onChange({
                ...track,
                prizes: [...track.prizes, { rank: track.prizes.length + 1, amount: "" }],
              })
            }
            className="label mt-3 text-ink-soft transition-colors duration-150 ease-settle hover:text-ink"
          >
            + add a place
          </button>
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <p className="label text-[0.875rem] text-ink">Scoring</p>

            {/* The weights have to add up exactly or the contract refuses the
                whole constitution. Saying so as it happens is the difference
                between fixing one number and rereading a rejected form. */}
            {/* What is left rather than only what is spent. Since the boxes
                cannot be pushed over a hundred, the only state worth naming is
                the shortfall, and naming it saves counting the column. */}
            <p className={`label ${balanced ? "text-verified" : "text-ink-faint"}`}>
              {(weight / 100).toFixed(0)}%
              {!balanced && ` · ${((WEIGHT_TOTAL_BPS - weight) / 100).toFixed(0)} left`}
            </p>
          </div>

          <div className="mt-3 space-y-2">
            {track.criteria.map((criterion, at) => (
              <div key={at} className="flex items-center gap-3">
                {/* Taken as written. The field used to rewrite every keystroke
                    into the contract's shape, so somebody typing "Clean Code"
                    watched it become `clean_code` under their hands. The
                    conversion happens once, where the constitution is built,
                    and what is shown back everywhere else is the phrase. */}
                <input
                  value={criterion.id}
                  onChange={(event) =>
                    onChange({
                      ...track,
                      criteria: track.criteria.map((c, i) =>
                        i === at ? { ...c, id: event.target.value.slice(0, 40) } : c,
                      ),
                    })
                  }
                  placeholder="Impact"
                  className="h-10 flex-1 bg-paper px-3 text-[1rem] text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-ink"
                />

                {/* Held to what is left rather than accepted and complained
                    about afterwards. The weights are the one field the contract
                    refuses the whole constitution over, and a box that took
                    4060 and printed it back as a percentage was inviting
                    somebody to fill the form in around an impossible number. */}
                <input
                  value={criterion.weightBps === 0 ? "" : String(criterion.weightBps / 100)}
                  onChange={(event) =>
                    onChange({
                      ...track,
                      criteria: track.criteria.map((c, i) =>
                        i === at ? { ...c, weightBps: within(event.target.value, track, at) } : c,
                      ),
                    })
                  }
                  inputMode="numeric"
                  placeholder="0"
                  className="tabular h-10 w-16 bg-paper px-3 text-center text-[1rem] text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-ink"
                />

                {track.criteria.length > 1 && (
                  <Remove
                    onClick={() =>
                      onChange({ ...track, criteria: track.criteria.filter((_, i) => i !== at) })
                    }
                  />
                )}
              </div>
            ))}
          </div>

          <button
            type="button"
            onClick={() =>
              onChange({ ...track, criteria: [...track.criteria, { id: "", weightBps: 0 }] })
            }
            className="label mt-3 text-ink-soft transition-colors duration-150 ease-settle hover:text-ink"
          >
            + add a criterion
          </button>

          {/* A hairline that fills as the weights approach a hundred. It is the
              only moving thing on the page and it moves for the one number that
              silently invalidates everything else. */}
          <div className="mt-4 h-px w-full bg-rule">
            <div
              className={`h-px transition-[width,background-color] duration-300 ease-settle ${
                balanced ? "bg-verified" : "bg-ink-faint"
              }`}
              style={{ width: `${Math.min(100, weight / 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One step of the form, as a card.
 *
 * It used to print its title twice, once through the numbered spec label and
 * again as a heading under it, which read as a rendering fault rather than as
 * emphasis. The number now sits in its own token beside a single title, which is
 * what the numbering was for.
 *
 * A card rather than open page. The form is long and every section used to run
 * to the same left edge with nothing marking where one ended and the next began;
 * a reader had to use the headings as fences. A surface with an edge does that
 * on its own, and it is also what lets the whole thing be centred rather than
 * pinned left with a third of the window empty beside it.
 */
function Section({
  index,
  title,
  children,
}: {
  /* A plain number rather than a zero padded string. "01" is a catalogue
     reference; there are five of these and nobody is looking one up. */
  index: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[1.25rem] bg-paper p-8 ring-1 ring-rule sm:p-10">
      <div className="flex items-center gap-3.5">
        <span className="tabular grid size-9 shrink-0 place-items-center rounded-full bg-paper-sunk text-[1.0625rem] font-semibold text-ink-soft ring-1 ring-inset ring-rule">
          {index}
        </span>

        <h2 className="text-[1.5rem] text-ink">{title}</h2>
      </div>

      <div className="mt-8">{children}</div>
    </section>
  );
}

/* No width cap of its own any more. The card is the measure, so a field that
   set its own would be two rules about the same edge and the narrower one would
   win invisibly. */
function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid gap-6 sm:grid-cols-2">{children}</div>;
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  mono?: boolean;
}) {
  return (
    <label className="grid gap-2">
      {/* Ink rather than the faint grey these used to be. A label is the
          question and the grey text inside the box is an example answer; when
          both were the same weight the form read as a column of grey with no
          indication which parts somebody was meant to supply. */}
      <span className="label text-[0.875rem] text-ink">{label}</span>

      {/* Not trimmed here. Trimming on every keystroke eats the space the moment
          it is typed, so "Stellar Türkiye" can only ever be entered as
          "StellarTürkiye" and the field looks broken rather than strict. What
          gets saved is trimmed at submit, which is where it belongs: a value is
          tidied when it is committed, not while somebody is still typing it. */}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`h-12 rounded-[0.625rem] bg-paper px-4 text-[1.0625rem] text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-2 focus:ring-ink ${
          mono ? "tabular text-[0.9375rem]" : ""
        }`}
      />
    </label>
  );
}

/**
 * One point in the schedule: what it is on the left, when it is on the right.
 *
 * A native datetime input rather than a written one. It is the only control
 * here that every platform already renders in the reader's own locale, and a
 * picker we wrote would be a second opinion about what the fourth of the month
 * at six means.
 */
function Moment({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <label className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b border-rule py-4">
      <span className="label text-[0.875rem] text-ink">{label}</span>

      <input
        type="datetime-local"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="tabular h-11 w-[15rem] rounded-[0.625rem] bg-paper px-3.5 text-[1rem] text-ink ring-1 ring-inset ring-rule outline-none transition-shadow duration-150 ease-settle focus:ring-2 focus:ring-ink"
      />
    </label>
  );
}

/**
 * The token's own mark, in its own colours.
 *
 * The real marks rather than something drawn to look like them, because these
 * are two currencies somebody is about to commit money in and an approximation
 * is a small lie in the one place on the form where recognising the thing at a
 * glance is the whole job. Both are the published token icons: the lumen's
 * shuttle on black, and USDC's blue disc.
 *
 * Inlined rather than fetched. Two marks at twenty four pixels are not worth a
 * request each, and a logo that arrives after the card it sits in is a card
 * that moves while somebody is reading it.
 *
 * `onDark` is the selected card, where the lumen's black disc would otherwise
 * disappear into the ground it is drawn on.
 */
function AssetMark({ code, onDark }: { code: string; onDark: boolean }) {
  const ring = onDark ? "ring-1 ring-white/30" : "";

  if (code === "USDC") {
    return (
      <svg
        aria-hidden
        viewBox="0 0 2000 2000"
        className={`size-7 shrink-0 rounded-full ${ring}`}
      >
        <path
          d="M1000 2000c554.17 0 1000-445.83 1000-1000S1554.17 0 1000 0 0 445.83 0 1000s445.83 1000 1000 1000z"
          fill="#2775ca"
        />
        <path
          d="M1275 1158.33c0-145.83-87.5-195.83-262.5-216.66-125-16.67-150-50-150-108.34s41.67-95.83 125-95.83c75 0 116.67 25 137.5 87.5 4.17 12.5 16.67 20.83 29.17 20.83h66.66c16.67 0 29.17-12.5 29.17-29.16v-4.17c-16.67-91.67-91.67-162.5-187.5-170.83v-100c0-16.67-12.5-29.17-33.33-33.34h-62.5c-16.67 0-29.17 12.5-33.34 33.34v95.83c-125 16.67-204.16 100-204.16 204.17 0 137.5 83.33 191.66 258.33 212.5 116.67 20.83 154.17 45.83 154.17 112.5s-58.34 112.5-137.5 112.5c-108.34 0-145.84-45.84-158.34-108.34-4.16-16.66-16.66-25-29.16-25h-70.84c-16.66 0-29.16 12.5-29.16 29.17v4.17c16.66 104.16 83.33 179.16 220.83 200v100c0 16.66 12.5 29.16 33.33 33.33h62.5c16.67 0 29.17-12.5 33.34-33.33v-100c125-20.84 208.33-108.34 208.33-220.84z"
          fill="#fff"
        />
        <path
          d="M787.5 1595.83c-325-116.66-491.67-479.16-370.83-800 62.5-175 200-308.33 370.83-370.83 16.67-8.33 25-20.83 25-41.67V325c0-16.67-8.33-29.17-25-33.33-4.17 0-12.5 0-16.67 4.16-395.83 125-612.5 545.84-487.5 941.67 75 233.33 254.17 412.5 487.5 487.5 16.67 8.33 33.34 0 37.5-16.67 4.17-4.16 4.17-8.33 4.17-16.66v-58.34c0-12.5-12.5-29.16-25-37.5zM1229.17 295.83c-16.67-8.33-33.34 0-37.5 16.67-4.17 4.17-4.17 8.33-4.17 16.67v58.33c0 16.67 12.5 33.33 25 41.67 325 116.66 491.67 479.16 370.83 800-62.5 175-200 308.33-370.83 370.83-16.67 8.33-25 20.83-25 41.67V1700c0 16.67 8.33 29.17 25 33.33 4.17 0 12.5 0 16.67-4.16 395.83-125 612.5-545.84 487.5-941.67-75-237.5-258.34-416.67-487.5-491.67z"
          fill="#fff"
        />
      </svg>
    );
  }

  return (
    <svg aria-hidden viewBox="0 0 256 256" className={`size-7 shrink-0 rounded-full ${ring}`}>
      <circle cx="128" cy="128" r="128" fill="#000" />

      {/* The published shuttle, scaled into the disc rather than redrawn. Its
          own artboard is 236.36 by 200, so it is placed by transform and left
          otherwise untouched. */}
      <g fill="#fff" transform="translate(43.5 56.6) scale(0.7141)">
        <path d="M203,26.16l-28.46,14.5-137.43,70a82.49,82.49,0,0,1-.7-10.69A81.87,81.87,0,0,1,158.2,28.6l16.29-8.3,2.43-1.24A100,100,0,0,0,18.18,100q0,3.82.29,7.61a18.19,18.19,0,0,1-9.88,17.58L0,129.57V150l25.29-12.89,0,0,8.19-4.18,8.07-4.11v0L186.43,55l16.28-8.29,33.65-17.15V9.14Z" />
        <path d="M236.36,50,49.78,145,33.5,153.31,0,170.38v20.41l33.27-16.95,28.46-14.5L199.3,89.24A83.45,83.45,0,0,1,200,100,81.87,81.87,0,0,1,78.09,171.36l-1,.53-17.66,9A100,100,0,0,0,218.18,100c0-2.57-.1-5.14-.29-7.68a18.2,18.2,0,0,1,9.87-17.58l8.6-4.38Z" />
      </g>
    </svg>
  );
}

function Remove({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Remove"
      className="grid size-10 shrink-0 place-items-center text-ink-faint transition-colors duration-150 ease-settle hover:text-broken"
    >
      <span aria-hidden className="text-[1.1875rem] leading-none">×</span>
    </button>
  );
}

/**
 * Which signed in account this is, from the browser's own session.
 *
 * Read here rather than passed in, because the challenge has to name the
 * account the server will check it against and the server takes that from the
 * cookie rather than from anything the page sends.
 */
async function accountId(): Promise<string | null> {
  const { browserClient } = await import("../../lib/supabase/client");
  const db = browserClient();

  if (db === null) {
    return null;
  }

  const { data } = await db.auth.getUser();

  return data.user?.id ?? null;
}

/** The handler wants hex; a wallet returns base64. */

interface Dates {
  opens: string;
  registrationCloses: string;
  submissionCloses: string;
  screeningCloses: string;
  judgingCloses: string;
}

/**
 * A month long event starting next week, which is what most of them are.
 *
 * Opening in the morning and every deadline in the evening, because that is
 * when events actually run and a default of one minute to midnight is a time
 * nobody chose. Computed lazily rather than at module load, and safe from a
 * hydration mismatch because the form does not render until the wallet has been
 * checked on the client.
 */
/**
 * The waits an organizer may put between the ranking and the first payment.
 *
 * A short list rather than a free number of seconds. The choice is about how
 * much room somebody wants to catch a mistake, which is answered in hours and
 * days; a text field would invite a figure typed in the wrong unit and freeze it
 * into rules nobody can amend.
 *
 * None is offered because a test event wants it and because an organizer paying
 * out on stage does too. It is not the default, since an event that has just
 * ranked is the worst moment to discover the ranking was wrong.
 */
/**
 * How far the schedule may slip, as choices rather than as a number to type.
 *
 * This is a promise to everybody who enters rather than a convenience for the
 * person running the event: it is hashed into the rules before anybody applies,
 * so a team knows up front that the build deadline can move by at most this
 * much. That is why the generous end is not the default. An event whose
 * announced dates can each slide a month has announced very little.
 *
 * The count and the budget travel together because the contract spends both,
 * and it refuses a document that allows moves worth no time at all.
 */
const EXTENSION_ALLOWANCES = [
  { times: 0, seconds: 0, label: "Not at all. The announced dates are final" },
  { times: 1, seconds: 2 * 86_400, label: "Once, by up to two days" },
  { times: 2, seconds: 7 * 86_400, label: "Twice, by up to a week in total" },
  { times: 3, seconds: 30 * 86_400, label: "Three times, by up to a month in total" },
] as const;

/**
 * Which of the offered allowances a stored document is closest to.
 *
 * The rules hold two arbitrary numbers and this form offers four pairs, so a
 * hackathon configured by something other than this page — or by an older
 * version of it — has to land somewhere. The nearest budget wins, and a
 * document that allows no movement lands on the choice that says so.
 */
function closestAllowance(held: { times: number; seconds: number }): number {
  if (held.times === 0 || held.seconds === 0) {
    return 0;
  }

  let nearest = 1;

  EXTENSION_ALLOWANCES.forEach((choice, index) => {
    const nearer =
      Math.abs(choice.seconds - held.seconds) <
      Math.abs(EXTENSION_ALLOWANCES[nearest]!.seconds - held.seconds);

    if (index > 0 && nearer) {
      nearest = index;
    }
  });

  return nearest;
}

const SETTLEMENT_DELAYS = [
  { seconds: 0, label: "Straight away" },
  { seconds: 3_600, label: "An hour after the ranking" },
  { seconds: 86_400, label: "A day after the ranking" },
  { seconds: 3 * 86_400, label: "Three days after the ranking" },
] as const;

function defaultDates(): Dates {
  const day = 86_400_000;
  const from = Date.now();

  /* Under a fortnight from here to the result, because that is the shape of
     almost every hackathon somebody comes here to run. The first draft of this
     opened in a week and finished in six, which is a conference season rather
     than a hackathon and meant the suggested dates were the first thing
     everybody had to throw away. */
  return {
    opens: momentOf(from + 2 * day, 9, 0),
    registrationCloses: momentOf(from + 7 * day, 23, 59),
    submissionCloses: momentOf(from + 9 * day, 18, 0),
    screeningCloses: momentOf(from + 10 * day, 18, 0),
    judgingCloses: momentOf(from + 12 * day, 18, 0),
  };
}

/** An instant from the contract, as the local wall clock a date input shows. */
function momentAt(seconds: number): string {
  const at = new Date(seconds * 1000);

  return momentOf(at.getTime(), at.getHours(), at.getMinutes());
}

/** What a datetime input wants: local wall clock, no zone and no seconds. */
function momentOf(ms: number, hour: number, minute: number): string {
  const at = new Date(ms);
  const month = String(at.getMonth() + 1).padStart(2, "0");
  const date = String(at.getDate()).padStart(2, "0");
  const time = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  return `${at.getFullYear()}-${month}-${date}T${time}`;
}

/* No trailing Z, so the browser reads it in the organizer's own timezone. A
   deadline belongs to whoever set it, and one silently taken as UTC would close
   three hours early for half of Europe. */
function secondsAt(value: string): number {
  return Math.floor(new Date(value).getTime() / 1000);
}

/**
 * The first thing wrong with the order, or nothing.
 *
 * The contract refuses a schedule that runs backwards and says only
 * `ScheduleInvalid`, which arrives after a deployment and a signature. These
 * are the same comparisons made before either.
 *
 * Compared as strings, which is sound because every one of them is the same
 * fixed width local format and sorts the way the instants do.
 *
 * Registration may close at the same moment submissions do, which is an event
 * with no separate sign up window and a normal shape. Screening and judging
 * each need their own, because the contract compares those strictly.
 */
/**
 * A typed weight, in basis points, held inside what the track has left.
 *
 * Clamped rather than validated. A rubric has to total exactly ten thousand
 * basis points or the contract refuses the constitution, so the room a
 * criterion has is a hundred per cent minus whatever its neighbours already
 * take, and typing past that can only ever produce a form that will be
 * rejected.
 */
function within(typed: string, track: Track, at: number): number {
  const asked = Math.round(Number(typed.replace(/[^0-9.]/g, "") || 0) * 100);

  if (!Number.isFinite(asked)) {
    return 0;
  }

  const others = track.criteria.reduce(
    (sum, criterion, i) => (i === at ? sum : sum + criterion.weightBps),
    0,
  );

  return Math.max(0, Math.min(WEIGHT_TOTAL_BPS - others, asked));
}

/** What the form keeps on this machine between one visit and the next. */
interface Kept {
  asset: string;
  tracks: Track[];
  judges: string[];
  dates: Dates;
  settlementDelay: number;
  /** An index into `EXTENSION_ALLOWANCES`, not the values themselves. */
  allowance: number;
  requires: SubmissionFields;
  openRegistration: boolean;
  communityBps: number;
  /** A `ProjectVisibility` discriminant: public, participants or restricted. */
  visibility: 0 | 1 | 2;
  name: string;
  tagline: string;
  location: string;
  tags: string;
  logo: string;
  banner: string;
}

/** Unknown or older draft values fail closed rather than opening a gallery. */
function asVisibility(value: number): 0 | 1 | 2 {
  return value === 0 || value === 1 || value === 2 ? value : 2;
}

/** Restores one string field, and only if what was on disk is one. */
function text(value: unknown, set: (next: string) => void) {
  if (typeof value === "string") {
    set(value);
  }
}

function disordered(dates: Dates, fresh = true): string | null {
  if (Object.values(dates).some((moment) => moment.length === 0)) {
    return "Every one of these needs a date and a time.";
  }

  /*
    Not in the past, and the contract does not say so.

    Its schedule check is about order, not about the clock, so an event whose
    every deadline has already gone is a perfectly valid document: it locks, it
    funds, it opens, and then nobody can apply or enter because those calls
    check the clock themselves. The result is an empty hackathon that runs to
    the end in seconds.

    Only for a new one. An existing draft may well have been written before its
    own opening moment passed, and refusing to save it would trap the organizer
    outside the form that could fix it.
  */
  if (fresh && secondsAt(dates.opens) <= Math.floor(Date.now() / 1000)) {
    return "The opening moment is in the past, so nobody would be able to sign up.";
  }

  if (dates.registrationCloses <= dates.opens) {
    return "Registration has to close after the event opens.";
  }

  if (dates.submissionCloses < dates.registrationCloses) {
    return "Submissions cannot close before registration does.";
  }

  if (dates.submissionCloses <= dates.opens) {
    return "Submissions have to close after the event opens.";
  }

  if (dates.screeningCloses <= dates.submissionCloses) {
    return "The entry check has to end after submissions close.";
  }

  if (dates.judgingCloses <= dates.screeningCloses) {
    return "Judging has to end after screening does.";
  }

  return null;
}

/**
 * A prize written in dollars, as an amount of the token it will be paid in.
 *
 * Both sides are held at seven decimal places and the arithmetic is done in
 * integers, so the string this returns fed back through `toSmallestUnit` gives
 * exactly the number of stroops counted here. A float divide would agree to
 * about fifteen digits and disagree on the last one, which is the difference
 * between a vault that is funded and a vault that is one stroop short of the
 * amount the contract insists on.
 *
 * Empty when there is no rate, rather than zero. Zero is a prize somebody
 * deliberately set to nothing; a missing rate is a figure that is not known
 * yet, and the two must not render the same.
 */
function inAsset(dollars: string, price: number | null): string {
  if (price === null || price <= 0) {
    return "";
  }

  const scale = BigInt(10_000_000);
  const perToken = BigInt(Math.round(price * 10_000_000));

  if (perToken === BigInt(0)) {
    return "";
  }

  return unitsToString((toSmallestUnit(dollars) * scale) / perToken);
}

/** Stroops back to the decimal string the rest of this file passes around. */
function unitsToString(units: bigint): string {
  const scale = BigInt(10_000_000);

  return `${units / scale}.${(units % scale).toString().padStart(7, "0")}`;
}

/**
 * A token amount as dollars, for the line under the figure that decides things.
 *
 * A float is right here and wrong two functions up. Nothing is encoded from
 * this: it is a number somebody reads to know roughly what they are committing,
 * and it is rounded to cents on the way out anyway.
 */
function dollarsOf(units: bigint, price: number): string {
  return ((Number(units) / 10_000_000) * price).toLocaleString("en-US", {
    maximumFractionDigits: 2,
  });
}

function blankTrack(): Track {
  return {
    id: "",
    criteria: [{ id: "", weightBps: 0 }],
    prizes: [{ rank: 1, amount: "" }],
    noAwardAllowed: false,
  };
}

function complete(track: Track): boolean {
  return (
    /* Both names measured as the symbols they will become. A track or a
       criterion called "!!" is a phrase with nothing in it once the contract
       has it. */
    symbolOf(track.id).length > 0 &&
    track.prizes.every((prize) => toSmallestUnit(prize.amount) > BigInt(0)) &&
    track.criteria.every((criterion) => symbolOf(criterion.id).length > 0) &&
    track.criteria.reduce((sum, c) => sum + c.weightBps, 0) === WEIGHT_TOTAL_BPS
  );
}

function ordinal(rank: number): string {
  return ["1st", "2nd", "3rd"][rank - 1] ?? `${rank}th`;
}

/**
 * The prize table as a person reads it, not as the ledger stores it.
 *
 * The fraction is kept when there is one, so a small amount never reads as
 * zero. This is the figure somebody is committing money against.
 */
function format(amount: bigint): string {
  const scale = BigInt(10_000_000);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(7, "0").replace(/0+$/, "");

  return fraction.length === 0
    ? whole.toLocaleString("en-US")
    : `${whole.toLocaleString("en-US")}.${fraction}`;
}

/**
 * The three answers, in the order they get stricter, each with the colour it
 * takes once it is the one chosen.
 *
 * Colour because the five rows are read as a set: an organizer wants to see at
 * a glance how much they are asking of a team, and five identical black pills
 * make that a reading exercise. Red for a field nobody will see, amber for one
 * that is offered, green for one that is demanded.
 *
 * The middle one says "Optional" because that is the word the submission form
 * puts beside the field. "Offered" was written from the organizer's side and
 * described the same state in a word no team ever reads.
 */
/**
 * The three ways a result can be decided, as somebody would name them.
 *
 * A mixed split is one choice rather than ninety nine, and the percentage
 * beside it is the detail. A slider from nought to a hundred would make the two
 * ends look like settings rather than like the two ordinary answers they are.
 */
const VOTING: { label: string; bps: number; holds: (at: number) => boolean }[] = [
  { label: "Judges only", bps: 0, holds: (at) => at === 0 },
  {
    label: "Judges and the crowd",
    bps: 3_000,
    holds: (at) => at > 0 && at < WEIGHT_TOTAL_BPS,
  },
  {
    label: "The crowd only",
    bps: WEIGHT_TOTAL_BPS,
    holds: (at) => at === WEIGHT_TOTAL_BPS,
  },
];

const RULES: { rule: FieldRule; label: string; chosen: string }[] = [
  { rule: "unasked", label: "Not asked", chosen: "bg-broken text-paper" },
  { rule: "optional", label: "Optional", chosen: "bg-signal text-signal-ink" },
  { rule: "required", label: "Required", chosen: "bg-verified text-paper" },
];

/**
 * One field a submission can carry, and what it is worth here.
 *
 * Three buttons rather than a checkbox, because the answer stopped being yes
 * or no. A tick could say a field was compulsory and could not say whether an
 * unticked one was wanted at all, so every event showed every field and the
 * two intentions were indistinguishable on the form a team filled in.
 */
/**
 * One of the two ways into a hackathon.
 *
 * A pair of rows rather than a switch, because a switch has a side that reads
 * as off and neither of these is: an event anybody may enter and an event you
 * pick the room for are two ordinary choices, and the label on a switch would
 * have to name one of them as the absence of the other.
 */
function Admission({
  label,
  chosen,
  onChoose,
}: {
  label: string;
  chosen: boolean;
  onChoose: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChoose}
      aria-pressed={chosen}
      className={`flex items-center gap-3 rounded-[0.625rem] px-3 py-2.5 text-left transition-colors duration-150 ease-settle ${
        chosen ? "bg-paper-sunk text-ink" : "text-ink-faint hover:text-ink-soft"
      }`}
    >
      <span
        aria-hidden
        className={`size-[0.875rem] shrink-0 rounded-full border transition-colors duration-150 ease-settle ${
          chosen ? "border-[0.3125rem] border-ink" : "border-rule"
        }`}
      />

      <span className="text-[1rem]">{label}</span>
    </button>
  );
}

function Requirement({
  label,
  rule,
  onChange,
}: {
  label: string;
  rule: FieldRule;
  onChange: (next: FieldRule) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-1.5">
      <span className="text-[1rem] text-ink">{label}</span>

      <div className="flex gap-0.5 rounded-[0.625rem] bg-paper-sunk p-0.5">
        {RULES.map((choice) => (
          <button
            key={choice.rule}
            type="button"
            onClick={() => onChange(choice.rule)}
            aria-pressed={rule === choice.rule}
            className={`rounded-[0.4375rem] px-3 py-1.5 text-[0.875rem] transition-colors duration-150 ease-settle ${
              rule === choice.rule
                ? `${choice.chosen} shadow-sm`
                : "text-ink-faint hover:text-ink-soft"
            }`}
          >
            {choice.label}
          </button>
        ))}
      </div>
    </div>
  );
}
