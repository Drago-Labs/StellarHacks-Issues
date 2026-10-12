import { looksLikeContract } from "../../../lib/explorer";
import { NextResponse } from "next/server";

import { currentUser } from "../../../lib/supabase/server";
import { signedByOrganizer } from "../../../lib/organizer";
import { phaseOf } from "../../../lib/running";

/**
 * Everything about a project that the chain does not hold.
 *
 * The contract stores a digest and a link. The title, the write up, the
 * artwork and the other links live here, and none of them decide anything: the
 * ranking is computed from scorecards against a rubric that was frozen before
 * any of this was typed.
 *
 * Written through a route rather than straight from the browser for the same
 * reason team names are. Row level security asks `team_members`, which the
 * indexer fills from chain events, so a team that submitted a minute ago is not
 * yet a team as far as the database is concerned and the write is refused. The
 * contract knew the moment the transaction landed, so the contract is asked.
 */

const url = process.env["NEXT_PUBLIC_SUPABASE_URL"];
const serviceRole = process.env["SUPABASE_SERVICE_ROLE_KEY"];
const rpcUrl = process.env["NEXT_PUBLIC_STELLAR_RPC_URL"];
const passphrase = process.env["NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE"];

interface Body {
  contract: string;
  teamId: number;
  title: string;
  summary?: string;
  description?: string;
  technical_overview?: string;
  logo_url?: string;
  banner_url?: string;
  pitch_deck_url?: string;
  repository_url?: string;
  live_url?: string;
  demo_video_url?: string;
  contract_address?: string;
  /** Signed by a member of the team, over the challenge in `lib/organizer.ts`. */
  signature: string;
  issuedAt: number;
}

export async function POST(request: Request) {
  if (
    url === undefined ||
    serviceRole === undefined ||
    rpcUrl === undefined ||
    passphrase === undefined
  ) {
    return NextResponse.json({ error: "not configured" }, { status: 500 });
  }

  const user = await currentUser();

  if (user === null) {
    return NextResponse.json({ error: "sign in first" }, { status: 401 });
  }

  let body: Body;

  try {
    body = (await request.json()) as Body;
  } catch {
    return NextResponse.json({ error: "unreadable" }, { status: 400 });
  }

  const title = String(body.title ?? "").trim();

  if (title.length === 0 || title.length > 120) {
    return NextResponse.json({ error: "a title, up to a hundred and twenty characters" }, { status: 400 });
  }

  const members = await membersOf(body.contract, Number(body.teamId));

  if (members === null) {
    return NextResponse.json({ error: "no such team" }, { status: 404 });
  }

  /* Any member, not only the captain. A submission belongs to the team, and
     making one person the only one who can correct a typo in it is a rule the
     contract does not have and this should not invent. */
  const proved = await Promise.all(
    members.map((member) =>
      signedByOrganizer({
        organizer: member,
        contract: body.contract,
        account: user.id,
        issuedAt: Number(body.issuedAt),
        signature: String(body.signature ?? ""),
        purpose: "team",
      }),
    ),
  );

  if (!proved.some(Boolean)) {
    return NextResponse.json({ error: "not on this team" }, { status: 403 });
  }

  /* Nothing changes once submissions close. The judges and the AI review read
     this row after the deadline, and a write up that could still be edited
     then would let a team answer the review instead of the brief. The phase is
     the contract's, asked here rather than trusted from the page, and a
     contract that cannot be read is not taken as permission. */
  const phase = await phaseOf(body.contract);

  if (phase === null || phase > OPEN) {
    return NextResponse.json(
      { error: "submissions have closed, so the project can no longer be edited" },
      { status: 409 },
    );
  }

  const row = {
    contract_id: body.contract,
    team_id: Number(body.teamId),
    title,
    summary: text(body.summary),
    description: text(body.description),
    technical_overview: bounded(body.technical_overview, 2000),
    logo_url: text(body.logo_url),
    banner_url: text(body.banner_url),
    pitch_deck_url: text(body.pitch_deck_url),
    repository_url: text(body.repository_url),
    live_url: text(body.live_url),
    demo_video_url: text(body.demo_video_url),
    /* Refused rather than stored malformed. The column has the same check, and
       a row rejected by the database fails the whole write, taking a good
       description down with a typo in an optional field. */
    contract_address: looksLikeContract(String(body.contract_address ?? ""))
      ? String(body.contract_address)
      : null,
  };

  async function save(what: Record<string, unknown>) {
    return fetch(`${url}/rest/v1/projects?on_conflict=contract_id,team_id`, {
      method: "POST",
      headers: {
        apikey: serviceRole!,
        Authorization: `Bearer ${serviceRole}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(what),
    });
  }

  let candidate: Record<string, unknown> = { ...row };
  let failure = "the project could not be saved";

  /* Presentation columns were added over several migrations. PostgREST rejects
     the whole row if even one of them is not in its schema cache, which used to
     make a valid title and description disappear together with that optional
     field. Drop only a column the database explicitly says it does not know,
     then preserve everything the deployed schema can store. */
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const written = await save(candidate);

    if (written.ok) {
      return NextResponse.json({ ok: true });
    }

    failure = (await written.text()).slice(0, 500);
    const missing = missingOptionalColumn(failure);

    if (missing === null || !(missing in candidate)) {
      break;
    }

    const { [missing]: _dropped, ...older } = candidate;
    candidate = older;
  }

  return NextResponse.json({ error: failure.slice(0, 200) }, { status: 502 });
}

/** The phase in which entries are made, numbered as the contract numbers it. */
const OPEN = 2;

const OPTIONAL_PRESENTATION_COLUMNS = new Set([
  "technical_overview",
  "banner_url",
  "pitch_deck_url",
  "contract_address",
]);

function missingOptionalColumn(message: string): string | null {
  for (const column of OPTIONAL_PRESENTATION_COLUMNS) {
    if (
      message.includes(`'${column}' column`) ||
      message.includes(`projects.${column}`) ||
      message.includes(`column \"${column}\"`)
    ) {
      return column;
    }
  }

  return null;
}

/** Text held to the column's own limit, so a long overview is cut here rather
    than refused by the database along with everything saved beside it. */
function bounded(value: unknown, limit: number): string | null {
  const kept = text(value);

  return kept === null ? null : kept.slice(0, limit);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Who the chain says is on a team, or nothing when it says no such team. */
async function membersOf(contract: string, teamId: number): Promise<string[] | null> {
  if (!Number.isInteger(teamId) || teamId <= 0) {
    return null;
  }

  const [{ Account, Contract, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative }, rpc] =
    await Promise.all([
      import("@stellar/stellar-sdk/base"),
      import("@stellar/stellar-sdk/rpc"),
    ]);

  try {
    const server = new rpc.Server(rpcUrl!);

    const tx = new TransactionBuilder(
      new Account("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", "0"),
      { fee: BASE_FEE, networkPassphrase: passphrase! },
    )
      .addOperation(
        new Contract(contract).call("team_by_id", nativeToScVal(teamId, { type: "u32" })),
      )
      .setTimeout(30)
      .build();

    const simulated = await server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simulated) || simulated.result === undefined) {
      return null;
    }

    const team = scValToNative(simulated.result.retval) as { members?: unknown };

    return Array.isArray(team.members) ? team.members.map(String) : null;
  } catch {
    return null;
  }
}
