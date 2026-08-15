import { dataset } from '../data/dataset';

/**
 * The single list both the model route and the catalog index check read, so an
 * index row can never promise a detail page the build does not generate.
 */
export function modelStaticPaths() {
  return dataset.releases.map((release) => ({
    params: { slug: release.slug },
    props: { releaseId: release.id },
  }));
}
