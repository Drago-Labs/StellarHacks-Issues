import type Anthropic from "@anthropic-ai/sdk";

import type { Criterion } from "./chain.js";
import type { Outcome } from "./db.js";
import { validate, weightedTotal } from "./schema.js";

/**
 * One answer, as something that can be stored.
 *
 * The stop reason is read before the content. A declined request comes back as
 * a success with nothing in it, and reading the content first would turn one
 * refusal into a crash in the middle of a three hundred project run.
 */
export function interpret(message: Anthropic.Message, criteria: readonly Criterion[]): Outcome {
  if (message.stop_reason === "refusal") {
    return {
      status: "declined",
      why: message.stop_details?.explanation ?? "the model declined to review this project",
    };
  }

  if (message.stop_reason === "max_tokens") {
    return { status: "failed", why: "the review was longer than the model was allowed to write" };
  }

  const text = message.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "failed", why: "the review was not valid JSON" };
  }

  const checked = validate(parsed, criteria);

  if (!checked.ok) {
    return { status: "failed", why: `the review was refused: ${checked.why}` };
  }

  return {
    status: "reviewed",
    review: checked.review,
    totalScore: weightedTotal(checked.review.criteria, criteria),
  };
}
