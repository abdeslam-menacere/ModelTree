import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';
import type { HomeEntityType, HomeSuggestion, HomepageSearchIndex } from '../lib/homepage-search';
import {
  clearAllHomeFilters,
  clearHomeFilterValue,
  deriveHomeSearchResults,
  defaultHomeSearchState,
  hasActiveFilters,
  hasActiveQueryOrFilters,
  homeSuggestionsFor,
  HOME_FILTER_DIMENSIONS,
  parseHomeSearchState,
  serializeHomeSearchState,
  toggleHomeFilterValue,
  type HomeFilterKey,
  type HomeSearchState,
} from '../lib/homepage-search-view';
import { accessLabel, formatReleaseDate, statusLabel } from '../lib/format';

interface Props {
  index: HomepageSearchIndex;
}

const ENTITY_LABELS: Record<HomeEntityType, string> = {
  model: 'Model',
  family: 'Family',
  organization: 'Creator',
  product: 'Product',
};

const SUGGESTION_LIMIT = 8;

export default function HomepageSearch({ index }: Props) {
  const [state, setState] = useState<HomeSearchState>(defaultHomeSearchState());
  const [enhanced, setEnhanced] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const listboxId = useId();
  const optionId = (position: number) => `${listboxId}-option-${position}`;
  const searchRef = useRef<HTMLInputElement | null>(null);

  const results = useMemo(() => deriveHomeSearchResults(index, state), [index, state]);
  const suggestions = useMemo(
    () => homeSuggestionsFor(index, state.query, SUGGESTION_LIMIT),
    [index, state.query],
  );

  // Restore the shareable view once hydrated, so a reload, a back/forward
  // navigation, or a copied link all land on the same query, filters, and
  // selection. `popstate` covers browser history; the initial call covers reload.
  useEffect(() => {
    const restore = () => {
      setState(parseHomeSearchState(window.location.search, index));
      setEnhanced(true);
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [index]);

  function apply(next: HomeSearchState) {
    setState(next);
    if (typeof window === 'undefined') return;
    const query = serializeHomeSearchState(next, index);
    window.history.replaceState({}, '', `${window.location.pathname}${query}${window.location.hash}`);
  }

  function updateQuery(query: string) {
    apply({ ...state, query, selected: null });
    setOpen(query.trim().length > 0);
    setActiveIndex(-1);
  }

  function chooseSuggestion(suggestion: HomeSuggestion) {
    // A model or single-routed product suggestion pins that release; a family,
    // creator, or multi-routed product narrows the query instead.
    apply({
      ...state,
      query: suggestion.term,
      selected: suggestion.targetSlug,
    });
    setOpen(false);
    setActiveIndex(-1);
    searchRef.current?.focus();
  }

  function handleSearchKeys(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!suggestions.length) return;
      setOpen(true);
      setActiveIndex((current) => (current + 1) % suggestions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!suggestions.length) return;
      setOpen(true);
      setActiveIndex((current) => (current <= 0 ? suggestions.length - 1 : current - 1));
    } else if (event.key === 'Enter') {
      if (open && activeIndex >= 0 && suggestions[activeIndex]) {
        event.preventDefault();
        chooseSuggestion(suggestions[activeIndex]);
      }
    } else if (event.key === 'Escape') {
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActiveIndex(-1);
      }
    }
  }

  const showListbox = enhanced && open && suggestions.length > 0;
  const noResults = results.total === 0;
  const canReset = hasActiveQueryOrFilters(state);

  function filterGroup(key: HomeFilterKey) {
    const dimension = HOME_FILTER_DIMENSIONS.find((entry) => entry.key === key)!;
    const options = index.facets[dimension.facet];
    if (!options.length) return null;
    const selected = new Set(state.filters[key]);
    return (
      <fieldset className="home-search-filter-group" key={key}>
        <legend>{dimension.label}</legend>
        <div className="home-search-filter-options">
          {options.map((option) => (
            <label className="home-search-filter-option" key={option.value}>
              <input
                type="checkbox"
                name={dimension.param}
                value={option.value}
                checked={selected.has(option.value)}
                onChange={() => apply(toggleHomeFilterValue(state, key, option.value))}
              />
              <span className="home-search-filter-label">{option.label}</span>
              <span className="home-search-filter-count" aria-hidden="true">{option.count}</span>
              <span className="visually-hidden">{option.count} releases</span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  return (
    <section className="home-search" aria-labelledby="home-search-title" data-enhanced={enhanced ? 'true' : 'false'}>
      <div className="home-search-head">
        <span className="eyebrow">Find a release</span>
        <h2 id="home-search-title">Search featured models, families, and creators.</h2>
        <p>
          Look up a model by name, a known API alias, its family, or its creator, then
          narrow by category, access, status, or release period.
        </p>
      </div>

      <form className="home-search-toolbar" role="search" onSubmit={(event) => event.preventDefault()}>
        <div className="home-search-field">
          <label htmlFor="home-search-input">Search featured releases</label>
          <div className="home-search-input-wrap">
            <Search className="home-search-icon" size={18} aria-hidden="true" />
            <input
              id="home-search-input"
              ref={searchRef}
              type="text"
              role="combobox"
              autoComplete="off"
              aria-autocomplete="list"
              aria-expanded={showListbox}
              aria-controls={listboxId}
              aria-activedescendant={showListbox && activeIndex >= 0 ? optionId(activeIndex) : undefined}
              placeholder="Search by model, alias, family, or creator"
              value={state.query}
              onChange={(event) => updateQuery(event.target.value)}
              onKeyDown={handleSearchKeys}
              onFocus={() => setOpen(state.query.trim().length > 0)}
              onBlur={() => window.setTimeout(() => setOpen(false), 120)}
            />
            {state.query && (
              <button
                type="button"
                className="home-search-clear-input"
                onClick={() => { updateQuery(''); searchRef.current?.focus(); }}
              >
                <X size={16} aria-hidden="true" />
                <span className="visually-hidden">Clear search</span>
              </button>
            )}
          </div>
          <ul
            className="home-search-listbox"
            id={listboxId}
            role="listbox"
            aria-label="Search suggestions"
            hidden={!showListbox}
          >
            {suggestions.map((suggestion, position) => (
              <li
                key={`${suggestion.entity}:${suggestion.normalized}:${suggestion.targetSlug ?? ''}`}
                id={optionId(position)}
                role="option"
                aria-selected={position === activeIndex}
                className="home-search-option"
                data-active={position === activeIndex ? 'true' : 'false'}
                // Mouse down fires before the input blur, so the choice is not lost.
                onMouseDown={(event) => { event.preventDefault(); chooseSuggestion(suggestion); }}
                onMouseEnter={() => setActiveIndex(position)}
              >
                <span className="home-search-option-term">{suggestion.term}</span>
                <span className="home-search-option-entity" data-entity={suggestion.entity}>
                  {ENTITY_LABELS[suggestion.entity]}
                </span>
                <span className="home-search-option-context">{suggestion.context}</span>
              </li>
            ))}
          </ul>
        </div>

        <button
          type="button"
          className="home-search-filters-toggle"
          aria-expanded={filtersOpen}
          aria-controls="home-search-filters"
          onClick={() => setFiltersOpen((value) => !value)}
        >
          Filters{hasActiveFilters(state) ? ` · ${results.active.length}` : ''}
        </button>
      </form>

      <div className="home-search-filters" id="home-search-filters" hidden={!filtersOpen}>
        {HOME_FILTER_DIMENSIONS.map((dimension) => filterGroup(dimension.key))}
      </div>

      <div className="home-search-results-head">
        <p className="home-search-count" role="status" aria-live="polite">
          {noResults
            ? 'No featured releases match the current search'
            : `${results.total} ${results.total === 1 ? 'release' : 'releases'}`}
          {results.selected && !noResults && (
            <span className="home-search-selected-note"> · showing {results.selected.name}</span>
          )}
        </p>
        {(results.active.length > 0 || state.query) && (
          <ul className="home-search-active" aria-label="Active filters">
            {state.query && (
              <li>
                <button
                  type="button"
                  className="home-search-chip"
                  onClick={() => updateQuery('')}
                >
                  <span>Search: “{state.query}”</span>
                  <span className="visually-hidden">, remove search</span>
                  <span aria-hidden="true">×</span>
                </button>
              </li>
            )}
            {results.active.map((filter) => (
              <li key={`${filter.key}:${filter.value}`}>
                <button
                  type="button"
                  className="home-search-chip"
                  onClick={() => apply(clearHomeFilterValue(state, filter.key, filter.value))}
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
        <div className="home-search-empty">
          <p>
            No featured releases match {canReset ? 'this search' : 'the homepage'}. The homepage
            covers featured releases only — the full catalog is searchable from the model directory.
          </p>
          {canReset && (
            <button
              type="button"
              className="home-search-reset"
              onClick={() => apply(clearAllHomeFilters(state))}
            >
              Clear search and filters
            </button>
          )}
        </div>
      ) : (
        <ul className="home-search-results">
          {results.matches.map((row) => (
            <li
              className="home-search-result"
              key={row.slug}
              aria-current={results.selected?.slug === row.slug ? 'true' : undefined}
              data-selected={results.selected?.slug === row.slug ? 'true' : 'false'}
            >
              <a href={row.route} className="home-search-result-title">{row.name}</a>
              <p className="home-search-result-meta">
                {row.organizationName} · {row.familyName}
              </p>
              <dl className="home-search-result-facts">
                <div><dt>Released</dt><dd>{formatReleaseDate(row.releaseDate, row.datePrecision)}</dd></div>
                <div><dt>Status</dt><dd>{statusLabel(row.status as never)}</dd></div>
                <div><dt>Access</dt><dd>{accessLabel(row.accessType as never)}</dd></div>
              </dl>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
