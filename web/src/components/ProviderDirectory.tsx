import { startTransition, useEffect, useMemo, useRef, useState } from 'react';
import { formatDate, formatNumber } from '../lib/format';
import {
  filterDirectory,
  letterSectionId,
  OTHER_INITIAL,
  parseDirectoryQuery,
  serializeDirectoryQuery,
  type DirectoryEntry,
  type DirectoryGroup,
  type DirectoryModel,
} from '../lib/provider-directory';

interface Props {
  directory: DirectoryModel;
}

function countText(count: number, noun: { one: string; many: string }) {
  return `${formatNumber(count)} ${count === 1 ? noun.one : noun.many}`;
}

function entryDetail(entry: DirectoryEntry) {
  if (entry.kind === 'creator') {
    const parts = [
      countText(entry.familyCount, { one: 'family', many: 'families' }),
      countText(entry.releaseCount, { one: 'release', many: 'releases' }),
    ];
    if (entry.operatedPlatformCount > 0) {
      parts.push(
        `also operates ${countText(entry.operatedPlatformCount, {
          one: 'serving platform',
          many: 'serving platforms',
        })}`,
      );
    }
    return parts.join(' · ');
  }

  return [
    `operated by ${entry.operatorName}`,
    countText(entry.servedReleaseCount, { one: 'release served', many: 'releases served' }),
  ].join(' · ');
}

export default function ProviderDirectory({ directory }: Props) {
  const [query, setQuery] = useState('');
  const [enhanced, setEnhanced] = useState(false);
  const sectionRefs = useRef(new Map<string, HTMLElement | null>());

  const view = useMemo(() => filterDirectory(directory, query), [directory, query]);
  const searching = query.trim().length > 0;

  // Read the shareable search out of the URL once hydrated, so a reload, a back
  // or forward navigation, and a copied link all restore the same view.
  useEffect(() => {
    const restore = () => {
      startTransition(() => {
        setQuery(parseDirectoryQuery(window.location.search));
        setEnhanced(true);
      });
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, []);

  function apply(next: string) {
    setQuery(next);
    if (typeof window === 'undefined') return;
    const search = serializeDirectoryQuery(next);
    window.history.replaceState({}, '', `${window.location.pathname}${search}${window.location.hash}`);
  }

  /**
   * Moves the reading position to the letter that was activated.
   *
   * The default fragment navigation is deliberately left to happen -- it keeps
   * the letter shareable in the URL and keeps the jump working with no
   * JavaScript at all -- but it moves the viewport without reliably moving
   * focus, so a keyboard or screen-reader user lands back at the top of the
   * page on the next Tab. Focusing the section itself is what actually carries
   * them there, which is why each section is a focus target.
   */
  function jumpToSection(id: string) {
    sectionRefs.current.get(id)?.focus();
  }

  function registerSection(id: string) {
    return (node: HTMLElement | null) => {
      sectionRefs.current.set(id, node);
    };
  }

  function renderGroup(group: DirectoryGroup) {
    const headingId = `directory-${group.id}-heading`;
    const listId = `directory-${group.id}-entries`;
    const populated = group.letters.filter((letter) => letter.entries.length > 0);

    return (
      <section className="directory-group" key={group.id} aria-labelledby={headingId}>
        <header className="directory-group-head">
          <h2 id={headingId}>{group.label}</h2>
          <p className="directory-count">{countText(group.total, group.noun)}</p>
          <p className="directory-role-note">{group.roleDescription}</p>
        </header>

        {group.total === 0 ? (
          <p className="directory-empty">
            {searching
              ? `No ${group.noun.many} match “${query.trim()}”.`
              : group.emptyMessage}
          </p>
        ) : (
          <>
            <nav className="directory-alphabet" aria-label={`Jump to a letter in ${group.label}`}>
              <a className="directory-skip" href={`#${listId}`} onClick={() => jumpToSection(listId)}>
                Skip the A to Z links
              </a>
              {/*
                Said once, up front, instead of on all twenty-something empty
                letters: repeating "no entries" per letter would make the bar
                slower to listen to than the directory it navigates. The empty
                letters are still rendered rather than dropped, so the bar keeps
                one shape as the data grows, and they are plain text rather than
                links so no control leads nowhere.
              */}
              <p className="visually-hidden">
                Letters with no {group.noun.many} are listed but are not links.
              </p>
              <ul className="directory-letters">
                {group.letters.map((letter) => {
                  const id = letterSectionId(group.id, letter.letter);
                  const empty = letter.entries.length === 0;
                  return (
                    <li key={letter.key}>
                      {empty ? (
                        <span className="directory-letter is-empty">{letter.letter}</span>
                      ) : (
                        <a
                          className="directory-letter"
                          href={`#${id}`}
                          onClick={() => jumpToSection(id)}
                        >
                          {letter.letter}
                          <span className="visually-hidden">
                            , {countText(letter.entries.length, group.noun)}
                          </span>
                        </a>
                      )}
                    </li>
                  );
                })}
              </ul>
            </nav>

            <div className="directory-entries" id={listId} tabIndex={-1} ref={registerSection(listId)}>
              {populated.map((letter) => {
                const id = letterSectionId(group.id, letter.letter);
                const letterHeadingId = `${id}-heading`;
                return (
                  <section
                    className="directory-letter-section"
                    key={letter.key}
                    id={id}
                    tabIndex={-1}
                    aria-labelledby={letterHeadingId}
                    ref={registerSection(id)}
                  >
                    <h3 id={letterHeadingId}>
                      <span aria-hidden="true">{letter.letter}</span>
                      <span className="visually-hidden">
                        {letter.letter === OTHER_INITIAL ? 'Other names' : letter.letter} in {group.label},{' '}
                        {countText(letter.entries.length, group.noun)}
                      </span>
                    </h3>
                    <ul className="directory-rows">
                      {letter.entries.map((entry) => (
                        <li className="directory-row" key={entry.id}>
                          <p className="directory-name">
                            {entry.href ? (
                              <a href={entry.href}>{entry.name}</a>
                            ) : (
                              <span>{entry.name}</span>
                            )}
                          </p>
                          <p className="directory-role">
                            <span className="directory-tag">{entry.roleText}</span>
                            <span className="directory-type">{entry.typeText}</span>
                          </p>
                          <p className="directory-metrics">{entryDetail(entry)}</p>
                          {entry.unlinkedNote ? (
                            <p className="directory-unlinked">{entry.unlinkedNote}</p>
                          ) : null}
                          <p className="directory-verified">Verified {formatDate(entry.verifiedAt)}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </>
        )}
      </section>
    );
  }

  return (
    <div className="provider-directory" data-enhanced={enhanced ? 'true' : 'false'}>
      <form className="directory-toolbar" role="search" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="directory-search-input">Search creators and serving platforms</label>
        <input
          id="directory-search-input"
          type="search"
          name="q"
          value={query}
          autoComplete="off"
          placeholder="Name, operator, or platform type"
          onChange={(event) => apply(event.target.value)}
        />
        {query ? (
          <button type="button" className="directory-clear" onClick={() => apply('')}>
            Clear search
          </button>
        ) : null}
      </form>

      <p className="directory-summary" aria-live="polite">
        {searching
          ? `${countText(view.totalEntries, { one: 'entry', many: 'entries' })} matching “${query.trim()}”.`
          : `${countText(view.totalEntries, { one: 'entry', many: 'entries' })} in the directory.`}
      </p>

      {view.groups.map(renderGroup)}

      {/*
        A coverage note, not a third role: these organizations publish no family
        and operate no platform, so the data evidences no role for them and this
        page will not invent one from their name or company type. It is hidden
        while a search is active because it answers a question about the whole
        dataset, not about the query.
      */}
      {!searching && directory.unclassified.length > 0 ? (
        <section className="directory-unclassified" aria-labelledby="directory-unclassified-heading">
          <h2 id="directory-unclassified-heading">Organizations with no role recorded yet</h2>
          <p>
            These organizations are in the data but publish no model family and operate no serving
            platform, so neither role is evidenced. They are named here rather than filed under a
            role they have not been shown to hold.
          </p>
          <ul>
            {directory.unclassified.map((organization) => (
              <li key={organization.id}>
                {organization.name}
                <span className="directory-verified"> — verified {formatDate(organization.verifiedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
