import families from './families.json';
import benchmarks from './benchmarks.json';
import benchmarkResults from './benchmark-results.json';
// A model is one entity, the product it is placed inside is another, and the
// platform that serves it is a third. They are separate documents so that a
// deployment can never be mistaken for evidence of who built the model.
import deployments from './deployments.json';
import modelFitEvidenceGaps from './model-fit-evidence-gaps.json';
import modelFitStatements from './model-fit-statements.json';
import organizations from './organizations.json';
import products from './products.json';
import publishers from './publishers.json';
import releaseEvents from './release-events.json';
import releases from './releases.json';
import servingPlatforms from './serving-platforms.json';
import sources from './sources.json';
// Empty until an observation can be tied to a real source that states its
// metric, population, window, and method. Absence is the honest default.
import usageObservations from './usage-observations.json';
import usageSyntheses from './usage-syntheses.json';

export const rawDataset = {
  sources,
  publishers,
  organizations,
  families,
  releases,
  products,
  servingPlatforms,
  deployments,
  releaseEvents,
  benchmarks,
  benchmarkResults,
  usageObservations,
  usageSyntheses,
  modelFitStatements,
  modelFitEvidenceGaps,
};