// @ts-check
import react from '@astrojs/react';
import { env } from 'node:process';
import { defineConfig } from 'astro/config';

// The origin the deploy and CI both set through SITE_URL. Canonical URLs, the
// sitemap, robots, and Open Graph tags are generated at build (ADR 0001) and are
// meaningless without an absolute origin, so a build with no SITE_URL falls back
// to the settled production origin rather than emitting empty canonical/OG tags
// or failing the sitemap endpoint. The deploy (pages.yml) and web-ci.yml still
// pass SITE_URL explicitly and win over this default; base keeps its '/' default
// so a local root-base build is unchanged.
const SITE_URL = env.SITE_URL ?? 'https://abdeslam-menacere.github.io';

// https://astro.build/config
export default defineConfig({
	site: SITE_URL,
	base: env.BASE_PATH ?? '/',
	integrations: [react()],
	output: 'static',
});
