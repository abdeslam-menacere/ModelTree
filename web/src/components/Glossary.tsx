import { startTransition, useEffect, useMemo, useState } from 'react';
import { ExternalLink, Link2 } from 'lucide-react';
import type { GlossaryEntry } from '../data/glossary-schema';
import {
  createGlossarySearchUrl,
  glossaryCountText,
  parseGlossaryAnchor,
  parseGlossaryQuery,
  searchGlossary,
} from '../lib/glossary';

interface Props {
  entries: GlossaryEntry[];
}

const CATEGORY_LABELS: Record<GlossaryEntry['category'], string> = {
  parameters: 'Parameter notation',
  architecture: 'Architecture',
  openness: 'Openness',
  context: 'Context units',
  precision: 'Numeric precision',
  identifiers: 'Identifiers',
  versioning: 'Versions and aliases',
  tuning: 'Tuning',
};

/**
 * The searchable glossary.
 *
 * Every entry is rendered on the server, so a reader with no JavaScript gets the
 * whole glossary, every source, and every working anchor; hydration only adds
 * the search box. The query is written to the URL, so a search is shareable and
 * survives a reload or a Back navigation, and each entry's `id` is its anchor,
 * so a single term is shareable too.
 *
 * The entry a fragment names is never filtered away. A link carrying both a
 * query and a fragment would otherwise scroll to an element the search had just
 * removed, which is a dead shared link — the exact failure the acceptance
 * criterion is guarding. Such an entry is kept and labelled as kept, rather than
 * silently widening the result set.
 */
export default function Glossary({ entries }: Props) {
  const [query, setQuery] = useState('');
  const [pinnedId, setPinnedId] = useState<string | null>(null);

  const matches = useMemo(
    () => searchGlossary(entries, query, pinnedId),
    [entries, query, pinnedId],
  );

  // The count states how many entries the *search* found. An entry held in view
  // only because the fragment names it is not one of them, and counting it would
  // overstate the search by one.
  const matchedCount = useMemo(
    () => matches.filter((match) => !match.pinned || isTextMatch(match.entry, query)).length,
    [matches, query],
  );

  useEffect(() => {
    const restore = () => {
      startTransition(() => {
        setQuery(parseGlossaryQuery(window.location.search));
        setPinnedId(parseGlossaryAnchor(window.location.hash, entries));
      });
    };

    restore();
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    return () => {
      window.removeEventListener('popstate', restore);
      window.removeEventListener('hashchange', restore);
    };
  }, [entries]);

  function apply(next: string) {
    setQuery(next);
    if (typeof window === 'undefined') return;
    window.history.replaceState({}, '', createGlossarySearchUrl(window.location.href, next));
  }

  const shown = matches.length;

  return (
    <div className="glossary">
      <div className="glossary-search">
        <label htmlFor="glossary-search">Search terms, aliases, and definitions</label>
        <input
          id="glossary-search"
          type="search"
          value={query}
          autoComplete="off"
          placeholder="Try MoE, 16E, -Instruct, or Q4_K_M"
          onChange={(event) => apply(event.target.value)}
        />
      </div>

      <p className="glossary-count" id="glossary-count" aria-live="polite">
        {glossaryCountText(matchedCount, entries.length, query)}
      </p>

      {shown === 0 ? (
        <p className="glossary-empty">
          Nothing here matches that. The glossary records naming terms only, so model, creator, and
          platform names live in the catalog and the directory instead.
        </p>
      ) : (
        <div className="glossary-results" id="glossary-results">
          {matches.map(({ entry, matchedAlias, pinned }) => (
            <article className="glossary-entry" id={entry.id} key={entry.id}>
              <header className="glossary-entry-head">
                <h2>
                  {entry.term}
                  <a
                    className="glossary-anchor"
                    href={`#${entry.id}`}
                    aria-label={`Link to ${entry.term}`}
                  >
                    <Link2 size={15} aria-hidden="true" />
                  </a>
                </h2>
                <span className="glossary-category">{CATEGORY_LABELS[entry.category]}</span>
              </header>

              {matchedAlias && (
                <p className="glossary-alias-hit">
                  Matched the alias “{matchedAlias}”, which resolves to {entry.term}.
                </p>
              )}
              {pinned && query.trim() !== '' && !isTextMatch(entry, query) && (
                <p className="glossary-alias-hit">
                  Kept in view because the link you followed points at this entry, even though it
                  does not match the current search.
                </p>
              )}

              <p className="glossary-short">{entry.short}</p>
              <p className="glossary-definition">{entry.definition}</p>

              {entry.aliases.length > 0 && (
                <p className="glossary-aliases">
                  <span className="glossary-label">Also written</span>
                  {entry.aliases.map((alias) => (
                    <code key={alias}>{alias}</code>
                  ))}
                </p>
              )}

              {entry.distinctions.length > 0 && (
                <div className="glossary-block">
                  <h3>Not the same as</h3>
                  <dl>
                    {entry.distinctions.map((distinction) => (
                      <div key={distinction.from}>
                        <dt>{distinction.from}</dt>
                        <dd>{distinction.note}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {entry.examples.length > 0 && (
                <div className="glossary-block">
                  <h3>In practice</h3>
                  <dl>
                    {entry.examples.map((example) => (
                      <div key={example.notation}>
                        <dt><code>{example.notation}</code></dt>
                        <dd>{example.reading}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              )}

              {entry.conflicts.length > 0 && (
                <div className="glossary-block glossary-conflicts">
                  <h3>Where usage disagrees</h3>
                  {entry.conflicts.map((conflict) => (
                    <p key={conflict.note}>{conflict.note}</p>
                  ))}
                </div>
              )}

              {entry.related.length > 0 && (
                <p className="glossary-related">
                  <span className="glossary-label">Related</span>
                  {entry.related.map((id) => (
                    <a key={id} href={`#${id}`}>
                      {entries.find((candidate) => candidate.id === id)?.term ?? id}
                    </a>
                  ))}
                </p>
              )}

              <div className="glossary-block glossary-sources">
                <h3>Primary sources</h3>
                <ul>
                  {entry.sources.map((source) => (
                    <li key={source.url}>
                      <a href={source.url}>
                        {source.title} <ExternalLink size={12} aria-hidden="true" />
                      </a>
                      <span className="glossary-source-meta">
                        {source.publisher} · checked {source.lastCheckedDate}
                      </span>
                      <blockquote>{source.quote}</blockquote>
                    </li>
                  ))}
                </ul>
                <p className="glossary-verified">Entry verified {entry.verifiedAt}.</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

/** Whether the query matches this entry on its own, ignoring any pinning. */
function isTextMatch(entry: GlossaryEntry, query: string): boolean {
  return searchGlossary([entry], query).length > 0;
}
