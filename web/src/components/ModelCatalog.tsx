import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { CatalogFacets, ModelIndexRow } from '../lib/catalog';
import { contextTierLabel, contextTierOf } from '../lib/catalog';
import {
  CATALOG_PAGE_SIZE,
  clearAllFilters,
  clearFilterValue,
  defaultCatalogState,
  deriveCatalogResults,
  FILTER_DIMENSIONS,
  hasActiveFilters,
  MODEL_SORTS,
  parseCatalogState,
  serializeCatalogState,
  SORT_LABELS,
  toggleFilterValue,
  type CatalogView,
  type CatalogViewState,
  type FilterKey,
} from '../lib/catalog-view';
import { accessLabel, formatDate, statusLabel } from '../lib/format';

interface Props {
  models: ModelIndexRow[];
  facets: CatalogFacets;
}

const VIEW_LABELS: Record<CatalogView, string> = {
  table: 'Table',
  list: 'Compact list',
};

function contextTierText(row: ModelIndexRow) {
  return row.contextWindow === null
    ? contextTierLabel('unknown')
    : contextTierLabel(contextTierOf(row.contextWindow));
}

export default function ModelCatalog({ models, facets }: Props) {
  const [state, setState] = useState<CatalogViewState>(defaultCatalogState());
  const [enhanced, setEnhanced] = useState(false);
  const pageButtonRefs = useRef(new Map<number, HTMLButtonElement | null>());
  const pendingFocusPage = useRef<number | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(
    () => deriveCatalogResults(models, state, facets, CATALOG_PAGE_SIZE),
    [models, state, facets],
  );

  // Read the shareable view out of the URL once hydrated, so a reload, a back or
  // forward navigation, or a copied link all restore the same catalog view.
  useEffect(() => {
    const restore = () => {
      startTransition(() => {
        setState(parseCatalogState(window.location.search, facets));
        setEnhanced(true);
      });
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [facets]);

  // Focus the page control the reader just moved to, so keyboard focus is never
  // lost when a page changes or a Prev/Next button disables at a bound.
  useEffect(() => {
    if (pendingFocusPage.current === null) return;
    const target = pageButtonRefs.current.get(pendingFocusPage.current);
    pendingFocusPage.current = null;
    target?.focus();
  }, [results.page]);

  function apply(next: CatalogViewState) {
    setState(next);
    if (typeof window === 'undefined') return;
    const query = serializeCatalogState(next, facets);
    window.history.replaceState({}, '', `${window.location.pathname}${query}${window.location.hash}`);
  }

  function goToPage(page: number, focus = false) {
    if (page < 1 || page > results.pageCount || page === results.page) return;
    if (focus) pendingFocusPage.current = page;
    apply({ ...state, page });
  }

  const sortValues = MODEL_SORTS;
  const viewValues: CatalogView[] = ['table', 'list'];
  const pageNumbers = Array.from({ length: results.pageCount }, (_, index) => index + 1);
  const noResults = results.total === 0;

  function facetGroup(key: FilterKey) {
    const dimension = FILTER_DIMENSIONS.find((entry) => entry.key === key)!;
    const options = facets[dimension.facet];
    if (!options.length) return null;
    const selected = new Set(state.filters[key]);
    return (
      <fieldset className="catalog-filter-group" key={key}>
        <legend>{dimension.label}</legend>
        <div className="catalog-filter-options">
          {options.map((option) => (
            <label className="catalog-filter-option" key={option.value}>
              <input
                type="checkbox"
                name={dimension.param}
                value={option.value}
                checked={selected.has(option.value)}
                onChange={() => apply(toggleFilterValue(state, key, option.value))}
              />
              <span className="catalog-filter-label">{option.label}</span>
              <span className="catalog-filter-count" aria-hidden="true">{option.count}</span>
              <span className="visually-hidden">{option.count} models</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  function handlePaginationKeys(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Home') {
      event.preventDefault();
      goToPage(1, true);
    } else if (event.key === 'End') {
      event.preventDefault();
      goToPage(results.pageCount, true);
    }
  }

  return (
    <section className="model-catalog" data-enhanced={enhanced ? 'true' : 'false'} data-view={state.view}>
      <form className="catalog-toolbar" role="search" onSubmit={(event) => event.preventDefault()}>
        <div className="catalog-search">
          <label htmlFor="catalog-search-input">Search models</label>
          <input
            id="catalog-search-input"
            ref={searchRef}
            type="search"
            autoComplete="off"
            placeholder="Search by model, family, or creator"
            value={state.search}
            onChange={(event) => apply({ ...state, search: event.target.value, page: 1 })}
          />
        </div>
        <div className="catalog-sort">
          <label htmlFor="catalog-sort-select">Sort by</label>
          <select
            id="catalog-sort-select"
            value={state.sort}
            onChange={(event) => apply({ ...state, sort: event.target.value as CatalogViewState['sort'] })}
          >
            {sortValues.map((sort) => (
              <option value={sort} key={sort}>{SORT_LABELS[sort]}</option>
            ))}
          </select>
        </div>
        <div className="catalog-view-toggle" role="group" aria-label="Result layout">
          {viewValues.map((view) => (
            <button
              type="button"
              key={view}
              className="catalog-view-button"
              aria-pressed={state.view === view}
              onClick={() => apply({ ...state, view })}
            >
              {VIEW_LABELS[view]}
            </button>
          ))}
        </div>
      </form>

      <div className="catalog-body">
        <aside className="catalog-filters" aria-label="Filters">
          <div className="catalog-filters-head">
            <h2>Filters</h2>
            <button
              type="button"
              className="catalog-clear-all"
              onClick={() => apply(clearAllFilters(state))}
              disabled={!hasActiveFilters(state)}
            >
              Clear all
            </button>
          </div>
          {FILTER_DIMENSIONS.map((dimension) => facetGroup(dimension.key))}
        </aside>

        <div className="catalog-results">
          <div className="catalog-results-head">
            <p className="catalog-count" role="status" aria-live="polite">
              {noResults
                ? 'No models match the current filters'
                : `${results.total} ${results.total === 1 ? 'model' : 'models'}`}
              {!noResults && results.pageCount > 1 && (
                <span className="catalog-range"> · showing {results.pageStart}–{results.pageEnd}</span>
              )}
            </p>
            {results.active.length > 0 && (
              <ul className="catalog-active-filters" aria-label="Active filters">
                {state.search && (
                  <li>
                    <button
                      type="button"
                      className="catalog-chip"
                      onClick={() => apply({ ...state, search: '', page: 1 })}
                    >
                      <span>Search: “{state.search}”</span>
                      <span className="visually-hidden">, remove search</span>
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                )}
                {results.active.map((filter) => (
                  <li key={`${filter.key}:${filter.value}`}>
                    <button
                      type="button"
                      className="catalog-chip"
                      onClick={() => apply(clearFilterValue(state, filter.key, filter.value))}
                    >
                      <span>{filter.dimensionLabel}: {filter.label}</span>
                      <span className="visually-hidden">, remove filter</span>
                      <span aria-hidden="true">×</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {noResults ? (
            <div className="catalog-empty">
              <p>No models match {hasActiveFilters(state) ? 'these filters' : 'the catalog'}.</p>
              {hasActiveFilters(state) && (
                <div className="catalog-empty-actions">
                  {state.search && (
                    <button type="button" onClick={() => apply({ ...state, search: '', page: 1 })}>
                      Clear search
                    </button>
                  )}
                  {results.active.map((filter) => (
                    <button
                      type="button"
                      key={`${filter.key}:${filter.value}`}
                      onClick={() => apply(clearFilterValue(state, filter.key, filter.value))}
                    >
                      Clear {filter.dimensionLabel}: {filter.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="catalog-clear-all"
                    onClick={() => apply(clearAllFilters(state))}
                  >
                    Clear all filters
                  </button>
                </div>
              )}
            </div>
          ) : state.view === 'table' ? (
            <div className="catalog-table-scroll">
              <table className="catalog-table">
                <caption className="visually-hidden">
                  Model catalog, sorted by {SORT_LABELS[state.sort].toLowerCase()}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Model</th>
                    <th scope="col">Creator</th>
                    <th scope="col">Family</th>
                    <th scope="col">Released</th>
                    <th scope="col">Status</th>
                    <th scope="col">Access</th>
                    <th scope="col">Context</th>
                    <th scope="col">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {results.pageRows.map((row) => (
                    <tr key={row.slug}>
                      <th scope="row" data-label="Model">
                        <a href={row.route}>{row.name}</a>
                      </th>
                      <td data-label="Creator">{row.organizationName}</td>
                      <td data-label="Family">{row.familyName}</td>
                      <td data-label="Released">{formatDate(row.releaseDate)}</td>
                      <td data-label="Status">{statusLabel(row.status as never)}</td>
                      <td data-label="Access">{accessLabel(row.accessType as never)}</td>
                      <td data-label="Context">{contextTierText(row)}</td>
                      <td data-label="Price">{row.hasPublishedPrice ? 'Published' : 'Not published'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <ul className="catalog-list">
              {results.pageRows.map((row) => (
                <li className="catalog-list-item" key={row.slug}>
                  <a href={row.route} className="catalog-list-title">{row.name}</a>
                  <p className="catalog-list-meta">
                    {row.organizationName} · {row.familyName}
                  </p>
                  <dl className="catalog-list-facts">
                    <div><dt>Released</dt><dd>{formatDate(row.releaseDate)}</dd></div>
                    <div><dt>Status</dt><dd>{statusLabel(row.status as never)}</dd></div>
                    <div><dt>Access</dt><dd>{accessLabel(row.accessType as never)}</dd></div>
                    <div><dt>Context</dt><dd>{contextTierText(row)}</dd></div>
                    <div><dt>Price</dt><dd>{row.hasPublishedPrice ? 'Published' : 'Not published'}</dd></div>
                  </dl>
                </li>
              ))}
            </ul>
          )}

          {results.pageCount > 1 && (
            <nav
              className="catalog-pagination"
              aria-label="Catalog pages"
              onKeyDown={handlePaginationKeys}
            >
              <button
                type="button"
                className="catalog-page-step"
                onClick={() => goToPage(results.page - 1, true)}
                disabled={results.page === 1}
              >
                Previous
              </button>
              <ul className="catalog-page-list">
                {pageNumbers.map((page) => (
                  <li key={page}>
                    <button
                      type="button"
                      className="catalog-page-number"
                      ref={(node) => { pageButtonRefs.current.set(page, node); }}
                      aria-label={`Page ${page}`}
                      aria-current={page === results.page ? 'page' : undefined}
                      onClick={() => goToPage(page, true)}
                    >
                      {page}
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                className="catalog-page-step"
                onClick={() => goToPage(results.page + 1, true)}
                disabled={results.page === results.pageCount}
              >
                Next
              </button>
            </nav>
          )}
        </div>
      </div>
    </section>
  );
}
