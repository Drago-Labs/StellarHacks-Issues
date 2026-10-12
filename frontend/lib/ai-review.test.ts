import { describe, expect, it } from "vitest";

import { outOfHundred, ranked, shortlistOf, type AiReview } from "./ai-review";

function review(team: number, totalScore: number | null, stage: AiReview["stage"] = "quick"): AiReview {
  return {
    team,
    stage,
    status: totalScore === null ? "declined" : "reviewed",
    totalScore,
    confidence: totalScore === null ? null : "medium",
    recommendation: totalScore === null ? null : "PASS",
    report: null,
    strengths: [],
    weaknesses: [],
    missingInformation: [],
    unread: [],
    error: null,
    commitSha: null,
    model: "claude-opus-5-5",
    reviewedAt: "2026-09-29T00:00:00Z",
    criteria: [],
  };
}

describe("the AI ranking", () => {
  /** Two screens drawing the same ranking in different orders would have two
   * judges disagreeing about who was fifth for no reason at all. */
  it("orders by total and breaks ties by team, the same on every screen", () => {
    const order = ranked([review(4, 500_000), review(2, 700_000), review(1, 500_000)]).map((one) => one.team);

    expect(order).toEqual([2, 1, 4]);
  });

  /** A project the AI declined is one a judge has to read by hand. Ranking it
   * last among the scored would say the AI judged it worst, which it never did. */
  it("lists projects the AI could not score after the ranking, not inside it", () => {
    const order = ranked([review(3, null), review(1, 200_000), review(2, 900_000)]).map((one) => one.team);

    expect(order).toEqual([2, 1, 3]);
  });

  it("keeps the quick and the deep reviews apart", () => {
    expect(ranked([review(1, 100, "deep"), review(2, 200)]).map((one) => one.team)).toEqual([2]);
  });
});

describe("the shortlist", () => {
  it("is the top of the quick ranking, and marks nothing until a size is set", () => {
    const reviews = [review(1, 900_000), review(2, 800_000), review(3, 700_000)];

    expect(shortlistOf(reviews, null)).toEqual(new Set());
    expect(shortlistOf(reviews, 2)).toEqual(new Set([1, 2]));
  });

  /** Filling a shortlist of twenty with a declined project would pass it on
   * the strength of a score it does not have. */
  it("never passes a project the AI did not score", () => {
    expect(shortlistOf([review(1, 900_000), review(2, null)], 2)).toEqual(new Set([1]));
  });
});

describe("the total, as it is read", () => {
  /** The stored total keeps full precision; this is the only place it is
   * divided, and it keeps one decimal so close projects do not look equal. */
  it("reads a MAX_WEIGHTED_SCORE total out of a hundred to one decimal", () => {
    expect(outOfHundred(1_000_000)).toBe(100);
    expect(outOfHundred(642_500)).toBe(64.3);
  });
});
