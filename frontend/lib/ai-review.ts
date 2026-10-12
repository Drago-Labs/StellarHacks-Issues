/**
 * The AI pre review, as the panel reads it.
 *
 * Types and plain arithmetic only, so both the route and the browser can import
 * it. Nothing here reaches a database: the rows come through `/api/ai-review`,
 * which checks who is asking against the chain before reading them.
 */

export type Stage = "quick" | "deep";

export type Recommendation = "PASS" | "MANUAL_REVIEW" | "LOW_PRIORITY";

export interface AiCriterion {
  criterion: string;
  /** Zero to a hundred, the contract's per criterion scale. */
  score: number;
  reason: string;
  evidence: string[];
  concerns: string[];
}

export interface AiReview {
  team: number;
  stage: Stage;
  status: "reviewed" | "declined" | "failed";
  /** At `MAX_WEIGHTED_SCORE` scale. Divided only when it is shown. */
  totalScore: number | null;
  confidence: "low" | "medium" | "high" | null;
  recommendation: Recommendation | null;
  report: string | null;
  strengths: string[];
  weaknesses: string[];
  missingInformation: string[];
  unread: string[];
  error: string | null;
  commitSha: string | null;
  model: string;
  reviewedAt: string;
  criteria: AiCriterion[];
}

export interface AiRun {
  id: string;
  stage: Stage;
  /** Null when the run covered every valid submission. */
  teams: number[] | null;
  status: "queued" | "running" | "finished" | "failed";
  total: number;
  done: number;
  error: string | null;
  requestedAt: string;
  finishedAt: string | null;
}

export type AiPanel =
  | { access: "signed-out" }
  | { access: "denied" }
  | {
      access: "granted";
      shortlistSize: number | null;
      runs: AiRun[];
      reviews: AiReview[];
    };

/** The contract's scale for a whole card: a hundred times ten thousand. */
const MAX_WEIGHTED_SCORE = 100 * 10_000;

/**
 * A weighted total out of a hundred, for reading only.
 *
 * The one place this total is divided, and it is the interface: the stored
 * number keeps full precision, like a judge's.
 */
export function outOfHundred(total: number): number {
  return Math.round((total / MAX_WEIGHTED_SCORE) * 1000) / 10;
}

/**
 * The quick reviews in ranking order.
 *
 * Reviewed projects by total, highest first. Ties are broken by team number so
 * the order is the same on every screen. Projects with no score follow, because
 * a refusal or an unreadable answer is something a judge has to read by hand,
 * not something at the bottom of a ranking it was never placed in.
 */
export function ranked(reviews: readonly AiReview[], stage: Stage = "quick"): AiReview[] {
  return reviews
    .filter((review) => review.stage === stage)
    .sort((a, b) => {
      if (a.totalScore === null || b.totalScore === null) {
        return a.totalScore === null ? (b.totalScore === null ? a.team - b.team : 1) : -1;
      }

      return b.totalScore - a.totalScore || a.team - b.team;
    });
}

/** The teams that passed the first stage: the top `size` of the quick ranking. */
export function shortlistOf(reviews: readonly AiReview[], size: number | null): Set<number> {
  if (size === null) {
    return new Set();
  }

  return new Set(
    ranked(reviews)
      .filter((review) => review.totalScore !== null)
      .slice(0, size)
      .map((review) => review.team),
  );
}
