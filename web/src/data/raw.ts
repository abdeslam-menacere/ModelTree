import families from './families.json';
import benchmarks from './benchmarks.json';
import benchmarkResults from './benchmark-results.json';
import modelFitEvidenceGaps from './model-fit-evidence-gaps.json';
import modelFitStatements from './model-fit-statements.json';
import organizations from './organizations.json';
import publishers from './publishers.json';
import releases from './releases.json';
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
  benchmarks,
  benchmarkResults,
  usageObservations,
  usageSyntheses,
  modelFitStatements,
  modelFitEvidenceGaps,
};