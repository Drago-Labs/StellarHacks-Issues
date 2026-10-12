import { MAX_CRITERION_SCORE } from "@stelhacks/sdk";

import type { Criterion } from "./chain.js";

/**
 * The shape the model has to answer in, and what is refused even when it does.
 *
 * Built per track from the frozen rubric, so a model that invents a criterion or
 * drops one fails to validate instead of writing a plausible wrong number.
 */

export const RECOMMENDATIONS = ["PASS", "MANUAL_REVIEW", "LOW_PRIORITY"] as const;
export const CONFIDENCES = ["low", "medium", "high"] as const;

export type Recommendation = (typeof RECOMMENDATIONS)[number];
export type Confidence = (typeof CONFIDENCES)[number];

export interface CriterionReview {
  criterion: string;
  score: number;
  reason: string;
  evidence: string[];
  concerns: string[];
}

export interface Review {
  report: string;
  confidence: Confidence;
  recommendation: Recommendation;
  strengths: string[];
  weaknesses: string[];
  missingInformation: string[];
  criteria: CriterionReview[];
}

/**
 * The highest score a criterion may carry with nothing quoted to support it.
 *
 * The one instruction that makes the whole review worth running is that a well
 * written description does not by itself earn a high score. Asking for that is
 * hopeful; refusing a review that breaks it is enforceable. Half the scale is
 * the line: below it an unsupported score is a cautious guess, above it the
 * model is rewarding a claim it could not point at.
 */
export const UNSUPPORTED_CEILING = MAX_CRITERION_SCORE / 2;

const strings = { type: "array", items: { type: "string" } } as const;

/**
 * JSON Schema for one track's review.
 *
 * Numeric bounds are not in the schema: structured output guarantees the shape,
 * and the range is checked in `validate`, where a violation can say which
 * criterion broke it.
 */
export function schemaFor(criteria: readonly Criterion[]): Record<string, unknown> {
  const criterion = {
    type: "object",
    properties: {
      score: { type: "integer" },
      reason: { type: "string" },
      evidence: strings,
      concerns: strings,
    },
    required: ["score", "reason", "evidence", "concerns"],
    additionalProperties: false,
  };

  return {
    type: "object",
    properties: {
      criteria: {
        type: "object",
        properties: Object.fromEntries(criteria.map((one) => [one.id, criterion])),
        required: criteria.map((one) => one.id),
        additionalProperties: false,
      },
      report: { type: "string" },
      confidence: { type: "string", enum: [...CONFIDENCES] },
      recommendation: { type: "string", enum: [...RECOMMENDATIONS] },
      strengths: strings,
      weaknesses: strings,
      missingInformation: strings,
    },
    required: [
      "criteria",
      "report",
      "confidence",
      "recommendation",
      "strengths",
      "weaknesses",
      "missingInformation",
    ],
    additionalProperties: false,
  };
}

/** A review the model wrote, or the reason it cannot be stored. */
export function validate(
  raw: unknown,
  criteria: readonly Criterion[],
): { ok: true; review: Review } | { ok: false; why: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, why: "the answer was not an object" };
  }

  const answer = raw as Record<string, unknown>;
  const scored = answer["criteria"];

  if (typeof scored !== "object" || scored === null) {
    return { ok: false, why: "no criteria in the answer" };
  }

  const given = scored as Record<string, unknown>;
  const extra = Object.keys(given).filter((id) => !criteria.some((one) => one.id === id));

  if (extra.length > 0) {
    return { ok: false, why: `scored criteria the rubric does not have: ${extra.join(", ")}` };
  }

  const out: CriterionReview[] = [];

  for (const { id } of criteria) {
    const entry = given[id] as Record<string, unknown> | undefined;

    if (entry === undefined) {
      return { ok: false, why: `${id} was not scored` };
    }

    const score = entry["score"];

    if (!Number.isInteger(score) || (score as number) < 0 || (score as number) > MAX_CRITERION_SCORE) {
      return { ok: false, why: `${id} scored ${String(score)}, outside 0 to ${MAX_CRITERION_SCORE}` };
    }

    const evidence = texts(entry["evidence"]);

    if (evidence.length === 0 && (score as number) > UNSUPPORTED_CEILING) {
      return { ok: false, why: `${id} scored ${String(score)} with no evidence quoted` };
    }

    out.push({
      criterion: id,
      score: score as number,
      reason: String(entry["reason"] ?? ""),
      evidence,
      concerns: texts(entry["concerns"]),
    });
  }

  const confidence = answer["confidence"];
  const recommendation = answer["recommendation"];

  if (!CONFIDENCES.includes(confidence as Confidence)) {
    return { ok: false, why: `confidence ${String(confidence)} is not one of ${CONFIDENCES.join(", ")}` };
  }

  if (!RECOMMENDATIONS.includes(recommendation as Recommendation)) {
    return {
      ok: false,
      why: `recommendation ${String(recommendation)} is not one of ${RECOMMENDATIONS.join(", ")}`,
    };
  }

  return {
    ok: true,
    review: {
      report: String(answer["report"] ?? ""),
      confidence: confidence as Confidence,
      recommendation: recommendation as Recommendation,
      strengths: texts(answer["strengths"]),
      weaknesses: texts(answer["weaknesses"]),
      missingInformation: texts(answer["missingInformation"]),
      criteria: out,
    },
  };
}

/**
 * The weighted total, at `MAX_WEIGHTED_SCORE` scale.
 *
 * Each score times its weight in basis points, summed and never divided. The
 * contract keeps a judge's card the same way, so the two are comparable number
 * for number, and the only rounding is the interface's.
 */
export function weightedTotal(
  scores: readonly CriterionReview[],
  criteria: readonly Criterion[],
): number {
  return criteria.reduce((total, criterion) => {
    const found = scores.find((one) => one.criterion === criterion.id);

    return total + (found?.score ?? 0) * criterion.weightBps;
  }, 0);
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((one) => one.trim().length > 0) : [];
}
