// @ts-check
import react from '@astrojs/react';
import { env } from 'node:process';
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	site: env.SITE_URL,
	base: env.BASE_PATH ?? '/',
	integrations: [react()],
	output: 'static',
});
