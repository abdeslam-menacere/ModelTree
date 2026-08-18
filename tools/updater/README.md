# ModelTree updater (proposal-only)

A Python tool that **proposes** source-backed ModelTree updates. It reads sources,
extracts atomic claims with their evidence, reviews and validates them, and writes a
proposal bundle for a human to act on.

It has no path to publication by design: it never writes `web/src/data`, never creates a
branch, and never opens a pull request. `tests/test_proposal_only.py` enforces that.

The Astro site stays static. This tool runs separately and is not part of the web build.

## Quick start (offline, no credentials)

```bash
cd tools/updater
python -m venv .venv && .venv/Scripts/activate      # macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"

modeltree-updater creators
modeltree-updater run --creator contoso-ai --output ../../out/proposals
pytest
```

`python -m modeltree_updater ...` works identically without installing the console script.

The bundled fixtures under `fixtures/creators/` are synthetic (`example.com`, invented
creators). They exercise the pipeline; they are not ModelTree data and must never be
copied into `web/src/data`.

## Commands

| Command | Action |
|---|---|
| `run` | Run the workflow for one or more creators |
| `creators` | List creators available in the fixtures |
| `checkpoints` | List stored checkpoints for the creator workflow |
| `resume` | Finish a checkpointed run from a checkpoint id |

Useful `run` flags: `--creator` (repeatable), `--fixtures`, `--provider fixtures|foundry`,
`--output`, `--checkpoint-dir`, `--run-id`, `--timestamp`, and the budget flags below.
`resume` takes `--provider` too, and refuses a provider the checkpoint did not record.

Exit codes: `0` success, `2` usage or configuration error, `3` at least one creator failed.

## The workflow

Four Microsoft Agent Framework executors run in a chain, one creator at a time:

```
discover-sources → extract-claims → review-claims → bundle-proposal
```

Each executor charges the creator's budget, records typed failures instead of swallowing
them, and persists stage state, so a run can be checkpointed and resumed
(`--checkpoint-dir`, then `resume --checkpoint-id --provider <name>`). Checkpoint restore
is restricted to an explicit allow-list of ModelTree types (see `checkpoints.py`).

Provenance survives a resume: the provider descriptor is carried in the checkpointed
messages, and `resume` refuses to continue if the requested providers differ from the
ones that produced the checkpoint. A resumed run can never quietly finish against
fixtures while claiming otherwise.

Claims are judged twice, in two different ways. **Three semantic reviewers** each answer
a different question and vote; **deterministic gates** then decide whether the candidate
is admissible at all. See "Review and gates" below.
Disagreeing sources produce a `Conflict` — nothing picks a winner.

## Review and gates

The review stage runs a panel of three reviewers concurrently. They are three different
jobs, not three copies of one, and each is handed a deliberately different view of the
run so that agreement between two of them is corroboration rather than an echo:

| Lens | Question | What it sees |
|---|---|---|
| `provenance` | Does the cited source directly state this value? | the claim, its quoted evidence, and the sources those quotes came from |
| `consistency` | Does this sit consistently beside the run's other claims and the creator's lineage? | the claim and its sibling claims, quotes stripped |
| `editorial` | Is this the right field on the right entity, as the dataset means it? | the claim and the dataset's expectation for that field — no evidence at all |

A **2-of-3 majority** accepts or rejects a claim, and may approve a *newly discovered*
source (one whose origin the creator profile did not configure) for use in that run's
proposal. That last rule is deliberately permissive; it is the agreed policy and is
recorded here rather than quietly tightened. Abstentions never count as consent, so a
majority always needs two positive votes; a reviewer that fails or does not run abstains.
No majority means `needs-human-review`, never a guess.

**Deterministic gates are hard vetoes.** They are objective checks, and a failed gate
rejects the candidate however the panel voted — a unanimous accept loses to one failed
gate. There is no override, no `--skip`, and no severity dial; a gate passed or it did
not.

| Gate | Refuses |
|---|---|
| `url-safety` | non-HTTPS, credential-bearing, loopback/private, or bare-IP URLs |
| `typed-contract` | a candidate that is not the typed contract it claims to be |
| `schema-validation` | values the dataset's shape rules (mirrored from Zod) reject |
| `date-sanity` | imprecise or impossible dates, and evidence verified after the run |
| `reference-integrity` | evidence citing a source this run never read, or a mismatched URL |
| `lineage-invariants` | a claim outside its creator, or one id spanning two entity kinds |
| `source-approval` | a claim resting on a source this run did not approve |

Everything is preserved for audit: all three reviewer identities, lenses, verdicts,
rationales, and evidence references travel in the bundle, alongside the gate results and
an adjudication recording both what the panel decided (`semantic_decision`) and what
binds (`decision`, plus `vetoed_by`). A split panel becomes a visible
`reviewer-disagreement` conflict; disagreement is never averaged away or dropped.

## Budgets

Per creator, configurable by flag or environment variable:

| Flag | Environment variable | Default |
|---|---|---|
| `--max-pages` | `MODELTREE_UPDATER_MAX_PAGES` | 8 |
| `--max-tokens` | `MODELTREE_UPDATER_MAX_TOKENS` | 40000 |
| `--max-seconds` | `MODELTREE_UPDATER_MAX_SECONDS` | 120 |
| `--max-retries` | `MODELTREE_UPDATER_MAX_RETRIES` | 2 |

Exhausting a budget is an explicit outcome: the proposal records a `budget-exhausted`
failure, lists the exhausted resource in `budget.exhausted_by`, and reports `incomplete`
or `failed`. A budget must never look like "there was nothing to find".

## Microsoft Foundry (optional)

`--provider foundry` uses a Foundry model deployment for extraction and for all three
review lenses (one reviewer instance per lens, each with its own brief).
Authentication is keyless — `DefaultAzureCredential`, no API key is read or stored.

```bash
pip install -e ".[foundry]"
az login
export MODELTREE_FOUNDRY_ENDPOINT=https://<resource>.services.ai.azure.com/api/projects/<project>
export MODELTREE_FOUNDRY_DEPLOYMENT=<deployment-name>
```

The extra installs `agent-framework-foundry`, which supplies `FoundryChatClient`.
The Azure packages are imported lazily, so tests and fixture runs need neither the
packages nor a cloud login.

> **Status: not verified against a live deployment.** The Foundry path is covered by
> unit tests with a stub client that reproduces the real client's contract —
> `get_response(...)` returns an *awaitable*, message contents are sequences, and
> usage arrives as a mapping — but no ModelTree run has yet been executed against a
> real Foundry resource. Treat the first live run as a smoke test.

Provider methods are `async def` by contract (`providers/base.py`). A synchronous
provider is refused with a typed, non-retryable failure naming the method rather than
silently yielding an un-awaited coroutine that looks like an empty answer.

## Proposal shape

`report.json` plus one `<creator-id>.json` per creator, each carrying `sources`, `claims`
(with quoted evidence, source URL, content hash, and verification date), `verdicts` (three
per claim, one per lens), `adjudications` (the vote tally, the binding decision, and any
`vetoed_by` gates), `gates` (every deterministic result, passed or failed),
`source_approvals`, `validations`, `conflicts`, `budget`, `failures`, and `notes`.

## Layout

```
src/modeltree_updater/
  contracts.py     typed, immutable proposal contracts
  budgets.py       page/token/time/retry ledger
  validation.py    dataset shape rules mirrored from web/src/data/schema.ts
  gates.py         deterministic hard gates; no majority can override one
  review.py        the three lenses, 2-of-3 aggregation, and source approval
  conflicts.py     contradiction detection, never resolution
  workflow.py      Agent Framework executors and proposal bundling
  runner.py        one creator, then many, continuing past failures
  checkpoints.py   durable checkpoint storage and its type allow-list
  cli.py           local CLI
  safety.py        proposal-only output guard
  providers/       source, extraction, and review-panel boundaries
fixtures/creators/ synthetic creator fixtures for offline runs and CI
tests/             pytest suite; no network, no credentials
```

## Out of scope here

Human publication approval, creator-specific prompts or profiles, public usage or
recommendation UI, GitHub issue publication, scheduled execution, and production
deployment.
