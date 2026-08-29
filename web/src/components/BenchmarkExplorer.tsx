import { Fragment, startTransition, useEffect, useMemo, useRef, useState } from 'react';
import {
  benchmarksRoute,
  buildBenchmarkExplorerView,
  readEvidenceState,
  type BenchmarkExplorerDataset,
  type EvidenceFilters,
  type EvidenceGroupView,
  type EvidenceSourceLink,
} from '../lib/benchmark-explorer';

interface Props {
  dataset: BenchmarkExplorerDataset;
  /** Build-time selection. Empty on a static build; the URL wins once hydrated. */
  initialSlugs: string[];
  initialFilters: EvidenceFilters;
  base: string;
}

function Sources({ sources, label }: { sources: EvidenceSourceLink[]; label: string }) {
  if (sources.length === 0) return <span className="evidence-none">Not disclosed</span>;
  return (
    <ul className="evidence-sources" aria-label={label}>
      {sources.map((source) => (
        <li key={source.id}>
          <a href={source.url} rel="nofollow noopener external" target="_blank">
            {source.title}
          </a>
          <span className="evidence-source-meta">
            {source.publisherName} · checked {source.lastCheckedDate}
            {source.publishedDate ? ` · published ${source.publishedDate}` : ''}
          </span>
        </li>
      ))}
    </ul>
  );
}

function GroupTable({ group }: { group: EvidenceGroupView }) {
  const setupLabels = group.results[0]?.setup.map((entry) => entry.label) ?? [];
  const columnCount = 5 + setupLabels.length + 1; // model, score, version, date, setup..., sources, verified
  const headingId = `evidence-group-${group.key.replace(/[^a-z0-9]+/gi, '-')}`;

  return (
    <section className="evidence-group" aria-labelledby={headingId} data-cross-model={group.isCrossModel ? 'yes' : 'no'}>
      <header className="evidence-group-head">
        <h3 id={headingId}>
          {group.benchmarkName} <span className="evidence-group-version">({group.benchmarkVersion})</span>
        </h3>
        <p className="evidence-group-meta">
          <span className="evidence-domain-tag">{group.domainLabel}</span>
          <span className="evidence-metric">
            {group.metric}, measured in {group.unit}
          </span>
          <span className={`evidence-verdict verdict-${group.verdict}`}>
            {group.isCrossModel ? group.verdictLabel : 'Single model'}
          </span>
        </p>
      </header>

      <div className="evidence-table-scroll">
        <table className="evidence-table">
          <caption>{group.table.caption}</caption>
          <thead>
            <tr>
              <th scope="col">Model release</th>
              <th scope="col">Score</th>
              <th scope="col">Benchmark version</th>
              <th scope="col">Evaluation date</th>
              {setupLabels.map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
              <th scope="col">Sources</th>
              <th scope="col">Verified</th>
            </tr>
          </thead>
          <tbody>
            {group.results.map((row) => (
              <Fragment key={row.resultId}>
                <tr data-result={row.resultId}>
                  <th scope="row" className="evidence-model-cell">
                    <a href={row.passportRoute}>{row.releaseName}</a>
                  </th>
                  <td className="evidence-score">{row.scoreLabel}</td>
                  <td>{row.benchmarkVersion}</td>
                  <td>{row.evaluationDate}</td>
                  {row.setup.map((entry) => (
                    <td key={entry.label} data-disclosed={entry.isDisclosed ? 'yes' : 'no'}>
                      {entry.value}
                    </td>
                  ))}
                  <td>
                    <Sources sources={row.sources} label={`Sources for ${row.releaseName} on ${group.benchmarkName}`} />
                  </td>
                  <td>{row.verifiedAt}</td>
                </tr>
                {row.hasCaveats && (
                  <tr className="evidence-caveat-row">
                    <td colSpan={columnCount}>
                      <details className="evidence-caveat">
                        <summary>Caveats for {row.releaseName}</summary>
                        <p>{row.caveats}</p>
                      </details>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {group.benchmarkSources.length > 0 && (
        <p className="evidence-benchmark-source">
          Benchmark definition:{' '}
          {group.benchmarkSources.map((source, index) => (
            <span key={source.id}>
              {index > 0 ? '; ' : ''}
              <a href={source.url} rel="nofollow noopener external" target="_blank">
                {source.title}
              </a>
            </span>
          ))}
        </p>
      )}

      {group.notes.length > 0 && (
        <div className="evidence-notes" role="note">
          <p className="evidence-notes-head">Why these results {group.isCrossModel ? 'are only partly comparable' : 'stand alone'}:</p>
          <ul>
            {group.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="evidence-policy">Assessed under comparability policy {group.policyVersion}.</p>
    </section>
  );
}

export default function BenchmarkExplorer({ dataset, initialSlugs, initialFilters, base }: Props) {
  const [slugs, setSlugs] = useState<string[]>(initialSlugs);
  const [filters, setFilters] = useState<EvidenceFilters>(initialFilters);
  const [enhanced, setEnhanced] = useState(false);
  const [query, setQuery] = useState('');
  const statusRef = useRef<HTMLParagraphElement | null>(null);

  const view = useMemo(
    () => buildBenchmarkExplorerView(dataset, slugs, filters, base),
    [dataset, slugs, filters, base],
  );

  // A static build cannot know the selection, so the URL is read once hydrated
  // and again on every history navigation; without it a shared link would render
  // an empty view.
  useEffect(() => {
    const restore = () => {
      const state = readEvidenceState(window.location.search);
      startTransition(() => {
        setSlugs(state.slugs);
        setFilters(state.filters);
        setEnhanced(true);
      });
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  // Every interactive control is a real link carrying the target state in its
  // href, so it works without JavaScript. When enhanced, the click updates state
  // and pushes history instead of navigating, and moves focus to the live status
  // so the change is announced.
  function follow(href: string, event: { preventDefault: () => void }) {
    if (!enhanced) return;
    event.preventDefault();
    const url = new URL(href, window.location.origin);
    const state = readEvidenceState(url.search);
    startTransition(() => {
      setSlugs(state.slugs);
      setFilters(state.filters);
    });
    window.history.pushState({}, '', href);
    statusRef.current?.focus();
  }

  const needle = query.trim().toLowerCase();
  const candidates = needle
    ? view.candidates.filter(
        (candidate) =>
          candidate.displayName.toLowerCase().includes(needle) ||
          candidate.organizationName.toLowerCase().includes(needle) ||
          candidate.familyName.toLowerCase().includes(needle),
      )
    : view.candidates;

  const selectedNames = view.models.map((model) => model.displayName);

  return (
    <div className="evidence" data-enhanced={enhanced ? 'yes' : 'no'}>
      <noscript>
        <p className="evidence-noscript">
          Which models to explore is read from this page&rsquo;s address, which needs JavaScript on a site built
          entirely ahead of time. Every value below is also on each model&rsquo;s own Model Passport, with the same
          sources and dates.
        </p>
      </noscript>

      {view.selection.rejections.length > 0 && (
        <div className="evidence-rejections" role="alert">
          <h2>Some models were not added</h2>
          <ul>
            {view.selection.rejections.map((rejection) => (
              <li key={`${rejection.code}-${rejection.slug}`} data-code={rejection.code}>
                {rejection.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="evidence-status" tabIndex={-1} ref={statusRef} aria-live="polite">
        {view.selection.slugs.length === 0
          ? 'No models selected. Choose one or more releases to see their benchmark evidence.'
          : `Showing evidence for ${selectedNames.join(', ')}. ${view.filteredResultCount} result${view.filteredResultCount === 1 ? '' : 's'} across ${view.groups.length} benchmark group${view.groups.length === 1 ? '' : 's'}.`}
      </p>

      <section className="evidence-picker" aria-labelledby="evidence-picker-heading">
        <h2 id="evidence-picker-heading">Choose models</h2>
        <p className="evidence-picker-hint">
          Up to {view.maxSelectedModels} models. Each entry is a link, so this works without JavaScript too.
        </p>
        <label className="evidence-search">
          <span>Filter models</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, creator or family"
          />
        </label>
        <ul className="evidence-candidates">
          {candidates.map((candidate) => (
            <li key={candidate.slug}>
              <a
                href={candidate.toggleHref}
                aria-label={candidate.toggleLabel}
                aria-pressed={candidate.selected}
                data-selected={candidate.selected ? 'yes' : 'no'}
                className="evidence-candidate"
                onClick={(event) => follow(candidate.toggleHref, event)}
              >
                <span className="evidence-candidate-name">{candidate.displayName}</span>
                <span className="evidence-candidate-meta">
                  {candidate.organizationName} · {candidate.familyName}
                </span>
                <span className="evidence-candidate-action">
                  {candidate.selected ? 'Remove' : candidate.hasEvidence ? 'Add' : 'Add (no evidence yet)'}
                </span>
              </a>
            </li>
          ))}
        </ul>
        {candidates.length === 0 && <p className="evidence-empty">No model matches &ldquo;{query}&rdquo;.</p>}
      </section>

      {view.models.length > 0 && (
        <section className="evidence-selected" aria-labelledby="evidence-selected-heading">
          <h2 id="evidence-selected-heading">Selected models</h2>
          <ul className="evidence-selected-cards">
            {view.models.map((model) => (
              <li key={model.slug}>
                <a className="evidence-selected-name" href={model.route}>
                  {model.displayName}
                </a>
                <p className="evidence-selected-meta">
                  {model.organizationName} · {model.familyName}
                </p>
                <p className="evidence-selected-count">
                  {model.resultCount} benchmark result{model.resultCount === 1 ? '' : 's'} · record checked {model.verifiedAt}
                </p>
                <a
                  className="evidence-remove"
                  href={model.removeHref}
                  aria-label={model.removeLabel}
                  onClick={(event) => follow(model.removeHref, event)}
                >
                  Remove
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(view.domainFacets.length > 0 || view.benchmarkFacets.length > 0) && (
        <section className="evidence-filters" aria-labelledby="evidence-filters-heading">
          <h2 id="evidence-filters-heading">Filter evidence</h2>
          {view.domainFacets.length > 0 && (
            <div className="evidence-facet-group" role="group" aria-label="Capability domain">
              <span className="evidence-facet-label">Capability domain</span>
              <ul className="evidence-facet-list">
                {view.domainFacets.map((facet) => (
                  <li key={facet.value}>
                    <a
                      href={facet.href}
                      className="evidence-chip"
                      aria-pressed={facet.active}
                      data-active={facet.active ? 'yes' : 'no'}
                      onClick={(event) => follow(facet.href, event)}
                    >
                      {facet.label} <span className="evidence-chip-count">{facet.count}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {view.benchmarkFacets.length > 0 && (
            <div className="evidence-facet-group" role="group" aria-label="Benchmark">
              <span className="evidence-facet-label">Benchmark</span>
              <ul className="evidence-facet-list">
                {view.benchmarkFacets.map((facet) => (
                  <li key={facet.value}>
                    <a
                      href={facet.href}
                      className="evidence-chip"
                      aria-pressed={facet.active}
                      data-active={facet.active ? 'yes' : 'no'}
                      onClick={(event) => follow(facet.href, event)}
                    >
                      {facet.label} <span className="evidence-chip-count">{facet.count}</span>
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(view.filters.domain || view.filters.benchmark) && (
            <a
              className="evidence-clear"
              href={view.clearFiltersHref}
              onClick={(event) => follow(view.clearFiltersHref, event)}
            >
              Clear filters
            </a>
          )}
        </section>
      )}

      {view.comparabilityNotice && (
        <section className="evidence-notice" role="note" aria-labelledby="evidence-notice-heading">
          <h2 id="evidence-notice-heading">No comparable evidence across these models</h2>
          <p>{view.comparabilityNotice.reason}</p>
          <ul className="evidence-next-actions">
            {view.comparabilityNotice.nextActions.map((action) => (
              <li key={action.label}>
                {action.href ? <a href={action.href}>{action.label}</a> : action.label}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.emptyState ? (
        <section className="evidence-emptystate" data-code={view.emptyState.code} aria-labelledby="evidence-empty-heading">
          <h2 id="evidence-empty-heading">{view.emptyState.heading}</h2>
          <p>{view.emptyState.reason}</p>
          {view.emptyState.nextActions.length > 0 && (
            <ul className="evidence-next-actions">
              {view.emptyState.nextActions.map((action) => (
                <li key={action.label}>
                  {action.href ? <a href={action.href}>{action.label}</a> : action.label}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : (
        <>
          {view.comparableGroups.length > 0 && (
            <section className="evidence-section" aria-labelledby="evidence-comparable-heading">
              <h2 id="evidence-comparable-heading">Comparable evidence</h2>
              <p className="evidence-section-hint">
                These benchmarks were measured on two or more of your models under setups that can be read against each
                other. Within each benchmark, rows run best-first by that benchmark&rsquo;s own declared direction; that
                is not an overall or cross-benchmark ranking, and there is no combined score across benchmarks.
              </p>
              {view.comparableGroups.map((group) => (
                <GroupTable key={group.key} group={group} />
              ))}
            </section>
          )}

          {view.singleModelGroups.length > 0 && (
            <section className="evidence-section" aria-labelledby="evidence-direct-heading">
              <h2 id="evidence-direct-heading">Direct evidence</h2>
              <p className="evidence-section-hint">
                Each of these was measured on only one of your selected models, or under a setup that keeps it out of a
                shared group. It is shown on its own rather than placed on a scale it does not share.
              </p>
              {view.singleModelGroups.map((group) => (
                <GroupTable key={group.key} group={group} />
              ))}
            </section>
          )}
        </>
      )}

      <p className="evidence-permalink">
        <a href={benchmarksRoute(base)}>Start a new evidence view</a>
      </p>
    </div>
  );
}
