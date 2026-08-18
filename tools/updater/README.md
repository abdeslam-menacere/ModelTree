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

Claims accepted by the reviewer are re-checked against the dataset's shape rules; a claim
the dataset would reject is downgraded to `needs-human-review` rather than accepted.
Disagreeing sources produce a `Conflict` — nothing picks a winner.

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

`--provider foundry` uses a Foundry model deployment for extraction and review.
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
(with quoted evidence, source URL, content hash, and verification date), `verdicts`,
`validations`, `conflicts`, `budget`, `failures`, and `notes`.

## Layout

```
src/modeltree_updater/
  contracts.py     typed, immutable proposal contracts
  budgets.py       page/token/time/retry ledger
  validation.py    dataset shape rules mirrored from web/src/data/schema.ts
  conflicts.py     contradiction detection, never resolution
  workflow.py      Agent Framework executors and proposal bundling
  runner.py        one creator, then many, continuing past failures
  checkpoints.py   durable checkpoint storage and its type allow-list
  cli.py           local CLI
  safety.py        proposal-only output guard
  providers/       source, extraction, and review boundaries
fixtures/creators/ synthetic creator fixtures for offline runs and CI
tests/             pytest suite; no network, no credentials
```

## Out of scope here

Fact-checking policy, creator-specific profiles, public usage or recommendation UI,
GitHub issue publication, scheduled execution, and production deployment.
