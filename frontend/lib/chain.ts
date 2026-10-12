import { createClient } from "@supabase/supabase-js";

import { CONSTITUTION_VERSION, rulesFor, type Rules } from "./rules";

/**
 * Reading a hackathon, the way an observer reads one.
 *
 * Everything here uses the anonymous key and nothing else, because every page
 * built on it has to work for somebody with no account. If a query needs a
 * session to return a row, that row does not belong on an observer surface.
 *
 * What comes back is what the indexer wrote from the chain. The page never
 * treats it as the authority: a digest shown here is shown so a reader can
 * compare it against the contract themselves, which is what the proof strip is
 * for.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

/**
 * The database, or nothing.
 *
 * A missing key is not a crash. The frontend is built and previewed long before
 * a project is wired up, and a landing page that will not render because an
 * environment variable is absent is a worse failure than a listing that says it
 * has nothing to show.
 */
export const db =
  url === undefined || key === undefined
    ? null
    : createClient(url, key, { auth: { persistSession: false } });

export interface HackathonSummary {
  contract_id: string;
  slug: string;
  name: string;
  tagline: string | null;
  phase: number | null;
  visibility: number | null;
  /** The prize table's total, in the smallest unit. Absent if unreadable. */
  prize: bigint | null;
  /** When submissions shut, seconds since the epoch. From the frozen rules. */
  closesAt: number | null;
  /**
   * When signing up shuts, which happens before submissions do.
   *
   * Carried separately because they answer different questions. A card asks
   * whether somebody arriving can still get in, and that is this one; the
   * countdown a team already in is watching is the other.
   */
  registrationClosesAt: number | null;
  /**
   * When signing up starts.
   *
   * Only the card uses it, and only when the indexer has not recorded a phase:
   * between "published and waiting" and "open for sign-ups" there is nothing
   * else to tell them apart from.
   */
  registrationOpensAt: number | null;
  /** The token the prize is paid in, from the frozen rules. */
  asset: string | null;
  logo_url: string | null;
  banner_url: string | null;
  /** Null when the organizer has not said, which is not the same as remote. */
  location: string | null;
  tags: string[];
}

export interface HackathonDetail extends HackathonSummary {
  description: string | null;
  organizer: string | null;
  constitution_hash: string | null;
  prize_asset: string | null;
  vault_id: string | null;
  /**
   * The whole frozen document, or absent when the contract could not be
   * reached. A card only needs the prize and the deadline off it; a hackathon
   * page shows the schedule, the tracks and the prize table, and all of them
   * have to come from the same read or they could disagree.
   */
  rules: Rules | null;
}

/**
 * The two halves of a hackathon, fetched separately and joined here.
 *
 * There is no foreign key between `hackathons` and `hackathon_state`, and there
 * must not be. The indexer has to be able to record what the chain says about
 * an event nobody has typed a name for yet: the contract comes first and
 * acquires a description second. A foreign key would invert that and make the
 * chain wait for the copy.
 *
 * The cost is this: PostgREST will not join tables it has no relationship for,
 * so the join happens in code. Two round trips rather than one, in exchange for
 * a schema that does not lie about which side is the authority.
 */
/** What a reader has narrowed the list down to. */
export interface Filter {
  /** "open", "upcoming", "finished", or nothing for all of them. */
  stage?: string | undefined;
  tag?: string | undefined;
  /** Matched against the name and the tagline. */
  q?: string | undefined;
  /** How many to read the chain for. */
  limit?: number | undefined;
  /** Only the hackathons this address created, for the Management Panel. */
  organizer?: string | undefined;
}

/**
 * How many cards a page shows, and therefore how many contracts it asks about.
 *
 * The prize and the deadline are read from the chain one call per hackathon,
 * because our tables do not carry them. That is one round trip per card, so the
 * page's cost grows with the list: thirty three took two and a half seconds and
 * two hundred would take a node's patience as well as a reader's.
 *
 * Bounding it here is the fix that is available today. The one that removes the
 * problem is for the indexer to record both numbers, and until it does this
 * page is paged rather than slow.
 */
export const PAGE = 12;

export async function listHackathons(filter: Filter = {}): Promise<HackathonSummary[]> {
  if (db === null) {
    return [];
  }

  /*
    The presentation columns arrived in a later migration, and code and schema
    do not deploy at the same instant. Asking for a column that is not there
    yet fails the whole select, and the first version of this then returned an
    empty list, so a database one migration behind reported that no hackathon
    existed. A query that failed and a world with nothing in it are not the same
    answer and must never render the same.
  */
  const columns = "contract_id, slug, name, tagline, logo_url";
  const dressed = `${columns}, banner_url, location, tags`;

  const [written, chain] = await Promise.all([
    db
      .from("hackathons")
      .select(dressed)
      .order("created_at", { ascending: false })
      .then((answer) =>
        answer.error === null
          ? answer
          : db.from("hackathons").select(columns).order("created_at", { ascending: false }),
      ),
    filter.organizer === undefined
      ? db.from("hackathon_state").select("contract_id, phase, visibility")
      : db
          .from("hackathon_state")
          .select("contract_id, phase, visibility")
          .eq("organizer", filter.organizer),
  ]);

  if (written.error !== null) {
    throw new Error(`the hackathon list could not be read: ${written.error.message}`);
  }

  const byContract = new Map((chain.data ?? []).map((row) => [String(row.contract_id), row]));

  const all = (written.data ?? [])
    /* Narrowed to the organizer's own when asked, by the state the indexer
       read off the chain rather than by anything typed beside it. */
    .filter((row) => filter.organizer === undefined || byContract.has(String(row.contract_id)))
    .map((row) => merge(row, byContract.get(String(row.contract_id)) ?? {}));

  /*
    Narrowed and ordered before the chain is asked anything, so a filtered page
    pays for the cards it shows rather than for every hackathon that exists.
  */
  const candidates = all
    .filter((hackathon) => matches(hackathon, filter))
    .sort((a, b) => standing(a) - standing(b));

  /*
    Read a page at a time until a page's worth survives.

    Two things have to happen here and they fight each other. The prize and the
    deadlines come from the contract, one call per hackathon, so the page has to
    stop asking at some point. And a hackathon on a superseded constitution is
    dropped — but only the chain knows which those are, so the drop happens
    after the asking.

    Slicing once, before the reads, made those two into a bug rather than a
    trade: twelve slots went to old events that were then all thrown away, and
    the hackathon somebody had just created sat in thirteenth place and never
    got a slot at all. The listing showed one card while fifteen existed.

    So the window moves instead. Each pass reads one page in parallel, keeps
    what survives, and stops as soon as there are enough — which on a database
    with nothing superseded left is exactly one pass, the cost this always
    meant to pay.
  */
  const wanted = filter.limit ?? PAGE;
  const cards: HackathonSummary[] = [];

  for (let from = 0; from < candidates.length && cards.length < wanted; from += wanted) {
    const batch = candidates.slice(from, from + wanted);

    /*
      The prize is read from the contract rather than from our tables, because
      we do not have it: the indexer records the digest and the phase, and the
      amount lives in the constitution behind them. It is also the one number
      that decides whether somebody gives up a weekend, so a card without it is
      a card nobody can act on.

      All of them at once, and a hackathon whose prize cannot be read keeps its
      card rather than losing it. A slow node should cost a number, not a row.
    */
    const rules = await Promise.all(
      batch.map((summary) => rulesOf(summary.contract_id).catch(() => null)),
    );

    batch.forEach((summary, index) => {
      const document = rules[index];

      /*
        Hackathons running on superseded code are dropped rather than drawn.

        The contracts have no upgrade path, so an event created before the
        platform fee joined the constitution stays on the old shape forever.
        Its card would render, because the decoder defends every field, and
        that is exactly the problem: it would look like every other card while
        being an event this build cannot fully read, quote a fee for, or settle
        one.
      */
      if (document !== null && document.version < CONSTITUTION_VERSION) {
        return;
      }

      cards.push({
        ...summary,
        prize: document?.prize ?? null,
        closesAt: document?.closesAt ?? null,
        registrationOpensAt: document?.registrationOpensAt ?? null,
        registrationClosesAt: document?.registrationClosesAt ?? null,
        asset: document?.asset ?? null,
      });
    });
  }

  return cards.slice(0, wanted);
}

/** Whether one hackathon survives what the reader asked for. */
function matches(hackathon: HackathonSummary, filter: Filter): boolean {
  if (filter.stage !== undefined && filter.stage.length > 0) {
    const where = standing(hackathon);
    const wanted = { open: 0, upcoming: 1, finished: 2 }[filter.stage];

    if (wanted !== undefined && where !== wanted) {
      return false;
    }
  }

  /* Compared without case, because the column is not. Tags are lowercased on
     the way in now, but rows written before that are stored as they were typed,
     and a chip that matched only one spelling hid every hackathon that used the
     other. */
  if (filter.tag !== undefined && filter.tag.length > 0) {
    const wanted = filter.tag.toLowerCase();

    if (!hackathon.tags.some((tag) => tag.toLowerCase() === wanted)) {
      return false;
    }
  }

  if (filter.q !== undefined && filter.q.trim().length > 0) {
    /* Name and tagline, which is what somebody types a word from. Searching the
       description as well would match a hackathon on a word buried in a
       paragraph nobody read. */
    const looking = filter.q.trim().toLowerCase();
    const inside = `${hackathon.name} ${hackathon.tagline ?? ""}`.toLowerCase();

    if (!inside.includes(looking)) {
      return false;
    }
  }

  return true;
}

/**
 * What a hackathon is called, from its contract address.
 *
 * The organizer's console is keyed on the address, because a hackathon exists
 * on chain before the indexer has caught up and before anybody has typed a
 * slug. It still has a name from the moment it was created, though, and a page
 * headed by fifty six characters when it could be headed by the name the
 * organizer chose is a page making somebody decode an address to find out which
 * of their events they are looking at.
 *
 * Null is an ordinary answer, not a failure: the row is written a moment after
 * the contract is, and a page that waited for it would be blank for that
 * moment.
 */
export async function nameOf(contractId: string): Promise<{ name: string; slug: string } | null> {
  if (db === null) {
    return null;
  }

  const { data } = await db
    .from("hackathons")
    .select("name, slug")
    .eq("contract_id", contractId)
    .maybeSingle();

  return data === null
    ? null
    : { name: String(data.name), slug: String(data.slug) };
}

/**
 * How a hackathon presents itself, for the panel's own masthead.
 *
 * The panel used to head itself with the name alone, which made it look like
 * any other page of the product rather than like this organizer's event. The
 * logo and the line under the name are what an organizer recognises their own
 * hackathon by, and they are already stored; they were simply never read here.
 */
export async function presentationOf(contractId: string): Promise<{
  name: string;
  slug: string;
  tagline: string | null;
  /** The long one the public page opens with, when it has been written. */
  description: string | null;
  logo: string | null;
  banner: string | null;
  location: string | null;
  tags: string[];
  /** When the row was written, which is about when the contract was created. */
  createdAt: string | null;
} | null> {
  if (db === null) {
    return null;
  }

  const { data } = await db
    .from("hackathons")
    .select("name, slug, tagline, description, logo_url, banner_url, location, tags, created_at")
    .eq("contract_id", contractId)
    .maybeSingle();

  return data === null
    ? null
    : {
        name: String(data.name),
        slug: String(data.slug),
        tagline: data.tagline === null ? null : String(data.tagline),
        description: data.description === null ? null : String(data.description),
        logo: data.logo_url === null ? null : String(data.logo_url),
        banner: data.banner_url === null ? null : String(data.banner_url),
        location: data.location === null ? null : String(data.location),
        tags: Array.isArray(data.tags) ? (data.tags as string[]) : [],
        createdAt: data.created_at === null ? null : String(data.created_at),
      };
}

/** Every tag in use, for building the filter from what actually exists. */
export async function tagsInUse(): Promise<string[]> {
  if (db === null) {
    return [];
  }

  const { data } = await db.from("hackathons").select("tags");

  /* One entry per topic, whatever case it was stored in. "Payments" and
     "payments" are one subject, and listing both put the same word in the row
     twice with the hackathons using it split between the two chips. The
     lowercase form is what goes in the URL; the filter row capitalises it for
     display and the match ignores case at both ends. */
  const seen = new Set<string>();

  for (const row of data ?? []) {
    for (const tag of (row.tags as string[] | null) ?? []) {
      seen.add(tag.toLowerCase());
    }
  }

  return [...seen].sort();
}

/**
 * How many match, without asking the chain about any of them.
 *
 * The first version of this counted by listing, which read a contract per row
 * and so cost exactly what the paging was introduced to avoid. Nothing in a
 * count needs a prize or a deadline.
 */
export async function countHackathons(filter: Filter = {}): Promise<number> {
  if (db === null) {
    return 0;
  }

  const [written, chain] = await Promise.all([
    db.from("hackathons").select("contract_id, name, tagline, tags"),
    db.from("hackathon_state").select("contract_id, phase"),
  ]);

  const phases = new Map(
    (chain.data ?? []).map((row) => [String(row.contract_id), Number(row.phase)]),
  );

  return (written.data ?? []).filter((row) =>
    matches(
      {
        contract_id: String(row.contract_id),
        slug: "",
        name: String(row.name),
        tagline: (row.tagline as string | null) ?? null,
        phase: phases.get(String(row.contract_id)) ?? null,
        visibility: null,
        prize: null,
        closesAt: null,
        registrationClosesAt: null,
        registrationOpensAt: null,
        asset: null,
        logo_url: null,
        banner_url: null,
        location: null,
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
      },
      filter,
    ),
  ).length;
}

/**
 * The order a reader wants, which is not the order they were created in.
 *
 * What is running comes first, because that is the only group anybody can still
 * join. Then what has not opened yet, which is worth watching. Finished events
 * come last and are kept rather than hidden: a platform that shows only live
 * hackathons is a platform with no record, and the record is the product.
 */
function standing(hackathon: HackathonSummary): number {
  if (hackathon.phase === null) {
    return 1;
  }

  if (hackathon.phase >= 8) {
    return 2;
  }

  return hackathon.phase >= 2 ? 0 : 1;
}

/**
 * The two things a card needs from the frozen rules.
 *
 * A card wants a prize and a deadline; a hackathon page wants the whole
 * document. Both come from the same single call, so this is a narrowing rather
 * than a second way of asking.
 */
async function rulesOf(
  contractId: string,
): Promise<{
  version: number;
  prize: bigint;
  closesAt: number;
  registrationOpensAt: number;
  registrationClosesAt: number;
  asset: string | null;
} | null> {
  const rules = await rulesFor(contractId);

  return rules === null
    ? null
    : {
        version: rules.version,
        prize: rules.total,
        closesAt: rules.schedule.submissionCloses,
        registrationOpensAt: rules.schedule.registrationOpens,
        registrationClosesAt: rules.schedule.registrationCloses,
        asset: rules.prizeAsset,
      };
}

export async function findHackathon(slug: string): Promise<HackathonDetail | null> {
  if (db === null) {
    return null;
  }

  /* Same two step as the listing, and for the same reason: a database one
     migration behind fails the whole select rather than dropping the column,
     and a hackathon that exists must not read as one that does not. */
  const plain = "contract_id, slug, name, tagline, description";
  const dressed = `${plain}, logo_url, banner_url, website_url, location, tags`;

  const written = await db
    .from("hackathons")
    .select(dressed)
    .eq("slug", slug)
    .maybeSingle()
    .then((answer) =>
      answer.error === null
        ? answer.data
        : db.from("hackathons").select(plain).eq("slug", slug).maybeSingle().then((f) => f.data),
    );

  if (written === null || written === undefined) {
    return null;
  }

  const contractId = String((written as Record<string, unknown>)["contract_id"]);

  /* Both at once. The indexer's row and the contract's own document are
     independent reads and a page needs both before it can render anything, so
     making them wait for each other costs a round trip for nothing. */
  const [{ data: chain }, rules] = await Promise.all([
    db
      .from("hackathon_state")
      .select("phase, visibility, organizer, constitution_hash, prize_asset, vault_id")
      .eq("contract_id", contractId)
      .maybeSingle(),
    rulesFor(contractId),
  ]);

  /* Not found rather than shown, so a hackathon dropped from the listing is not
     still reachable by typing its address. Absent rules are a node that could
     not be reached, which is a different thing from an old document and keeps
     its page. */
  if (rules !== null && rules.version < CONSTITUTION_VERSION) {
    return null;
  }

  const merged = merge(written as Record<string, unknown>, chain ?? {});

  return {
    ...merged,
    rules,
    /* Filled from the contract rather than left null, so the hackathon page and
       the card in the listing quote the same figure from the same source. */
    prize: rules?.total ?? null,
    closesAt: rules?.schedule.submissionCloses ?? null,
    registrationClosesAt: rules?.schedule.registrationCloses ?? null,
    registrationOpensAt: rules?.schedule.registrationOpens ?? null,
    asset: rules?.prizeAsset ?? null,
  };
}

/**
 * What somebody wrote, and what the chain says, as one object.
 *
 * A hackathon the indexer has not reached has no chain half at all, and every
 * field from it reads as absent rather than as a default. A page showing a
 * phase nobody published would be inventing one.
 */
function merge(
  written: Record<string, unknown>,
  chain: Record<string, unknown>,
): HackathonDetail {
  return {
    contract_id: String(written["contract_id"]),
    slug: String(written["slug"]),
    name: String(written["name"]),
    tagline: (written["tagline"] as string | null) ?? null,
    description: (written["description"] as string | null) ?? null,
    phase: chain["phase"] === undefined ? null : Number(chain["phase"]),
    visibility: chain["visibility"] === undefined ? null : Number(chain["visibility"]),
    prize: null,
    closesAt: null,
    registrationClosesAt: null,
    registrationOpensAt: null,
    asset: null,
    logo_url: (written["logo_url"] as string | null) ?? null,
    banner_url: (written["banner_url"] as string | null) ?? null,
    location: (written["location"] as string | null) ?? null,
    tags: Array.isArray(written["tags"]) ? (written["tags"] as string[]) : [],
    organizer: (chain["organizer"] as string | null) ?? null,
    constitution_hash: hex(chain["constitution_hash"]),
    prize_asset: (chain["prize_asset"] as string | null) ?? null,
    vault_id: (chain["vault_id"] as string | null) ?? null,
    rules: null,
  };
}

/** Postgres hands back `\x…`; a reader comparing a digest wants the digits. */
function hex(value: unknown): string | null {
  return typeof value === "string" ? value.replace(/^\\x/, "") : null;
}
