/**
 * Every long lived service, under one command.
 *
 * The frontend is one `npm run dev` and the backend was several, in several
 * places, one of which needed an argument nobody remembers. That asymmetry is
 * the whole reason this file exists: a stack you have to be told how to start
 * is a stack that gets started wrong.
 *
 * It supervises rather than daemonises. Output stays interleaved on the
 * terminal with a tag per line so a failure says which part failed, and killing
 * this kills them all, because orphaned services are worse than none.
 *
 *   cd backend && npm run dev
 */

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const root = new URL(".", import.meta.url).pathname;

/**
 * What the environment file says, without loading it into this process.
 *
 * Each service reads `.env.local` itself through dotenv. This only needs to
 * look, and looking is how a service that cannot run yet is left out rather
 * than started and watched to fail.
 */
function setting(name) {
  if (process.env[name] !== undefined) {
    return process.env[name];
  }

  try {
    const found = readFileSync(`${root}.env.local`, "utf8")
      .split("\n")
      .find((line) => line.trimStart().startsWith(`${name}=`));

    return found?.slice(found.indexOf("=") + 1).trim().replace(/^"|"$/g, "") ?? null;
  } catch {
    return null;
  }
}

function set(name) {
  const value = setting(name);

  return value !== null && value !== "";
}

/**
 * Which hackathon the indexer follows, when somebody wants only one.
 *
 * It used to be required, because the indexer took one contract and there was
 * no way to name several. It follows every hackathon in the database now, so
 * this narrows rather than enables: set it while working on a single event and
 * leave it empty the rest of the time.
 */
const contract = setting("WATCH_CONTRACT");
const only = contract !== null && contract !== "";

console.log(
  only
    ? `indexer: following ${contract} only, because WATCH_CONTRACT names it`
    : "indexer: following every hackathon in the database",
);

const services = [
  {
    name: "indexer",
    args: only
      ? ["start", "--prefix", "indexer", "--", contract]
      : ["start", "--prefix", "indexer"],
  },
  { name: "sealer", args: ["start", "--prefix", "sealer"] },
];

/*
  The clock is the one service the stack runs without.

  It needs a funded account, and a checkout that has not been given one should
  still start. What is lost is phases moving on by themselves; deadlines are
  still enforced by the contract, and the manage page still offers the call to
  anybody who wants to send it. Starting it without a key would take the whole
  stack down on the first lap instead, which is a far worse trade for a part
  that is a convenience.
*/
if (set("CLOCK_SECRET_KEY")) {
  services.push({ name: "clock", args: ["start", "--prefix", "clock"] });
} else {
  console.log("clock: not started, CLOCK_SECRET_KEY is not set. Phases wait to be moved by hand.");
}

/*
  The reviewer is optional in the same way.

  It needs a model key and a GitHub token, and an event that never asks for an
  AI review loses nothing without it. A run somebody requests while it is not
  running waits in the queue and starts when it does.
*/
if (set("GITHUB_TOKEN") && (set("ANTHROPIC_API_KEY") || set("ANTHROPIC_AUTH_TOKEN"))) {
  services.push({ name: "reviewer", args: ["start", "--prefix", "reviewer"] });
} else {
  console.log("reviewer: not started, GITHUB_TOKEN or ANTHROPIC_API_KEY is not set. Requested reviews wait in the queue.");
}

const running = services.map(({ name, args }) => {
  const child = spawn("npm", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

  const tag = (stream) => (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim().length > 0) {
        stream.write(`${name.padEnd(8)} │ ${line}\n`);
      }
    }
  };

  child.stdout.on("data", tag(process.stdout));
  child.stderr.on("data", tag(process.stderr));

  /* One dead service is a broken stack, not a degraded one: a page that reads a
     phase from a database nothing is writing is worse than a page that is
     plainly down. So the first exit takes the rest with it. */
  child.on("exit", (code) => {
    console.error(`\n${name} exited (${code}). Stopping the rest.`);
    stop();
    process.exit(code ?? 1);
  });

  return child;
});

function stop() {
  for (const child of running) {
    child.kill("SIGTERM");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    stop();
    process.exit(0);
  });
}

console.log("sealer on its configured port\n");
