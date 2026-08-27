# Approved source origins

Human-reviewed **origin approvals** for creators that do not have a dedicated
reviewed profile. One document per creator, named after the creator id.

## What these documents are, and are not

They are the human half of a rule the tooling states in two places. A refresh run
may cite a new *page* on an origin the repository already stands behind; it may
never introduce a new *host*. `.github/skills/modeltree-scout/SKILL.md` says so
("A new *host* is work for a human"), `gate-source-approval.mjs` enforces it, and
no panel vote overrides it. Approving a host is therefore an ordinary reviewed
change, made here, before any run can reach it.

They are **not** profiles, and they join neither reviewed set:

- `tools/updater/profiles/*.json` is the reviewed set of **dedicated creator
  profiles**. `load_profile_library` reads exactly the files at that top level;
  a creator with a document there is a pilot creator, adjudicated on the
  majority policy.
- `tools/updater/profiles/generic/*.json` is the reviewed set of **long-tail
  profiles**, per ADR 0002, each restating the unanimous 3-of-3 policy.

`_reviewed_profile_paths` skips directories, so neither loader sees this one —
the same reason `generic/` is invisible to the dedicated-profile loader. Adding a
creator here does **not** promote it to a pilot creator and does **not** move it
off the unanimous 3-of-3 long-tail bar. That separation is the point: approving
where a creator publishes is a smaller act than deciding how its models are read,
and it should not silently perform the larger one.

## What reads them

`gate-source-approval.mjs`'s second trust anchor, which walks every `*.json`
under `tools/updater/profiles/` at the merge base with published `main` and
collects `source_catalog[].url`. Trust attaches to the **origin** (scheme +
host); `allowed_paths` bounds link-following for the run that uses it and is not
enforced by that gate.

Nothing in `tools/updater/src/` parses these documents. A key here is
documentation for the next human and the next run, not a validated field.

## Adding a creator

- Record only origins the creator itself publishes on, and only those actually
  reached and checked. An origin nobody verified is worse than an omitted one,
  because it cannot be told apart later from one that was.
- Say what each origin is authoritative **for**, in `trust_notes`. A bare URL
  list is not an approval.
- Bound `allowed_paths` to the sections that were checked. `www.microsoft.com`
  is the worked example: the host also carries product, support and licensing
  pages that say nothing about who trained a model.
- Keep creator, model, product and serving platform apart. A host is not
  approved because it *serves* a creator's models.
- Leave conflicts explicit in `ambiguities`, and record origins considered and
  turned down in `deferred_origins` with the reason. A deferral nobody wrote
  down gets re-proposed.

## Deferred creators

Considered for the first batch and deliberately left out, so the next agent
inherits the reason rather than the gap:

- **DeepSeek** — `api-docs.deepseek.com` could not be reached from the
  environment this batch was researched in (connection failure, not a 4xx), so
  no origin was verified. Nothing was approved on the strength of recollection.
- **Alibaba / Qwen** — the creator entity is unresolved. Qwen material appears
  under Alibaba Group, Alibaba Cloud, Tongyi Lab and the Qwen team, across
  `qwen.ai`, `qwenlm.github.io`, ModelScope and Alibaba Cloud documentation.
  Which of those is *the creator* is the question a refresh would have to answer
  first, and approving origins ahead of it would prejudge it.
