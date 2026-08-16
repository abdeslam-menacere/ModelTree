import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Cloud,
  ExternalLink,
  GitBranch,
} from 'lucide-react';
import { startTransition, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { HomepageOrganization } from '../lib/homepage';
import { accessLabel, formatDate, statusLabel } from '../lib/format';
import { readSelectedModel } from '../lib/selection';

interface SourceSummary {
  title: string;
  url: string;
}

interface Props {
  hierarchy: HomepageOrganization[];
  sourceByReleaseId: Record<string, SourceSummary>;
  basePath: string;
}

export default function LineageExplorer({ hierarchy, sourceByReleaseId, basePath }: Props) {
  const entries = hierarchy.flatMap(({ organization, families }) => families.flatMap(({ family, releases }) => (
    releases.map((release) => ({ organization, family, release }))
  )));
  const defaultSlug = entries[0]?.release.slug ?? '';
  const releaseKey = entries.map(({ release }) => release.slug).join('\0');
  const [selectedSlug, setSelectedSlug] = useState(defaultSlug);
  const nodeRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const selected = entries.find(({ release }) => release.slug === selectedSlug) ?? entries[0];
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;

  useEffect(() => {
    const next = readSelectedModel(
      window.location.search,
      entries.map(({ release }) => release.slug),
      defaultSlug,
    );
    startTransition(() => setSelectedSlug(next));
  }, [defaultSlug, releaseKey]);

  function selectRelease(slug: string) {
    startTransition(() => setSelectedSlug(slug));
  }

  function handleNodeKeyDown(event: KeyboardEvent, index: number) {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % entries.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + entries.length) % entries.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = entries.length - 1;
    }

    if (nextIndex === undefined) return;
    event.preventDefault();
    nodeRefs.current[nextIndex]?.focus();
  }

  let releaseIndex = 0;

  return (
    <section className="lineage-explorer" aria-labelledby="lineage-heading">
      <div className="explorer-heading">
        <div>
          <span className="eyebrow">Complete seed catalog</span>
          <h2 id="lineage-heading">Every creator, family, and release</h2>
        </div>
        <div className="legend" aria-label="Lineage legend">
          <span><CheckCircle2 size={16} aria-hidden="true" /> Available</span>
          <span><Cloud size={16} aria-hidden="true" /> Model Passport</span>
        </div>
      </div>

      <div className="ecosystem-selector" aria-label="Catalog coverage">
        <span>Catalog</span>
        <strong>{hierarchy.length} creators</strong>
        <small>{hierarchy.reduce((count, item) => count + item.families.length, 0)} families · {entries.length} releases</small>
      </div>

      <div className="lineage-stage">
        <div className="lineage-directory">
          {hierarchy.map(({ organization, families }) => (
            <section className="organization-branch" aria-labelledby={`organization-${organization.id}`} key={organization.id}>
              <header className="tree-level tree-root">
                <span className="tree-kicker">Creator</span>
                <strong id={`organization-${organization.id}`}>{organization.name}</strong>
                <small>{families.length} {families.length === 1 ? 'family' : 'families'}</small>
              </header>

              <div className="family-list">
                {families.map(({ family, releases }) => (
                  <article className="family-branch" aria-labelledby={`family-${family.id}`} key={family.id}>
                    <header className="tree-level tree-family">
                      <span className="tree-kicker"><GitBranch size={14} aria-hidden="true" /> Family</span>
                      <h3 id={`family-${family.id}`}>{family.name}</h3>
                      <small>First released {formatDate(family.firstReleaseDate)}</small>
                    </header>

                    <ol className="release-nodes" aria-label={`${family.name} releases`}>
                      {releases.map((release) => {
                        const index = releaseIndex;
                        releaseIndex += 1;
                        const isSelected = release.slug === selected?.release.slug;
                        return (
                          <li key={release.id}>
                            <a
                              ref={(node) => { nodeRefs.current[index] = node; }}
                              className="release-node"
                              data-selected={isSelected ? 'true' : 'false'}
                              href={`${normalizedBase}models/${release.slug}/`}
                              onFocus={() => selectRelease(release.slug)}
                              onMouseEnter={() => selectRelease(release.slug)}
                              onKeyDown={(event) => handleNodeKeyDown(event, index)}
                            >
                              <span className="node-status"><span aria-hidden="true" /> {statusLabel(release.status)}</span>
                              <strong>{release.displayName}</strong>
                              <small>{release.variant} | {formatDate(release.releaseDate)}</small>
                              <span className="node-link">View passport <ArrowUpRight size={14} aria-hidden="true" /></span>
                            </a>
                          </li>
                        );
                      })}
                    </ol>
                  </article>
                ))}
              </div>
            </section>
          ))}
        </div>

        {selected && (
          <aside className="model-summary" aria-live="polite" aria-label={`Selected model: ${selected.release.displayName}`}>
            <div className="summary-topline">
              <span>{selected.organization.shortName} / {selected.family.name}</span>
              <span className="verification-mark"><CheckCircle2 size={15} aria-hidden="true" /> Verified</span>
            </div>
            <h3>{selected.release.displayName}</h3>
            <p className="summary-copy">{selected.release.summary}</p>
            <dl className="summary-facts">
              <div>
                <dt><CalendarDays size={15} aria-hidden="true" /> Release</dt>
                <dd>{formatDate(selected.release.releaseDate)}</dd>
              </div>
              <div>
                <dt><CheckCircle2 size={15} aria-hidden="true" /> Status</dt>
                <dd>{statusLabel(selected.release.status)}</dd>
              </div>
              <div>
                <dt><Cloud size={15} aria-hidden="true" /> Access</dt>
                <dd>{accessLabel(selected.release.accessType)}</dd>
              </div>
            </dl>
            <div className="summary-purpose">
              <span>When to use it</span>
              <p>{selected.release.intendedUse}</p>
            </div>
            <div className="details-actions">
              <a className="primary-action" href={`${normalizedBase}models/${selected.release.slug}/`}>
                View Model Passport <ArrowUpRight size={17} aria-hidden="true" />
              </a>
              {sourceByReleaseId[selected.release.id] && (
                <a className="text-action" href={sourceByReleaseId[selected.release.id].url}>
                  Primary source <ExternalLink size={15} aria-hidden="true" />
                </a>
              )}
            </div>
            {sourceByReleaseId[selected.release.id] && (
              <p className="source-caption">
                {sourceByReleaseId[selected.release.id].title} | Checked {formatDate(selected.release.verifiedAt)}
              </p>
            )}
          </aside>
        )}
      </div>
    </section>
  );
}