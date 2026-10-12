import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { backend, remove, signUp, someAddress, someContract, visitor, type TestUser } from "./roles.js";

/**
 * Who can see the AI pre review, and who can write one.
 *
 * The review is for the people judging the event. A team that could read the
 * machine's opinion of itself, or of its rivals, would be reading notes the
 * judges are working from; anybody who could write one could put a number in
 * front of every judge. Both are enforced here and nowhere on chain, so both
 * are proved here.
 */

let judge: TestUser;
let organizer: TestUser;
let participant: TestUser;
let judgeAddress: string;
let organizerAddress: string;
let participantAddress: string;
const contract = someContract();

async function seed(insert: PromiseLike<{ error: { message: string } | null }>): Promise<void> {
  const { error } = await insert;

  if (error !== null) {
    throw new Error(`could not set the fixture up: ${error.message}`);
  }
}

beforeAll(async () => {
  [judge, organizer, participant] = await Promise.all([signUp(), signUp(), signUp()]);

  judgeAddress = someAddress();
  organizerAddress = someAddress();
  participantAddress = someAddress();

  const admin = backend();

  await seed(
    admin.from("wallet_links").insert([
      { address: judgeAddress, profile_id: judge.id },
      { address: organizerAddress, profile_id: organizer.id },
      { address: participantAddress, profile_id: participant.id },
    ]),
  );

  await seed(
    admin.from("hackathons").insert({
      contract_id: contract,
      slug: `event-${contract.slice(1, 9).toLowerCase()}`,
      name: "A hackathon",
    }),
  );

  await seed(
    admin.from("hackathon_state").insert({
      contract_id: contract,
      organizer: organizerAddress,
      judges: [judgeAddress],
      constitution_hash: "\\x00",
      phase: 4,
      visibility: 0,
      observed_at_ledger: 1,
    }),
  );

  await seed(
    admin
      .from("participants")
      .insert({ contract_id: contract, address: participantAddress, approved_at_ledger: 1 }),
  );

  await seed(admin.from("teams").insert({ contract_id: contract, team_id: 1, name: "A team" }));

  await seed(
    admin.from("ai_reviews").insert({
      contract_id: contract,
      team_id: 1,
      stage: "quick",
      status: "reviewed",
      total_score: 640_000,
      confidence: "medium",
      recommendation: "PASS",
      model: "claude-opus-5-5",
    }),
  );

  await seed(
    admin.from("ai_review_criteria").insert({
      contract_id: contract,
      team_id: 1,
      stage: "quick",
      criterion: "technical",
      score: 80,
      reason: "a real contract",
    }),
  );
});

afterAll(async () => {
  const admin = backend();

  await admin.from("hackathons").delete().eq("contract_id", contract);
  await admin.from("hackathon_state").delete().eq("contract_id", contract);
  await admin.from("participants").delete().eq("contract_id", contract);
  await admin.from("teams").delete().eq("contract_id", contract);
  await remove(judge);
  await remove(organizer);
  await remove(participant);
});

describe("an AI review", () => {
  it("is readable by a judge the rules name", async () => {
    const { data } = await judge.client.from("ai_reviews").select("total_score").eq("contract_id", contract);
    const criteria = await judge.client.from("ai_review_criteria").select("score").eq("contract_id", contract);

    expect(data).toEqual([{ total_score: 640_000 }]);
    expect(criteria.data).toEqual([{ score: 80 }]);
  });

  it("is readable by the organizer", async () => {
    const { data } = await organizer.client.from("ai_reviews").select("team_id").eq("contract_id", contract);

    expect(data).toHaveLength(1);
  });

  /**
   * A participant is approved into the event and can read its public gallery,
   * which is exactly why this matters: being in the event is not being on the
   * bench, and the notes the bench works from are not theirs to read.
   */
  it("is closed to a participant, even in a public event", async () => {
    const { data, error } = await participant.client.from("ai_reviews").select("team_id").eq("contract_id", contract);
    const criteria = await participant.client.from("ai_review_criteria").select("score").eq("contract_id", contract);

    expect(error).toBeNull();
    expect(data).toHaveLength(0);
    expect(criteria.data).toHaveLength(0);
  });

  it("is closed to a signed out visitor", async () => {
    const { data } = await visitor().from("ai_reviews").select("team_id").eq("contract_id", contract);

    expect(data ?? []).toHaveLength(0);
  });

  /**
   * Only the reviewer writes a review. A judge who could write one could put a
   * number in front of every other judge and call it the machine's.
   */
  it("cannot be written by a client, not even a judge", async () => {
    const written = await judge.client.from("ai_reviews").insert({
      contract_id: contract,
      team_id: 1,
      stage: "deep",
      status: "reviewed",
      total_score: 1_000_000,
      confidence: "high",
      recommendation: "PASS",
      model: "made up",
    });

    expect(written.error?.code).toBe("42501");
  });
});

describe("a review run", () => {
  /** Runs are queued by the frontend's route after it checks the chain. A
   * client queueing its own would skip that check and spend the platform's
   * money on whatever it liked. */
  it("cannot be queued by a client directly", async () => {
    const { error } = await judge.client.from("ai_review_runs").insert({ contract_id: contract, stage: "quick" });

    expect(error?.code).toBe("42501");
  });

  /** Two runs racing to write the same rows would leave a review half from
   * one and half from the other. */
  it("is one at a time per hackathon", async () => {
    const admin = backend();

    await seed(admin.from("ai_review_runs").insert({ contract_id: contract, stage: "quick" }));
    const second = await admin.from("ai_review_runs").insert({ contract_id: contract, stage: "deep" });

    /* Removed at once, because this is the live project and a running
       reviewer would otherwise pick the queued row up. */
    await admin.from("ai_review_runs").delete().eq("contract_id", contract);

    expect(second.error?.code).toBe("23505");
  });
});

describe("a technical overview", () => {
  it("is held to two thousand characters", async () => {
    const { error } = await backend()
      .from("projects")
      .insert({ contract_id: contract, team_id: 1, title: "A project", technical_overview: "x".repeat(2001) });

    expect(error?.code).toBe("23514");
  });
});
