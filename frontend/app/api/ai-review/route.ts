import { NextResponse } from "next/server";

import type { AiPanel, AiReview, AiRun, Stage } from "../../../lib/ai-review";
import { canWrite, linkedToAccount, organizerOf } from "../../../lib/authority";
import { phaseOf } from "../../../lib/running";
import { rulesFor } from "../../../lib/rules";
import { currentUser, serverClient } from "../../../lib/supabase/server";

/**
 * The AI pre review, for the people judging an event.
 *
 * Who may see it and start it is asked of the chain: the judges the frozen
 * rules name and the organizer the contract records, each proved to belong to
 * the signed in account by a wallet link. The same answer as the row level
 * policies give, from the authority rather than from the indexer's copy of it,
 * so a judge is not refused for the minute it takes the indexer to catch up.
 *
 * Reads and writes then go through the service role. Nothing here can touch a
 * result: a run is a request for the reviewer, and the shortlist is a number
 * that marks projects without removing any.
 */

export const dynamic = "force-dynamic";

const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
const serviceRole = process.env["SUPABASE_SERVICE_ROLE_KEY"];

/** Screening and Judging: after submissions close, before the reveal. */
const REVIEWABLE = new Set([3, 4]);

export async function GET(request: Request) {
  const contract = new URL(request.url).searchParams.get("contract") ?? "";
  const access = await accessOf(contract);

  if (access !== "granted") {
    return NextResponse.json({ access } satisfies AiPanel);
  }

  const [settings, runs, reviews, criteria] = await Promise.all([
    read(`ai_review_settings?contract_id=eq.${contract}&select=shortlist_size`),
    read(
      `ai_review_runs?contract_id=eq.${contract}&select=id,stage,teams,status,total,done,error,requested_at,finished_at&order=requested_at.desc&limit=10`,
    ),
    read(
      `ai_reviews?contract_id=eq.${contract}&select=team_id,stage,status,total_score,confidence,recommendation,report,strengths,weaknesses,missing_information,unread,error,commit_sha,model,reviewed_at`,
    ),
    read(`ai_review_criteria?contract_id=eq.${contract}&select=team_id,stage,criterion,score,reason,evidence,concerns`),
  ]);

  const panel: AiPanel = {
    access: "granted",
    shortlistSize: (settings[0]?.["shortlist_size"] as number | null | undefined) ?? null,
    runs: runs.map(
      (row): AiRun => ({
        id: String(row["id"]),
        stage: row["stage"] as Stage,
        teams: (row["teams"] as number[] | null) ?? null,
        status: row["status"] as AiRun["status"],
        total: Number(row["total"]),
        done: Number(row["done"]),
        error: (row["error"] as string | null) ?? null,
        requestedAt: String(row["requested_at"]),
        finishedAt: (row["finished_at"] as string | null) ?? null,
      }),
    ),
    reviews: reviews.map(
      (row): AiReview => ({
        team: Number(row["team_id"]),
        stage: row["stage"] as Stage,
        status: row["status"] as AiReview["status"],
        totalScore: (row["total_score"] as number | null) ?? null,
        confidence: (row["confidence"] as AiReview["confidence"]) ?? null,
        recommendation: (row["recommendation"] as AiReview["recommendation"]) ?? null,
        report: (row["report"] as string | null) ?? null,
        strengths: (row["strengths"] as string[]) ?? [],
        weaknesses: (row["weaknesses"] as string[]) ?? [],
        missingInformation: (row["missing_information"] as string[]) ?? [],
        unread: (row["unread"] as string[]) ?? [],
        error: (row["error"] as string | null) ?? null,
        commitSha: (row["commit_sha"] as string | null) ?? null,
        model: String(row["model"]),
        reviewedAt: String(row["reviewed_at"]),
        criteria: criteria
          .filter((one) => one["team_id"] === row["team_id"] && one["stage"] === row["stage"])
          .map((one) => ({
            criterion: String(one["criterion"]),
            score: Number(one["score"]),
            reason: String(one["reason"]),
            evidence: (one["evidence"] as string[]) ?? [],
            concerns: (one["concerns"] as string[]) ?? [],
          })),
      }),
    ),
  };

  return NextResponse.json(panel);
}

type Body =
  | { contract: string; action: "start"; stage: Stage; teams?: number[] }
  | { contract: string; action: "shortlist"; size: number | null };

export async function POST(request: Request) {
  let body: Body;

  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "unreadable" }, { status: 400 });
  }

  const contract = String(body.contract ?? "");
  const access = await accessOf(contract);

  if (access === "signed-out") {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  if (access === "denied") {
    return NextResponse.json(
      { error: "only this hackathon's judges and organizer can use the AI review" },
      { status: 403 },
    );
  }

  const user = await currentUser();

  if (body.action === "shortlist") {
    const size = body.size === null ? null : Number(body.size);

    if (size !== null && (!Number.isInteger(size) || size < 1 || size > 1000)) {
      return NextResponse.json({ error: "a number from 1 to 1000" }, { status: 400 });
    }

    const saved = await write("ai_review_settings?on_conflict=contract_id", {
      contract_id: contract,
      shortlist_size: size,
      updated_by: user?.id ?? null,
    }, "resolution=merge-duplicates,return=minimal");

    return saved.ok
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "the shortlist could not be saved" }, { status: 502 });
  }

  if (body.action !== "start" || (body.stage !== "quick" && body.stage !== "deep")) {
    return NextResponse.json({ error: "unknown request" }, { status: 400 });
  }

  /* Only once submissions have closed, because a review of a project that can
     still change is a review of something that was never submitted; and only
     until the reveal, after which there is nothing left for it to help with. */
  const phase = await phaseOf(contract);

  if (phase === null || !REVIEWABLE.has(phase)) {
    return NextResponse.json(
      { error: "the AI review opens when submissions close and ends with judging" },
      { status: 409 },
    );
  }

  const teams =
    body.teams === undefined
      ? null
      : [...new Set(body.teams.map(Number))].filter((team) => Number.isInteger(team) && team > 0);

  if (teams !== null && teams.length === 0) {
    return NextResponse.json({ error: "choose at least one project" }, { status: 400 });
  }

  const queued = await write("ai_review_runs", {
    contract_id: contract,
    stage: body.stage,
    teams,
    requested_by: user?.id ?? null,
  }, "return=minimal");

  /* The index allowing one run in flight per event answers a second press
     with a conflict, which is the case worth naming. */
  if (queued.status === 409) {
    return NextResponse.json(
      { error: "a review is already running for this hackathon" },
      { status: 409 },
    );
  }

  return queued.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "the review could not be queued" }, { status: 502 });
}

/**
 * Whether the signed in account may see this event's AI review.
 *
 * A judge named in the frozen rules, the organizer the contract records, or
 * platform staff. The first two are checked against every wallet the account
 * has proved it holds, because a judge's key is the one the rules name, not
 * whichever wallet happens to be connected.
 */
async function accessOf(contract: string): Promise<AiPanel["access"]> {
  if (contract.length !== 56 || !canWrite()) {
    return "denied";
  }

  const user = await currentUser();

  if (user === null) {
    return "signed-out";
  }

  const [rules, organizer, staff] = await Promise.all([
    rulesFor(contract).catch(() => null),
    organizerOf(contract),
    isStaff(),
  ]);

  if (staff) {
    return "granted";
  }

  const allowed = [...(rules?.judgeAddresses ?? []), ...(organizer === null ? [] : [organizer])];
  const held = await Promise.all(allowed.map((address) => linkedToAccount(address, user.id)));

  return held.some(Boolean) ? "granted" : "denied";
}

async function isStaff(): Promise<boolean> {
  const db = await serverClient();

  if (db === null) {
    return false;
  }

  const { data } = await db.rpc("is_staff");

  return data === true;
}

async function read(path: string): Promise<Record<string, unknown>[]> {
  const answer = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: serviceRole!, Authorization: `Bearer ${serviceRole!}` },
    cache: "no-store",
  }).catch(() => null);

  if (answer === null || !answer.ok) {
    return [];
  }

  const rows = (await answer.json().catch(() => [])) as unknown;

  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

function write(path: string, row: Record<string, unknown>, prefer: string): Promise<Response> {
  return fetch(`${url}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: serviceRole!,
      Authorization: `Bearer ${serviceRole!}`,
      "Content-Type": "application/json",
      Prefer: prefer,
    },
    body: JSON.stringify(row),
  });
}
