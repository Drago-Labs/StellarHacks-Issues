# Reviewer

Reads every submission once, so judges start from an ordered list with a
reason for every number in it. The design is in `docs/ai-pre-review.md`.

```bash
npx tsx src/index.ts            # keep watching the review queue
npx tsx src/index.ts --once     # carry out what is queued, then stop
npm test                        # schema, total, answer handling, source order
```

## What it may do, and what it cannot

Nothing it writes decides anything. An AI score does not enter the ranking, does
not move money and never removes a project. It holds no Stellar key at all: the
constitution is read by simulation, and the only writes are to the review tables
and to the run it is carrying out.

## The shape of a run

A judge or an organizer asks for a run from the panel, which writes a row to
`ai_review_runs`. This service picks up the oldest queued or interrupted run and:

1. reads the rubric from the frozen constitution and the valid submissions from
   `submissions`;
2. pins each repository to the commit that was current when submissions closed;
3. **quick**: reads the README, file tree, languages and metadata over the API;
   **deep**: downloads the tarball at that commit and reads the source, in a
   fixed order (contracts, manifests and deployment, application code, tests,
   the rest), listing whatever did not fit;
4. sends each slice as one batch, with the shared part of the prompt cached;
5. validates every answer against the rubric and writes it, with a SHA-256 of
   exactly what was sent.

A slice at a time, so the panel's progress moves during a long run and a restart
loses at most the slice in flight. A run left `running` is picked up again and
the projects it already wrote are skipped.

## What is refused even when the model answers

- a criterion the rubric does not have, or one it has and the answer skipped;
- a score outside 0 to 100;
- a score above 50 with no evidence quoted, because a well written description
  must not by itself earn a high score.

A refused answer, a refusal by the model, and a repository that could not be
read are all stored as rows with a reason, never as silence.
