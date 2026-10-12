import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Which files a deep review reads, when the repository is larger than one
 * request.
 *
 * In a fixed order, so two projects of the same size are cut the same way:
 * contracts, manifests and deployment first, because on a Stellar hackathon
 * that is where the substance is and it is the cheapest to fake in a README;
 * then the application source; then tests; then everything else. Whatever does
 * not fit is returned by name, so the review can say what the model did not see
 * rather than scoring as though it had seen everything.
 */

export interface SourceFile {
  path: string;
  size: number;
}

export interface Selection {
  read: string[];
  unread: string[];
}

/** Nothing a reviewer learns from, or something that is not text. */
const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "coverage",
  "__pycache__",
  ".venv",
]);

const TEXT = /\.(rs|sol|move|cairo|ts|tsx|js|jsx|mjs|cjs|py|go|java|kt|swift|rb|php|cs|c|h|cpp|hpp|toml|json|ya?ml|md|sql|sh|html|css|scss|vue|svelte|graphql|proto)$/i;
const LOCKFILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|bun\.lockb)$/i;

/** One file larger than this is generated or vendored more often than written. */
const FILE_LIMIT = 100_000;

export function rank(path: string): number {
  const lower = path.toLowerCase();

  if (/\.(rs|sol|move|cairo)$/.test(lower) || /(^|\/)contracts?\//.test(lower)) {
    return 0;
  }

  if (
    /(^|\/)(cargo\.toml|package\.json|go\.mod|pyproject\.toml|requirements\.txt|dockerfile|docker-compose[^/]*|vercel\.json|netlify\.toml|fly\.toml)$/.test(
      lower,
    ) ||
    lower.startsWith(".github/workflows/") ||
    /(^|\/)deploy/.test(lower)
  ) {
    return 1;
  }

  if (/(^|\/)(tests?|__tests__|spec)\//.test(lower) || /[._-](test|spec)\.[a-z]+$/.test(lower)) {
    return 3;
  }

  if (/(^|\/)(src|app|lib|pages|server|api|cmd)\//.test(lower)) {
    return 2;
  }

  return 4;
}

/** The order and the cut, without touching the disk. */
export function select(files: readonly SourceFile[], budget: number): Selection {
  const eligible = files.filter(
    (file) => TEXT.test(file.path) && !LOCKFILES.test(file.path) && file.size <= FILE_LIMIT,
  );

  const ordered = [...eligible].sort(
    (a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path),
  );

  const read: string[] = [];
  const unread: string[] = [];
  let spent = 0;

  for (const file of ordered) {
    if (spent + file.size <= budget) {
      read.push(file.path);
      spent += file.size;
    } else {
      unread.push(file.path);
    }
  }

  return { read, unread };
}

/** Every regular file under `root`, symlinks never followed. */
export async function walk(root: string): Promise<SourceFile[]> {
  const found: SourceFile[] = [];

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) {
          await visit(full);
        }
      } else if (entry.isFile()) {
        /* A symlink in a repository can point anywhere on this host. The
           archive is untrusted input, so only plain files are read. */
        const stat = await lstat(full);

        found.push({ path: relative(root, full), size: stat.size });
      }
    }
  }

  await visit(root);

  return found;
}

/** The selected files, each under its path, ready for the prompt. */
export async function readSelected(root: string, paths: readonly string[]): Promise<{ path: string; text: string }[]> {
  return Promise.all(
    paths.map(async (path) => ({ path, text: await readFile(join(root, path), "utf8") })),
  );
}
