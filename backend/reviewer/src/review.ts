import { rulesOf, type Criterion } from "./chain.js";
import { settings } from "./config.js";
import {
  alreadyReviewed,
  failed,
  finished,
  hackathonOf,
  progressed,
  projectsOf,
  started,
  write,
  type Run,
} from "./db.js";
import { commitAt, factsOf, repositoryOf, unpack } from "./github.js";
import { ended, outcomes, submit, type Request } from "./model.js";
import { inputHash, projectFor, systemFor, type Evidence, type Hackathon, type Project } from "./prompt.js";
import { readSelected, select, walk } from "./source.js";

/**
 * One run, from the queue to the last review written.
 *
 * In slices: each slice is read from GitHub, sent as one batch, and written
 * before the next is read. The panel's progress moves with every slice, and a
 * restart loses at most the one in flight.
 */
export async function carryOut(run: Run): Promise<void> {
  try {
    const [rules, hackathon, projects, done] = await Promise.all([
      rulesOf(run.contractId),
      hackathonOf(run.contractId),
      projectsOf(run.contractId, run.teams),
      alreadyReviewed(run),
    ]);

    const waiting = projects.filter((project) => !done.has(project.teamId));
    let count = projects.length - waiting.length;

    await started(run, projects.length, settings.model);
    console.log(`${run.contractId}: ${run.stage} review of ${waiting.length} of ${projects.length} projects`);

    const closedAt = new Date(rules.submissionClosesAt * 1000);

    for (let from = 0; from < waiting.length; from += settings.chunk) {
      const slice = waiting.slice(from, from + settings.chunk);
      const prepared = await Promise.all(
        slice.map((project) =>
          prepare(run, hackathon, project, rules.tracks.get(project.track) ?? [], closedAt),
        ),
      );

      const batchId = await submit(prepared.map((one) => one.request));
      await progressed(run, count, batchId);
      await ended(batchId);

      const byId = new Map(prepared.map((one) => [one.request.id, one]));
      const results = await outcomes(batchId, (id) => byId.get(id)?.request.criteria ?? []);

      for (const one of prepared) {
        await write({
          run,
          teamId: one.project.teamId,
          outcome: results.get(one.request.id) ?? { status: "failed", why: "the batch returned no result" },
          inputHash: inputHash(one.request.system, one.request.user),
          commitSha: one.commitSha,
          unread: one.unread,
          model: settings.model,
        });
      }

      count += slice.length;
      await progressed(run, count, null);
    }

    await finished(run);
    console.log(`${run.contractId}: ${run.stage} review finished`);
  } catch (thrown) {
    const why = thrown instanceof Error ? thrown.message : String(thrown);

    console.error(`${run.contractId}: ${run.stage} review failed: ${why}`);
    await failed(run, why);
  }
}

interface Prepared {
  project: Project;
  request: Request;
  commitSha: string | null;
  unread: string[];
}

/**
 * One project's request.
 *
 * A repository that cannot be read does not stop the project from being
 * reviewed. The model is told why it has no repository, and a missing one is
 * exactly what should lower its confidence.
 */
async function prepare(
  run: Run,
  hackathon: Hackathon,
  project: Project,
  criteria: readonly Criterion[],
  closedAt: Date,
): Promise<Prepared> {
  const evidence = await evidenceFor(run, project, closedAt);
  const system = systemFor(run.stage, hackathon, project.track, criteria);

  return {
    project,
    request: {
      id: String(project.teamId),
      stage: run.stage,
      system,
      user: projectFor(project, evidence),
      criteria,
    },
    commitSha: evidence.kind === "none" ? null : evidence.kind === "facts" ? evidence.facts.commitSha : evidence.commitSha,
    unread: evidence.kind === "source" ? evidence.unread : [],
  };
}

async function evidenceFor(run: Run, project: Project, closedAt: Date): Promise<Evidence> {
  const repo = repositoryOf(project.repositoryUrl);

  if (repo === null) {
    return {
      kind: "none",
      why: project.repositoryUrl === null ? "the team gave no repository" : "the repository is not a public GitHub link",
    };
  }

  try {
    const sha = await commitAt(repo, closedAt);

    if (run.stage === "quick") {
      return { kind: "facts", facts: await factsOf(repo, sha) };
    }

    const unpacked = await unpack(repo, sha);

    try {
      const chosen = select(await walk(unpacked.root), settings.deepChars);

      return {
        kind: "source",
        commitSha: sha,
        files: await readSelected(unpacked.root, chosen.read),
        unread: chosen.unread,
      };
    } finally {
      await unpacked.done();
    }
  } catch (thrown) {
    return {
      kind: "none",
      why: `the repository could not be read (${thrown instanceof Error ? thrown.message : String(thrown)})`,
    };
  }
}
