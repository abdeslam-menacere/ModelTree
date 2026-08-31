import variantPositioningRecords from './variant-positioning.json';
import { validateVariantPositioning } from './variant-positioning-schema';

/**
 * Variant positioning, validated at build time like every other document here.
 *
 * Kept out of `raw.ts` on purpose. `gate-scope.mjs` bounds an auto-merging
 * refresh to exactly the documents `raw.ts` composes, and `editorial.summary` is
 * ModelTree's own prose — the kind of change a person should have to accept.
 * `glossary.ts` and `refresh-log.ts` are kept out for the same reason.
 */
export const variantPositioning = validateVariantPositioning(variantPositioningRecords);

export const variantPositioningByFamilyId = new Map(
  variantPositioning.map((record) => [record.familyId, record]),
);
