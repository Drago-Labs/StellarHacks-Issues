import { config } from "dotenv";

config({ path: new URL("../../.env.local", import.meta.url).pathname, quiet: true });

function required(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. See backend/.env.example.`);
  }

  return value;
}

/**
 * A number from the environment, where an empty value is an absent one.
 *
 * The clock learned this the expensive way: `X=""` from a copied example file
 * reads as zero, and a zero wait is a loop hammering the database for as long
 * as nobody notices.
 */
function positive(name: string, otherwise: number): number {
  const written = process.env[name];
  const asked = written === undefined || written === "" ? Number.NaN : Number(written);

  return Number.isFinite(asked) && asked > 0 ? asked : otherwise;
}

export const settings = {
  supabaseUrl: required("SUPABASE_URL"),
  serviceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  rpcUrl: required("STELLAR_RPC_URL"),
  networkPassphrase: required("STELLAR_NETWORK_PASSPHRASE"),
  /**
   * Required, not a nicety. Unauthenticated, GitHub allows sixty requests an
   * hour, and a quick review makes five per project: the twelfth project of a
   * run would wait an hour. A token raises the limit to five thousand.
   */
  githubToken: required("GITHUB_TOKEN"),
  /*
    The Anthropic key is not read here. The SDK resolves it itself, from
    `ANTHROPIC_API_KEY` or from a profile, and a copy in this object would be a
    second place for it to be wrong.
  */
  model: process.env["REVIEWER_MODEL"] || "claude-opus-5-5",
  /**
   * How long between looks at the queue.
   *
   * This is how long a judge waits between pressing the button and the run
   * starting, and each look is one small read whether or not anybody pressed
   * anything. A minute is a wait nobody notices on a run that takes far longer.
   */
  everyMs: positive("REVIEWER_EVERY_MS", 60_000),
  /**
   * Projects per batch.
   *
   * A run is sent in slices rather than as one batch so the panel's progress
   * moves while a long run is going, and so GitHub is asked at a pace rather
   * than all at once at the start.
   */
  chunk: positive("REVIEWER_CHUNK", 25),
  /**
   * How much source a deep review sends, in characters.
   *
   * Roughly a hundred thousand tokens. A repository larger than this is read in
   * a fixed order and what did not fit is listed in the review, so a judge
   * knows what the model did not see.
   */
  deepChars: positive("REVIEWER_DEEP_CHARS", 400_000),
} as const;
