import { createClient } from "@supabase/supabase-js";

import { settings } from "./config.js";
import type { Hackathon, Project, Stage } from "./prompt.js";
import type { Review } from "./schema.js";

/**
 * Everything the reviewer reads from and writes to Postgres.
 *
 * The service role, because a review is written by nobody a policy knows: no
 * judge or organizer signed it. It writes only the review tables and the run
 * it is carrying out, and reads the submissions, the projects and the event.
 */

const db = createClient(settings.supabaseUrl, settings.serviceRoleKey, {
  auth: { persistSession: false },
});

export interface Run {
  id: string;
  contractId: string;
  stage: Stage;
  teams: number[] | null;
  status: "queued" | "running";
}

/**
 * The oldest run waiting or interrupted.
 *
 * A run left `running` is one this process was carrying when it stopped. It is
 * picked up again rather than abandoned, and the projects it already wrote are
 * skipped, so a restart costs at most the slice that was in flight.
 */
export async function nextRun(): Promise<Run | null> {
  const { data, error } = await db
    .from("ai_review_runs")
    .select("id, contract_id, stage, teams, status")
    .in("status", ["queued", "running"])
    .order("requested_at", { ascending: true })
    .limit(1);

  if (error !== null) {
    throw new Error(error.message);
  }

  const row = data?.[0];

  return row === undefined
    ? null
    : {
        id: String(row.id),
        contractId: String(row.contract_id),
        stage: row.stage as Stage,
        teams: (row.teams as number[] | null) ?? null,
        status: row.status as Run["status"],
      };
}

export async function started(run: Run, total: number, model: string): Promise<void> {
  await update(run.id, {
    status: "running",
    total,
    model,
    started_at: new Date().toISOString(),
  });
}

export async function progressed(run: Run, done: number, batchId: string | null): Promise<void> {
  await update(run.id, { done, batch_id: batchId });
}

export async function finished(run: Run): Promise<void> {
  await update(run.id, { status: "finished", finished_at: new Date().toISOString(), batch_id: null });
}

export async function failed(run: Run, why: string): Promise<void> {
  await update(run.id, {
    status: "failed",
    error: why.slice(0, 1000),
    finished_at: new Date().toISOString(),
  });
}

export async function hackathonOf(contract: string): Promise<Hackathon> {
  const { data, error } = await db
    .from("hackathons")
    .select("name, tagline, description")
    .eq("contract_id", contract)
    .single();

  if (error !== null) {
    throw new Error(error.message);
  }

  return {
    name: String(data.name),
    tagline: (data.tagline as string | null) ?? null,
    description: (data.description as string | null) ?? null,
  };
}

/**
 * The projects still in the running, with what their teams wrote.
 *
 * From `submissions`, which the indexer derives from chain events, and only the
 * valid ones: an entry struck out in screening is not something the judges
 * will score, so reviewing it would be money spent on a list nobody reads.
 */
export async function projectsOf(contract: string, teams: number[] | null): Promise<Project[]> {
  let query = db
    .from("submissions")
    .select("team_id, track")
    .eq("contract_id", contract)
    .eq("status", 0);

  if (teams !== null) {
    query = query.in("team_id", teams);
  }

  const [entered, written] = await Promise.all([
    query,
    db
      .from("projects")
      .select(
        "team_id, title, summary, description, technical_overview, repository_url, live_url, demo_video_url, contract_address",
      )
      .eq("contract_id", contract),
  ]);

  if (entered.error !== null) {
    throw new Error(entered.error.message);
  }

  if (written.error !== null) {
    throw new Error(written.error.message);
  }

  const byTeam = new Map((written.data ?? []).map((row) => [Number(row.team_id), row]));

  return (entered.data ?? []).map((entry) => {
    const row = byTeam.get(Number(entry.team_id));
    const text = (key: string) => {
      const value = row?.[key as keyof typeof row];

      return typeof value === "string" && value.trim().length > 0 ? value : null;
    };

    return {
      teamId: Number(entry.team_id),
      track: String(entry.track),
      title: text("title"),
      summary: text("summary"),
      description: text("description"),
      technicalOverview: text("technical_overview"),
      repositoryUrl: text("repository_url"),
      liveUrl: text("live_url"),
      demoVideoUrl: text("demo_video_url"),
      contractAddress: text("contract_address"),
    };
  });
}

/** Teams this run already wrote a review for, so a resumed run skips them. */
export async function alreadyReviewed(run: Run): Promise<Set<number>> {
  const { data, error } = await db
    .from("ai_reviews")
    .select("team_id")
    .eq("contract_id", run.contractId)
    .eq("stage", run.stage)
    .eq("run_id", run.id);

  if (error !== null) {
    throw new Error(error.message);
  }

  return new Set((data ?? []).map((row) => Number(row.team_id)));
}

export type Outcome =
  | { status: "reviewed"; review: Review; totalScore: number }
  | { status: "declined" | "failed"; why: string };

export interface Written {
  run: Run;
  teamId: number;
  outcome: Outcome;
  inputHash: Buffer | null;
  commitSha: string | null;
  unread: string[];
  model: string;
}

/**
 * One project's review, replacing whatever this stage held for it before.
 *
 * The criteria are cleared first rather than upserted, so a rubric line that
 * a previous run scored and this one did not cannot survive into the new
 * review as though it belonged to it.
 */
export async function write(written: Written): Promise<void> {
  const { run, teamId, outcome } = written;
  const key = { contract_id: run.contractId, team_id: teamId, stage: run.stage };
  const reviewed = outcome.status === "reviewed" ? outcome.review : null;

  const row = {
    ...key,
    run_id: run.id,
    status: outcome.status,
    total_score: outcome.status === "reviewed" ? outcome.totalScore : null,
    confidence: reviewed?.confidence ?? null,
    recommendation: reviewed?.recommendation ?? null,
    report: reviewed?.report ?? null,
    strengths: reviewed?.strengths ?? [],
    weaknesses: reviewed?.weaknesses ?? [],
    missing_information: reviewed?.missingInformation ?? [],
    unread: written.unread,
    error: outcome.status === "reviewed" ? null : outcome.why.slice(0, 1000),
    input_hash: written.inputHash === null ? null : `\\x${written.inputHash.toString("hex")}`,
    commit_sha: written.commitSha,
    model: written.model,
    reviewed_at: new Date().toISOString(),
  };

  const cleared = await db
    .from("ai_review_criteria")
    .delete()
    .eq("contract_id", run.contractId)
    .eq("team_id", teamId)
    .eq("stage", run.stage);

  if (cleared.error !== null) {
    throw new Error(cleared.error.message);
  }

  const saved = await db.from("ai_reviews").upsert(row, { onConflict: "contract_id,team_id,stage" });

  if (saved.error !== null) {
    throw new Error(saved.error.message);
  }

  if (reviewed !== null && reviewed.criteria.length > 0) {
    const criteria = await db.from("ai_review_criteria").insert(
      reviewed.criteria.map((criterion) => ({
        ...key,
        criterion: criterion.criterion,
        score: criterion.score,
        reason: criterion.reason,
        evidence: criterion.evidence,
        concerns: criterion.concerns,
      })),
    );

    if (criteria.error !== null) {
      throw new Error(criteria.error.message);
    }
  }
}

async function update(id: string, values: Record<string, unknown>): Promise<void> {
  const { error } = await db.from("ai_review_runs").update(values).eq("id", id);

  if (error !== null) {
    throw new Error(error.message);
  }
}
