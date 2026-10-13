import { rpc } from "@stellar/stellar-sdk";
import { type HackathonCore } from "@stelhacks/sdk";

import { named, refusal } from "./due.js";

/**
 * Hands the money out once settlement is open, so nobody has to come and ask.
 *
 * Every call here is one the contract already lets anybody make: the amounts
 * and the recipients were frozen at the lock, a prize can only go to the member
 * it belongs to, and a sweep can only go to whoever funded the position. So this
 * is the clock doing the same errand as everywhere else, just at the end.
 *
 * What a lap tries, per position the rules pay:
 *
 *   won       pay each member their share, straight to their own wallet
 *   not won   return the whole position to the organizer, or its sponsor
 *
 * and for a member who cannot be paid, most often a wallet with no trustline
 * for the prize asset, their share goes back the same way. The contract holds
 * both returns until the claim period announced at the lock has run out, so a
 * winner who fixes their wallet in the meantime is still paid; this simply asks
 * again every lap and the refusal is the answer until then.
 */

/** Settlement, the only phase any of this can happen in. */
const SETTLEMENT = 7;

/** Members already reported as unpayable, so a month of laps says it once. */
const reported = new Set<string>();

export interface Paid {
  call: "settle_platform_fee" | "settle_prize" | "sweep_unclaimed" | "sweep_share";
  what: string;
}

export async function payOut(core: HackathonCore, contract: string): Promise<Paid[]> {
  const phase = (await core.phase()).result;

  if (!phase.isOk() || Number(phase.unwrap()) !== SETTLEMENT) {
    return [];
  }

  const paid: Paid[] = [];

  /* The platform's cut first. It is refused once settled, and never fails a
     prize, so its outcome decides nothing below. */
  if (await sent(await core.settle_platform_fee())) {
    paid.push({ call: "settle_platform_fee", what: "platform fee" });
  }

  for (const { track, rank } of await positions(core)) {
    if ((await core.is_paid({ track, rank })).result) {
      continue;
    }

    const ranking = (await core.ranking({ track })).result;
    const placement = ranking.isOk()
      ? ranking.unwrap().find((placed) => placed.rank === rank)
      : undefined;

    if (placement === undefined) {
      if (await sent(await core.sweep_unclaimed({ track, rank }))) {
        paid.push({ call: "sweep_unclaimed", what: `${track} #${rank} back to its funder` });
      }

      continue;
    }

    const team = (await core.team_by_id({ id: placement.team })).result;

    if (!team.isOk()) {
      continue;
    }

    for (const member of team.unwrap().members) {
      const prize = await core.settle_prize({ track, rank, member });

      if (await sent(prize)) {
        paid.push({ call: "settle_prize", what: `${track} #${rank} to ${member}` });
        continue;
      }

      const why = failure(prize);

      /* Already paid is the one refusal that is not about this member's
         wallet: a teammate's payment in an earlier lap closed the share. */
      if (why?.startsWith("refused: PrizeAlreadyPaid")) {
        continue;
      }

      if (await sent(await core.sweep_share({ track, rank, member }))) {
        paid.push({ call: "sweep_share", what: `${track} #${rank} share of ${member} back to its funder` });
        continue;
      }

      const key = `${contract}:${track}:${rank}:${member}`;

      if (!reported.has(key)) {
        reported.add(key);
        console.error(`${contract}: cannot pay ${member} for ${track} #${rank} yet, ${why}`);
      }
    }
  }

  return paid;
}

/**
 * Every position the rules pay: the frozen table, then the sponsored tracks
 * that were accepted. The same list `complete` checks, so once each of these
 * is settled the event can close.
 */
async function positions(core: HackathonCore): Promise<{ track: string; rank: number }[]> {
  const rules = (await core.constitution()).result;

  if (!rules.isOk()) {
    return [];
  }

  const all = rules.unwrap().prize_tiers.map(({ track, rank }) => ({ track, rank }));

  for (const id of (await core.sponsor_track_ids()).result) {
    const sponsored = (await core.sponsor_track({ id })).result;

    /* Accepted is 1. Read from the number because the enum is generated into
       the bindings and the clock does not import it anywhere else. */
    if (sponsored.isOk() && Number(sponsored.unwrap().status) === 1) {
      all.push(...sponsored.unwrap().tiers.map(({ track, rank }) => ({ track, rank })));
    }
  }

  return all;
}

type Built = Awaited<ReturnType<HackathonCore["settle_prize"]>>;

/** Sends the call when the simulation went through, and says whether it did. */
async function sent(built: Built): Promise<boolean> {
  if (failure(built) !== null) {
    return false;
  }

  await built.signAndSend();

  return true;
}

function failure(built: Built): string | null {
  const simulation = built.simulation;

  if (simulation === undefined || !rpc.Api.isSimulationError(simulation)) {
    return null;
  }

  /* Named only when the code is ours. A token that refuses the transfer, the
     usual one being a wallet with no trustline, raises its own contract error
     whose number means something else entirely in this contract's table. */
  const code = refusal(simulation.error);
  const ours = code !== null && !simulation.error.includes("token");

  return ours ? `refused: ${named(code)}` : simulation.error.slice(0, 200);
}
