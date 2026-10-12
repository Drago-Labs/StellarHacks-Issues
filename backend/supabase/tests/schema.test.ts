import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  backend,
  remove,
  signUp,
  someAddress,
  someContract,
  visitor,
  type TestUser,
} from "./roles.js";

/**
 * The sealed tables, the derived tables, and who may write the text.
 *
 * Three different promises are checked here and they fail in three different
 * ways, which is worth keeping straight while reading:
 *
 *   Sealed      Nobody reads a scorecard or a ballot through this API. The
 *               refusal is `42501`, from the grant, because there is no policy
 *               to even reach.
 *   Derived     Anybody reads them, nobody but the indexer writes them. Reads
 *               return rows; writes are refused with `42501`.
 *   Written     The person the chain named may write; anybody else is refused
 *               by the policy, which shows up as `42501` on an insert whose
 *               `with check` found nothing.
 */

const admin = backend();

interface Event {
  contract: string;
  organizer: string;
  team: number;
  memberAddress: string;
}

let organizerUser: TestUser;
let memberUser: TestUser;
let stranger: TestUser;
let event: Event;

async function must<T extends { error: { message: string } | null }>(
  query: PromiseLike<T>,
): Promise<T> {
  const result = await query;

  if (result.error !== null) {
    throw new Error(`could not set the fixture up: ${result.error.message}`);
  }

  return result;
}

beforeAll(async () => {
  organizerUser = await signUp();
  memberUser = await signUp();
  stranger = await signUp();

  const contract = someContract();
  const organizer = someAddress();
  const memberAddress = someAddress();

  // Addresses are bound the way the verifier binds them, after a signature it
  // has already checked. No client can do this, which is what makes every
  // policy below mean something.
  await must(
    admin.from("wallet_links").insert([
      { address: organizer, profile_id: organizerUser.id },
      { address: memberAddress, profile_id: memberUser.id },
    ]),
  );

  await must(
    admin.from("hackathons").insert({
      contract_id: contract,
      slug: `event-${contract.slice(1, 9).toLowerCase()}`,
      name: "A hackathon",
    }),
  );
  await must(
    admin.from("hackathon_state").insert({
      contract_id: contract,
      organizer,
      constitution_hash: "\\x00",
      phase: 2,
      visibility: 0,
      observed_at_ledger: 1,
    }),
  );
  await must(admin.from("teams").insert({ contract_id: contract, team_id: 1, name: "A team" }));
  await must(
    admin.from("team_members").insert({
      contract_id: contract,
      team_id: 1,
      address: memberAddress,
      joined_at_ledger: 1,
    }),
  );

  event = { contract, organizer, team: 1, memberAddress };
});

afterAll(async () => {
  for (const table of [
    "projects",
    "team_members",
    "teams",
    "scorecards",
    "ballots",
    "chain_events",
    "submissions",
    "scores",
    "results",
    "payments",
    "hackathon_state",
    "hackathons",
  ]) {
    await admin.from(table).delete().eq("contract_id", event.contract);
  }

  await remove(organizerUser);
  await remove(memberUser);
  await remove(stranger);
});

describe("the sealed tables", () => {
  beforeAll(async () => {
    await must(
      admin.from("scorecards").insert({
        contract_id: event.contract,
        team_id: event.team,
        judge: someAddress(),
        scores: [{ criterion: "technical", score: 80 }],
        feedback: "solid work",
        leaf: "\\xaa",
        signature: "\\xbb",
      }),
    );
    await must(
      admin.from("ballots").insert({
        contract_id: event.contract,
        voter: someAddress(),
        choices: [{ team: event.team, weight: 10 }],
        leaf: "\\xcc",
        signature: "\\xdd",
      }),
    );
  });

  it("are unreadable by a signed out visitor", async () => {
    const scorecards = await visitor().from("scorecards").select("*");
    const ballots = await visitor().from("ballots").select("*");

    expect(scorecards.error?.code).toBe("42501");
    expect(ballots.error?.code).toBe("42501");
  });

  it("are unreadable by somebody signed in", async () => {
    const scorecards = await memberUser.client.from("scorecards").select("*");
    const ballots = await memberUser.client.from("ballots").select("*");

    expect(scorecards.error?.code).toBe("42501");
    expect(ballots.error?.code).toBe("42501");
  });

  /**
   * The one that matters most. An organizer who could read the scorecards
   * before the reveal would know the result while the judging window was still
   * open, and every promise the sealing makes would be theirs to break.
   */
  it("are unreadable by the organizer of the event they belong to", async () => {
    const scorecards = await organizerUser.client
      .from("scorecards")
      .select("*")
      .eq("contract_id", event.contract);

    expect(scorecards.error?.code).toBe("42501");
  });

  it("cannot be written by a client either", async () => {
    const { error } = await memberUser.client.from("ballots").insert({
      contract_id: event.contract,
      voter: someAddress(),
      choices: [{ team: event.team, weight: 10 }],
      leaf: "\\xee",
      signature: "\\xff",
    });

    expect(error?.code).toBe("42501");
  });

  it("are reachable by the collection service, which is the only reader", async () => {
    const { data, error } = await admin
      .from("scorecards")
      .select("feedback")
      .eq("contract_id", event.contract);

    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  });
});

describe("the derived tables", () => {
  beforeAll(async () => {
    await must(
      admin.from("submissions").insert({
        contract_id: event.contract,
        team_id: event.team,
        track: "payments",
        metadata_hash: "\\x01",
        uri: "ipfs://cid",
        submitted_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 0,
      }),
    );
    await must(
      admin.from("results").insert({
        contract_id: event.contract,
        track: "payments",
        rank: 1,
        team_id: event.team,
        final_score: 688000,
        judge_average: 860000,
        community: 0,
        decided_by: 0,
      }),
    );
    await must(
      admin.from("payments").insert({
        contract_id: event.contract,
        track: "payments",
        rank: 1,
        recipient: event.memberAddress,
        amount: "1667",
        kind: 0,
        ledger: 42,
        tx_hash: "\\x02",
      }),
    );
  });

  /**
   * A stranger has to be able to check a result without an account. That is the
   * whole observer surface, and it is why every one of these is public.
   */
  it("are readable by somebody with no account at all", async () => {
    const anyone = visitor();

    const submissions = await anyone
      .from("submissions")
      .select("metadata_hash")
      .eq("contract_id", event.contract);
    const results = await anyone
      .from("results")
      .select("rank, team_id")
      .eq("contract_id", event.contract);
    const payments = await anyone
      .from("payments")
      .select("recipient, amount")
      .eq("contract_id", event.contract);

    expect(submissions.data).toHaveLength(1);
    expect(results.data).toHaveLength(1);
    expect(payments.data).toHaveLength(1);
  });

  /**
   * A submission record stays readable whatever the gallery says. The digest,
   * the timestamp and the track are what make a receipt checkable by a
   * stranger, and a private hackathon is still supposed to produce one.
   */
  it("show a submission even when its write up is hidden", async () => {
    await must(
      admin.from("hackathon_state").update({ visibility: 2 }).eq("contract_id", event.contract),
    );

    const anyone = visitor();
    const submissions = await anyone
      .from("submissions")
      .select("metadata_hash")
      .eq("contract_id", event.contract);
    const projects = await anyone
      .from("projects")
      .select("title")
      .eq("contract_id", event.contract);

    expect(submissions.data).toHaveLength(1);
    expect(projects.data).toHaveLength(0);

    await must(
      admin.from("hackathon_state").update({ visibility: 0 }).eq("contract_id", event.contract),
    );
  });

  /**
   * These must be droppable and rebuildable by replaying from ledger zero. A
   * row a client wrote could not be regenerated, and would quietly outrank the
   * chain it is supposed to mirror.
   */
  it("refuse every write from a client", async () => {
    const result = await memberUser.client.from("results").insert({
      contract_id: event.contract,
      track: "payments",
      rank: 2,
      team_id: event.team,
      final_score: 999999,
      judge_average: 999999,
      community: 0,
      decided_by: 0,
    });
    const payment = await memberUser.client.from("payments").insert({
      contract_id: event.contract,
      track: "payments",
      rank: 2,
      recipient: event.memberAddress,
      amount: "99999",
      kind: 0,
      ledger: 43,
      tx_hash: "\\x03",
    });
    const membership = await stranger.client.from("team_members").insert({
      contract_id: event.contract,
      team_id: event.team,
      address: someAddress(),
      joined_at_ledger: 2,
    });

    expect(result.error?.code).toBe("42501");
    expect(payment.error?.code).toBe("42501");
    expect(membership.error?.code).toBe("42501");
  });

  /**
   * Editing a result you did not like is the same attack as writing one.
   */
  it("refuse an edit from a client", async () => {
    const { error } = await memberUser.client
      .from("results")
      .update({ rank: 1, final_score: 1000000 })
      .eq("contract_id", event.contract);

    expect(error?.code).toBe("42501");
  });
});

describe("writing the text people type", () => {
  it("lets the organizer the chain named edit the event page", async () => {
    const { error } = await organizerUser.client
      .from("hackathons")
      .update({ tagline: "Build something that pays out" })
      .eq("contract_id", event.contract);

    expect(error).toBeNull();

    const { data } = await admin
      .from("hackathons")
      .select("tagline")
      .eq("contract_id", event.contract)
      .single();
    expect(data!.tagline).toBe("Build something that pays out");
  });

  /**
   * Holding an account is not holding the organizer's address. Without this
   * anybody could rewrite the front page of somebody else's hackathon.
   */
  it("refuses an event page edit from anybody else", async () => {
    const { error } = await stranger.client
      .from("hackathons")
      .update({ tagline: "mine now" })
      .eq("contract_id", event.contract);

    expect(error).toBeNull();

    const { data } = await admin
      .from("hackathons")
      .select("tagline")
      .eq("contract_id", event.contract)
      .single();
    expect(data!.tagline).toBe("Build something that pays out");
  });

  it("lets a team member write their own project", async () => {
    const { error } = await memberUser.client.from("projects").insert({
      contract_id: event.contract,
      team_id: event.team,
      title: "Lumen Split",
      summary: "Shared expenses settled in USDC",
    });

    expect(error).toBeNull();
  });

  /**
   * A project page is the thing judges read. Somebody outside the team writing
   * it would be editing the entry the result is derived from.
   */
  it("refuses a project from somebody outside the team", async () => {
    const { error } = await stranger.client.from("projects").insert({
      contract_id: event.contract,
      team_id: event.team,
      title: "not mine",
    });

    expect(error?.code).toBe("42501");
  });

  it("refuses a project edit from somebody outside the team", async () => {
    const { error } = await stranger.client
      .from("projects")
      .update({ title: "hijacked" })
      .eq("contract_id", event.contract);

    expect(error).toBeNull();

    const { data } = await admin
      .from("projects")
      .select("title")
      .eq("contract_id", event.contract)
      .single();
    expect(data!.title).toBe("Lumen Split");
  });

  /**
   * A page that took part in a finished event is part of a record the proof
   * page still points at, so nothing here is deletable by the people who wrote
   * it.
   */
  it("refuses a delete from everybody", async () => {
    const project = await memberUser.client
      .from("projects")
      .delete()
      .eq("contract_id", event.contract);
    const hackathon = await organizerUser.client
      .from("hackathons")
      .delete()
      .eq("contract_id", event.contract);

    expect(project.error?.code).toBe("42501");
    expect(hackathon.error?.code).toBe("42501");
  });
});
