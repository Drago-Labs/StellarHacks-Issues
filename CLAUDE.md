# Working on StelHacks

An end to end verifiable hackathon platform on Stellar and Soroban. The product
requirements are in `StelHacks-PRD.md` (Turkish). Where the code and the PRD
disagree, `docs/decisions.md` says which one governs and why.

## Where things live

Four layers, and each one owns its directory. Work belongs to the layer that
uses it, not to whichever directory is convenient.

| Path | Layer |
|---|---|
| `contracts/` | Soroban contracts, Rust |
| `backend/` | `supabase/` schema and role tests, and the long lived services: `indexer/`, `sealer/`, `clock/`, `reviewer/` |
| `frontend/` | The web application, from M15 |
| `sdk/` | TypeScript, shared by backend and frontend |
| `fixtures/` | Test vectors read by Rust and TypeScript together |

`sdk/` and `fixtures/` sit outside the three layers because they belong to
neither. Everything else does: a Supabase migration goes under `backend/`, not
at the root, even though the CLI would happily create it there.

Each layer runs its commands from its own directory. `supabase` looks for
`supabase/` beside the working directory, so it has to be run from `backend/`.

## Commands

Contract commands run from `contracts/`.

```bash
cargo test                                # unit and contract tests
cargo fmt --all                           # before every commit
cargo clippy --all-targets -- -D warnings # CI fails on any warning
stellar contract build                    # wasm artifacts
```

Run all three of format, lint and test before committing. CI runs them plus a
reproducible build check that compiles the wasm twice from clean and compares
the hashes.

The SDK runs from `sdk/`, and its suite reads the built wasm, so
`stellar contract build` has to have run first.

```bash
npm test                                  # digests, merkle, signing, events, ranking
npm run check                             # types, including the examples
npm run bindings                          # regenerate from the wasm
```

The database runs from `backend/`. There is no local stack: migrations go
straight to the linked project and the role tests run against it over HTTP.

```bash
supabase db push                          # apply migrations to the linked project
cd supabase/tests && npm test             # what each role can actually reach
```

## The one environment gotcha

Homebrew's `rust` formula used to shadow rustup and only knows the host target,
which breaks every wasm build. It has been removed and `~/.zshrc` puts rustup's
shims first. If `which cargo` does not print a path under
`/opt/homebrew/opt/rustup/bin`, that regressed.

## Architecture

Two contracts, deliberately few.

**`hackathon-core`** is the authority. It holds the locked constitution, runs
the lifecycle, records submissions, scorecards and ballots, computes the
ranking, and tells the vault when to pay.

**`prize-vault`** holds the money. It takes deposits from anyone at any phase
and pays out only when the core instance it was bound to at creation says so.
There is no administrator and no withdrawal function.

Inside the core, the module layout follows the shape of the problem:

| Module | Holds |
|---|---|
| `constitution/` | Everything that decides an outcome, all of it hashed and frozen at the lock |
| `contract.rs` | Every entry point |
| `state.rs` | What changes while the event runs, kept outside the frozen rules |
| `storage.rs` | Typed keys and TTL; no raw symbol keys anywhere |
| `merkle.rs` | Sealed scorecards and ballots, with domain separated leaves |
| `results.rs` | Final scores, the tie break chain, placements |
| `hashing.rs` | Every digest, each over a domain tagged payload |
| `test/` | Tests driven through the generated client |

## Conventions that are not obvious

**Tests read as sentences.** `nobody_but_the_bound_hackathon_can_move_money_out`
rather than `test_pay_auth`. A doc comment above a test says what would go wrong
without it, not what the test does.

**Comments explain the why.** The code already says what it does. A comment
earns its place by explaining a decision a reader would otherwise second guess.

**Nothing is written before it has a caller.** Storage accessors, helper
functions and enum variants land in the same commit as the code that uses them.
Two `#![allow(dead_code)]` were added during this build and both were removed
within a milestone.

**Scores keep full precision.** Weighted totals are held at
`MAX_WEIGHTED_SCORE` scale rather than divided to a percentage, because the
division would happen twice and each one drops a fraction that decides close
results. Only the interface rounds.

**Deferred work is written down.** `docs/roadmap.md` has a "Deferred, not
dropped" table. Anything postponed goes there with what is missing and what it
blocks, so nothing quietly becomes a gap nobody agreed to.

## Where things stand

`docs/roadmap.md` is the live plan and its "Current position" section is kept
up to date. `docs/roadmap.md` is gitignored on purpose; it lives on disk only.

The contract layer is complete through settlement and the discretion paths: a
hackathon runs from creation to paying winners, the vault empties exactly when
it closes, and every use of organizer discretion (deadline extension,
disqualification with an appeal, cancellation) is bounded by something announced
before the lock and leaves a reason hash behind.

M10 is done too: the signature checks, the phase machine and fund conservation
each have their own suite, coverage sits above ninety percent on every file, and
both contracts are on testnet with their addresses and wasm hashes in
`docs/deployments.md`.

M11 is done: `sdk/` holds the TypeScript SDK, which hashes, signs, decodes
events and rederives a ranking from chain data alone. M12, Supabase, is next and
is the first milestone needing an account rather than only code.

## The cross language contract

`fixtures/` holds the digests the contract and the SDK both have to reach, one
value per file. `contracts/hackathon-core/src/test/interop.rs` proves the
contract still produces them; `sdk/test/` proves TypeScript reaches them from
independently written inputs. Changing one breaks both suites on purpose.

Two rules follow from that. The SDK never hand writes an XDR layout: encoding
goes through the contract spec generated from the wasm. And the SDK suite reads
the built wasm, so `stellar contract build` has to have run before `npm test`.

An error enum over fifty cases makes the whole contract interface unparseable
outside Rust, silently. `sdk/test/spec.test.ts` is what catches it.
