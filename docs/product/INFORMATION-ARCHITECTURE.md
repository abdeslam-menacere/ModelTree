# ModelTree Information Architecture

## Route Map

| Route | Purpose | Primary interaction |
|---|---|---|
| `/` | Signature lineage experience | Select ecosystem, family, and release; open details |
| `/tree/` | Dedicated semantic model tree | Progressively disclose reviewed creator, family, and release branches |
| `/models` | Complete model catalog | Search, filter, sort, paginate, share query state |
| `/models/[slug]` | Model Passport | Inspect identity, lineage, access, evidence, and sources |
| `/providers` | Creator and provider directory | Search and jump A-Z |
| `/providers/[slug]` | Organization profile | Explore family tree, releases, products, and platforms |
| `/benchmarks` | Benchmark evidence | Compare source-backed results within compatible contexts |
| `/compare` | Two-to-four-model comparison | Compare facts and comparable evidence without a winner |
| `/updates` | Chronological release view | Filter verified changes by date, creator, and category |
| `/methodology` | Editorial and data policy | Understand inclusion, terminology, and verification |

All user selections that define a useful view use stable query parameters. The
homepage starts with `provider` and `model`; catalog routes add filters and sort;
evidence uses `models=<slug,slug>` plus optional `domain` and `benchmark`.

## Navigation

The compact global header contains ModelTree, Explore, Model Tree, Models, Providers,
Evidence, Updates, and Methodology. On small screens, the same links use a
keyboard-accessible disclosure menu. The homepage is the product experience,
not a marketing gate.

`/` remains the broad signature experience and catalog overview. `/tree/` is a
complementary, focused hierarchy for mind-map-style progressive disclosure:
Root → Featured ecosystems → creator → model family → model release, with an
empty `Others` branch reserved for reviewed long-tail coverage. It derives
featured membership from reviewed catalog flags and does not imply popularity
or rank. The complete hierarchy is server-rendered; client JavaScript enhances
disclosure, selection, and stable `?model=<release-id>` deep links.

## Homepage Composition

1. Header and one-sentence product statement
2. Featured ecosystem selector
3. Interactive lineage explorer with an accessible HTML representation
4. Model detail drawer or anchored panel
5. Compact Release Pulse
6. Coverage counts and latest verification date

The first viewport shows the brand, purpose, and usable lineage controls while
leaving a visible hint of recent releases below.

## Component Architecture

### Static Astro components

- `BaseLayout`: metadata, canonical URL, navigation, and footer
- `BrandMark`: repository-controlled mark and text fallback
- `HeroIntro`: literal product statement and coverage summary
- `ModelPassport`: source-backed model detail sections
- `SourceList`: primary sources and verification metadata
- `ReleasePulse`: recent verified release events

### React islands

- `LineageExplorer`: provider selection, lineage state, keyboard movement, URL sync
- `CatalogFilters`: deferred search, filters, sorting, and result summary
- `EvidenceExplorer`: model and benchmark selection with comparability states
- `CompareTray`: persistent two-to-four-model selection

The server renders meaningful headings, controls, and a vertical lineage list.
JavaScript enhances layout and selection; it is not required to read the data.
No graph library is added until measured complexity justifies its bundle cost.

## Data Flow

```mermaid
flowchart LR
    JSON[Repository JSON records] --> Validate[Zod schemas and cross-reference checks]
    Validate --> Build[Astro static build]
    Build --> Pages[Static routes and serialized island props]
    Pages --> UI[Accessible HTML plus React enhancement]
```

Validation fails for malformed required fields, duplicate IDs or slugs,
impossible dates, broken organization/family/lineage references, and featured
releases without a primary source. Unknown optional facts stay absent rather
than receiving guessed defaults.

## Responsive Lineage Behavior

- Desktop: provider rail, branching family layout, and anchored details panel
- Tablet: compact provider control and collapsible family branches
- Mobile: provider to family to release drill-down with a vertical chronology
- Reduced motion: state changes occur without animated traversal

## Accessibility Contract

- Native buttons, links, headings, landmarks, lists, and dialog semantics
- Roving or conventional tab navigation documented in component tests
- Visible focus and non-color status labels
- Selection announced through accessible names and live status where useful
- A text alternative contains the same releases and relationships as the visual
- Touch targets, contrast, and interactions meet WCAG 2.2 AA

## Content Boundaries

Organizations, families, releases, products, serving platforms, pricing,
benchmarks, benchmark results, and sources remain separate records. Pages join
them for presentation but do not collapse creator into provider, product into
model, or open-weight into open-source.