import { spec } from "@stelhacks/sdk";

/**
 * The two judgements a lap makes on its own, and nothing else.
 *
 * Everything that decides whether a call may go through is the contract's,
 * asked by simulating it. What is left here is which hackathons are worth
 * asking about and which refusals are the ordinary answer. Both are kept apart
 * from the service so they can be tested without a network, a database or a
 * key.
 */

/** Completed and Cancelled, the two phases nothing leaves. */
const TERMINAL = [8, 9];

export interface Known {
  contracts: readonly string[];
  /** The phase the indexer last saw, for the hackathons it has reached. */
  phases: ReadonlyMap<string, number>;
}

/**
 * The hackathons still capable of moving, out of what the database knows.
 *
 * Only the terminal phases are filtered out, and the reason is the direction
 * the indexer can be wrong in. Its projection is rebuilt from the event log, so
 * it is either current or behind, never ahead. Behind is harmless here: a row
 * saying Draft while the chain says Open costs one simulation that goes
 * through. A row saying Completed cannot be behind, because nothing follows it,
 * so that one is safe to believe and skip for good.
 *
 * Keeping only the phases a deadline closes reads as the obvious optimisation
 * and is the bug: a hackathon the indexer had not caught up on would be skipped
 * exactly while it was due.
 */
export function stillMoving({ contracts, phases }: Known): string[] {
  return contracts.filter((contract) => {
    const phase = phases.get(contract);

    return phase === undefined || !TERMINAL.includes(phase);
  });
}

/**
 * The calls this service makes, in the order a hackathon meets them.
 *
 * All three are mechanical and none is gated on an address. A phase moves when
 * its deadline passes, settlement opens when the announced safety window runs
 * out, and the event closes once the vault owes nobody anything: three
 * conditions a contract can check for itself and cannot act on by itself.
 * Leaving them to a person meant a page full of buttons whose only honest
 * caption was "yes, the clock is right".
 *
 * Paying the winners is not in this list because it is not one call per
 * hackathon but one per member of every winning team. It lives in `payout.ts`
 * and runs before `complete`, which is what lets the close go through.
 */
export const CALLS = ["advance_phase", "open_settlement", "complete"] as const;

export type Call = (typeof CALLS)[number];

/**
 * The refusals that mean "not yet" rather than "something is wrong".
 *
 * One per call, and each one is the ordinary state of a hackathon that is
 * simply still running: a window that has not closed, a safety hold that has
 * not elapsed, a prize nobody has collected. `WrongPhase` covers all three at
 * once, since every hackathon is in at most one of these positions and refuses
 * the other two calls outright.
 *
 * Their numbers come from the spec the wasm publishes rather than from
 * constants written here, so a contract that renumbered its errors makes this
 * throw at startup. That is the failure worth having: a clock that quietly
 * treated some other refusal as ordinary would leave hackathons sitting at
 * conditions that had long since been met and say nothing about it.
 */
function codeOf(name: string): number {
  const found = spec.errorCases().find((error) => error.name().toString() === name);

  if (found === undefined) {
    throw new Error(`the contract has no ${name} error, so an ordinary refusal cannot be told from a fault`);
  }

  return found.value();
}

const EXPECTED = new Set(
  [
    "WrongPhase",
    "DeadlineNotReached",
    "SafetyWindowOpen",
    "SettlementIncomplete",
    "SettlementPaused",
  ].map(codeOf),
);

/**
 * The contract error code inside a failed simulation, if that is what failed.
 *
 * Read from the code and never from the sentence beside it. The generated
 * client does carry a message per error, but it is the error's doc comment
 * rather than its name, so a service that matched on prose would go quiet the
 * day somebody improved the wording in `contract.rs`. Nothing else in this
 * repository matches contract behaviour by string, and this is the same rule.
 */
export function refusal(error: string): number | null {
  const found = /Error\(Contract, #(\d+)\)/.exec(error);

  return found === null ? null : Number(found[1]);
}

export function nothingToDo(code: number | null): boolean {
  return code !== null && EXPECTED.has(code);
}

/**
 * What a refusal is called, for the one line that says it out loud.
 *
 * The same spec that gives the codes gives the names, so an unexpected refusal
 * arrives as `ScheduleInvalid` rather than as a number somebody has to look up
 * in a Rust file at the moment a hackathon is stuck.
 */
export function named(code: number): string {
  const found = spec.errorCases().find((error) => error.value() === code);

  return found === undefined ? `contract error ${code}` : found.name().toString();
}
