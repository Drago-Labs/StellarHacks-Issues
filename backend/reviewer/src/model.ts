import Anthropic from "@anthropic-ai/sdk";

import type { Criterion } from "./chain.js";
import { settings } from "./config.js";
import { interpret } from "./answer.js";
import type { Outcome } from "./db.js";
import type { Stage } from "./prompt.js";
import { schemaFor } from "./schema.js";

/**
 * The model, through the Batches API.
 *
 * A run happens after the deadline and nobody waits on a single answer, which
 * is the shape batching is for: half the price, results usually within the
 * hour. Progress is reported per slice, so the panel still moves.
 */

const client = new Anthropic();

export interface Request {
  /** The team id, as text. Results come back in any order and are matched by it. */
  id: string;
  stage: Stage;
  system: string;
  user: string;
  criteria: readonly Criterion[];
}

export async function submit(requests: readonly Request[]): Promise<string> {
  const batch = await client.messages.batches.create({
    requests: requests.map((request) => ({
      custom_id: request.id,
      params: {
        model: settings.model,
        /* The source a deep review reads makes for a longer answer, and a
           review cut off by the cap is a review thrown away. */
        max_tokens: request.stage === "deep" ? 32_000 : 16_000,
        system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: request.user }],
        output_config: {
          /* Set rather than left to the default, which on this model is a level
             below what a judgement across a whole rubric deserves. */
          effort: "high",
          format: { type: "json_schema", schema: schemaFor(request.criteria) },
        },
      },
    })),
  });

  return batch.id;
}

/** Waits for a batch to end, without holding a connection open while it does. */
export async function ended(batchId: string): Promise<void> {
  for (;;) {
    const batch = await client.messages.batches.retrieve(batchId);

    if (batch.processing_status === "ended") {
      return;
    }

    await new Promise((wake) => setTimeout(wake, 30_000));
  }
}

/** Every result of a batch, as an outcome keyed by the request id. */
export async function outcomes(
  batchId: string,
  criteriaOf: (id: string) => readonly Criterion[],
): Promise<Map<string, Outcome>> {
  const found = new Map<string, Outcome>();

  for await (const entry of await client.messages.batches.results(batchId)) {
    const { result } = entry;

    switch (result.type) {
      case "succeeded":
        found.set(entry.custom_id, interpret(result.message, criteriaOf(entry.custom_id)));
        break;

      case "errored":
        found.set(entry.custom_id, { status: "failed", why: `the model request failed: ${result.error.error.message}` });
        break;

      case "canceled":
      case "expired":
        found.set(entry.custom_id, { status: "failed", why: `the model request ${result.type}` });
        break;
    }
  }

  return found;
}
