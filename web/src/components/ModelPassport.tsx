/**
 * The Model Passport's progressively disclosed sections.
 *
 * A React component rather than Astro markup for one reason: this repository
 * already renders `ModelFit` and `UsageEvidence` from the same page with no
 * `client:` directive, so they cost no client JavaScript and are still directly
 * renderable in a test through `renderToStaticMarkup`. Markup that decides
 * whether a section appears, and how a licence is worded, needs to be asserted
 * against real HTML rather than against the intent behind it.
 *
 * Everything displayed here is read from {@link ModelPassportView}. The
 * component chooses no labels and resolves no records of its own, so what a
 * test asserts about the view model is what a reader sees.
 */
import { AlertTriangle, ExternalLink, Info, ScrollText } from 'lucide-react';
import { formatDate } from '../lib/format';
import type {
  AvailabilityRow,
  ModelPassportView,
  PassportFact,
  PassportSection,
  PassportSourceView,
  PricingRow,
} from '../lib/passport';

interface Props {
  view: ModelPassportView;
}

function SectionHeading({ section }: { section: PassportSection }) {
  return (
    <div className="section-heading">
      <span className="section-number">{section.number}</span>
      <div>
        <span className="eyebrow">{section.eyebrow}</span>
        <h2 id={section.headingId}>{section.title}</h2>
      </div>
    </div>
  );
}

/** Sources for one row, as inline links that name the document they open. */
function RowSources({ sources, label }: { sources: PassportSourceView[]; label: string }) {
  if (!sources.length) return <span className="passport-unknown">Not recorded</span>;

  return (
    <ul className="row-sources" aria-label={label}>
      {sources.map((source) => (
        <li key={source.id}>
          <a href={source.url}>
            {source.title}
            <ExternalLink size={13} strokeWidth={1.8} aria-hidden="true" />
          </a>
          <span className="row-source-meta">
            {source.publisherName} · {source.typeLabel} · checked {formatDate(source.lastCheckedDate)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function FactList({ facts, className }: { facts: PassportFact[]; className: string }) {
  return (
    <dl className={className}>
      {facts.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd className={item.unknown ? 'passport-unknown' : undefined}>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function StaleNote({ row }: { row: PricingRow | AvailabilityRow }) {
  if (!row.isStale) return null;

  return (
    <span className="passport-stale">
      <AlertTriangle size={13} aria-hidden="true" />
      Not re-checked for {row.daysSinceVerified} days
    </span>
  );
}

export default function ModelPassport({ view }: Props) {
  const sectionById = new Map(view.sections.map((section) => [section.id, section]));
  const section = (id: Parameters<typeof sectionById.get>[0]) => {
    const found = sectionById.get(id);
    if (!found) throw new Error(`passport section "${id}" is missing from the view model`);
    return found;
  };

  const identity = section('identity');
  const lineage = section('lineage');
  const technical = section('technical');
  const access = section('access');
  const availability = section('availability');
  const pricing = section('pricing');
  const history = section('history');

  return (
    <>
      <nav className="passport-actions" aria-label="Actions for this record">
        <ul>
          {view.actions.map((action) => (
            <li key={action.kind}>
              <a
                className={`passport-action passport-action-${action.kind}`}
                href={action.href}
                data-action={action.kind}
              >
                {action.label}
                {action.external ? <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" /> : null}
              </a>
              <span className="passport-action-description">{action.description}</span>
            </li>
          ))}
        </ul>
      </nav>

      <section className="passport-section identity-section" aria-labelledby={identity.headingId}>
        <SectionHeading section={identity} />

        {/* The plain-language summary sits above every table on the page: the
            technical record is progressive disclosure beneath it, not the
            entry point. */}
        <div className="passport-summary">
          <p className="passport-summary-text">{view.summary}</p>
          <p className="passport-purpose"><strong>When to use it.</strong> {view.intendedUse}</p>
          {view.featuredRationale ? (
            <p className="passport-featured">
              <Info size={15} aria-hidden="true" />
              Featured in ModelTree because {view.featuredRationale}
            </p>
          ) : null}
        </div>

        <div className="passport-grid">
          <FactList facts={view.identityFacts} className="passport-facts" />

          <div className="passport-names">
            <h3>Canonical record</h3>
            <dl className="passport-facts">
              <div>
                <dt>Canonical name</dt>
                <dd>{view.canonicalName}</dd>
              </div>
              <div>
                <dt>Canonical page</dt>
                <dd><code>{view.canonicalRoute}</code></dd>
              </div>
              <div>
                <dt>Lifecycle</dt>
                <dd>
                  {view.statusLabel}. {view.statusDefinition}
                </dd>
              </div>
            </dl>

            {view.otherNames.length ? (
              <div className="tag-block">
                <h4>Also known as</h4>
                <ul className="api-aliases">
                  {view.otherNames.map((name) => <li key={name}>{name}</li>)}
                </ul>
              </div>
            ) : null}

            {view.apiAliases.length ? (
              <div className="tag-block">
                <h4>API identifiers</h4>
                <ul className="api-aliases">
                  {view.apiAliases.map((alias) => <li key={alias}><code>{alias}</code></li>)}
                </ul>
              </div>
            ) : (
              <p className="passport-unknown">No API identifier is recorded for this release.</p>
            )}
          </div>
        </div>
      </section>

      {lineage.present ? (
        <section className="passport-section" aria-labelledby={lineage.headingId}>
          <SectionHeading section={lineage} />

          <div className="family-trail">
            <span>{view.organization.name}</span>
            <span aria-hidden="true">›</span>
            <span>{view.family.name}</span>
            <span aria-hidden="true">›</span>
            <strong>{view.displayName}</strong>
          </div>

          {/* Each relationship is a different claim, so each keeps its own
              heading and its own sentence saying what it asserts. */}
          {view.presentRelationships.map((group) => (
            <div className="relationship-group" key={group.kind} data-relationship={group.kind}>
              <h3>{group.label}</h3>
              <p className="relationship-note">{group.description}</p>
              {group.links.length ? (
                <ul className="sibling-links">
                  {group.links.map((link) => (
                    <li key={link.slug}>
                      <a href={link.href}>{link.displayName}</a>
                    </li>
                  ))}
                </ul>
              ) : null}
              {group.unresolvedIds.length ? (
                <p className="passport-unknown">
                  {group.unresolvedIds.length} related record(s) named here are not yet in ModelTree:{' '}
                  {group.unresolvedIds.join(', ')}.
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ) : null}

      <section className="passport-section" aria-labelledby={technical.headingId}>
        <SectionHeading section={technical} />
        <FactList facts={view.technicalFacts} className="technical-facts" />
        <div className="tag-groups">
          <div>
            <span>Categories</span>
            <ul>{view.categories.map((category) => <li key={category}>{category}</li>)}</ul>
          </div>
        </div>
      </section>

      <section className="passport-section" aria-labelledby={access.headingId}>
        <SectionHeading section={access} />

        <p className="access-summary">
          <strong>{view.access.label}.</strong> {view.access.definition}
        </p>
        <p className="access-methodology">
          <a href={view.access.methodologyHref}>
            How ModelTree defines access and licensing
          </a>
        </p>

        {view.access.license ? (
          <div className="licence-block">
            <h3>Licence</h3>
            <dl className="technical-facts">
              <div>
                <dt>Licence</dt>
                <dd>
                  {view.access.license.url ? (
                    <a href={view.access.license.url}>
                      {view.access.license.name}
                      <ExternalLink size={13} strokeWidth={1.8} aria-hidden="true" />
                    </a>
                  ) : view.access.license.name}
                </dd>
              </div>
              <div>
                <dt>SPDX identifier</dt>
                <dd className={view.access.license.spdxId ? undefined : 'passport-unknown'}>
                  {view.access.license.spdxId ?? 'Not recorded'}
                </dd>
              </div>
              <div>
                <dt>Downloadable weights</dt>
                <dd>{view.access.license.weightsStatement}</dd>
              </div>
              <div>
                <dt>OSI-approved</dt>
                <dd>{view.access.license.osiStatement}</dd>
              </div>
            </dl>
          </div>
        ) : (
          <p className="passport-unknown">{view.access.licenseAbsenceNote}</p>
        )}
      </section>

      {availability.present ? (
        <section className="passport-section" aria-labelledby={availability.headingId}>
          <SectionHeading section={availability} />
          <div
            className="passport-table-scroll"
            role="region"
            aria-label={`Availability records for ${view.displayName}`}
            tabIndex={0}
          >
            <table className="passport-table">
              <caption>
                Platforms recorded as serving {view.displayName}, with the date each record takes
                effect.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Platform</th>
                  <th scope="col">Delivery</th>
                  <th scope="col">API identifier</th>
                  <th scope="col">Regions</th>
                  <th scope="col">Effective</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {view.availability.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">
                      {row.platformName}
                      <span className="cell-note">{row.platformTypeLabel} · operated by {row.operatorName}</span>
                    </th>
                    <td>{row.deliveryModeLabel}</td>
                    <td className={row.apiIdentifier ? undefined : 'passport-unknown'}>
                      {row.apiIdentifier ? <code>{row.apiIdentifier}</code> : 'Not recorded'}
                    </td>
                    <td className={row.regions.length ? undefined : 'passport-unknown'}>
                      {row.regions.length ? row.regions.join(', ') : 'Not recorded'}
                    </td>
                    <td>
                      {row.effectiveRange}
                      {row.isCurrent ? null : <span className="cell-note">Superseded</span>}
                      <span className="cell-note">Verified {formatDate(row.verifiedAt)}</span>
                      <StaleNote row={row} />
                    </td>
                    <td><RowSources sources={row.sources} label={`Sources for ${row.platformName}`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {pricing.present ? (
        <section className="passport-section" aria-labelledby={pricing.headingId}>
          <SectionHeading section={pricing} />
          <p className="pricing-disclosure">
            <ScrollText size={16} aria-hidden="true" />
            Every price is recorded against one platform, in the currency and unit the vendor
            published, with the date it took effect. Prices are not converted between currencies or
            normalised between units, because a converted price is a figure no source states.
          </p>
          <div
            className="passport-table-scroll"
            role="region"
            aria-label={`Pricing records for ${view.displayName}`}
            tabIndex={0}
          >
            <table className="passport-table">
              <caption>
                Published prices recorded for {view.displayName}, with currency, unit, effective
                date, and source.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Platform</th>
                  <th scope="col">Currency</th>
                  <th scope="col">Rates</th>
                  <th scope="col">Unit</th>
                  <th scope="col">Region and tier</th>
                  <th scope="col">Effective</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {view.pricing.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.platformName}</th>
                    <td>{row.currency}</td>
                    <td>
                      <ul className="pricing-rates">
                        {row.rates.map((rate) => (
                          <li key={rate.key}>
                            <span className="pricing-rate-label">{rate.label}</span>
                            <span className="pricing-rate-amount">{rate.amount}</span>
                          </li>
                        ))}
                      </ul>
                    </td>
                    <td>{row.unitLabel}</td>
                    <td className={row.region || row.processingTier ? undefined : 'passport-unknown'}>
                      {row.region || row.processingTier
                        ? [row.region, row.processingTier].filter(Boolean).join(' · ')
                        : 'Not recorded'}
                    </td>
                    <td>
                      {row.effectiveRange}
                      {row.isCurrent ? null : <span className="cell-note">Superseded</span>}
                      <span className="cell-note">Verified {formatDate(row.verifiedAt)}</span>
                      <StaleNote row={row} />
                    </td>
                    <td><RowSources sources={row.sources} label={`Sources for the ${row.platformName} price`} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {history.present ? (
        <section className="passport-section" aria-labelledby={history.headingId}>
          <SectionHeading section={history} />
          <ol className="passport-history">
            {view.history.map((row) => (
              <li key={row.id}>
                <p className="history-headline">
                  <span className="history-type">{row.typeLabel}</span>
                  <time>{row.date}</time>
                </p>
                <p>{row.note}</p>
                <RowSources sources={row.sources} label={`Sources for the ${row.typeLabel} event`} />
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {view.notRecorded.length ? (
        <section className="passport-section not-recorded-section" aria-labelledby="not-recorded-title">
          <div className="section-heading">
            <span className="section-number" aria-hidden="true">—</span>
            <div>
              <span className="eyebrow">Coverage</span>
              <h2 id="not-recorded-title">What this passport does not record</h2>
            </div>
          </div>
          <p className="not-recorded-intro">
            These sections are absent from this page because no reviewed record exists for them.
            They are listed rather than dropped silently, because a missing section and a section
            ModelTree has decided nothing about look identical otherwise.
          </p>
          <dl className="not-recorded-list">
            {view.notRecorded.map((item) => (
              <div key={item.id}>
                <dt>{item.title}</dt>
                <dd>{item.reason}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  );
}
