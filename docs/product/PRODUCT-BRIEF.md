# ModelTree Product Brief

## Product

**ModelTree - AI Model Lineage**

**Tagline:** The living family tree of AI models.

ModelTree is a source-backed map of AI creators, model families, releases, and
relationships. It helps people distinguish a model from the product or platform
that serves it, understand what came before and after it, and inspect comparable
evidence without treating one benchmark as universal truth.

## Problem

AI model names mix creators, products, families, tiers, versions, aliases, and
API identifiers. Existing directories optimize for breadth, pricing, or ranking;
they rarely explain lineage or preserve enough context to make historical and
benchmark claims trustworthy.

## Audience

- AI-curious professionals who need plain-language orientation
- Developers and architects selecting models for applications
- Product and technology leaders tracking the market
- Researchers, analysts, writers, and journalists checking chronology
- Open-weight users evaluating licenses and deployment options

## Product Promise

Within seconds, a visitor should be able to answer:

1. Who created this model?
2. Which family and tier does it belong to?
3. When was it released, and what is its lifecycle state?
4. What related releases came before, beside, or after it?
5. Is it hosted, downloadable, or both, and where is it available?
6. Which source supports each important fact?
7. Which evidence is genuinely comparable with another model?

## MVP Outcome

The first public release provides:

- A memorable, responsive lineage explorer for featured ecosystems
- Source-backed provider and Model Passport pages
- Searchable model and provider directories with stable URLs
- Benchmark evidence and two-to-four-model comparison without a composite score
- Release chronology, verification timestamps, and correction paths
- Static GitHub Pages deployment with keyboard and mobile support

The first vertical slice proves the architecture with one OpenAI family: a
deployable shell, validated seed data, an interactive lineage, one Model
Passport, and visible primary-source attribution.

## Product Principles

1. Clarity before completeness.
2. History is a first-class feature.
3. Important facts carry provenance and a verification date.
4. Unknown and conflicting data remain explicit.
5. Creator, model, product, and serving platform are separate entities.
6. Benchmarks are contextual evidence, not universal truth.
7. Accessibility and speed are requirements, not polish.
8. Data changes are reviewable repository changes.

## Editorial Inclusion

The homepage uses the labels **Featured ecosystems** and **Widely used model
families**, never an unsupported usage ranking. Editorial inclusion may consider
consumer reach, API availability, cloud distribution, open-weight adoption,
developer-tool integration, and sustained release activity. The complete
criteria and exceptions belong on `/methodology`.

## Non-Goals

- Complete historical coverage at launch
- Live API monitoring or a runtime database
- Original large-scale benchmark execution
- A proprietary universal score or universal winner
- User accounts, subscriptions, or unreviewed automatic ingestion
- Forcing unlike model categories into one specification or leaderboard

## Initial Success Signals

Until privacy-conscious analytics are approved, success is assessed through
release readiness: source coverage, data freshness, accessibility checks,
performance budgets, accepted community corrections, and stable shareable URLs.

## Known Launch Constraint

The GitHub repository is private as of 2026-08-14. Public visibility and Pages
settings are repository-owner decisions and must be enabled before an open-source
launch; no implementation issue should silently change them.