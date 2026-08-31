/**
 * The Model DNA identity strip (issue #37).
 *
 * A React component with no `client:` directive, rendered to static markup like
 * `ModelPassport` beside it, so it costs no client JavaScript and is still
 * assertable against real HTML. The passport route's asset budget tracks a
 * near-zero JS ceiling; a hydration directive here would trip it immediately.
 *
 * Everything this component decides is layout. What each segment says, which
 * field it came from, what order they appear in, and what an absent one reads
 * as, are all settled in `lib/model-dna.ts` and arrive on the view.
 *
 * **Nothing is carried by colour, hue, or glyph.** Every segment prints its
 * label and its value as text, including the ones with nothing recorded, which
 * print the words rather than being dimmed or dropped. That is what makes the
 * strip its own text equivalent: strip the stylesheet entirely and it still
 * reads as nine labelled facts in a fixed order. The disclosure beneath adds the
 * definition and the record field behind each one; it is always rendered, needs
 * no pointer and no script, and holds no fact the strip does not already state.
 *
 * There is deliberately no genome imagery, no coloured swatch, and no
 * per-creator hue: `docs/product/INTERACTION-CONTRACT.md` rules out colour that
 * implies a category the dataset does not record, and this dataset records no
 * scale for one to encode.
 */
import type { ModelDnaView } from '../lib/model-dna';

interface Props {
  dna: ModelDnaView;
}

export default function ModelDna({ dna }: Props) {
  return (
    <div className="model-dna">
      <h3 id={dna.headingId}>{dna.title}</h3>
      <p className="model-dna-note">{dna.note}</p>

      <ul className="model-dna-strip" role="list" aria-labelledby={dna.headingId}>
        {dna.segments.map((segment) => (
          <li
            className={segment.recorded ? 'model-dna-segment' : 'model-dna-segment model-dna-absent'}
            key={segment.id}
            data-dimension={segment.id}
            data-recorded={segment.recorded ? 'true' : 'false'}
          >
            <span className="model-dna-label">{segment.label}</span>
            <span className="model-dna-value">{segment.value}</span>
          </li>
        ))}
      </ul>

      <details className="model-dna-key">
        <summary>{dna.textEquivalentLabel}</summary>
        <dl>
          {dna.segments.map((segment) => (
            <div key={segment.id} data-dimension={segment.id}>
              <dt>{segment.label}</dt>
              <dd>
                <span className="model-dna-key-value">{segment.value}</span>
                <span className="model-dna-key-definition">{segment.definition}</span>
                {segment.absenceNote ? (
                  <span className="model-dna-key-absence">{segment.absenceNote}</span>
                ) : null}
                {/* Named in the reader's view, not just in the source. A summary
                    that says where a fact came from is checkable; one that only
                    asserts the fact is not. */}
                <span className="model-dna-key-field">
                  Read from <code>{segment.field}</code> on this release record.
                </span>
                {segment.definitionHref && segment.definitionLinkText ? (
                  <a href={segment.definitionHref}>{segment.definitionLinkText}</a>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
