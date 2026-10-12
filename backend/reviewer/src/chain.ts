import { HackathonCore } from "@stelhacks/sdk";

import { settings } from "./config.js";

/**
 * What the frozen rules say the model is scoring against.
 *
 * Read from the contract rather than from any table, because the rubric is part
 * of what was hashed at the lock. The model is scored against the same criteria
 * and weights a judge is, read from the same place; a rubric written anywhere
 * else would be a rubric nobody agreed to.
 */

export interface Criterion {
  /** The constitution's `Symbol`: lowercase, no spaces. */
  id: string;
  weightBps: number;
}

export interface Rules {
  tracks: Map<string, Criterion[]>;
  /** When submissions closed, in seconds. The moment a repository is pinned to. */
  submissionClosesAt: number;
}

export async function rulesOf(contract: string): Promise<Rules> {
  /* No key. Reading the constitution is a simulation, and this service holds
     nothing that could sign for anything. */
  const core = new HackathonCore({
    contractId: contract,
    networkPassphrase: settings.networkPassphrase,
    rpcUrl: settings.rpcUrl,
  });

  const read = (await core.constitution()).result;

  if (!read.isOk()) {
    throw new Error(`${contract} has no readable constitution`);
  }

  const constitution = read.unwrap();

  return {
    tracks: new Map(
      constitution.tracks.map((track) => [
        track.id,
        track.criteria.map((criterion) => ({
          id: criterion.id,
          weightBps: Number(criterion.weight_bps),
        })),
      ]),
    ),
    submissionClosesAt: Number(constitution.schedule.submission_closes_at),
  };
}
