import { settings } from "./config.js";
import { nextRun } from "./db.js";
import { carryOut } from "./review.js";

/**
 * The reviewer.
 *
 * Waits for a judge or an organizer to ask for a run, then carries it out: every
 * valid submission, or the ones they picked, read and scored against the frozen
 * rubric. Nothing it writes decides anything. It does not enter the ranking,
 * does not move money and never removes a project; it gives the judges an
 * ordered list and a reason for every number in it.
 *
 *   reviewer             keep watching the queue
 *   reviewer --once      carry out whatever is queued, then stop
 *
 * Losing it loses nothing but time. A run it was carrying is picked up again on
 * the next start, and the projects it already wrote are not sent twice.
 */

async function drain(): Promise<void> {
  for (let run = await nextRun(); run !== null; run = await nextRun()) {
    await carryOut(run);
  }
}

if (process.argv.includes("--once")) {
  await drain();
} else {
  console.log(`watching the review queue every ${settings.everyMs / 1000}s, model ${settings.model}`);

  for (;;) {
    try {
      await drain();
    } catch (thrown) {
      /* The queue could not be read. Reported and retried on the next look,
         because a database blinking is not a reason to stop the service. */
      console.error(`could not read the review queue: ${thrown}`);
    }

    await new Promise((wake) => setTimeout(wake, settings.everyMs));
  }
}
