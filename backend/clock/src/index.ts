import { advance } from "./advance.js";
import { settings } from "./config.js";
import { following } from "./hackathons.js";

/**
 * The clock.
 *
 * A Soroban contract cannot wake itself up. It knows its own deadlines, its own
 * safety window and whether it still owes anybody money, and it will refuse
 * every one of the calls below until the moment is right — but nothing in the
 * ledger schedules a call, so a condition that has been met stays unacted on
 * until somebody sends a transaction. Without this service that somebody was
 * the organizer, looking at a row of buttons whose only honest caption was
 * "yes, the contract is right".
 *
 * So this is not an automation of a decision. There is no decision in any of
 * them: each condition is something anybody can read off the chain, each call
 * takes no signature, and the contract refuses it early no matter who sends it.
 * All this process contributes is being awake.
 *
 *   clock                            keep every hackathon to its own clock
 *   clock <contract id>              keep one, including one we hold no row for
 *   clock --once                     one lap, then stop
 *
 * Which means losing it is a degradation and not a corruption. Deadlines are
 * still enforced while it is down, because entries and scores are refused by
 * their own timestamps rather than by the phase, and no money can move anywhere
 * it was not already owed. What stops is the handing over: a stage that has
 * ended does not open the next one, payouts do not open when the safety window
 * expires, and an event whose vault is empty is not marked finished.
 */

/**
 * One hackathon, when somebody names one.
 *
 * The same argument the indexer takes, and for the same reason: the list comes
 * from the `hackathons` table, so an instance deployed outside the product —
 * which is every instance a test script stands up — is invisible to a service
 * that only reads that table. Naming it is how the pair can be pointed at a run
 * that nobody wrote a row for.
 */
const only = process.argv.slice(2).find((argument) => !argument.startsWith("--")) ?? null;

async function lap(): Promise<void> {
  const contracts = only === null ? await following() : [only];

  for (const contract of contracts) {
    try {
      for (const done of await advance(contract)) {
        if (done.sent) {
          console.log(`${contract}: ${done.call}${done.what === undefined ? "" : ` ${done.what}`}`);
        } else if (!done.expected) {
          /* An expected refusal is most laps of most hackathons and saying so
             would bury the one line that matters under a running commentary on
             every window that is still open. */
          console.error(`${contract}: ${done.call} ${done.because}`);
        }
      }
    } catch (thrown) {
      /*
        One hackathon's failure is not the others'.

        An unfunded account, an RPC that timed out, a contract whose state has
        expired: each of those stops this hackathon and none of them is a
        reason for the hackathon next in the list to miss its deadline.
      */
      console.error(`${contract}: ${thrown instanceof Error ? thrown.message : String(thrown)}`);
    }
  }
}

async function keep(): Promise<never> {
  for (;;) {
    try {
      await lap();
    } catch (thrown) {
      /* Reading the list is the one step with nothing underneath it to carry
         on with. Reported and retried on the next lap, because a database
         blinking is not a reason to take the service down for the day. */
      console.error(`could not read the hackathons: ${thrown}`);
    }

    await new Promise((wake) => setTimeout(wake, settings.everyMs));
  }
}

if (process.argv.includes("--once")) {
  await lap();
} else {
  console.log(
    only === null
      ? `keeping every hackathon to its own clock, every ${settings.everyMs / 1000}s`
      : `keeping ${only} to its own clock, every ${settings.everyMs / 1000}s`,
  );

  await keep();
}
