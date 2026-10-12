-- The AI pre review: a first read of every submission, for the judges.
--
-- `docs/ai-pre-review.md` is the design. What matters for the schema is that
-- none of this decides anything. An AI score does not enter the ranking, does
-- not move money and is not in the constitution, so it lives here, on the
-- cheap side of the authority rule, and nothing on chain knows it exists.
--
-- It is a third kind of table. `hackathons` and `projects` were typed by a
-- person and must never be dropped; `submissions`, `scores` and `results` are
-- derived from events and must be droppable. A review is neither: it has no
-- event behind it and can only be reproduced by paying to run the model again.
-- So the rebuild test must not drop these tables, and every row carries the
-- model and the moment that produced it, so a stale review is visible rather
-- than silently trusted.

-- What the team says they built ------------------------------------------------

-- The substance the quick review reads. Without it the model is grading a
-- marketing blurb.
--
-- A column rather than a field in the hashed `SubmissionMetadata`, which would
-- mean a contract change and a redeploy. The gap that opens is closed from two
-- sides: the project route refuses edits once submissions close, and the
-- reviewer records a digest of exactly what it sent. Folding it into the hash
-- is written down in the roadmap's deferred table.
alter table public.projects
  add column if not exists technical_overview text;

alter table public.projects
  drop constraint if exists projects_technical_overview_length;

alter table public.projects
  add constraint projects_technical_overview_length check (
    char_length(technical_overview) <= 2000
  );

comment on column public.projects.technical_overview is
  'How the project is built, in the team''s words. Read by the AI pre review; not part of the pinned digest.';

-- The shortlist ------------------------------------------------------------------

-- One number per hackathon, not one per judge, so every judge sees the same
-- first stage. The shortlist itself is not stored: it is the top that many of
-- the quick ranking, and a stored copy would be a second thing to go stale.
create table public.ai_review_settings (
  contract_id public.contract_address primary key
    references public.hackathons (contract_id) on delete cascade,
  shortlist_size integer,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),

  constraint ai_review_settings_shortlist_range check (
    shortlist_size is null or shortlist_size between 1 and 1000
  )
);

comment on table public.ai_review_settings is
  'How many of the quick ranking the judges marked as having passed the first stage. Marks, never removes.';

create trigger ai_review_settings_touch_updated_at
  before update on public.ai_review_settings
  for each row execute function public.touch_updated_at();

-- Runs ---------------------------------------------------------------------------

-- A request for the reviewer, and then its progress.
--
-- The panel writes a row and `backend/reviewer` picks it up. A deep run can take
-- hours, and without a row saying one is going the panel would show a half
-- written list as though it were finished.
create table public.ai_review_runs (
  id uuid primary key default gen_random_uuid(),
  contract_id public.contract_address not null
    references public.hackathons (contract_id) on delete cascade,
  stage text not null,
  -- Which teams. Null is every valid submission, which is what both "quick
  -- first" and "deep from the start" ask for; a list is a deep run over a
  -- shortlist or a hand picked selection.
  teams integer[],
  status text not null default 'queued',
  total integer not null default 0,
  done integer not null default 0,
  model text,
  batch_id text,
  error text,
  requested_by uuid references public.profiles (id) on delete set null,
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,

  constraint ai_review_runs_stage check (stage in ('quick', 'deep')),
  constraint ai_review_runs_status check (status in ('queued', 'running', 'finished', 'failed')),
  constraint ai_review_runs_progress check (done between 0 and greatest(total, 0))
);

comment on table public.ai_review_runs is
  'One AI pre review run: requested from the panel, carried out by backend/reviewer.';

-- One run in flight per hackathon. Two at once would race to write the same
-- rows, and a judge pressing the button twice is not asking for two runs.
create unique index ai_review_runs_one_in_flight
  on public.ai_review_runs (contract_id)
  where status in ('queued', 'running');

create index ai_review_runs_by_contract
  on public.ai_review_runs (contract_id, requested_at desc);

-- Reviews ------------------------------------------------------------------------

-- One review per project per stage. The stage is in the key so a project that
-- went through both keeps both, side by side, rather than the deep review
-- overwriting the quick one a judge may already have read.
create table public.ai_reviews (
  contract_id public.contract_address not null
    references public.hackathons (contract_id) on delete cascade,
  team_id integer not null,
  stage text not null,
  run_id uuid references public.ai_review_runs (id) on delete set null,
  -- `declined` is the model refusing to review, `failed` is anything else that
  -- stopped it. Both are rows rather than absences, so a project with no score
  -- says why instead of looking forgotten.
  status text not null,
  -- At `MAX_WEIGHTED_SCORE` scale, a hundred times ten thousand, and not
  -- divided to a percentage. Comparable to a judge's weighted total and
  -- rounded only by the interface, for the same reason the contract keeps it.
  total_score integer,
  confidence text,
  recommendation text,
  report text,
  strengths text[] not null default '{}',
  weaknesses text[] not null default '{}',
  missing_information text[] not null default '{}',
  -- What a deep review did not read, when the repository was larger than one
  -- request. A judge should know what the model did not see.
  unread text[] not null default '{}',
  error text,
  -- SHA-256 of exactly what was sent to the model. With no chain anchor it
  -- proves nothing to a stranger, but it makes "the model saw something else"
  -- a checkable claim rather than an unanswerable one.
  input_hash bytea,
  commit_sha text,
  model text not null,
  reviewed_at timestamptz not null default now(),

  primary key (contract_id, team_id, stage),
  constraint ai_reviews_stage check (stage in ('quick', 'deep')),
  constraint ai_reviews_status check (status in ('reviewed', 'declined', 'failed')),
  constraint ai_reviews_total_range check (total_score is null or total_score between 0 and 1000000),
  constraint ai_reviews_confidence check (confidence is null or confidence in ('low', 'medium', 'high')),
  constraint ai_reviews_recommendation check (
    recommendation is null or recommendation in ('PASS', 'MANUAL_REVIEW', 'LOW_PRIORITY')
  ),
  constraint ai_reviews_reviewed_has_score check (
    status <> 'reviewed' or (total_score is not null and recommendation is not null)
  )
);

comment on table public.ai_reviews is
  'Machine generated, advisory. Never part of the ranking. Not derived from events, so the rebuild must not drop it.';

-- Split out rather than kept as a jsonb blob, because that is what lets the
-- panel sort by one criterion.
create table public.ai_review_criteria (
  contract_id public.contract_address not null,
  team_id integer not null,
  stage text not null,
  -- The constitution's own `Symbol`, not its display title.
  criterion text not null,
  -- The contract's per criterion scale, `MAX_CRITERION_SCORE`.
  score smallint not null,
  reason text not null,
  evidence text[] not null default '{}',
  concerns text[] not null default '{}',

  primary key (contract_id, team_id, stage, criterion),
  foreign key (contract_id, team_id, stage)
    references public.ai_reviews (contract_id, team_id, stage) on delete cascade,
  constraint ai_review_criteria_score_range check (score between 0 and 100)
);

comment on table public.ai_review_criteria is
  'One criterion of one AI review, scored against the frozen rubric.';

-- Who may read it ----------------------------------------------------------------

-- The organizer, the judges and platform staff. Judges see it on purpose: the
-- point is to make hundreds of submissions reviewable, and that only works if
-- the people reviewing them can see it. Their independence is protected by the
-- panel keeping the machine's number visibly apart from theirs, not by hiding
-- it. Teams and the public never see it.
--
-- No client write policies. Runs and the shortlist are written by the
-- frontend's routes with the service role, after the same `is_judge` and
-- `is_organizer` checks, and reviews only by the reviewer.

alter table public.ai_review_settings enable row level security;
alter table public.ai_review_runs enable row level security;
alter table public.ai_reviews enable row level security;
alter table public.ai_review_criteria enable row level security;

grant select on public.ai_review_settings, public.ai_review_runs,
  public.ai_reviews, public.ai_review_criteria to authenticated;

grant select, insert, update, delete on public.ai_review_settings, public.ai_review_runs,
  public.ai_reviews, public.ai_review_criteria to service_role;

create policy "event staff read the shortlist"
  on public.ai_review_settings for select to authenticated
  using (public.is_organizer(contract_id) or public.is_judge(contract_id) or public.is_staff());

create policy "event staff read the runs"
  on public.ai_review_runs for select to authenticated
  using (public.is_organizer(contract_id) or public.is_judge(contract_id) or public.is_staff());

create policy "event staff read the reviews"
  on public.ai_reviews for select to authenticated
  using (public.is_organizer(contract_id) or public.is_judge(contract_id) or public.is_staff());

create policy "event staff read the criteria"
  on public.ai_review_criteria for select to authenticated
  using (public.is_organizer(contract_id) or public.is_judge(contract_id) or public.is_staff());
