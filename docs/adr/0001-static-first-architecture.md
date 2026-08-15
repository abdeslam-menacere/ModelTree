# ADR 0001: Static-First Astro Architecture

- Status: Accepted
- Date: 2026-08-14
- Decision owners: ModelTree maintainers

## Context

ModelTree is a content-heavy public data product with a small set of rich client
interactions. It must deploy to GitHub Pages, remain contribution-friendly, and
fail builds when source-backed data violates schema or lineage invariants. The
repository currently contains the Drydock template and no ModelTree prototype.

## Decision

### Repository placement

Build the product in `web/` during the foundation milestone. This keeps the
existing Drydock delivery tooling runnable while avoiding a collision between
its root `src/` directory and Astro's source tree. Reconsider moving the web app
to the repository root after M1, when the value of retaining the template CLI is
known. This is a reversible layout decision, not a permanent monorepo strategy.

### Application stack

- Astro with `output: "static"` for routes and content-heavy pages
- TypeScript strict mode
- React islands only for lineage, filtering, and comparison interactions
- npm and a committed lockfile because npm is present in the project toolchain
- Plain token-driven CSS for the first slice; no utility framework dependency
- Lucide React for familiar interface icons
- No D3 in the first slice; use semantic HTML and CSS branches until graph layout
  complexity demonstrates a real need

### Data and validation

- Repository-controlled JSON records grouped by entity type
- Zod schemas shared by build validation and application loading
- Explicit cross-record checks for uniqueness, references, dates, and featured
  release source requirements
- Source references and `verifiedAt` stored with important facts
- Derived view models computed at build time instead of checked into the data

The initial schema implements organizations, model families, model releases,
and source references. Products, deployments, prices, benchmarks, and change
events are added through focused schema issues before their UI depends on them.

### Routing and deployment

- Every route is statically generated
- Dynamic provider and model routes use `getStaticPaths`
- `site` and `base` are configured from GitHub Actions for project Pages paths
- Canonical URLs, sitemap, robots, and Open Graph metadata are generated at build
- GitHub Actions runs data validation, tests, type checks, build, and Pages deploy

### Quality strategy

- Unit tests cover validation and data transformations
- Component tests cover keyboard and selection behavior
- Playwright smoke tests cover homepage, model passport, deep links, and mobile
- Performance budgets are enforced before launch: LCP under 2.5 s, INP under
  200 ms, CLS under 0.1, and an explicit initial-JavaScript budget

## Consequences

### Positive

- Pages hosting has no runtime service, secret, or database dependency.
- Most content ships as HTML while interactive code remains narrowly scoped.
- Contributors can review factual changes as structured diffs.
- The first provider path proves schema, routing, provenance, and interaction
  before bulk migration.

### Costs

- Repository JSON requires disciplined review and periodic rebuilds.
- Client-side filtering must remain bounded or move to generated search indexes.
- Cross-entity validation needs custom code beyond field-level schemas.
- Keeping Drydock and `web/` temporarily creates two package boundaries.

## Alternatives Considered

- **React SPA:** rejected because content routes, no-JavaScript readability, and
  metadata would require more client code and custom prerendering.
- **Next.js:** rejected because its server-oriented surface is unnecessary for
  GitHub Pages and increases deployment complexity.
- **Single monolithic HTML prototype:** rejected because it prevents reusable
  routes, schema enforcement, and independently testable interactions.
- **D3 from day one:** deferred because the first curated tree does not justify
  its bundle and accessibility cost.

## Guardrails

- Do not hardcode catalog records in components.
- Do not publish unreviewed facts from automation.
- Do not infer a missing fact or silently resolve conflicting sources.
- Do not introduce a composite ModelTree score in the MVP.
- Do not move repository visibility, branch protection, or Pages settings through
  application code; those remain explicit owner actions.