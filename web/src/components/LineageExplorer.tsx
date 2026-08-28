import {
  ArrowUpRight,
  CalendarDays,
  CheckCircle2,
  Cloud,
  ExternalLink,
  GitBranch,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { accessLabel, formatDate, formatReleaseDate, statusLabel } from '../lib/format';
import { compareUrl } from '../lib/compare-route';
import {
  LINEAGE_RELATION_LABELS,
  buildLineageHighlight,
  findLineagePlacement,
  firstEcosystemRelease,
  lineageRelation,
  lineageReleaseSlugs,
  type LineageEcosystem,
  type LineageHighlight,
  type LineageNode,
} from '../lib/lineage-view';
import {
  createLineageSelectionUrl,
  readOptionalSelectedModel,
  readOptionalSelectedProvider,
} from '../lib/selection';

interface SourceSummary {
  title: string;
  url: string;
}

interface Props {
  /** Featured ecosystems, already derived from the validated records at build time. */
  ecosystems: LineageEcosystem[];
  sourceByReleaseId: Record<string, SourceSummary>;
  /** Display names for every release, so a cross-family derivation can be named. */
  releaseLabels: Record<string, string>;
  basePath: string;
}

/**
 * The homepage lineage explorer.
 *
 * This component knows nothing about any particular creator. It renders whatever
 * `buildLineageEcosystems` derived from the catalog, so seeding a new
 * organization adds a branch here without touching this file.
 *
 * Two rendering rules carry the acceptance criteria:
 *
 * - **A connector is drawn only where the catalog records one.** Nesting is the
 *   connector, and nesting comes from the view model's recorded-relationship
 *   forest, so a family the catalog says nothing about renders flat.
 * - **Nothing is conveyed by colour alone.** Status, access, and lineage relation
 *   each render as text with an icon; emphasis only repeats what the text says.
 *
 * Keyboard model, deliberately the nested-list route rather than an ARIA tree:
 * the creator switcher is a toolbar with roving tabindex (arrows move, Home/End
 * jump, Enter/Space or click selects), and everything below it is ordinary
 * buttons and links in document order. Focus is never moved by anything other
 * than the user.
 */
export default function LineageExplorer({
  ecosystems,
  sourceByReleaseId,
  releaseLabels,
  basePath,
}: Props) {
  const slugs = useMemo(() => lineageReleaseSlugs(ecosystems), [ecosystems]);
  const providerSlugs = useMemo(
    () => ecosystems.map(({ organization }) => organization.slug),
    [ecosystems],
  );
  const defaultSlug = ecosystems[0] ? firstEcosystemRelease(ecosystems[0]).slug : '';

  const [selectedSlug, setSelectedSlug] = useState(defaultSlug);
  // Until the client has read the URL, every ecosystem is rendered: that server
  // output is the complete no-JS alternative to the interactive view.
  const [narrowed, setNarrowed] = useState(false);
  const [rovingIndex, setRovingIndex] = useState(0);
  const providerRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
  const placement = findLineagePlacement(ecosystems, selectedSlug)
    ?? findLineagePlacement(ecosystems, defaultSlug);
  const selectedIndex = Math.max(
    0,
    ecosystems.findIndex(({ organization }) => organization.id === placement?.organization.id),
  );
  const highlight = useMemo(
    () => buildLineageHighlight(ecosystems, placement?.release.slug),
    [ecosystems, placement?.release.slug],
  );
  const visible = narrowed ? ecosystems.slice(selectedIndex, selectedIndex + 1) : ecosystems;

  useEffect(() => {
    const search = window.location.search;
    const fromModel = readOptionalSelectedModel(search, slugs);
    const fromProvider = readOptionalSelectedProvider(search, providerSlugs);
    const providerDefault = ecosystems
      .find(({ organization }) => organization.slug === fromProvider);

    // A model implies exactly one creator, so it settles a disagreement between
    // the two parameters on its own.
    setSelectedSlug(
      fromModel
      ?? (providerDefault ? firstEcosystemRelease(providerDefault).slug : undefined)
      ?? defaultSlug,
    );
    setNarrowed(true);
  }, [defaultSlug, slugs.join('\0'), providerSlugs.join('\0')]);

  useEffect(() => {
    setRovingIndex(selectedIndex);
  }, [selectedIndex]);

  useEffect(() => {
    if (!narrowed || !placement) return;
    window.history.replaceState(
      null,
      '',
      createLineageSelectionUrl(
        window.location.href,
        placement.organization.slug,
        placement.release.slug,
      ),
    );
  }, [narrowed, placement?.organization.slug, placement?.release.slug]);

  function selectEcosystem(ecosystem: LineageEcosystem) {
    setSelectedSlug(firstEcosystemRelease(ecosystem).slug);
  }

  function handleProviderKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = ecosystems.length - 1;
    let next: number | undefined;

    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = index === last ? 0 : index + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = index === 0 ? last : index - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = last;

    if (next === undefined) return;
    event.preventDefault();
    setRovingIndex(next);
    providerRefs.current[next]?.focus();
  }

  if (!placement) return null;

  return (
    <section className="lineage-explorer" aria-labelledby="lineage-heading">
      <div className="explorer-heading">
        <div>
          <span className="eyebrow">Featured ecosystems</span>
          <h2 id="lineage-heading">Recorded lineage, creator by creator</h2>
        </div>
        <div className="legend" aria-label="Lineage legend">
          <span><GitBranch size={16} aria-hidden="true" /> Nesting shows a recorded predecessor</span>
          <span><Cloud size={16} aria-hidden="true" /> Model Passport</span>
        </div>
      </div>

      <div
        className="ecosystem-selector"
        role="toolbar"
        aria-label="Choose a featured creator"
        aria-orientation="horizontal"
      >
        {ecosystems.map((ecosystem, index) => {
          const isSelected = ecosystem.organization.id === placement.organization.id;
          return (
            <button
              key={ecosystem.organization.id}
              type="button"
              ref={(node) => { providerRefs.current[index] = node; }}
              className="ecosystem-option"
              data-selected={isSelected ? 'true' : 'false'}
              aria-pressed={isSelected}
              tabIndex={index === rovingIndex ? 0 : -1}
              onClick={() => selectEcosystem(ecosystem)}
              onKeyDown={(event) => handleProviderKeyDown(event, index)}
            >
              <Users size={15} aria-hidden="true" />
              <strong>{ecosystem.organization.name}</strong>
              <small>
                {ecosystem.families.length === 1 ? '1 family' : `${ecosystem.families.length} families`}
              </small>
            </button>
          );
        })}
      </div>

      <div className="lineage-stage">
        <div className="lineage-directory">
          {visible.map((ecosystem) => (
            <section
              className="organization-branch"
              aria-labelledby={`organization-${ecosystem.organization.id}`}
              key={ecosystem.organization.id}
            >
              <header className="tree-level tree-root">
                <span className="tree-kicker">Creator</span>
                <strong id={`organization-${ecosystem.organization.id}`}>
                  {ecosystem.organization.name}
                </strong>
                <small>{ecosystem.organization.description}</small>
              </header>

              <div className="family-list">
                {ecosystem.families.map((view) => (
                  <article
                    className="family-branch"
                    aria-labelledby={`family-${view.family.id}`}
                    key={view.family.id}
                  >
                    <header className="tree-level tree-family">
                      <span className="tree-kicker">
                        <GitBranch size={14} aria-hidden="true" /> Family
                      </span>
                      <h3 id={`family-${view.family.id}`}>{view.family.name}</h3>
                      <small>First released {formatReleaseDate(view.family.firstReleaseDate, view.family.datePrecision)}</small>
                    </header>

                    {view.hasRecordedLineage ? (
                      <p className="lineage-note">
                        {view.linkCount === 1
                          ? '1 recorded lineage link in this family.'
                          : `${view.linkCount} recorded lineage links in this family.`}
                      </p>
                    ) : (
                      <p className="lineage-note" data-empty="true">
                        No recorded lineage links in this family, so no releases are connected here.
                      </p>
                    )}

                    <LineageBranch
                      nodes={view.roots}
                      parentId={undefined}
                      label={`${view.family.name} releases`}
                      highlight={highlight}
                      releaseLabels={releaseLabels}
                      onSelect={setSelectedSlug}
                    />
                  </article>
                ))}
              </div>
            </section>
          ))}

          <p className="lineage-longtail">
            Families without a featured release are not drawn here. Every record in the
            catalog, featured or not, is listed in the{' '}
            <a href={`${normalizedBase}models/`}>model index</a> and the{' '}
            <a href={`${normalizedBase}tree/`}>Model Tree</a>.
          </p>
        </div>

        <aside
          className="model-summary"
          aria-live="polite"
          aria-label={`Selected model: ${placement.release.displayName}`}
        >
          <div className="summary-topline">
            <span>{placement.organization.shortName} / {placement.family.family.name}</span>
            <span className="verification-mark">
              <CheckCircle2 size={15} aria-hidden="true" /> Verified
            </span>
          </div>
          <h3>{placement.release.displayName}</h3>
          <p className="summary-copy">{placement.release.summary}</p>
          <dl className="summary-facts">
            <div>
              <dt><CalendarDays size={15} aria-hidden="true" /> Release</dt>
              <dd>{formatReleaseDate(placement.release.releaseDate, placement.release.datePrecision)}</dd>
            </div>
            <div>
              <dt><CheckCircle2 size={15} aria-hidden="true" /> Status</dt>
              <dd>{statusLabel(placement.release.status)}</dd>
            </div>
            <div>
              <dt><Cloud size={15} aria-hidden="true" /> Access</dt>
              <dd>{accessLabel(placement.release.accessType)}</dd>
            </div>
          </dl>

          <div className="summary-lineage">
            <span>Recorded lineage</span>
            <dl>
              <div>
                <dt>{LINEAGE_RELATION_LABELS.ancestor}</dt>
                <dd>{namesFor(placement.release.predecessorIds, releaseLabels) ?? 'No recorded predecessor.'}</dd>
              </div>
              <div>
                <dt>{LINEAGE_RELATION_LABELS.successor}</dt>
                <dd>{namesFor(placement.release.successorIds, releaseLabels) ?? 'No recorded successor.'}</dd>
              </div>
              <div>
                <dt>{LINEAGE_RELATION_LABELS.sibling}</dt>
                <dd>{namesFor(placement.release.siblingIds, releaseLabels) ?? 'No recorded sibling release.'}</dd>
              </div>
              <div>
                <dt>Derived from</dt>
                <dd>{namesFor(placement.release.derivedFromIds, releaseLabels) ?? 'No recorded derivation.'}</dd>
              </div>
            </dl>
          </div>

          <div className="summary-purpose">
            <span>When to use it</span>
            <p>{placement.release.intendedUse}</p>
          </div>
          <div className="details-actions">
            <a className="primary-action" href={`${normalizedBase}models/${placement.release.slug}/`}>
              View Model Passport <ArrowUpRight size={17} aria-hidden="true" />
            </a>
            <a
              className="text-action"
              href={compareUrl(normalizedBase, [placement.release.slug])}
              aria-label={`Add ${placement.release.displayName} to the comparison`}
            >
              Add to comparison <ArrowUpRight size={15} aria-hidden="true" />
            </a>
            {sourceByReleaseId[placement.release.id] && (
              <a className="text-action" href={sourceByReleaseId[placement.release.id].url}>
                Primary source <ExternalLink size={15} aria-hidden="true" />
              </a>
            )}
          </div>
          {sourceByReleaseId[placement.release.id] && (
            <p className="source-caption">
              {sourceByReleaseId[placement.release.id].title} | Checked {formatDate(placement.release.verifiedAt)}
            </p>
          )}
        </aside>
      </div>
    </section>
  );
}

function namesFor(ids: readonly string[], releaseLabels: Record<string, string>) {
  if (ids.length === 0) return undefined;
  return ids.map((id) => releaseLabels[id] ?? id).join(', ');
}

interface BranchProps {
  nodes: LineageNode[];
  /**
   * The release these nodes descend from, or `undefined` at the root of a family.
   * It is stamped onto each item as `data-lineage-link`, so every connector in the
   * markup names the recorded relationship that justifies it -- and a family with
   * no recorded relationships emits none.
   */
  parentId: string | undefined;
  label?: string;
  highlight: LineageHighlight;
  releaseLabels: Record<string, string>;
  onSelect: (slug: string) => void;
}

function LineageBranch({ nodes, parentId, label, highlight, releaseLabels, onSelect }: BranchProps) {
  if (nodes.length === 0) return null;

  return (
    <ul
      className={parentId === undefined ? 'lineage-branch' : 'lineage-branch lineage-branch--nested'}
      aria-label={label}
      style={{ '--lineage-depth': String(nodes[0].depth) } as CSSProperties}
    >
      {nodes.map((node) => {
        const relation = lineageRelation(highlight, node.release.id);
        const alsoFollows = namesFor(node.additionalPredecessorIds, releaseLabels);

        return (
          <li key={node.release.id} data-lineage-link={parentId}>
            <button
              type="button"
              className="release-node"
              data-release={node.release.slug}
              data-relation={relation}
              data-status={node.release.status}
              aria-current={relation === 'selected' ? 'true' : undefined}
              onClick={() => onSelect(node.release.slug)}
            >
              <span className="node-status">
                <CheckCircle2 size={14} aria-hidden="true" /> {statusLabel(node.release.status)}
              </span>
              <strong>{node.release.displayName}</strong>
              <small>
                {node.release.variant} | {formatReleaseDate(node.release.releaseDate, node.release.datePrecision)}
              </small>
              <span className="node-access">
                <Cloud size={14} aria-hidden="true" /> {accessLabel(node.release.accessType)}
              </span>
              {relation !== 'unrelated' && (
                <span className="node-relation">{LINEAGE_RELATION_LABELS[relation]}</span>
              )}
            </button>

            {alsoFollows && (
              <p className="node-aside">Also follows {alsoFollows}, shown without a connector.</p>
            )}

            <LineageBranch
              nodes={node.children}
              parentId={node.release.id}
              highlight={highlight}
              releaseLabels={releaseLabels}
              onSelect={onSelect}
            />
          </li>
        );
      })}
    </ul>
  );
}
