import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Cloud,
  ExternalLink,
  GitBranch,
  Info,
} from 'lucide-react';
import {
  startTransition,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type { ModelFamily, ModelRelease, Organization } from '../data/schema';
import { accessLabel, formatDate, statusLabel } from '../lib/format';
import { createModelSelectionUrl, readSelectedModel } from '../lib/selection';

interface SourceSummary {
  title: string;
  url: string;
}

interface Props {
  organization: Organization;
  family: ModelFamily;
  releases: ModelRelease[];
  sourceByReleaseId: Record<string, SourceSummary>;
  basePath: string;
}

export default function LineageExplorer({
  organization,
  family,
  releases,
  sourceByReleaseId,
  basePath,
}: Props) {
  const defaultSlug = releases[0].slug;
  const [selectedSlug, setSelectedSlug] = useState(defaultSlug);
  const nodeRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selected = releases.find((release) => release.slug === selectedSlug) ?? releases[0];
  const source = sourceByReleaseId[selected.id];
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;

  useEffect(() => {
    const syncFromUrl = () => {
      const next = readSelectedModel(
        window.location.search,
        releases.map((release) => release.slug),
        defaultSlug,
      );
      startTransition(() => setSelectedSlug(next));
    };

    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, [defaultSlug, releases]);

  function selectRelease(slug: string, historyMode: 'push' | 'replace' = 'push') {
    const nextUrl = createModelSelectionUrl(window.location.href, slug);
    if (historyMode === 'push') window.history.pushState({}, '', nextUrl);
    else window.history.replaceState({}, '', nextUrl);
    startTransition(() => setSelectedSlug(slug));
  }

  function handleNodeKeyDown(event: KeyboardEvent, index: number) {
    let nextIndex: number | undefined;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % releases.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + releases.length) % releases.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = releases.length - 1;
    }

    if (nextIndex === undefined) return;
    event.preventDefault();
    nodeRefs.current[nextIndex]?.focus();
    selectRelease(releases[nextIndex].slug, 'replace');
  }

  return (
    <section className="lineage-explorer" aria-labelledby="lineage-heading">
      <div className="explorer-heading">
        <div>
          <span className="eyebrow">Featured ecosystem</span>
          <h2 id="lineage-heading">One family, three sibling releases</h2>
        </div>
        <div className="legend" aria-label="Lineage legend">
          <span><CheckCircle2 size={16} aria-hidden="true" /> Available</span>
          <span><Cloud size={16} aria-hidden="true" /> Hosted API</span>
        </div>
      </div>

      <div className="ecosystem-selector" aria-label="Featured model creators">
        <span>Creator</span>
        <button type="button" aria-pressed="true">{organization.name}</button>
        <small>1 of 1 in this seed slice</small>
      </div>

      <div className="lineage-stage">
        <div className="tree-plot" aria-label={`${organization.name}, ${family.name} family lineage`}>
          <div className="tree-level tree-root">
            <span className="tree-kicker">Company</span>
            <strong>{organization.name}</strong>
            <small>Model creator</small>
          </div>

          <div className="tree-connector" aria-hidden="true" />

          <div className="tree-level tree-family">
            <span className="tree-kicker"><GitBranch size={14} aria-hidden="true" /> Family</span>
            <strong>{family.name}</strong>
            <small>First released {formatDate(family.firstReleaseDate)}</small>
          </div>

          <div className="tree-connector" aria-hidden="true" />

          <ol className="release-nodes" aria-label={`${family.name} releases`}>
            {releases.map((release, index) => {
              const isSelected = release.slug === selected.slug;
              return (
                <li key={release.id}>
                  <button
                    ref={(node) => { nodeRefs.current[index] = node; }}
                    type="button"
                    className="release-node"
                    data-selected={isSelected ? 'true' : 'false'}
                    aria-pressed={isSelected}
                    onClick={() => selectRelease(release.slug)}
                    onKeyDown={(event) => handleNodeKeyDown(event, index)}
                  >
                    <span className="node-status"><span aria-hidden="true" /> {statusLabel(release.status)}</span>
                    <strong>{release.displayName}</strong>
                    <small>{release.variant} | {formatDate(release.releaseDate)}</small>
                  </button>
                </li>
              );
            })}
          </ol>
          <p className="relationship-note"><Info size={15} aria-hidden="true" /> Sibling variants announced together. No predecessor or successor is inferred.</p>
        </div>

        <aside className="model-summary" aria-live="polite" aria-label={`Selected model: ${selected.displayName}`}>
          <div className="summary-topline">
            <span>{organization.shortName} / {family.name}</span>
            <span className="verification-mark"><CheckCircle2 size={15} aria-hidden="true" /> Verified</span>
          </div>
          <h3>{selected.displayName}</h3>
          <p className="summary-copy">{selected.summary}</p>
          <dl className="summary-facts">
            <div>
              <dt><CalendarDays size={15} aria-hidden="true" /> Release</dt>
              <dd>{formatDate(selected.releaseDate)}</dd>
            </div>
            <div>
              <dt><CheckCircle2 size={15} aria-hidden="true" /> Status</dt>
              <dd>{statusLabel(selected.status)}</dd>
            </div>
            <div>
              <dt><Cloud size={15} aria-hidden="true" /> Access</dt>
              <dd>{accessLabel(selected.accessType)}</dd>
            </div>
          </dl>
          <div className="summary-purpose">
            <span>When to use it</span>
            <p>{selected.intendedUse}</p>
          </div>
          <div className="details-actions">
            <a className="primary-action" href={`${normalizedBase}models/${selected.slug}/`}>
              View Model Passport <ArrowUpRight size={17} aria-hidden="true" />
            </a>
            <a className="text-action" href={source.url}>
              Primary source <ExternalLink size={15} aria-hidden="true" />
            </a>
          </div>
          <p className="source-caption">{source.title} | Checked {formatDate(selected.verifiedAt)}</p>
        </aside>
      </div>
    </section>
  );
}