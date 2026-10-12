import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { settings } from "./config.js";

/**
 * What a repository says about itself, as it stood when submissions closed.
 *
 * Everything is read at the commit that was current at the deadline, not at
 * the tip. A repository that grows after the close would otherwise be reviewed
 * as something that was never submitted, and the teams who stopped on time
 * would be compared against the ones who did not.
 */

export interface Repository {
  owner: string;
  name: string;
}

export interface Facts {
  commitSha: string;
  description: string | null;
  license: string | null;
  createdAt: string | null;
  languages: Record<string, number>;
  /** Every path in the tree, or as many as GitHub would list. */
  paths: string[];
  pathsTruncated: boolean;
  readme: string | null;
}

/** A github.com repository link, or nothing for anything else. */
export function repositoryOf(url: string | null): Repository | null {
  if (url === null) {
    return null;
  }

  const found = /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/?#].*)?$/i.exec(
    url.trim(),
  );

  return found === null ? null : { owner: found[1]!, name: found[2]! };
}

/** The commit that was the tip of the default branch at `before`. */
export async function commitAt(repo: Repository, before: Date): Promise<string> {
  const listed = (await ask(
    `/repos/${repo.owner}/${repo.name}/commits?until=${before.toISOString()}&per_page=1`,
  )) as { sha?: string }[];

  const sha = listed[0]?.sha;

  if (sha === undefined) {
    throw new Error("the repository has no commit from before submissions closed");
  }

  return sha;
}

/** The quick review's reading: metadata, never the source. */
export async function factsOf(repo: Repository, sha: string): Promise<Facts> {
  const base = `/repos/${repo.owner}/${repo.name}`;

  const [meta, languages, tree, readme] = await Promise.all([
    ask(base) as Promise<{ description?: string; license?: { spdx_id?: string }; created_at?: string }>,
    ask(`${base}/languages`) as Promise<Record<string, number>>,
    ask(`${base}/git/trees/${sha}?recursive=1`) as Promise<{
      tree?: { path: string; type: string }[];
      truncated?: boolean;
    }>,
    /* A repository without a README is an answer, not a failure. */
    raw(`${base}/readme?ref=${sha}`).catch(() => null),
  ]);

  return {
    commitSha: sha,
    description: meta.description ?? null,
    license: meta.license?.spdx_id ?? null,
    createdAt: meta.created_at ?? null,
    languages,
    paths: (tree.tree ?? []).filter((entry) => entry.type === "blob").map((entry) => entry.path),
    pathsTruncated: tree.truncated === true,
    readme,
  };
}

/**
 * The repository's files at `sha`, unpacked into a directory the caller removes.
 *
 * A tarball over the API rather than a clone: one request, no git on the host,
 * and no history, which a review has no use for.
 */
export async function unpack(repo: Repository, sha: string): Promise<{ root: string; done: () => Promise<void> }> {
  const answer = await fetchPaced(`https://api.github.com/repos/${repo.owner}/${repo.name}/tarball/${sha}`);

  if (!answer.ok) {
    throw new Error(`GitHub refused the tarball: ${answer.status}`);
  }

  /* Held in memory before it is written, so a repository carrying a dataset
     or a build directory is refused rather than allowed to take the process
     down. Nothing a review reads is anywhere near this size. */
  if (Number(answer.headers.get("content-length") ?? 0) > TARBALL_LIMIT) {
    throw new Error("the repository archive is too large to read");
  }

  const root = await mkdtemp(join(tmpdir(), "reviewer-"));
  const archive = join(root, "source.tar.gz");

  await writeFile(archive, Buffer.from(await answer.arrayBuffer()));
  await run("tar", ["-xzf", archive, "-C", root, "--strip-components=1"]);
  await rm(archive);

  return { root, done: () => rm(root, { recursive: true, force: true }) };
}

const TARBALL_LIMIT = 200 * 1024 * 1024;

async function ask(path: string): Promise<unknown> {
  const answer = await fetchPaced(`https://api.github.com${path}`);

  if (!answer.ok) {
    throw new Error(`GitHub answered ${answer.status} for ${path}`);
  }

  return answer.json();
}

async function raw(path: string): Promise<string> {
  const answer = await fetchPaced(`https://api.github.com${path}`, "application/vnd.github.raw");

  if (!answer.ok) {
    throw new Error(`GitHub answered ${answer.status} for ${path}`);
  }

  return answer.text();
}

/**
 * One request, waiting out the rate limit rather than failing the project.
 *
 * Five thousand an hour covers a thousand quick reviews exactly, so a large run
 * can reach the limit. When it does, the right thing is to wait for the window
 * to reset: a project skipped for a rate limit would be reviewed without its
 * repository and scored as though it had none.
 */
async function fetchPaced(url: string, accept = "application/vnd.github+json"): Promise<Response> {
  for (;;) {
    const answer = await fetch(url, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${settings.githubToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "stelhacks-reviewer",
      },
    });

    const remaining = answer.headers.get("x-ratelimit-remaining");

    if ((answer.status === 403 || answer.status === 429) && remaining === "0") {
      const reset = Number(answer.headers.get("x-ratelimit-reset") ?? 0) * 1000;
      const wait = Math.max(reset - Date.now(), 0) + 1_000;

      console.log(`GitHub rate limit reached, waiting ${Math.ceil(wait / 1000)}s`);
      await new Promise((wake) => setTimeout(wake, wait));
      continue;
    }

    return answer;
  }
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((done, failed) => {
    const child = spawn(command, args, { stdio: "ignore" });

    child.on("error", failed);
    child.on("exit", (code) =>
      code === 0 ? done() : failed(new Error(`${command} exited with ${code}`)),
    );
  });
}
