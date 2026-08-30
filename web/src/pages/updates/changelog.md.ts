import type { APIRoute } from 'astro';
import { dataset } from '../../data/dataset';
import { buildUpdateFeed, renderUpdatesChangelog } from '../../lib/updates-feed';
import { buildUpdateIndex } from '../../lib/updates';

/**
 * The public changelog, generated at build time from the same records `/updates`
 * renders.
 *
 * Emitted rather than committed. A changelog file checked into the repository
 * would be a second copy of facts the dataset already holds, and the two would
 * drift the first time someone edited one and not the other. Generating it means
 * there is exactly one source for a release event, and the artifact cannot say
 * anything the page does not.
 *
 * Markdown rather than HTML, so the same bytes read well in a terminal, in a
 * diff, and in a browser, and so a consumer can paste it into release notes
 * without stripping tags.
 */
export const prerender = true;

export const GET: APIRoute = () => {
  const base = import.meta.env.BASE_URL;
  const index = buildUpdateIndex(dataset, base);
  const feed = buildUpdateFeed(index, { updatesUrl: `${base}updates/` });

  return new Response(renderUpdatesChangelog({ feed, records: index.records }), {
    headers: { 'content-type': 'text/markdown; charset=utf-8' },
  });
};
