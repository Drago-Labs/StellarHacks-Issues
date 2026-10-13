import { rpc } from "@stellar/stellar-sdk";
import { ballotLeaf, scorecardLeaf, spec } from "@stelhacks/sdk";

import { core } from "./core.js";
import { proofFor, seal } from "./seal.js";
import { everyHackathon, heldBallots, heldScorecards, leaves } from "./store.js";

/**
 * Getting the sealed entries onto the chain without anybody asking.
 *
 * The service already held every scorecard, every ballot and the tree they
 * build; what it did not do was act. `POST /seal` had to be called by hand and
 * nothing at all revealed the entries afterwards, so a hackathon judged
 * perfectly well arrived at its ranking with no scores on chain to rank.
 *
 * Three moments, and the contract decides all of them:
 *
 *   Judging, once the window shuts   publish the root that commits to the set
 *   Reveal                           open every entry under that root
 *   Reveal, once they are all open   rank, since nothing is left to wait for
 *
 * Nothing here is a decision either. The root is a pure function of the entries
 * held, the reveals are authorized by their proofs rather than by this service,
 * and a contract that is not ready refuses the call. The only thing this adds
 * is being awake, the same as the clock.
 *
 * It is separate from the clock because of what it holds. Sealed entries live
 * behind a wall no client role can reach, and the process on the other side of
 * that wall is this one; moving the work to a service that has to be handed the
 * scorecards to do it would put them somewhere new for no gain.
 */

/** The phase a hackathon has to be in for each half of the job. */
const JUDGING = 4;
const REVEAL = 5;

/**
 * Refusals that mean "not this hackathon, not yet" rather than a fault.
 *
 * Every one of them is an ordinary state of an event that is simply somewhere
 * else in its life, or of an entry the contract is right to leave out: a window
 * still open, a root already published, a judge who stepped away, a voter who
 * is not eligible. Read by code rather than by message, because the
 * generated client reports an error's doc comment rather than its name.
 */
const EXPECTED = new Set(
  [
    "WrongPhase",
    "DeadlineNotReached",
    "RootAlreadyPublished",
    "RootMissing",
    "CommunityVoteDisabled",
    "ScorecardAlreadyRecorded",
    "BallotAlreadyCounted",
    "NotJudge",
    "JudgeRecused",
    "VoterNotEligible",
    "NotFound",
    "DisqualificationUnresolved",
  ].map((name) => {
    const found = spec.errorCases().find((error) => error.name().toString() === name);

    if (found === undefined) {
      throw new Error(`the contract has no ${name} error, so a refusal cannot be read`);
    }

    return found.value();
  }),
);

function refusalIn(error: string): number | null {
  const found = /Error\(Contract, #(\d+)\)/.exec(error);

  return found === null ? null : Number(found[1]);
}

function named(code: number): string {
  const found = spec.errorCases().find((error) => error.value() === code);

  return found === undefined ? `contract error ${code}` : found.name().toString();
}

/**
 * Sends one prepared call, unless the contract has already said no.
 *
 * The refusal is read off the simulation rather than caught from the send, so
 * an event that is not ready costs one simulated call and no fee.
 */
async function put(built: { simulation?: unknown; signAndSend: () => Promise<unknown> }): Promise<
  string | null
> {
  const simulation = built.simulation as rpc.Api.SimulateTransactionResponse | undefined;

  if (simulation !== undefined && rpc.Api.isSimulationError(simulation)) {
    const code = refusalIn(simulation.error);

    if (code !== null && EXPECTED.has(code)) {
      return null;
    }

    return code === null ? simulation.error : `refused: ${named(code)}`;
  }

  await built.signAndSend();

  return null;
}

/*
  When a reveal last failed, per hackathon.

  The reveal reads every held scorecard in full, ciphertext and all, and a pass
  that fails is retried on the next lap. One entry the contract keeps refusing,
  or a drand node that will not answer, then reads the whole table every two
  minutes for as long as nobody notices: at a hundred cards that is most of a
  free tier's monthly egress in a month. Half an hour between attempts still
  ranks a recovered event within the hour and costs a fifteenth as much.
*/
const failedAt = new Map<string, number>();
const RETRY_AFTER_MS = 30 * 60_000;

/** One hackathon, one round. */
export async function round(contract: string): Promise<string[]> {
  const client = core(contract);

  /*
    One state read to decide whether this hackathon is our business at all.

    Cheaper than the alternative it replaced: attempting both halves everywhere
    meant reading every held scorecard out of the database for events that were
    still taking sign-ups. The phase can be a moment out of date and it does not
    matter — the contract refuses anything the read got wrong.
  */
  const phase = (await client.phase()).result;
  const at = phase.isOk() ? Number(phase.unwrap()) : null;

  if (at !== JUDGING && at !== REVEAL) {
    return [];
  }

  if (at === REVEAL && Date.now() - (failedAt.get(contract) ?? 0) < RETRY_AFTER_MS) {
    return [];
  }

  try {
    const said = await work(client, contract, at);

    if (at === REVEAL) {
      if (said.length > 0) {
        failedAt.set(contract, Date.now());
      } else {
        failedAt.delete(contract);
      }
    }

    return said;
  } catch (thrown) {
    if (at === REVEAL) {
      failedAt.set(contract, Date.now());
    }

    throw thrown;
  }
}

/** The work of one round, for a hackathon already known to be in Judging or Reveal. */
async function work(
  client: ReturnType<typeof core>,
  contract: string,
  at: number,
): Promise<string[]> {
  const said: string[] = [];

  if (at === JUDGING) {
    /* Building the roots needs only the signed leaves. The private bodies are
       Sub Rosa tlock ciphertext and deliberately cannot be opened yet. */
    const [scoreLeaves, ballotLeaves] = await Promise.all([
      leaves(contract, "scorecards"),
      leaves(contract, "ballots"),
    ]);

    /* Nothing to commit to is not a root of nothing. An empty tree would still
       be a digest the contract accepted, and it would close the window on a
       hackathon whose judges had simply not finished. */
    if (scoreLeaves.length > 0) {
      const failed = await put(
        await client.publish_score_root({
          root: Buffer.from(seal(scoreLeaves).root),
        }),
      );

      said.push(...report(contract, "the score root", failed));
    }

    if (ballotLeaves.length > 0) {
      const failed = await put(
        await client.publish_ballot_root({
          root: Buffer.from(seal(ballotLeaves).root),
        }),
      );

      said.push(...report(contract, "the ballot root", failed));
    }

    return said;
  }

  const [scorecards, ballots] = await Promise.all([
    heldScorecards(contract),
    heldBallots(contract),
  ]);

  /*
    Reveal. Each entry carries its own proof, so they go one at a time and one
    that the contract turns away leaves the rest untouched — a judge who recused
    themselves, a voter who is no longer eligible.

    Held nothing, nothing to open. A tree cannot be built from no leaves, and an
    event that reached the reveal with an empty table is the ordinary shape of a
    hackathon nobody judged rather than a fault to report every half minute.
  */
  if (scorecards.length > 0) {
    const scored = seal(await leaves(contract, "scorecards"));

    for (const scorecard of scorecards) {
      const proof = proofFor(scored, scorecardLeaf(scorecard));

      if (proof === null) {
        said.push(`${contract}: a held scorecard is not under its own root`);

        continue;
      }

      const failed = await put(
        await client.reveal_score({
          scorecard,
          proof: proof.map((step) => Buffer.from(step)),
        }),
      );

      said.push(...report(contract, `the scorecard for team ${scorecard.team}`, failed));
    }
  }

  if (ballots.length > 0) {
    const cast = seal(await leaves(contract, "ballots"));

    for (const ballot of ballots) {
      const proof = proofFor(cast, ballotLeaf(ballot.voter, ballot.choices));

      if (proof === null) {
        said.push(`${contract}: a held ballot is not under its own root`);

        continue;
      }

      const failed = await put(
        await client.reveal_ballot({
          voter: ballot.voter,
          choices: ballot.choices,
          proof: proof.map((step) => Buffer.from(step)),
        }),
      );

      said.push(...report(contract, `the ballot from ${ballot.voter}`, failed));
    }
  }

  /*
    And then the ranking, because by here nothing is left to wait for.

    It was the organizer's press, on the argument that nothing on chain knows
    whether the judges are finished. That was true while the cards sat in a
    service nobody asked; it is not true here. This process holds every card, no
    more can arrive — the window shut before the root was published — and it has
    just put each one on chain. There is nothing left for a person to know.

    Only when the pass was clean. A reveal that failed for a reason worth
    reporting is a card that belongs in the ranking and is not in it yet, and
    ranking around it would settle a result on a subset of the scores and refuse
    to do it again. Better a hackathon that waits a lap than one ranked early.
  */
  if (said.length === 0) {
    const failed = await put(await client.finalize_results());

    said.push(...report(contract, "the ranking", failed));
  }

  return said;
}

function report(contract: string, what: string, failed: string | null): string[] {
  return failed === null ? [] : [`${contract}: ${what} ${failed}`];
}

/** Every hackathon, once. */
export async function rounds(): Promise<string[]> {
  const said: string[] = [];

  for (const contract of await everyHackathon()) {
    try {
      said.push(...(await round(contract)));
    } catch (thrown) {
      /* One hackathon's failure is not the others'. The next event in the list
         may be the one whose judging window closes in a minute. */
      said.push(`${contract}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
  }

  return said;
}
