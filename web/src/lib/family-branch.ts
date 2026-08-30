/**
 * The membership rule every creator hierarchy on this site applies: a family is
 * a branch only where at least one release belongs to it.
 *
 * It lives in one place because it was previously written out three times and
 * one of the three was missing. `model-tree.ts` and `lineage-view.ts` each
 * carried `.filter(({ releases }) => releases.length > 0)`; `homepage.ts` never
 * did, so `/tree/` dropped a family with no releases while the homepage's
 * `<noscript>` hierarchy rendered it as a heading above an empty list and the
 * page still counted it (abdeslam-menacere/ModelTree#554). Three copies of a
 * rule is three chances to omit one, and that is the defect rather than a
 * detail of it.
 *
 * This is the second line of defence and not the first. `validateDataset`
 * refuses a family that no release belongs to, so a dataset carrying one never
 * reaches these builders at all — see the note beside that check in
 * `web/src/data/validate.ts` for why the refusal is what keeps the family count
 * a page prints equal to the branches it renders. What this predicate adds is
 * that the two hierarchies answer alike whatever they are handed, including the
 * unvalidated fixtures the tests build.
 */
export function hasRecordedRelease({ releases }: { releases: readonly unknown[] }) {
  return releases.length > 0;
}
