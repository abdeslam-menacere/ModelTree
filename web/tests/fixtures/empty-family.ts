import { familySchema } from '../../src/data/schema';
import type { Dataset } from '../../src/data/schema';

/**
 * Adds a family that no release belongs to — after validation, and deliberately
 * outside it.
 *
 * `validateDataset` refuses that shape (abdeslam-menacere/ModelTree#554), which
 * is the point rather than an obstacle: an empty family is a data error the
 * dataset cannot state as "announced but unreleased", so the build must fail
 * instead of publishing a heading above an empty list. The refusal is the first
 * line of defence and the one that keeps a family count honest.
 *
 * The hierarchy builders drop such a family as well, and that second line still
 * needs exercising. A fixture cannot reach it through the validator any more,
 * so it goes round — narrowly. Only the family -> release rule is bypassed:
 * the record is still parsed by `familySchema`, so a fixture that drifts into a
 * malformed family fails here rather than quietly testing a shape no dataset
 * could hold.
 *
 * The guard below is what makes a fixture built with this worth reading. A
 * family that turns out to have a release would produce exactly the "it is
 * present in both hierarchies" result a working filter produces, so it is
 * refused rather than allowed to look like a pass.
 */
export function withEmptyFamily(dataset: Dataset, family: unknown): Dataset {
  const parsed = familySchema.parse(family);

  if (dataset.families.some(({ id }) => id === parsed.id)) {
    throw new Error(`withEmptyFamily: ${parsed.id} is already in the dataset`);
  }
  if (dataset.releases.some(({ familyId }) => familyId === parsed.id)) {
    throw new Error(
      `withEmptyFamily: a release already belongs to ${parsed.id}, so this fixture is not empty and proves nothing`,
    );
  }

  return { ...dataset, families: [...dataset.families, parsed] };
}
