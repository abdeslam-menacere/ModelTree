---
name: modeltree-scout
description: Research source-backed ModelTree data changes for one or more creators. Fetches primary sources from the reviewed catalog, extracts atomic claims with verbatim quotes and content hashes, and writes a claim bundle for review. Use when refreshing ModelTree data, checking a creator for new releases, or verifying that existing facts still hold.
---

# ModelTree scout

Find what changed, and bring back proof. You research and record; you do not
decide. Acceptance belongs to `modeltree-review` and the gates, and you must not
pre-empt either by dropping a candidate because you suspect it will be rejected
or by softening a statement so it passes.

Your output is one claim bundle per creator, contract in
[`../modeltree-gates/reference/claim-bundle.md`](../modeltree-gates/reference/claim-bundle.md).
Read it before you start; every field there exists to refuse a specific way of
being wrong.

## The one rule that matters most

**A search result is never evidence.** It is a pointer to a source. You may
search to *find* a page; you must then fetch that page and quote it. Every piece
of evidence you record carries `"retrieval": "fetch"` and a `sha256` hash of what
you actually read, and `gate-evidence.mjs` refuses anything else.

This is the rule most likely to erode under time pressure, which is why a machine
enforces it rather than your discretion.

## Where the sources come from

Two catalogues, both already reviewed, both read-only to you:

- `tools/updater/profiles/*.json` — one per pilot creator (`openai`,
  `anthropic`, `google-deepmind`, `meta`), plus
  `tools/updater/profiles/generic/long-tail.json`. Each carries the creator's
  `source_catalog` (seed URLs and what each is authoritative *for*),
  `terminology`, `naming_rules`, `extraction_rules`, and `ambiguities`.
- `web/src/data/sources.json` — every source already cited, with its
  `lastCheckedDate`.

**Do not edit either.** `tools/updater/` belongs to a different subsystem and is
out of scope for a refresh; `sources.json` changes only as a claim in your bundle.

Read the profile before you read a page. `terminology` and `naming_rules` are
this repository's reviewed statement of how that creator names things, and
`ambiguities` lists the traps — the GPT/o-series boundary, ChatGPT-the-product
versus GPT-the-model, dated snapshots versus rolling aliases. A claim that
ignores them will be rejected by the editorial reviewer, correctly.

## What to look for

For each creator, in this order:

1. **New releases.** Anything on the announcement feed or model reference that
   `releases.json` does not have. This is the highest-value finding and the
   reason the refresh exists — abdeslam-menacere/ModelTree#86 records the dataset
   going sixteen months stale on exactly this.
2. **Changed facts on existing releases.** Status moving to `legacy` or
   `deprecated`, a corrected context window, a new API alias, a licence change —
   the one item here that obliges you to fetch a *second* publisher's page, and
   only while you are still fetching at all; see **Boundaries**.
3. **Stale verifications.** Entries whose `verifiedAt` is oldest. Re-checking a
   fact that still holds is a real finding: record it as `kind: "unchanged"`
   with fresh evidence, so `verifiedAt` can move forward honestly.
4. **New sources** worth adding to `sources.json`, each proposed as its own
   claim — but only on an origin the dataset or a profile catalogue already
   stands behind, and **never alone**. A `sources` add claim is incomplete on
   its own: `web/src/data/validate.test.ts` treats an unreferenced source as
   dead provenance (`expect(orphaned).toEqual([])`), so a lone source claim
   cannot be applied without inventing an unreviewed edit to make some record
   cite it. Every source-add must be paired with the `change` claim that wires
   that source into a record's `sourceIds` — and the same applies to a
   status/field change whose supporting quotes come only from a new source:
   propose the source and propose the citation edit, so a reviewer can see and
   vote on both. The two claims are reviewed independently but recorded as
   coupled: if the reviewer rejects the citation edit, the paired source-add
   must be withheld rather than applied and orphaned; if the reviewer rejects
   the source-add, every claim citing it must be dropped for the same run. See
   **Boundaries** below.
5. **Conflicts.** Two sources disagreeing is a finding, not a problem to resolve.
   Record `kind: "conflict"` with both sides quoted, and let it stay explicit.

## Procedure

1. Resolve the creator list. Default: every organization in
   `web/src/data/organizations.json`, plus any long-tail creator you were asked
   for. Set `policy` to `pilot` when a reviewed profile exists for that creator
   and `long-tail` when it does not — that choice sets the review threshold, so
   get it right. Always write the field: the gate refuses a bundle that omits it
   rather than picking a default, so leaving it out fails the run instead of
   quietly selecting the looser bar.
2. Load the profile and the current dataset for that creator.
3. Fetch each catalogued source. Record `sourceId`, `url`, `contentHash`,
   `fetchedAt`, and `status` in `sourcesConsulted` — including failures, which
   go in `incomplete` rather than being dropped. When the source that fails is a
   creator's `official-announcement` — its authoritative feed for new releases,
   as OpenAI's `openai.com/news/` has been with a persistent 403 — flag it as a
   *degraded discovery channel for that creator*, so the refresh loop can record
   it against the creator (`found.degradedChannels`) rather than burying it as
   one line among unrelated fetch errors. Report the failure honestly; never
   scrape around it or spoof a user agent.
4. Follow links **only** where the profile's `allowed_paths` permits. A link off
   the creator's own domain is not a source you can use: `gate-source-approval.mjs`
   refuses a citation to any origin the committed dataset and the profile
   catalogues do not already stand behind, and no panel vote overrides it. A new
   *page* on an origin already trusted is fine and is the ordinary case — propose
   it as a `sources` claim and cite it. A new *host* is work for a human: record
   it in `incomplete` as a proposed follow-up and move on. Do not build the claim
   and let the gate refuse it; that publishes nothing and hides the finding in a
   failure list.
5. Extract **atomic** claims. One claim moves one field. "GPT-5.7 was released on
   20 August with a 400k context window" is two claims, because a reviewer may
   accept the date and reject the window, and a bundled claim forces one verdict
   on two facts.
6. Write `statement` as one plain sentence. Reviewers vote on that sentence, not
   on JSON.
7. Quote verbatim. At least 24 characters, copied exactly, showing the source
   stating the fact. Do not paraphrase into the quote field — a paraphrase is
   your reading of the source, which is the thing being reviewed.
8. Stop at the budget: 40 pages or 20 minutes per creator, whichever comes first.
   Record exhaustion in `budget` and `incomplete`. A truncated run that says so
   is fine; one that does not is a silent lie about coverage.
9. Write the bundle with **no** `verdicts`. Review fills those in.
10. **Run the pairing check** before handing off:
    `node .github/skills/modeltree-scout/scripts/check-bundle-pairing.mjs <bundle path>`.
    It exits 0 when every source-add in the bundle is paired with a claim that
    wires the source into some record's `sourceIds`, and exits 1 naming any
    source id that is added but nothing in the same bundle cites. A non-zero
    exit means the bundle is unappliable as written — add the missing citation
    claim, or drop the source-add, and re-run. Never hand off a bundle the
    check refused; that is the failure mode abdeslam-menacere/ModelTree#403 exists to prevent.

One creator failing does not stop the others. Record the failure and continue.

## Boundaries

- **Creator, model, product, and serving platform are four separate entities.**
  ChatGPT is not GPT-5. Azure OpenAI is not OpenAI. Gemini the app is not Gemini
  the model. Collapsing them is the single most common data error in this domain
  and one of the three reviewers exists to catch it.
- **An organization's two name fields have fixed jobs, and neither is an id.**
  `shortName` is the label the site displays, sorts on, and files an
  organization under; `name` is the fuller recorded form, kept searchable and
  shown where it differs. The rule is `web/src/lib/organization-name.ts` and it
  is uniform -- there is no per-creator exception to propose. So record each
  form as its source states it and never edit one to match the other to make a
  page read better: that is a presentation decision, and the presentation
  already has one. Where a creator's own surfaces use two names, that is a
  `kind: "conflict"` finding like any other and both forms stay
  (abdeslam-menacere/ModelTree#479 is the case that set this). `id` and `slug`
  are identity, never presentation, and a naming finding is never a reason to
  propose changing either.
- **Never invent a composite score, rank, or "best model" claim.** The product
  does not publish one (abdeslam-menacere/ModelTree#67 is blocked pending a
  product decision), and `gate-dataset.mjs` refuses the vocabulary outright.
- **Usage figures are observations, never rankings.** Each carries its metric,
  measured population, window, methodology, source category, scope, and caveats.
  Two figures measuring different populations are never added together.
- **Unknown stays unknown.** If a source does not state a field, leave it unset.
  A plausible guess is the failure mode this whole system exists to prevent, and
  it is far more dangerous than an empty field because it looks like knowledge.
- **A source's origin must already be trusted.** You may cite a new page, never a
  new host. The trusted set is every origin in `web/src/data/sources.json` as
  committed plus every `source_catalog` url in `tools/updater/profiles/`, and
  `gate-source-approval.mjs` refuses anything else — including a source you
  propose and cite in the same run, which is the run vouching for itself. A
  genuinely new publisher is a follow-up for a human, not a claim.
- **A `license` block is a claim about what OSI decided, so it rests on a page
  OSI published — and only a fetch obtains one.** `licenseSchema` makes
  `osiApproved` required, so every licence block carries the field and owes that
  source at *either* value; `validateDataset` refuses a release whose
  `sourceIds` cite none. The rule itself is stated in the `provenance` rubric of
  [`../modeltree-review/SKILL.md`](../modeltree-review/SKILL.md), under
  "Licence name is not OSI status", and in the note beside `licenseSchema` in
  `web/src/data/schema.ts`. Read one of those; this bullet deliberately does not
  restate them, because a third copy is a third thing to drift. What is yours is
  the **retrieval**, and it is yours because no later stage can perform it:
  evidence carries a `contentHash` of what you read, so a reviewer cannot cite a
  page nobody fetched. A licence claim that arrives with no OSI page is
  therefore dropped rather than improved, and the release it belongs to goes
  with it. When a card states a licence, fetch OSI as well as the card. Which
  page depends on the value, and both conventions are pinned over the committed
  data by `web/src/data/osi-approved-citations.test.ts`, in the cases named
  `rests every osiApproved: false on the exhaustive approved-licence index` and
  `never rests an osiApproved: true on the index alone standing in for a licence page`.
  Four OSI sources are already committed, so cite one rather than
  proposing a duplicate: `osi-license-index` (`https://opensource.org/licenses`)
  is the exhaustive list a `false` rests on; `osi-license-mit` and
  `osi-approved-licenses` (Apache-2.0, despite the id) are per-licence pages;
  `osi-open-source-ai-definition` defines the term and records no licence's
  approval, so it stands for neither value alone. A `true` naming a licence none
  of those pages covers is the ordinary paired source-add of item 4 above rather
  than a human hand-off — `opensource.org` is an approved origin already, and
  what stops a run is a new *host*, never a new page. Capture the `spdxId` or
  licence `url` while the page is open: `releaseSchema` requires one for a
  `true`, as a structural floor that identifies the licence and not as evidence
  of its status.
- **Never write to `web/src/data`.** You produce a bundle. Applying it is
  `modeltree-publish`'s job, after the gates.

## Handing off

Write the bundle, then report: creator, pages fetched, claims by kind, sources
proposed, conflicts found, and anything in `incomplete`. Then invoke
`modeltree-review`. Do not summarise your confidence in a claim — the reviewers
must not see your reasoning, and an unattended run has no one to correct for the
anchoring if they do.
