# AI pre review

A first pass over every submission, cheap enough to run on hundreds of them,
that leaves the judges with an ordered list and a reason for every number in
it. The AI never eliminates a project and never picks a winner; it makes three
or four hundred submissions reviewable, and every decision stays with the
judges.

It runs in two stages:

- **Quick review** reads what the team wrote and what the repository says
  about itself: description, Technical Overview, README, file tree and
  metadata. Every submission gets a score, a short report and a place in an
  initial ranking.
- **Deep review** opens the repository itself: code structure, architecture,
  smart contract implementation, tests, dependencies and deployment details.

Source: `StelHacks_AI_Pre_Review_Teknik_Plani.pdf`. This file is what governs
the build where the two differ, for the same reason `docs/decisions.md` exists:
the plan was written against the product, not against the code, and three of
its requirements land differently once the authority rule is taken seriously.

---

## Is it buildable here

Yes, and it is the rare feature that fits without bending anything. The reason
is that an AI score decides nothing. It does not enter the ranking, it does not
move money, and it is not part of the frozen rules. That puts it entirely on
the Supabase side of the authority rule, which is the cheap side.

Three things are needed that do not exist yet, in rising order of cost:

| Needed | Cost |
|---|---|
| A place to keep the result and a toggle to turn it on | One migration |
| A service that fetches, prompts and writes | A fourth long lived service under `backend/` |
| A field where a team describes what they actually built | A schema column, and a question about hashing |

Only the third one has a real decision in it, and it is in
[Technical Overview](#technical-overview-and-what-it-costs-to-hash-it) below.
Everything else is assembly.

## The one place the plan and the product disagree

Section 9 of the plan says the organizer may move "for example the top hundred
projects" to a second stage based on AI score. Read literally that is not a
sorting aid, it is a cut, and a cut decides who can win. The platform already
has a name for that: organizer discretion, and its rule is that every use of it
has to be bounded by something announced before the lock and has to leave a
reason hash behind.

So the line is drawn at visibility:

**A shortlist.** The judges enter a number, say twenty, and the top twenty of
the AI ranking are marked as having passed the first stage. From there they
read those twenty by hand, send them to deep review, or both. The other
projects are not removed: they stay in the list, unmarked, and any judge can
still open and score any of them. Nothing about the outcome changed, so
nothing goes on chain and nothing goes in the constitution.

**A cut.** Projects below a threshold are removed from what judges can score.
The contract has exactly one way to do that, `invalidate_submission`, and it
belongs to the organizer, in the `Screening` phase, before any scorecard
exists. A cut would have to run through that path, with the AI output as the
organizer's stated reason rather than as an automatic trigger. A shortlist that
judges vote into a cut would be a new contract step, with a bound announced
before the lock, a reason hash and new fixtures.

v1 is the shortlist only. The data model does not change between the two,
which is what makes deferring the cut safe.

## What the AI is told, and by whom

The plan is right that the criteria must come from the hackathon rather than
from a hardcoded list, and it is right for a sharper reason than it gives. The
criteria and their weights are already in the constitution, hashed and frozen
before anyone submitted. They are a `Vec<Criterion>` per track, each one a
`Symbol` and a `weight_bps` summing to ten thousand, and `frontend/lib/rubric.ts`
already reads them off the chain.

So the model is scored against the same rubric a judge is scored against, read
from the same place, and the example table in the plan (Code Quality 20,
Architecture 20, and so on) is an example rather than a default. Two
consequences worth writing down:

- The criterion identifier is a `Symbol`: lowercase, no spaces. `lib/words.ts`
  already holds the two spellings apart. The prompt gets `titleOf(id)`, the
  stored row gets the symbol.
- Per criterion scores use the contract's own scale, `MAX_CRITERION_SCORE`,
  which is zero to one hundred. Weighting by `weight_bps` then gives a total
  directly comparable to a judge's weighted total, and the arithmetic already
  exists in the SDK. Writing a second implementation of it in the reviewer
  would be the third place that rounds, and the PRD's whole complaint about
  rounding is that each one drops a fraction that decides close results.

## Technical Overview, and what it costs to hash it

The plan wants a mandatory two thousand character field where a team describes
its architecture. That field is the substance of the whole feature: without it
the model is grading a marketing blurb.

It is built as optional. Whether a submission field is compulsory is a rule
the constitution sets per event (`submission_requirements`), and a field the
product demands of every event whether or not it uses the AI review would be a
rule nobody locked. A project that leaves it empty is still reviewed, and the
missing overview is exactly what lowers the model's confidence.

The question is where it lives. A project's write up exists twice today. The
hashed copy is `SubmissionMetadata` in the contract, whose digest went on chain
when the team submitted. The readable copy is the `projects` row in Supabase.
Adding a field to the first one means a contract change, new
`fixtures/submission.sha256` and `submission.xdr.hex`, regenerated bindings, a
redeploy and a `docs/deployments.md` entry. Adding it to the second one is a
column.

The column is the right call for v1, with two conditions that close the hole it
would otherwise open:

1. **Project edits stop when submissions close.** A field the model reads after
   the deadline must not be editable after the deadline. The phase is already
   on chain and `app/api/project/route.ts` already asks the contract who the
   team is; refusing the write past the close is the same question asked once
   more.
2. **The reviewer records a digest of exactly what it sent.** One `input_hash`
   column over the concatenated prompt inputs. It proves nothing to a stranger,
   because there is no chain anchor, but it turns "the model saw something
   else" from an unanswerable accusation into a checkable one.

Folding `technical_overview` into the hashed `SubmissionMetadata` belongs in
the "Deferred, not dropped" table in `docs/roadmap.md`: it is the honest
version, the diff is small, and the only thing blocking it is that a redeploy
is expensive once an event is live.

## Where the data lives

A third kind of table appears here, and it is worth naming because the rebuild
rule is written in terms of only two.

`hackathons` and `projects` were typed by a person: they cannot be regenerated
and must never be dropped. `submissions`, `scores` and `results` are derived
from events: they must be droppable and rebuildable by replaying the ledger.
An AI review is neither. It is machine generated, it has no event behind it,
and it is reproducible only by paying to run the model again. So it sits with
the first group for the purposes of the M13 rebuild test — the test must not
drop it — while carrying its own `model` and `reviewed_at` so a stale row is
visible rather than silently trusted.

```
public.ai_review_settings      one row per hackathon: shortlist_size
public.ai_review_runs          one row per run: stage, teams, status, started_at, finished_at
public.ai_reviews              one row per (contract_id, team_id, stage)
public.ai_review_criteria      one row per (contract_id, team_id, stage, criterion)
```

`stage` is `quick` or `deep`, and it is part of the key, so a project that went
through both keeps both reviews side by side rather than the deep one
overwriting the quick one. `ai_reviews` holds `total_score` at
`MAX_WEIGHTED_SCORE` precision, `confidence`, `recommendation`, `strengths`,
`weaknesses`, `missing_information`, `input_hash`, `commit_sha`, `model`,
`reviewed_at`. Splitting the per criterion rows out rather than keeping a
`jsonb` blob is what lets the panel sort by one criterion, which the plan asks
for in section 8.

`shortlist_size` is the number the judges entered. It is one value per
hackathon, not one per judge, so every judge sees the same shortlist and the
panel does not quietly show two people two different first stages. The
shortlist itself is not stored: it is the top `shortlist_size` rows of the
quick ranking, and storing it would give it a second place to go stale.

`ai_review_runs` exists because a deep run can take hours, and the panel has to
say that one is in progress rather than show a half written list as if it were
finished.

Read access belongs to the organizer, the platform staff and the judges,
through `organizer_grants` and `public.is_judge`, the same checks the
restricted gallery already uses. Judges see the AI output on purpose: the
point is to make hundreds of submissions reviewable, and that only works if
the people reviewing them can see it. What protects their independence is the
interface keeping the two numbers visibly apart (see
[The panel](#the-panel)), not hiding one of them. Teams and the public do not
see it.

## The service

`backend/reviewer/`, beside `indexer/`, `sealer/` and `clock/`. Not a Next.js
route: it runs over hundreds of projects, holds a model key and a GitHub token,
and takes minutes for a quick run and possibly hours for a deep one.

A run is started from the panel once submissions close, in one of two modes:

**Quick first.** Stage one over every valid submission. The judges then enter
a shortlist size, and from the shortlist they can read projects by hand, send
some or all of them to deep review, or both.

**Deep from the start.** Stage two over every valid submission directly,
skipping the quick pass. Choosing it opens a confirmation panel that says
plainly the run can take a long time, possibly hours, and that the list fills
in as projects finish. The panel talks about time, never about tokens or
money: cost is the platform's concern, not the judge's.

```
run started (quick | deep, set of teams)
  → for each team
      read project row and rubric
      quick: fetch repository facts over the API
      deep:  clone the repository at the pinned commit and read the source
      build the prompt
  → batch to the model
  → write ai_reviews + ai_review_criteria for that stage
  → mark the run finished
```

**Repository facts.** README, file tree, language breakdown, commit count and
basic metadata, over the public GitHub API. Two notes the plan does not make.
Unauthenticated the limit is sixty requests an hour, which four calls per
project exhausts after fifteen projects; a token raises it to five thousand and
is not optional. And the commit SHA at the moment of the deadline should be
recorded and read, so that a repository which grows after the close is still
reviewed as it stood when it was submitted.

**Quick review does not clone.** It stays on the API so that running it over
every submission stays cheap. The source is deep review's job.

**Deep review reads, it does not run.** It clones the repository at the pinned
commit and gives the model the code structure, the smart contracts, the
tests, the dependency manifests and the deployment configuration. Nothing is
executed: running untrusted code needs a sandbox, and that is its own stage.
A repository too large for one request is cut down in a fixed order (contracts
and entry points first, then tests, then the rest) and whatever was left out
is listed in the review, so a judge knows what the model did not see.

## The model call

`claude-opus-5-5`, structured output, batched.

```ts
const response = await client.messages.parse({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  system: [{ type: "text", text: sharedPrefix, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: perProject }],
  output_config: { format: zodOutputFormat(ReviewSchema) },
});
```

Four things shape this beyond the plan's own requirements:

**Structured output rather than prompted JSON.** `output_config.format` with a
schema is a guarantee, not a request. The schema is built from the hackathon's
own criteria, so a model that invents a criterion or drops one fails to
validate rather than writing a plausible wrong number.

**The shared prefix is cached.** The hackathon description, the track
description, the rubric and the instructions are identical across every project
in one run, and only the project's own text differs. Put the fixed part in the
system prompt behind a cache breakpoint and the per project cost collapses to
the varying suffix. The minimum cacheable prefix on this model is 512 tokens,
which a real rubric clears easily.

**The Batches API.** The run happens after the deadline and nobody is waiting on
it, which is exactly the shape batching is for: half price, results within the
hour. One caveat — the server side `fallbacks` parameter is rejected on
batches, so a refusal has to be handled by re-sending that single project
normally rather than by a fallback chain.

**`stop_reason` is checked before `content`.** This model's classifiers can
decline a request and return a successful response with an empty body. Reading
`content[0]` unconditionally turns that into a crash in the middle of a three
hundred project run.

Rough cost for three hundred projects on a quick run, with roughly twelve
thousand input tokens and fifteen hundred output tokens each: about thirty
dollars at list price, about fifteen batched, and materially less once the
cached prefix is doing its job. A deep run sends the source, so the input per
project grows by roughly an order of magnitude, and so does the bill. Deep
from the start over a thousand projects is the expensive case. None of this is
shown to the user; it is what the platform has to plan for, and whether it
needs a line item in the pricing tiers is a decision to make once a real deep
run has been measured.

## What the model is asked for

Per criterion: `score`, `maxScore`, `reason`, `evidence`, `concerns`.
Overall: `totalScore`, `confidence`, `recommendation` in
`PASS | MANUAL_REVIEW | LOW_PRIORITY`, plus `strengths`, `weaknesses` and
`missingInformation`.

The plan's instruction that a well written description must not by itself earn a
high score is the part that makes the whole thing worth building, and it is
enforceable rather than hopeful. `evidence` is required per criterion and must
quote the overview, the README or the repository metadata. A claim with nothing
to point at goes in `missingInformation` and cannot raise the score. An empty
`evidence` array with a high score is a schema level contradiction and is worth
rejecting in the reviewer rather than storing.

`confidence` is the honest signal when the inputs are thin. A project with no
repository and a hundred word description should come back with low confidence
and `MANUAL_REVIEW`, not with a confident bad score.

## The panel

On the judge's own screen, `app/judge/[contract]`, as one of two ways to work
through the entries, chosen side by side at the top:

- **Manual review** is the scoresheets as they were: every project, scored by
  hand against the rubric.
- **AI review** is this feature. It opens in Screening, so a judge can have a
  ranking in hand before scoring starts, and stays open through Judging.

Inside the AI review, before anything has been read, the two run modes are the
two choices: **quick first** (recommended) and **deep from the start**, which
goes through the confirmation panel described in [The service](#the-service).

Once there are results, the list shows every reviewed project with its AI
score, recommendation and confidence, sortable by total or by any single
criterion. A project's report shows, per criterion, the score on the judge's
own scale (points out of the criterion's weight), the reason, the evidence
quoted back and any concerns, with the quick and the deep review switchable
when both exist. Above the list:

- **Shortlist size**, a number. The top that many of the quick ranking are
  marked as having passed the first stage; the rest stay in the list,
  unmarked and still scoreable.
- **Score the shortlist by hand**, which switches to manual review showing
  only those projects, and **deep review the shortlist**. Both also work on any
  selection ticked in the list, and a single project's **Score** button does
  the same for one.
- **Run status** while a run is going: how many projects are done out of how
  many, and that it may take a while. No token counts, no cost.

Reading it needs a signed in account linked to a wallet the rules name as a
judge, or the organizer's. The route asks the chain, not the indexer's copy, so
a judge is not refused while the indexer catches up.

Two things are shown that the plan does not ask for and the product needs.
Which model and when, because an AI score is only as current as the run that
produced it. And the AI score and the human judge score side by side and
visibly distinct — the plan's section 9 says to keep them apart in the data
model and in the interface, and the interface half is the one that actually
prevents somebody reading a machine's number as a judge's.

## Order of work

1. Migration: four tables, the `technical_overview` column, and the read
   policies. Run by hand, as always.
2. Freeze project edits at submission close.
3. `backend/reviewer/` quick stage: GitHub fetch, prompt build, batch call,
   write.
4. `backend/reviewer/` deep stage: clone at the pinned commit, source
   selection, the same call and write.
5. Submission form: the Technical Overview field and its guidance text.
6. The judge's screen: manual or AI review, and inside the AI review the list,
   detail view, the two run modes with the long run confirmation, shortlist
   size and run status.

There is no create form toggle. The judges choose manual or AI review
themselves, so an event does not have to decide before the lock whether its
judges will want help.

One through four can be built and run against a finished hackathon before any
interface exists, which is the cheapest way to find out whether the reviews are
any good before spending a milestone on showing them.

## Deferred, not dropped

| Deferred | What is missing | What it blocks |
|---|---|---|
| `technical_overview` in the hashed `SubmissionMetadata` | Contract field, fixtures, bindings, redeploy | A stranger being able to check the model read what the team wrote |
| Private repository access | GitHub authorization flow | Teams who cannot open their repository before judging |
| Sandbox execution | Isolation, resource limits, a runner | Running the code rather than only reading it |
| The organizer's view in `app/manage/[contract]` | A tab reusing the judge's panel | An organizer reading the reviews without a judge's screen. The route and the policies already let them |
| AI assisted screening as a real cut | Announced pre lock bound, reason hash, appeal path | Using the shortlist to remove projects rather than to sort them |
