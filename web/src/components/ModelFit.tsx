import { AlertTriangle, ExternalLink, Info, ScrollText } from 'lucide-react';
import type { FitGroupView, FitStatementView, ModelFitView } from '../lib/model-fit';
import { STALE_AFTER_DAYS, fitRubric } from '../lib/model-fit';
import { formatDate } from '../lib/format';

interface Props {
  guidance: ModelFitView;
  releaseName: string;
  headingId?: string;
}

function SourceLinks({ sources, label }: { sources: FitStatementView['sources']; label: string }) {
  return (
    <ul className="fit-sources" aria-label={label}>
      {sources.map(({ source, publisherName }) => (
        <li key={source.id}>
          <a href={source.url}>
            {source.title}
            <ExternalLink size={14} strokeWidth={1.8} aria-hidden="true" />
            <span className="visually-hidden"> — {publisherName}, {source.type.replaceAll('-', ' ')}</span>
          </a>
          <span className="fit-source-meta">
            {publisherName} · {source.type.replaceAll('-', ' ')} · checked {formatDate(source.lastCheckedDate)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function StatementCard({ view }: { view: FitStatementView }) {
  const { statement } = view;
  const headingId = `fit-${statement.id}`;

  return (
    <article className="fit-statement" aria-labelledby={headingId}>
      <h4 id={headingId}>
        <span className="fit-classification">{view.classificationLabel}</span>
        <span className="fit-condition">{statement.condition}</span>
      </h4>

      <p className="fit-synthesis">
        <span className="fit-synthesis-label">ModelTree editorial synthesis</span>
        {statement.statement}
      </p>

      <dl className="fit-facts">
        <div>
          <dt>Rubric dimensions used</dt>
          <dd>
            <ul className="fit-dimensions">
              {view.rubric.map(({ dimension, label, question }) => (
                <li key={dimension}>{label}<span className="fit-dimension-question"> — {question}</span></li>
              ))}
            </ul>
          </dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{statement.scope}</dd>
        </div>
        <div>
          <dt>Last verified</dt>
          <dd>
            {formatDate(statement.verifiedAt)}
            {view.isStale ? (
              <span className="fit-stale">
                <AlertTriangle size={14} aria-hidden="true" />
                Stale: not re-checked for {view.daysSinceVerified} days
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      {view.conflictsWith.length > 0 ? (
        <p className="fit-conflict">
          <AlertTriangle size={15} aria-hidden="true" />
          Contradicted by other recorded guidance for this model:{' '}
          {view.conflictsWith.map(({ classificationLabel, condition }) => `“${classificationLabel} ${condition}”`).join('; ')}.
          Both readings are kept and neither is treated as settling the question.
        </p>
      ) : null}

      <div className="fit-caveats">
        <h5>Caveats</h5>
        <ul>{statement.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}</ul>
      </div>

      <div className="fit-evidence">
        <h5>What this rests on</h5>
        {view.evidenceByClass.map((group) => (
          <section key={group.evidenceClass} className={`fit-evidence-group fit-evidence-${group.evidenceClass}`}>
            <h6>{group.label}</h6>
            <p className="fit-evidence-note">{group.note}</p>
            <ul className="fit-evidence-facts">
              {group.facts.map((fact) => (
                <li key={fact.key}>
                  <p className="fit-fact">
                    <span className="fit-fact-label">{fact.label}</span>
                    <span className="fit-fact-detail">{fact.detail}</span>
                  </p>
                  <p className="fit-source-meta">Recorded fact, verified {formatDate(fact.verifiedAt)}</p>
                  <SourceLinks sources={fact.sources} label={`Sources for ${fact.label}`} />
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="fit-statement-sources">
        <h5>Cited by this statement</h5>
        <SourceLinks sources={view.sources} label="Sources cited by this statement" />
      </div>
    </article>
  );
}

function FitGroup({ group }: { group: FitGroupView }) {
  const headingId = `fit-group-${group.classification}`;

  return (
    <section className={`fit-group fit-group-${group.classification}`} aria-labelledby={headingId}>
      <h3 id={headingId}>{group.label}</h3>
      <p className="fit-group-description">{group.description}</p>
      {group.statements.map((view) => <StatementCard key={view.statement.id} view={view} />)}
    </section>
  );
}

export default function ModelFit({ guidance, releaseName, headingId = 'fit-title' }: Props) {
  return (
    <section className="passport-section fit-section" aria-labelledby={headingId}>
      <div className="section-heading">
        <span className="section-number">05</span>
        <div>
          <span className="eyebrow">Conditional fit</span>
          <h2 id={headingId}>When it fits, and when it does not</h2>
        </div>
      </div>

      <p className="fit-disclosure">
        <ScrollText size={17} aria-hidden="true" />
        Everything in this section is ModelTree editorial synthesis: a reading of facts recorded
        elsewhere in this dataset, each traced to the sources beneath it. It is conditional guidance
        for a stated situation. It does not declare this model preferable to another, and no overall
        verdict is produced here or anywhere else in ModelTree.
      </p>

      {guidance.state === 'no-guidance' ? (
        <div className="fit-empty">
          <p className="fit-empty-headline">
            <Info size={17} aria-hidden="true" />
            No conditional-fit guidance is recorded for {releaseName}.
          </p>
          <p>
            A statement is published only when it can be derived from specific recorded facts about
            this release and cite the sources those facts already carry. Absence here means no such
            statement has been verified, not that the model suits every situation or none.
          </p>
        </div>
      ) : (
        <>
          <ul className="fit-flags">
            <li>{guidance.statementCount} recorded statement{guidance.statementCount === 1 ? '' : 's'}</li>
            {guidance.hasConflict ? <li>Includes contradicting statements, kept side by side</li> : null}
            {guidance.hasStale ? <li>Includes stale guidance awaiting re-verification</li> : null}
            {guidance.gaps.length > 0 ? <li>{guidance.gaps.length} rubric dimension{guidance.gaps.length === 1 ? '' : 's'} with no qualifying evidence</li> : null}
          </ul>

          <div className="fit-groups">
            {guidance.groups.map((group) => <FitGroup key={group.classification} group={group} />)}
          </div>
        </>
      )}

      {guidance.gaps.length > 0 ? (
        <section className="fit-gaps" aria-labelledby="fit-gaps-title">
          <h3 id="fit-gaps-title">Where the evidence runs out</h3>
          <p className="fit-group-description">
            Rubric dimensions ModelTree looked at for this release and could not support. They are
            recorded so a silent absence is not read as a judgement either way.
          </p>
          <ul className="fit-gap-list">
            {guidance.gaps.map(({ gap, dimensionLabel, question, reasonLabel }) => (
              <li key={gap.id}>
                <p className="fit-gap-dimension">
                  <span className="fit-fact-label">{dimensionLabel}</span>
                  <span className="fit-gap-reason">{reasonLabel}</span>
                </p>
                <p className="fit-dimension-question">{question}</p>
                <p>{gap.note}</p>
                <p className="fit-source-meta">Checked {formatDate(gap.verifiedAt)}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <details className="fit-methodology">
        <summary>How ModelTree derives conditional fit</summary>
        <div>
          <h3>Guidance is conditional, never a verdict</h3>
          <p>
            Every statement is filed as one of three kinds — good fit when, trade-off, or avoid when —
            and each carries the condition it applies under. There is no fourth, unconditional kind,
            no composite score, and no comparison against other models. Validation refuses winner
            language outright: a statement that calls a model the strongest, the one to pick for
            everything, or that places it above the field is rejected before it can be published.
          </p>
          <h3>The rubric is disclosed, not weighted</h3>
          <p>
            A statement names the dimensions it was derived from, and each dimension must be answered
            by a fact of a kind that can answer it. Dimensions are never added up or weighed against
            each other; they exist so a reader can see which questions were asked.
          </p>
          <ul className="fit-rubric-list">
            {fitRubric().map(({ dimension, label, question }) => (
              <li key={dimension}><strong>{label}</strong> — {question}</li>
            ))}
          </ul>
          <h3>The evidence threshold</h3>
          <p>
            A statement must rest on at least one structured fact already recorded here — a release or
            family field, a lifecycle event, an evaluation result, a usage observation, or a pricing
            record — and it must be a fact about this release. It may cite only sources those facts
            already cite, so guidance can never introduce a claim no recorded fact carries, and it
            cannot be dated earlier than the evidence beneath it.
          </p>
          <h3>Conflicts are shown, not resolved</h3>
          <p>
            When two statements about this release contradict each other on the same dimension, both
            are published and linked to one another. ModelTree does not decide between them, and the
            underlying disagreement between sources is left visible.
          </p>
          <h3>What this cannot tell you</h3>
          <p>
            Recorded facts are mostly documentation, and documentation states what an interface
            accepts rather than how well a model behaves. Where a dimension has no qualifying
            evidence, it is listed as a gap instead of being filled by inference. Guidance that has
            not been re-checked within {STALE_AFTER_DAYS} days is marked stale. Nothing here is a
            recommendation tailored to a reader, and nothing here ranks models.
          </p>
        </div>
      </details>
    </section>
  );
}
