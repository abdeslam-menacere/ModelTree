import families from './families.json';
import organizations from './organizations.json';
import releases from './releases.json';
import sources from './sources.json';
// Empty until an observation can be tied to a real source that states its
// metric, population, window, and method. Absence is the honest default.
import usageObservations from './usage-observations.json';
import usageSyntheses from './usage-syntheses.json';

export const rawDataset = {
  sources,
  organizations,
  families,
  releases,
  usageObservations,
  usageSyntheses,
};