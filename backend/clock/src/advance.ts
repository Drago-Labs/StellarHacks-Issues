import { Keypair, rpc } from "@stellar/stellar-sdk";
import { basicNodeSigner } from "@stellar/stellar-sdk/contract";
import { HackathonCore } from "@stelhacks/sdk";

import { settings } from "./config.js";
import { CALLS, named, nothingToDo, refusal, type Call } from "./due.js";
import { payOut, type Paid } from "./payout.js";

/**
 * One hackathon, one lap.
 *
 * Whether a call is due is never answered here. It is answered by simulating it
 * and letting the contract say, which keeps every condition in one place. A
 * copy of them in this file would be a second opinion, and the two would part
 * company the first time a deadline was extended or a safety window changed.
 */

const clock = Keypair.fromSecret(settings.clockSecret);

export type Done =
  | { sent: true; call: Call | Paid["call"]; what?: string }
  | { sent: false; call: Call; because: string; expected: boolean };

/** The phase whose exit has a precondition nothing on chain enforces. */
const JUDGING = 4;

/**
 * Tries each mechanical call in turn, and sends the ones that go through.
 *
 * Every call rather than the one the phase suggests, because the phase we would
 * pick it from is read from a projection that lags. The contract knows which
 * one applies and refuses the other two in the same breath, so asking all three
 * costs two simulations and needs no opinion about where the hackathon is.
 *
 * In order, and it matters on the lap after a long outage: closing a window can
 * make the next call legal within the same pass, so a hackathon that has been
 * waiting moves as far as it can rather than one step per lap.
 *
 * Nothing about this is privileged. None of these takes an address or calls
 * `require_auth`, so this service is one more member of the public who happens
 * to be awake: the contract cannot tell it from a participant refreshing the
 * page, and would refuse both at the same moment.
 */
export async function advance(contract: string): Promise<Done[]> {
  const core = new HackathonCore({
    contractId: contract,
    networkPassphrase: settings.networkPassphrase,
    rpcUrl: settings.rpcUrl,
    publicKey: clock.publicKey(),
    ...basicNodeSigner(clock, settings.networkPassphrase),
  });

  const done: Done[] = [];

  for (const call of CALLS) {
    /* The money goes out between settlement opening and the event closing, so
       a hackathon whose window ran out this lap is paid this lap too, and the
       close that follows sees every position settled. */
    if (call === "complete") {
      for (const paid of await payOut(core, contract)) {
        done.push({ sent: true, call: paid.call, what: paid.what });
      }
    }

    const built = await core[call]();
    const simulation = built.simulation;

    if (simulation !== undefined && rpc.Api.isSimulationError(simulation)) {
      const code = refusal(simulation.error);

      /* A failure with no contract error in it is not one of ours: an RPC that
         gave up, state that has expired. It is reported as it arrived rather
         than translated into a refusal the contract never made. */
      done.push({
        sent: false,
        call,
        because: code === null ? simulation.error : `refused: ${named(code)}`,
        expected: nothingToDo(code),
      });

      continue;
    }

    if (call === "advance_phase") {
      const holding = await sealsMissing(core);

      if (holding !== null) {
        done.push({ sent: false, call, because: holding, expected: true });

        continue;
      }
    }

    await built.signAndSend();
    done.push({ sent: true, call });
  }

  return done;
}

/**
 * Why leaving Judging has to wait, or nothing when it does not.
 *
 * A root can only be published while the hackathon is in Judging. Moving on
 * without one is therefore not a delay, it is a door closing: the scores stay
 * sealed in a service that can no longer put them on chain, and the event can
 * never be ranked. Nothing in the contract prevents it, because until there was
 * something moving phases on a timer the party doing it was the one who knew
 * whether the sealing had happened.
 *
 * So the check lives here, on the only thing that moves phases unattended. It
 * costs one state read at the one moment a hackathon is about to leave Judging,
 * and nothing on any other lap.
 */
async function sealsMissing(core: HackathonCore): Promise<string | null> {
  const phase = (await core.phase()).result;

  if (!phase.isOk() || Number(phase.unwrap()) !== JUDGING) {
    return null;
  }

  const scored = (await core.score_root()).result;

  if (!scored.isOk()) {
    return "waiting for the scores to be sealed";
  }

  /* Ballots only when the rules run a community vote at all. Asking for a root
     that was never going to exist would hold every event that scores the
     ordinary way. */
  const rules = (await core.constitution()).result;

  if (rules.isOk() && rules.unwrap().vote.community_bps > 0) {
    const cast = (await core.ballot_root()).result;

    if (!cast.isOk()) {
      return "waiting for the ballots to be sealed";
    }
  }

  return null;
}
