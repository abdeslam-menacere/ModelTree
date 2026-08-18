import { AlertTriangle, ExternalLink, Info } from 'lucide-react';
import type { UsageEvidenceGroup, UsageEvidenceView, UsageObservationView } from '../lib/usage-evidence';
import { formatDate } from '../lib/format';

interface Props {
  evidence: UsageEvidenceView;
  releaseName: string;
  headingId?: string;
}

function formatWindow(start: string, end: string) {
  return start === end ? start : `${start} to ${end}`;
}

function ObservationCard({ view }: { view: UsageObservationView }) {
  const { observation } = view;

  return (
    <li className="usage-observation">
      <p className="usage-provenance">
        <span className="usage-provenance-label">{view.provenanceLabel}</span>
        {view.isCreatorSelfReport ? (
          <span className="usage-provenance-note">Published by the model creator, not independent evidence.</span>
        ) : null}
      </p>
      <p className="usage-statement">{observation.valueAsStated}</p>
      <dl className="usage-facts">
        <div>
          <dt>Metric</dt>
          <dd>{observation.metricLabel} ({observation.unit})</dd>
        </div>
        <div>
          <dt>Measured population</dt>
          <dd>{observation.population}</dd>
        </div>
        <div>
          <dt>Time window</dt>
          <dd>{formatWindow(observation.windowStart, observation.windowEnd)}</dd>
        </div>
        <div>
          <dt>Methodology</dt>
          <dd>{observation.methodology}</dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{observation.scope}</dd>
        </div>
        <div>
          <dt>Last verified</dt>
          <dd>
            {formatDate(observation.verifiedAt)}
            {view.isStale ? (
              <span className="usage-stale">
                <AlertTriangle size={14} aria-hidden="true" />
                Stale: not re-checked for {view.daysSinceVerified} days
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
      {view.conflictsWith.length > 0 ? (
        <p className="usage-conflict">
          <AlertTriangle size={15} aria-hidden="true" />
          Conflicts with another recorded reading of {view.conflictsWith.join(', ')}. Both readings are kept; ModelTree does not pick a winner.
        </p>
      ) : null}
      <div className="usage-caveats">
        <h5>Caveats</h5>
        <ul>{observation.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
      </div>
      <ul className="usage-sources">
        {view.sources.map((source) => (
          <li key={source.id}>
            <a href={source.url}>
              {source.title}
              <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
              <span className="visually-hidden"> — {source.publisher}, {source.type.replaceAll('-', ' ')}</span>
            </a>
            <span className="usage-source-meta">
              {source.publisher} · {source.type.replaceAll('-', ' ')} · checked {formatDate(source.lastCheckedDate)}
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

function EvidenceGroup({ group }: { group: UsageEvidenceGroup }) {
  const selfReports = group.observations.filter((view) => view.isCreatorSelfReport);
  const independent = group.observations.filter((view) => !view.isCreatorSelfReport);
  const groupId = `usage-group-${group.key.replace(/[^a-z0-9]+/gi, '-')}`;

  return (
    <article className="usage-group" aria-labelledby={groupId}>
      <h3 id={groupId}>{group.metricLabel}</h3>
      <p className="usage-group-scope">
        Measured over {group.population}, reported in {group.unit}. Readings of other metrics or
        populations are listed separately and are not combined with these.
      </p>
      <p className="usage-synthesis-eligibility">
        {group.canSynthesize
          ? `Cross-source synthesis is available: ${group.independentPublishers.length} independent publishers reported this metric.`
          : 'Single-source evidence: not enough independent non-creator sources for a cross-source statement.'}
      </p>

      {independent.length > 0 ? (
        <section aria-labelledby={`${groupId}-independent`}>
          <h4 id={`${groupId}-independent`}>Independent evidence</h4>
          <ul className="usage-observations">
            {independent.map((view) => <ObservationCard key={view.observation.id} view={view} />)}
          </ul>
        </section>
      ) : null}

      {selfReports.length > 0 ? (
        <section aria-labelledby={`${groupId}-self-reported`}>
          <h4 id={`${groupId}-self-reported`}>Creator self-reports</h4>
          <ul className="usage-observations">
            {selfReports.map((view) => <ObservationCard key={view.observation.id} view={view} />)}
          </ul>
        </section>
      ) : null}
    </article>
  );
}

export default function UsageEvidence({ evidence, releaseName, headingId = 'usage-title' }: Props) {
  return (
    <section className="passport-section usage-section" aria-labelledby={headingId}>
      <div className="section-heading">
        <span className="section-number">04</span>
        <div>
          <span className="eyebrow">Usage evidence</span>
          <h2 id={headingId}>Who reports using it</h2>
        </div>
      </div>

      {evidence.state === 'no-data' ? (
        <div className="usage-empty">
          <p className="usage-empty-headline">
            <Info size={17} aria-hidden="true" />
            No source-qualified usage evidence is recorded for {releaseName}.
          </p>
          <p>
            ModelTree records a usage figure only when a citable source states the metric, the
            population it measured, the time window, and the method behind it. Absence here means no
            qualifying observation has been verified, not that the model is unused.
          </p>
        </div>
      ) : (
        <>
          <ul className="usage-flags">
            <li>{evidence.observationCount} recorded observation{evidence.observationCount === 1 ? '' : 's'}</li>
            {evidence.hasCreatorSelfReport ? <li>Includes creator self-reports, listed separately</li> : null}
            {evidence.hasConflict ? <li>Includes conflicting readings, kept side by side</li> : null}
            {evidence.hasStale ? <li>Includes stale figures awaiting re-verification</li> : null}
          </ul>

          {evidence.syntheses.length > 0 ? (
            <div className="usage-syntheses">
              <h3>Cross-source statements</h3>
              <ul>
                {evidence.syntheses.map(({ synthesis, isStale }) => (
                  <li key={synthesis.id}>
                    <p className="usage-synthesis-kind">
                      {synthesis.agreement === 'agreeing'
                        ? 'Independent sources agree'
                        : 'Independent sources disagree'}
                    </p>
                    <p>{synthesis.statement}</p>
                    <p className="usage-comparability">{synthesis.comparabilityNote}</p>
                    <ul className="usage-caveat-list">
                      {synthesis.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
                    </ul>
                    <p className="usage-source-meta">
                      Verified {formatDate(synthesis.verifiedAt)}
                      {isStale ? ' — stale, awaiting re-verification' : ''}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="usage-groups">
            {evidence.groups.map((group) => <EvidenceGroup key={group.key} group={group} />)}
          </div>
        </>
      )}

      <details className="usage-methodology">
        <summary>How ModelTree qualifies usage evidence</summary>
        <div>
          <h3>Incompatible populations are never merged</h3>
          <p>
            Weekly users of one assistant, downloads from one model hub, and routed tokens on one
            aggregator count different populations. ModelTree groups observations only when the
            metric, the unit, and the measured population match exactly. Nothing is converted,
            normalized, weighted, or ranked, and there is no composite popularity score.
          </p>
          <h3>Sources are qualified, not scored</h3>
          <p>
            Every observation names the exact sources behind it and states whether it is a creator
            self-report, a platform operator report, an independent measurement, a developer survey,
            or a community signal. Creator self-reports are kept in their own labelled list because
            the creator has an interest in the figure; they are still shown, never hidden.
          </p>
          <h3>A synthesis needs two independent publishers</h3>
          <p>
            A cross-source statement may only be made when at least two non-creator observations from
            at least two different publishers measure the same metric over the same population. A
            single-source observation is still published as an observation, but it cannot produce a
            cross-source statement.
          </p>
          <h3>Missing and conflicting evidence stays visible</h3>
          <p>
            When no qualifying source exists, this section says so rather than estimating. When two
            qualifying sources disagree, both readings are shown and labelled as conflicting; neither
            is dropped and no winner is declared. A figure that has not been re-checked within
            {' '}180 days is marked stale.
          </p>
        </div>
      </details>
    </section>
  );
}
