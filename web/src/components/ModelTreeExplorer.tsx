import { startTransition, useEffect, useState } from 'react';
import type { ModelTree, ModelTreeCreator } from '../lib/model-tree';
import {
  modelTreeReleaseIds,
  restoreModelTreeSelection,
  toggleModelTreeBranch,
} from '../lib/model-tree';
import { formatReleaseDate, statusLabel } from '../lib/format';
import { createModelSelectionUrl, readOptionalSelectedModel } from '../lib/selection';
import { organizationLabel } from '../lib/organization-name';
import LineageModelDrawer from './LineageModelDrawer';

interface SourceSummary {
  title: string;
  url: string;
}

interface Props {
  tree: ModelTree;
  sourceByReleaseId: Record<string, SourceSummary>;
  basePath: string;
}

export default function ModelTreeExplorer({ tree, sourceByReleaseId, basePath }: Props) {
  const [enhanced, setEnhanced] = useState(false);
  const [rootOpen, setRootOpen] = useState(true);
  const [featuredOpen, setFeaturedOpen] = useState(true);
  const [othersOpen, setOthersOpen] = useState(true);
  const [openCreators, setOpenCreators] = useState<ReadonlySet<string>>(new Set());
  const [openFamilies, setOpenFamilies] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string>();
  const [selectionNonce, setSelectionNonce] = useState(0);
  const releaseIds = modelTreeReleaseIds(tree);
  const releaseKey = releaseIds.join('\0');
  const normalizedBase = basePath.endsWith('/') ? basePath : `${basePath}/`;
  const selected = [...tree.featured, ...tree.others]
    .flatMap(({ organization, families }) => families.flatMap(({ family, releases }) => (
      releases.map((release) => ({ organization, family, release }))
    )))
    .find(({ release }) => release.id === selectedId);

  useEffect(() => {
    const releaseId = readOptionalSelectedModel(window.location.search, releaseIds);
    const restored = restoreModelTreeSelection(tree, releaseId);
    startTransition(() => {
      setSelectedId(restored.selectedReleaseId);
      setOpenCreators(new Set(restored.openCreatorIds));
      setOpenFamilies(new Set(restored.openFamilyIds));
      setEnhanced(true);
    });
  }, [releaseKey, tree]);

  function selectRelease(releaseId: string) {
    const restored = restoreModelTreeSelection(tree, releaseId);
    // Bumped even when the release is unchanged so the drawer can reopen after a
    // dismissal: the selected-id state alone bails out of a no-op update.
    setSelectionNonce((nonce) => nonce + 1);
    startTransition(() => {
      setSelectedId(releaseId);
      setOpenCreators((current) => new Set([...current, ...restored.openCreatorIds]));
      setOpenFamilies((current) => new Set([...current, ...restored.openFamilyIds]));
    });
    window.history.replaceState({}, '', createModelSelectionUrl(window.location.href, releaseId));
  }

  function isOpen(items: ReadonlySet<string>, id: string) {
    return !enhanced || items.has(id);
  }

  // Featured and Others render the identical markup contract; a creator belongs
  // to exactly one branch, so the generated element IDs stay unique.
  function creatorBranches(creators: ModelTreeCreator[]) {
    return creators.map(({ organization, families }) => {
      const creatorOpen = isOpen(openCreators, organization.id);
      const creatorContentId = `tree-creator-${organization.id}`;
      return (
        <li key={organization.id}>
          <button
            className="tree-disclosure tree-creator-node"
            type="button"
            aria-expanded={creatorOpen}
            aria-controls={creatorContentId}
            onClick={() => setOpenCreators((items) => toggleModelTreeBranch(items, organization.id))}
          >
            <span>{organizationLabel(organization)}</span>
            <small>{families.length} {families.length === 1 ? 'family' : 'families'}</small>
          </button>
          <ul id={creatorContentId} hidden={!creatorOpen}>
            {families.map(({ family, releases }) => {
              const familyOpen = isOpen(openFamilies, family.id);
              const familyContentId = `tree-family-${family.id}`;
              return (
                <li key={family.id}>
                  <button
                    className="tree-disclosure tree-family-node"
                    type="button"
                    aria-expanded={familyOpen}
                    aria-controls={familyContentId}
                    onClick={() => setOpenFamilies((items) => toggleModelTreeBranch(items, family.id))}
                  >
                    <span>{family.name}</span>
                    <small>{releases.length} {releases.length === 1 ? 'release' : 'releases'}</small>
                  </button>
                  <ol id={familyContentId} className="tree-release-list" hidden={!familyOpen}>
                    {releases.map((release) => {
                      const isSelected = release.id === selectedId;
                      return (
                        <li key={release.id}>
                          <div
                            className="tree-release-node"
                            data-selected={isSelected ? 'true' : 'false'}
                          >
                            <button
                              type="button"
                              aria-pressed={isSelected}
                              onClick={() => selectRelease(release.id)}
                            >
                              <strong>{release.displayName}</strong>
                              <span>{formatReleaseDate(release.releaseDate, release.datePrecision)} · {statusLabel(release.status)}</span>
                              {/* Selection is a border colour and a coloured ring otherwise,
                                  which no one perceiving hue poorly can read. The word is
                                  `aria-hidden` because `aria-pressed` above already carries
                                  the state, and announcing it twice helps nobody. */}
                              {isSelected && (
                                <span className="tree-release-selected" aria-hidden="true">
                                  Selected
                                </span>
                              )}
                            </button>
                            <a href={`${normalizedBase}models/${release.slug}/`}>
                              Passport<span className="visually-hidden"> for {release.displayName}</span>
                            </a>
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                </li>
              );
            })}
          </ul>
        </li>
      );
    });
  }

  return (
    <section className="model-tree-explorer" aria-label="Model lineage explorer">
      <div className="tree-workspace">
        {/* `overflow-x: auto` above 980px makes this a scrollable region, so it has
            to be reachable without a pointer, and `aria-label` only names an element
            that has a role to carry the name. Both are the same shape the passport's
            wide tables already use. */}
        <div
          className="tree-scroll"
          role="region"
          aria-label="Reviewed model ecosystem hierarchy"
          tabIndex={0}
        >
          <ul className="model-tree-list model-tree-root">
            <li>
              <button
                className="tree-disclosure tree-root-node"
                type="button"
                aria-expanded={rootOpen}
                aria-controls="model-tree-root-branches"
                onClick={() => setRootOpen((value) => !value)}
              >
                <span>AI Model Ecosystem</span>
                <small>Reviewed catalog</small>
              </button>
              <ul id="model-tree-root-branches" hidden={!rootOpen}>
                <li>
                  <button
                    className="tree-disclosure tree-featured-node"
                    type="button"
                    aria-expanded={featuredOpen}
                    aria-controls="model-tree-featured-creators"
                    onClick={() => setFeaturedOpen((value) => !value)}
                  >
                    <span>Featured ecosystems</span>
                    <small>Editorially reviewed · not ranked</small>
                  </button>
                  <ul id="model-tree-featured-creators" hidden={!featuredOpen}>
                    {creatorBranches(tree.featured)}
                  </ul>
                </li>
                <li>
                  {tree.others.length > 0 ? (
                    <>
                      <button
                        className="tree-disclosure tree-others-node"
                        type="button"
                        aria-expanded={othersOpen}
                        aria-controls="model-tree-other-creators"
                        onClick={() => setOthersOpen((value) => !value)}
                      >
                        <span>Others</span>
                        <small>Reviewed creators without a featured release</small>
                      </button>
                      <ul id="model-tree-other-creators" hidden={!othersOpen}>
                        {creatorBranches(tree.others)}
                      </ul>
                    </>
                  ) : (
                    <div className="tree-empty-node">
                      <strong>Others</strong>
                      <span>No non-featured creators in the reviewed catalog</span>
                    </div>
                  )}
                </li>
              </ul>
            </li>
          </ul>
        </div>

        <LineageModelDrawer
          selected={selected}
          source={selected ? sourceByReleaseId[selected.release.id] : undefined}
          basePath={basePath}
          selectionNonce={selectionNonce}
        />
      </div>
    </section>
  );
}
