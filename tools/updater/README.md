# ModelTree updater (proposal-only)

A Python tool that **proposes** source-backed ModelTree updates. It reads sources,
extracts atomic claims with their evidence, reviews and validates them, and writes a
proposal bundle for a human to act on.

It has no path to publication of *data* by design: it never writes `web/src/data`, never
creates a branch, and never opens a pull request. `tests/test_proposal_only.py` enforces
that. It can create one GitHub **issue** per creator so a human sees the proposal — that
is the only write it has, and it is described under "Publishing proposals" below.

The Astro site stays static. This tool runs separately and is not part of the web build.

## Quick start (offline, no credentials)

```bash
cd tools/updater
python -m venv .venv && .venv/Scripts/activate      # macOS/Linux: source .venv/bin/activate
pip install -e ".[dev]"

modeltree-updater creators
modeltree-updater run --creator contoso-ai --output ../../out/proposals
modeltree-updater publish --report ../../out/proposals/<run-id>/report.json --dry-run
pytest
```

`python -m modeltree_updater ...` works identically without installing the console script.

## Continuous integration

`.github/workflows/updater-tests.yml` runs this suite on every pull request that
touches `tools/updater/`. It installs the package from a clean, uncached environment on
Python 3.11 and 3.13, so an unsatisfiable dependency pin or a broken `pyproject.toml`
fails CI rather than review. The job uses no secrets and reaches no model endpoint.

The bundled fixtures under `fixtures/creators/` are synthetic (`example.com`, invented
creators). They exercise the pipeline; they are not ModelTree data and must never be
copied into `web/src/data`. `quiet-ai` is deliberately empty: it is the no-change case
that must produce no GitHub issue.

## Commands

| Command | Action |
|---|---|
| `run` | Run the workflow for one or more creators |
| `publish` | Create or update one GitHub proposal issue per material creator |
| `creators` | List creators available in the fixtures |
| `profiles` | List the version-controlled creator profiles and their trusted catalog |
| `checkpoints` | List stored checkpoints for the creator workflow |
| `resume` | Finish a checkpointed run from a checkpoint id |

`profiles` reads `profiles/*.json` and prints one row per creator (id, name, and the
number of catalogued sources); `profiles --json` emits the loaded library for scripting.
It only reads profile data — it never runs the workflow or reaches a source.

Useful `run` flags: `--creator` (repeatable), `--fixtures`, `--provider fixtures|foundry`,
`--sources fixtures|network`, `--long-tail`, `--long-tail-profile`, `--output`,
`--checkpoint-dir`, `--run-id`, `--timestamp`, and the budget flags below. `resume` takes
`--provider` and `--sources` too, and refuses any provider the checkpoint did not record;
it has no `--long-tail` flag because the policy is restored from the checkpoint.

Exit codes: `0` success, `2` usage or configuration error, `3` at least one creator failed,
`4` at least one creator could not be published.

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

That threshold is a `ReviewPolicy` the run carries, not a number hard-coded in the
aggregation. Creators with a reviewed dedicated profile use `majority-2-of-3`; the generic
long-tail profile uses `unanimous-3-of-3` (see below). The **reject** threshold stays at
two under both — raising the bar for *acceptance* is the point, and making it harder to
refuse a thin candidate would be backwards. Every proposal records the policy it was
decided under, and the policy travels in the checkpoint so a resumed run cannot be
adjudicated on a different bar than the one it started with.

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

## Creator profiles and the trusted source catalog

The differences between creators are **data, not code**. There is one shared
implementation; each creator is a version-controlled profile under `profiles/<id>.json`,
loaded by `profiles.py` into a `CreatorProfile`. Nothing in Python branches on a
creator id — a new creator is a new reviewed JSON file, not a new code path.

A profile is a reviewed description of a creator and *which* sources are trusted for it.
It never fetches anything: issue #73 owns a network provider. A profile only says what a
source is and what may be taken from it.

```jsonc
{
  "creator": {                    // identity, mapped to a CreatorRequest for a run
    "id": "openai",               // stable slug; the profile file name
    "name": "OpenAI",
    "type": "company",
    "aliases": ["OpenAI, Inc."]
  },
  "notes": ["free-text reviewer notes"],
  "terminology": {                // how this creator uses family/release/product/serving
    "family": "…", "release": "…", "product": "…", "serving": "…"
  },
  "naming_rules": [               // per-subject naming guidance, with an example
    { "subject": "release", "rule": "…", "example": "…" }
  ],
  "source_catalog": [             // the trusted sources — see the table below
    {
      "id": "openai-news",
      "owner": "OpenAI",
      "url": "https://openai.com/news/",
      "kind": "official-announcement",
      "allowed_paths": ["/news/", "/index/"],
      "allowed_content_types": ["announcement", "research-post"],
      "trust": "primary",
      "trust_notes": "why this source is trusted",
      "verified_at": "2026-08-18",
      "verification": "how the seed URL was confirmed"
    }
  ],
  "extraction_rules": {           // what kinds of entity may be extracted, plus notes
    "entity_kinds": ["organization", "family", "release", "product"],
    "notes": ["extract API ids only from the API reference", "…"]
  },
  "ambiguities": [                // unknowns that stay explicit, never smoothed over
    { "topic": "…", "note": "…", "guidance": "…" }
  ]
}
```

Each `source_catalog` entry is a `TrustedSource`:

| Field | Meaning |
|---|---|
| `id` | stable id for the source within the profile |
| `owner` | who publishes it |
| `url` | the canonical seed URL (its origin + allowed paths define the source's scope) |
| `kind` | one of `official-announcement`, `official-docs`, `model-card`, `repository`, `benchmark-owner`, `independent-evaluation` |
| `allowed_paths` | path prefixes admitted for this source; a trusted origin reached by another path is treated as a discovery |
| `allowed_content_types` | free-text labels for what the source is expected to carry |
| `trust` | trust tier (e.g. `primary`) |
| `trust_notes` | why it is trusted |
| `verified_at` | date the seed URL was last confirmed |
| `verification` | how it was confirmed |

Seed URLs are **real** creator-owned URLs, kept deliberately conservative: where an exact
sub-path was uncertain, the profile uses the canonical root the reviewer is sure of rather
than a guessed deep link. No seed URL is fabricated to look complete.

## The generic long-tail profile

Four creators have a reviewed dedicated profile. Everyone else — the minor and niche
creators that make up most of the field — is covered by **one** generic profile,
`profiles/generic/long-tail.json`, loaded by `longtail.py`. It is a profile, driven
through the same executors, the same three lenses, the same deterministic hard gates, and
the same proposal-only boundary. There is no second pipeline and no second agent.

It is **opt-in**, never an automatic fallback:

```bash
python -m modeltree_updater run --creator litware-ai --long-tail --output ./out
```

`--long-tail-profile <path>` swaps in a different reviewed profile document. `resume`
deliberately has **no** such flag: the policy and the profile id are recorded in the
checkpoint, so a resumed run restores the bar it started under rather than re-deciding it
from whatever the resuming command passed. A checkpoint whose profile cannot be honoured
stops the run with `ProfileMismatch`.

Three things differ from a dedicated profile, and all three follow from one fact — nobody
has reviewed this creator:

| | Dedicated profile | Generic long-tail profile |
|---|---|---|
| Accepting a claim | 2 of 3 lenses | **all 3** |
| Approving a newly discovered source | 2 of 3 lenses | **all 3** |
| Rejecting | 2 of 3 lenses | 2 of 3 lenses (unchanged) |
| Unsettled naming / ownership / lineage | escalated | escalated **and** recorded as an `unresolved-mapping` conflict |
| Promotion assessment | — | recorded on every run |

The profile document *restates* a `review_policy`; it does not define one. The loader
resolves the declared `id` against the policies `review.py` actually implements, checks
every field of the restatement matches, and **refuses** any policy that asks for less than
unanimity. Editing the file can therefore produce a load error but never a quieter gate,
and the threshold recorded in a proposal is always one the aggregation really applied.

**Where the seeds come from.** A long-tail creator has no catalogued sources, so
`LongTailProfile.for_creator()` builds a `CreatorProfile` whose catalog is the run's own
`entry_urls` — the URLs the operator supplied. Nothing here discovers, infers, or invents
a URL. They are marked `trust: "unverified-seed"` and carry **no** `verified_at`, because
nobody checked them and stamping a date on an unreviewed URL would fabricate provenance.
Lower trust buys a seed nothing: the seed URLs are run through the same `url-safety` check
before a single page is fetched (an unsafe seed stops the run), and everything read
afterwards passes exactly the same gate set as a catalogued source. Anything off a seed
origin is a discovery and needs the unanimous vote.

**Unknown mappings stay unknown.** A claim about naming, ownership, or lineage that the
panel could not settle becomes an explicit `unresolved-mapping` conflict naming the topic
and the profile's guidance. This matters because a claim all three lenses *abstain* on is
technically unanimous, so reviewer-disagreement detection says nothing about it — without
this it would leave no trace at all. The conflict is scoped to the long-tail path; a
dedicated-profile run's conflict output is unchanged.

**Promotion is a flag, never an action.** Every long-tail creator is assessed against the
criteria published in the profile — accepted claims, distinct approved sources actually
backing them, escalated mappings — and the observed value is recorded whether or not the
threshold was met, so a near miss is as legible as a pass. A recommendation asks a human
to write `profiles/<creator>.json`. **No code path in this tool creates a dedicated
profile**, and automatic creation is explicitly out of scope.

## The source scout

`scout.py` turns *leads* into *sources for review* — never into evidence. A lead
(`ScoutFinding`) is what a search returns: a URL, a title, a publisher, and maybe a
snippet. A `SourceScout(profile)` triages each lead against the profile's catalog:

* a lead from an origin and path the profile already trusts becomes a **configured**
  source, usable without a discovery vote;
* any other lead — including a trusted origin reached by an un-admitted path — becomes a
  **newly discovered** `SourceProposal`, put forward for the same recorded 2-of-3 review
  path described above. The scout proposes; a reviewer decides.

**A search snippet is never evidence.** `ScoutFinding` and `SourceProposal` have nowhere
to store an `Evidence` record; a snippet travels only as `search_snippet`, a
human-readable reason to read the page. `snippet_is_never_evidence()` exists solely to
make that rule executable and greppable — it always raises. Evidence is built only in the
extraction stage, from the bytes a source actually serves after it is read.



## Fetching real pages (the network source provider)

`--sources network` swaps the fixture reader for `NetworkSourceProvider`
(`providers/network.py`), the one component in the package that reaches the
network. It implements the *same* async `SourceProvider` protocol as the fixture
provider — `discover` turns a creator's configured seed URLs (`entry_urls`) into
candidates, `fetch` retrieves one — so the workflow, its per-creator budgets, and
its typed-failure handling are unchanged. Fixtures remain the default; offline and
CI runs are unaffected.

For a live run the sources come from the network but the extractor and reviewers
still come from `--provider` (use `--provider foundry` for a real run, since the
fixture extractor only understands fixture pages):

```bash
modeltree-updater run --creator openai --sources network --provider foundry \
  --output ../../out/proposals
```

What it guarantees, and how it behaves as an honest citizen:

* **The content hash is of the exact bytes served** — not the decoded or
  tag-stripped text the extractor reads — so `Evidence.content_hash` reproduces on
  a second fetch of unchanged content and changes the moment the served bytes do.
  `retrieved_at` is the real instant the bytes arrived.
* **HTTPS-only, no private hosts, no bare IPs, no embedded credentials**, applied
  *before* the request (the `url-safety` gate runs later, after the fetch) and
  re-checked on every redirect hop so a redirect cannot smuggle a fetch to a
  private host.
* **`robots.txt` is respected** per host (an absent/4xx robots means no
  restriction; an unavailable 429/5xx robots is a transient, retryable failure —
  never a guess), requests are **rate-limited per host**, and the client
  **identifies itself** truthfully in `User-Agent`.
* **Every failure is a typed `ProviderError`.** Transient causes (connection
  errors, timeouts, HTTP 429/5xx, unverifiable robots) are retryable and spend the
  retry budget; deterministic ones (unsafe URL, robots disallow, unsupported
  content type, oversized body, a 4xx) are not. No new silent failure mode.

> **Status: exercised against a real page.** `tests/test_network_provider.py`
> covers the whole provider offline with an injected opener; one test
> (`@pytest.mark.network`) performs a real fetch and is **excluded from the
> default run** (`addopts = -m 'not network'`). Run it explicitly with
> `pytest -m network`.

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

## Publishing proposals

`publish` turns a written run artefact into GitHub issues. It reads `report.json` back
from disk rather than re-running the workflow, so the issue a human reads is provably the
artefact that was produced — and the expensive step (models, network) is separate from the
step that needs a token.

```bash
# render the exact payload; no repository, no token, no network
modeltree-updater publish --report ../../out/proposals/<run-id>/report.json --dry-run

# create or update the issues
GITHUB_TOKEN=<token with issues:write> \
  modeltree-updater publish --report ../../out/proposals/<run-id>/report.json \
                            --repo owner/name
```

`--repo` defaults to `$GITHUB_REPOSITORY`. The dry run prints the title and the byte-exact
body that a real publication would send.

### One issue per creator

Identity is a hidden marker that must be the **first line** of the issue body:

```
<!-- modeltree-proposal: v1 creator=<creator-id> -->
```

Matching compares that first line for equality. It is never a substring search: a rendered
body quotes fetched pages, so marker-shaped text can legitimately appear inside the
content, and treating that as identity would let one creator's proposal steer an update
onto another creator's issue.

The title is `ModelTree proposal: <creator-id>`. Re-running updates the same issue in
place, so the issue stays the single, current view of that creator.

### What gets published, and when

An issue is created or updated only when the run has something material to say: at least
one claim candidate (**any** decision — a rejected or vetoed claim is a reviewable outcome,
not silence), at least one conflict, at least one failure, or a status other than
`complete`. A complete run that found nothing makes **no GitHub request at all**, not even
a read, and leaves any existing open proposal untouched — deciding a stale proposal is a
human's call, and closing it would destroy the review context.

The body carries the candidate patch (accepted claims as logical operations, plus a
copy-pasteable JSON block), the atomic evidence behind every claim, every source approval
decision with its vote tally, **all** reviewer verdicts and adjudications, every
deterministic gate and validation result, the conflicts, the budget ledger, and the
completion status with each failure spelled out. It is a pure function of the artefact:
re-rendering the same `report.json` is byte-identical, so an unchanged run does not churn
the issue. GitHub caps a body at 65 536 characters; an oversized proposal is truncated
section by section, least valuable detail first, and says in the body exactly what was
dropped.

### Duplicates

If more than one open issue carries a creator's marker, `publish` updates the
**lowest-numbered** one, leaves the rest exactly as they are, and reports the duplicates
both on stdout and in a warning block inside the body it just wrote. It never closes an
issue: the Issues API has no conditional write, so a read-then-close is a race that could
close an issue a human had repurposed in the meantime. Duplicates are *prevented* by the
repository-wide, non-cancelling `concurrency` group on the workflow, and reported if they
happen anyway.

### Supersession: what an update replaced

An update overwrites the body wholesale, so the previous run's evidence goes with it. A
reviewer who was reading that evidence would otherwise have no way to see that anything
changed. Every body therefore carries a machine-readable state line, immediately under the
identity marker and read only from that second line:

```
<!-- modeltree-run: v1 run=<id> supersedes=<id|-|?> claims=N accepted=N conflicts=N failures=N -->
```

When a run is about to overwrite a body written by a **different** run, it first posts a
comment naming that run and its material counts, then rewrites the body, whose header table
gains a `Supersedes run` row. The order matters: the comment exists to survive the thing it
describes, so it is filed *before* the rewrite. If the rewrite then fails, the record still
stands and the CLI reports the failure — the reverse order can lose the previous run with
nothing to show for it.

- Re-publishing the **same** run carries the earlier supersession forward unchanged, so the
  body stays byte-identical and no second comment appears.
- If the body being replaced **cannot be read** — hand-edited, or written by an older
  version — the comment says exactly that. It does not guess at a run id or at counts, and
  it does not stay silent. The new body repeats the warning.
- A run id reaches the state line, so it is validated (letters, digits, `.`, `_`, `-`) for
  the same reason a creator id is: a value carrying `-->` could otherwise close the comment
  early and forge a second state line.
- The comment endpoint (`POST /repos/{owner}/{repo}/issues/{n}/comments`) is the only
  addition to the client's URL surface, it stays under `/issues`, and it needs no permission
  beyond the `issues: write` the workflow already has.

A `--dry-run` reads nothing, so it can neither check for duplicates nor name a superseded
run. It says so in its output: a clean dry run is not evidence that neither exists.

### The manual GitHub workflow

`.github/workflows/publish-updater-proposals.yml` runs the pair of commands on a runner.

- `workflow_dispatch` **only**. There is deliberately no schedule: a run spends model
  tokens and writes issues a human then has to read.
- Inputs: `creators` (comma-separated), `mode` (`fixtures` runs offline, `live` fetches
  real pages through Foundry), and `dry_run`, which defaults to `true`.
- Permissions are `contents: read` at the top level; the job adds `issues: write` and
  `id-token: write` and nothing else. It therefore *cannot* modify repository content,
  create a branch, or open a pull request. The checkout runs with
  `persist-credentials: false`. `tests/test_publication_workflow.py` asserts all of this
  against the parsed YAML, so the claim is machine-checked rather than prose.
- The run artefact is uploaded, so the published issue can be diffed against the JSON.

### Azure setup this repository documents but does not provision

Live mode signs in with `azure/login@v2` using **Microsoft Entra workload identity
federation**. There is no client secret and no API key anywhere in the workflow, the code,
or the tests. Creating the following is a deliberate manual, auditable act — this
repository describes what is needed and provisions none of it:

1. **A Microsoft Entra application (or user-assigned managed identity)** for the publisher.
2. **A federated credential** on it, with issuer `https://token.actions.githubusercontent.com`,
   audience `api://AzureADTokenExchange`, and a subject that matches how the workflow is
   dispatched:
   - `repo:<owner>/<repo>:ref:refs/heads/main` — dispatches from `main`;
   - add one subject per branch you dispatch from, or
     `repo:<owner>/<repo>:environment:<environment-name>` if the job is bound to an
     environment.
3. **A role assignment** granting that identity **Azure AI User** on the Foundry *project*
   (not the subscription). That is the least privilege that lets it call a model
   deployment; no data-plane key is issued or needed.
4. **Repository variables** (not secrets): `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SUBSCRIPTION_ID`, `MODELTREE_FOUNDRY_ENDPOINT`, `MODELTREE_FOUNDRY_DEPLOYMENT`.

The only secret the workflow uses is the automatic `GITHUB_TOKEN`, scoped by the
permissions block above.

### Live publication tests

`tests/test_live_publication.py` publishes to a real repository and is marked `live`, which
the default `pytest` run excludes along with `network`. Normal CI stays offline and
credential-free. Opt in against a scratch repository you own:

```bash
MODELTREE_LIVE_PUBLISH_REPO=you/scratch GITHUB_TOKEN=<issues:write> pytest -m live
```

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
`source_approvals`, `validations`, `conflicts`, `budget`, `failures`, `notes`, and
`review_policy` (the acceptance threshold this run actually applied). A creator processed
under the generic long-tail profile also carries `promotion`: the criteria, their
thresholds, the observed values, and whether a dedicated profile is recommended.

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
  parsing.py       strict reader that rebuilds contracts from a written artefact
  publisher.py     materiality, issue identity, supersession, deterministic rendering
  github_issues.py the only module that speaks to GitHub, and only about issues
  profiles.py      shared loader for version-controlled creator profiles + catalog
  longtail.py      the generic long-tail profile: unanimity, unresolved mappings, promotion
  scout.py         triages source leads into proposals; snippets are never evidence
  providers/       source, extraction, and review-panel boundaries
                   (fixtures, the Foundry models, and the network source fetcher)
profiles/          version-controlled creator profiles and their trusted source catalog
profiles/generic/  the one generic profile for creators without a dedicated one
fixtures/creators/ synthetic creator fixtures for offline runs and CI
tests/             pytest suite; no network, no credentials
```

## Out of scope here

Human publication approval, public usage or recommendation UI, scheduled execution,
committing or pull-requesting data changes, provisioning the Azure resources the
publication workflow needs, and production deployment. Source *discovery* by search —
turning an open-web query into leads — also stays out: the network provider fetches the
seed URLs a creator profile already configures (see "Fetching real pages" above), it does
not crawl or search. **Automatic creation of dedicated creator profiles** is out too: the
long-tail promotion assessment is a flag for a human, exhaustive catalog coverage is not
attempted, and there is no lower-confidence publication path.
