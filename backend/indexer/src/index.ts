import { settings } from "./config.js";
import { db } from "./supabase.js";
import { explain, fellOffTheWindow } from "./errors.js";
import { advanceTo, noteProgress, resumeFrom, rewind } from "./cursor.js";
import { decode } from "./decode.js";
import { health } from "./health.js";
import { read, replayable, store } from "./ingest.js";
import { project } from "./project.js";
import { apply, discard } from "./write.js";

/**
 * Soroban events into Postgres, and nothing else.
 *
 * The shape of one pass is the whole design. Read a range from the chain, write
 * the log, move the cursor, then rebuild the projections from the log. The
 * projections are rebuilt from the log rather than from the range that just
 * arrived, which is slower and is the point: it means the rows in the database
 * are always exactly what the log says, never the accumulated result of every
 * pass that happened to run.
 *
 *   indexer                          follow every hackathon, forever
 *   indexer <contract id>            follow one, forever
 *   indexer <contract id> --once     one pass, then stop
 *   indexer <contract id> --rebuild  throw the projections away and rebuild
 *
 * Called with nothing, the list is the `hackathons` table rather than a setting.
 * It was one contract named in the environment, which is fine while there is
 * one and wrong the moment there are two: the second hackathon somebody creates
 * has a real deadline read from the chain and no phase read from here, so the
 * product shows it as never published. Naming the source of truth instead means
 * a hackathon created in the browser is followed without anybody editing a file
 * and restarting anything.
 */

async function pass(contract: string): Promise<number> {
  const from = await resumeFrom(contract);
  const found = await read(contract, from);

  /*
    Nothing arrived, so nothing derived from it can have moved.

    The projection used to be rebuilt here on every lap, including the
    overwhelming majority that find no new ledgers: an idle indexer downloaded
    the whole history of every hackathon it follows, every few seconds,
    forever. On a free tier that single line was the product's entire hosting
    bill. It now runs from `reproject`, and only once something has landed.

    The cursor still moves. It records how far the chain has been scanned rather
    than how much was found, and leaving it behind would mean rescanning the
    same ledgers until they aged out of the node's window.
  */
  if (found.events.length === 0 && found.reads.length === 0) {
    await noteProgress(contract, found.through);

    return 0;
  }

  await store(contract, found);

  // The cursor moves only after the rows it covers have landed. Ahead of them
  // it would skip a range on the next restart, and a skipped range is a gap no
  // later pass would think to look for.
  await advanceTo(contract, found.through);

  return found.events.length;
}

/*
  The projection is rebuilt from the whole log, so what it costs grows with the
  log. Run once per pass that found something, it was paid again for every page
  RPC handed back: an indexer catching up on a busy hackathon read its entire
  history once per page, and the total grew with the square of the event count.

  So the log is written as it arrives and the projection waits until the
  indexer has reached the head of the chain, then runs once for everything that
  landed. A contract not seen yet by this process counts as unprojected, which
  covers a restart between a store and the rebuild that should have followed.
*/
const projected = new Set<string>();

/* Within a minute of the head, at five seconds a ledger. Close enough that one
   more lap would add nothing a page could show. */
const NEAR_THE_HEAD = 12;

async function reproject(contract: string): Promise<void> {
  const log = await replayable(contract);
  await apply(project(decode(log.events), log.reads));
  projected.add(contract);
}

async function rebuild(contract: string): Promise<void> {
  console.log(`rebuilding ${contract} from the log`);

  await discard(contract);
  await rewind(contract);

  const log = await replayable(contract);
  await apply(project(decode(log.events), log.reads));

  console.log(`rebuilt from ${log.events.length} events and ${log.reads.length} reads`);
}

/**
 * Every hackathon the product knows about, re-read now and then.
 *
 * Read from the table rather than taken once at startup, so a hackathon
 * created while this is running is followed without a restart. Held for a few
 * minutes between reads, because the alternative was asking on every lap, and
 * on a database of thirty megabytes that question was the largest thing this
 * service sent anywhere.
 */
let watched: { at: number; contracts: string[] } | null = null;

async function watching(): Promise<string[]> {
  const now = Date.now();

  if (watched !== null && now - watched.at < settings.watchedForMs) {
    return watched.contracts;
  }

  const { data, error } = await db.from("hackathons").select("contract_id");

  if (error !== null) {
    console.error(`could not read the hackathons to follow: ${error.message}`);

    /* The list we already had, rather than none. A failed read is a reason to
       carry on following what was already being followed; returning nothing
       would quietly stop indexing every hackathon until the next lap. */
    return watched?.contracts ?? [];
  }

  const contracts = (data ?? []).map((row) => String(row.contract_id));
  watched = { at: now, contracts };

  return contracts;
}

async function follow(only: string | undefined): Promise<never> {
  for (;;) {
    const contracts = only === undefined ? await watching() : [only];
    let catchingUp = false;

    for (const contract of contracts) {
      try {
        const found = await pass(contract);
        const behind = await health(contract);

        if (found > 0) {
          projected.delete(contract);
        }

        if (behind.lag > NEAR_THE_HEAD) {
          catchingUp = true;
        } else if (!projected.has(contract)) {
          await reproject(contract);
        }

        if (behind.strandedBehindRetention) {
          // Saying this every pass is deliberate. It is the one condition
          // running longer does not fix, and an indexer that quietly kept up
          // from a point past the gap would look healthy while missing
          // everything before it.
          console.error(
            `${contract}: stranded at ${behind.cursor}, older than anything RPC still serves`,
          );
        }

        if (found > 0 || behind.lag > 0) {
          console.log(`${contract}: ingested ${found}, ${behind.lag} behind ${behind.latest}`);
        }
      } catch (thrown) {
        /*
          One contract's failure is not the others'.

          A hackathon whose events RPC has aged out would otherwise stop the
          loop and with it every event still arriving for every other
          hackathon. It is reported and skipped, and the next lap tries it
          again.
        */
        console.error(
          `${contract}: ${
            fellOffTheWindow(thrown)
              ? "stranded, its events are older than anything RPC still serves"
              : explain(thrown)
          }`,
        );
      }
    }

    if (contracts.length === 0) {
      console.log("no hackathons to follow yet");
    }

    /* Straight on while anything is behind, so a backlog clears at the speed
       RPC serves it. At the head, a lap a minute whether or not the last one
       found events: that is what keeps the rebuild above to once a minute for
       a busy hackathon instead of once per event. */
    if (!catchingUp) {
      await new Promise((wake) => setTimeout(wake, settings.idleMs));
    }
  }
}

const [contract, mode] = process.argv.slice(2);

/* The two maintenance modes still take one contract, because both are things
   somebody does to a particular hackathon after looking at it. Following is the
   one that wants the whole list. */
if (mode === "--rebuild" || mode === "--once") {
  if (contract === undefined) {
    console.error("usage: indexer <contract id> [--once|--rebuild]");
    process.exit(1);
  }

  if (mode === "--rebuild") {
    await rebuild(contract);
  } else {
    const found = await pass(contract);
    await reproject(contract);
    const behind = await health(contract);

    console.log(`ingested ${found} events, ${behind.lag} ledgers behind ${behind.latest}`);
  }
} else {
  await follow(contract);
}
