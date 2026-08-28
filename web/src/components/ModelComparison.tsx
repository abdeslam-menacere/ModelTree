import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildComparisonCandidates,
  buildModelComparison,
  compareRoute,
  MAX_COMPARISON_MODELS,
  MIN_COMPARISON_MODELS,
  readComparisonSlugs,
  serializeComparisonSelection,
  VALUE_STATE_LABELS,
  type ComparisonCandidate,
  type ComparisonCell,
  type ComparisonDataset,
  type ComparisonGroup,
  type ComparisonRow,
  type ComparisonSourceView,
} from '../lib/comparison';

interface Props {
  dataset: ComparisonDataset;
  /** Build-time selection. Always empty on a static build; the URL wins once hydrated. */
  initialSlugs: string[];
  base: string;
  today: string;
}

function SourceList({ sources, label }: { sources: ComparisonSourceView[]; label: string }) {
  if (sources.length === 0) return null;
  return (
    <ul className="comparison-sources" aria-label={label}>
      {sources.map((source) => (
        <li key={source.id}>
          <a href={source.url} rel="nofollow noopener external" target="_blank">
            {source.title}
          </a>
          <span className="comparison-source-meta">
            {source.publisherName} · checked {source.lastCheckedDate}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Cell({ cell, modelName, rowLabel }: { cell: ComparisonCell; modelName: string; rowLabel: string }) {
  return (
    <td data-model={modelName} data-state={cell.state} className={`comparison-cell state-${cell.state}`}>
      <span className="comparison-value">{cell.value}</span>
      {cell.state !== 'stated' && (
        <span className="comparison-state-tag">{VALUE_STATE_LABELS[cell.state]}</span>
      )}
      {cell.reason && <span className="comparison-reason">{cell.reason}</span>}
      {cell.setup && <span className="comparison-setup">Setup — {cell.setup}</span>}
      {(cell.verifiedAt || cell.effectiveRange) && (
        <span className="comparison-dates">
          {cell.effectiveRange && <span>{cell.effectiveRange}</span>}
          {cell.verifiedAt && <span>Checked {cell.verifiedAt}</span>}
        </span>
      )}
      <SourceList sources={cell.sources} label={`Sources for ${rowLabel} of ${modelName}`} />
    </td>
  );
}

function Row({ row, modelNames }: { row: ComparisonRow; modelNames: string[] }) {
  return (
    <>
      <tr data-row={row.id} data-differs={row.differs ? 'yes' : 'no'}>
        <th scope="row" className="comparison-row-header">
          <span className="comparison-row-label">{row.label}</span>
          {row.volatile && (
            <span className="comparison-volatile" title="This value can change without the model changing">
              can change over time
            </span>
          )}
          {row.note && <span className="comparison-row-note">{row.note}</span>}
        </th>
        {row.cells.map((cell, index) => (
          <Cell key={cell.slug} cell={cell} modelName={modelNames[index] ?? cell.slug} rowLabel={row.label} />
        ))}
      </tr>
      {row.evidence && (
        <tr className="comparison-evidence-row">
          <td colSpan={row.cells.length + 1}>
            <details className="comparison-evidence">
              <summary>
                Comparability of {row.evidence.benchmarkName}: {row.evidence.verdict.replace('-', ' ')}
              </summary>
              <p className="comparison-evidence-summary">{row.evidence.summary}</p>
              <p className="comparison-evidence-direction">{row.evidence.directionNote}</p>
              {row.evidence.evaluationWindow && (
                <p className="comparison-evidence-window">
                  Results evaluated between {row.evidence.evaluationWindow.earliest} and{' '}
                  {row.evidence.evaluationWindow.latest} — {row.evidence.evaluationWindow.spreadMonths} months
                  apart, against a {row.evidence.evaluationWindow.allowedSpreadMonths} month window
                  {row.evidence.evaluationWindow.isVolatile
                    ? '. That spread is wide enough that these results may not describe the same systems.'
                    : '.'}
                </p>
              )}
              {row.evidence.notes.length > 0 && (
                <ul className="comparison-evidence-notes">
                  {row.evidence.notes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>
              )}
              <p className="comparison-evidence-policy">
                Assessed under comparability policy {row.evidence.policyVersion}.
              </p>
            </details>
          </td>
        </tr>
      )}
    </>
  );
}

function Group({ group, modelNames }: { group: ComparisonGroup; modelNames: string[] }) {
  return (
    <section className="comparison-group" aria-labelledby={group.headingId}>
      <h3 id={group.headingId}>{group.title}</h3>
      <p className="comparison-group-description">{group.description}</p>
      <div className="comparison-table-scroll">
        <table className="comparison-table">
          <caption className="visually-hidden">
            {group.title} for {modelNames.join(', ')}. Columns follow the order you selected, which is not a ranking.
          </caption>
          <thead>
            <tr>
              <th scope="col">Attribute</th>
              {modelNames.map((name) => (
                <th scope="col" key={name}>
                  {name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <Row key={row.id} row={row} modelNames={modelNames} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function ModelComparison({ dataset, initialSlugs, base, today }: Props) {
  const [slugs, setSlugs] = useState<string[]>(initialSlugs);
  const [enhanced, setEnhanced] = useState(false);
  const [query, setQuery] = useState('');
  const statusRef = useRef<HTMLParagraphElement | null>(null);

  const view = useMemo(
    () => buildModelComparison(dataset, slugs, base, today),
    [dataset, slugs, base, today],
  );
  const candidates = useMemo(
    () => buildComparisonCandidates(dataset, view.selection.slugs, base),
    [dataset, view.selection.slugs, base],
  );

  // A static build cannot know the selection, so the URL is read once hydrated
  // and again on every history navigation. Without this the page would render an
  // empty comparison for a link somebody shared.
  useEffect(() => {
    const restore = () => {
      startTransition(() => {
        setSlugs(readComparisonSlugs(window.location.search));
        setEnhanced(true);
      });
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  // pushState rather than replaceState: adding or removing a model is a discrete
  // choice about what is being compared, so Back should undo it. The catalog uses
  // replaceState because its filters are a continuous refinement of one view.
  function apply(next: string[]) {
    setSlugs(next);
    if (typeof window === 'undefined') return;
    const query = serializeComparisonSelection(next, window.location.search);
    window.history.pushState({}, '', `${window.location.pathname}${query}${window.location.hash}`);
  }

  function toggle(candidate: ComparisonCandidate, event: { preventDefault: () => void }) {
    if (!enhanced) return;
    event.preventDefault();
    const next = candidate.selected
      ? view.selection.slugs.filter((slug) => slug !== candidate.slug)
      : view.selection.slugs.concat(candidate.slug).slice(0, MAX_COMPARISON_MODELS);
    apply(next);
    statusRef.current?.focus();
  }

  const modelNames = view.models.map((model) => model.displayName);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? candidates.filter(
        (candidate) =>
          candidate.displayName.toLowerCase().includes(needle) ||
          candidate.organizationName.toLowerCase().includes(needle) ||
          candidate.familyName.toLowerCase().includes(needle),
      )
    : candidates;

  return (
    <div className="comparison" data-enhanced={enhanced ? 'yes' : 'no'}>
      <noscript>
        <p className="comparison-noscript">
          Which models to compare is read from this page&rsquo;s address, which needs JavaScript on a site built
          entirely ahead of time. Every value in this table is also on each model&rsquo;s own page, with the same
          sources and dates.
        </p>
      </noscript>

      {view.selection.rejections.length > 0 && (
        <div className="comparison-rejections" role="alert">
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

      <p className="comparison-status" tabIndex={-1} ref={statusRef} aria-live="polite">
        {view.selection.slugs.length === 0
          ? `No models selected. Choose ${MIN_COMPARISON_MODELS} to ${MAX_COMPARISON_MODELS} models to compare.`
          : view.selection.isComparable
            ? `Comparing ${view.selection.slugs.length} models: ${modelNames.join(', ')}.`
            : `${modelNames.join(', ')} selected. Choose ${view.selection.shortfall} more to compare.`}
      </p>

      <section className="comparison-picker" aria-labelledby="comparison-picker-heading">
        <h2 id="comparison-picker-heading">Choose models</h2>
        <p className="comparison-picker-hint">
          Between {MIN_COMPARISON_MODELS} and {MAX_COMPARISON_MODELS} models. Each entry is a link, so this works
          without JavaScript too.
        </p>
        <label className="comparison-search">
          <span>Filter models</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, creator or family"
          />
        </label>
        <ul className="comparison-candidates">
          {shown.map((candidate) => (
            <li key={candidate.slug}>
              <a
                href={candidate.toggleUrl}
                aria-label={candidate.toggleLabel}
                aria-pressed={candidate.selected}
                data-selected={candidate.selected ? 'yes' : 'no'}
                className="comparison-candidate"
                onClick={(event) => toggle(candidate, event)}
              >
                <span className="comparison-candidate-name">{candidate.displayName}</span>
                <span className="comparison-candidate-meta">
                  {candidate.organizationName} · {candidate.familyName}
                </span>
                <span className="comparison-candidate-action">
                  {candidate.selected ? 'Remove' : 'Add'}
                </span>
              </a>
            </li>
          ))}
        </ul>
        {shown.length === 0 && <p className="comparison-empty">No model matches “{query}”.</p>}
      </section>

      {view.selection.isComparable && (
        <>
          <section className="comparison-columns" aria-labelledby="comparison-columns-heading">
            <h2 id="comparison-columns-heading">Models being compared</h2>
            <p className="comparison-no-ranking">{view.noRankingNote}</p>
            <ul className="comparison-column-cards">
              {view.models.map((model) => (
                <li key={model.slug}>
                  <a className="comparison-column-name" href={model.route}>
                    {model.displayName}
                  </a>
                  <p className="comparison-column-meta">
                    {model.organizationName} · {model.familyName}
                  </p>
                  <p className="comparison-column-canonical">{model.canonicalName}</p>
                  <p className="comparison-column-verified">Record checked {model.verifiedAt}</p>
                  <SourceList sources={model.sources} label={`Sources for ${model.displayName}`} />
                  <a
                    className="comparison-remove"
                    href={model.removeUrl}
                    aria-label={model.removeLabel}
                    onClick={(event) => {
                      if (!enhanced) return;
                      event.preventDefault();
                      apply(view.selection.slugs.filter((slug) => slug !== model.slug));
                      statusRef.current?.focus();
                    }}
                  >
                    Remove
                  </a>
                </li>
              ))}
            </ul>
          </section>

          {view.takeaways.length > 0 && (
            <section className="comparison-takeaways" aria-labelledby="comparison-takeaways-heading">
              <h2 id="comparison-takeaways-heading">Differences worth knowing</h2>
              <p className="comparison-takeaways-hint">
                Each of these reads one row where every model states a value and the values differ. None of them
                ranks a model above another.
              </p>
              <ul>
                {view.takeaways.map((takeaway) => (
                  <li key={takeaway.rule} data-rule={takeaway.rule} data-basis={takeaway.basisRowId}>
                    <p className="comparison-takeaway-headline">{takeaway.headline}</p>
                    <p className="comparison-takeaway-detail">{takeaway.detail}</p>
                    <SourceList sources={takeaway.sources} label={`Sources for ${takeaway.headline}`} />
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="comparison-groups" aria-labelledby="comparison-groups-heading">
            <h2 id="comparison-groups-heading">Attributes</h2>
            {view.presentGroups.map((group) => (
              <Group key={group.id} group={group} modelNames={modelNames} />
            ))}
          </section>

          {view.absentGroups.length > 0 && (
            <section className="comparison-absent" aria-labelledby="comparison-absent-heading">
              <h2 id="comparison-absent-heading">What this comparison does not show</h2>
              <p className="comparison-absent-hint">
                These sections are named rather than hidden, because a section that was dropped and a section
                nothing is known about look identical otherwise.
              </p>
              <dl>
                {view.absentGroups.map((group) => (
                  <div key={group.id} data-group={group.id} data-state={group.absence?.state}>
                    <dt>{group.title}</dt>
                    <dd>{group.absence?.reason}</dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          <section className="comparison-legend" aria-labelledby="comparison-legend-heading">
            <h2 id="comparison-legend-heading">How to read a value</h2>
            <dl>
              {view.valueStateLegend.map((entry) => (
                <div key={entry.state} data-state={entry.state}>
                  <dt>{entry.label}</dt>
                  <dd>{entry.definition}</dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}

      <p className="comparison-permalink">
        <a href={compareRoute(base)}>Start a new comparison</a>
      </p>
    </div>
  );
}
