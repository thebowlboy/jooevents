import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { createBackendProxyConfig } from './vite-routing.js';

const securityHeaders = {
  'Cache-Control': 'no-store, max-age=0',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY'
};

// Documents get the full auth security treatment including no-store. Modules,
// assets, and fonts must remain cacheable or every navigation re-downloads the
// whole dev/preview module graph on each load.
const applySecurityHeaders = (
  request: { headers: { accept?: string } },
  response: { setHeader(name: string, value: string): void },
  next: () => void
) => {
  if (request.headers.accept?.includes('text/html')) {
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
  }
  next();
};

const entrySecurityHeaders = {
  name: 'jooevents-entry-security-headers',
  configureServer(server) {
    server.middlewares.use(applySecurityHeaders);
  },
  configurePreviewServer(server) {
    server.middlewares.use(applySecurityHeaders);
  }
} satisfies Plugin;

function parseAllowedHosts(value: string | undefined): string[] {
  return value?.split(',').map((host) => host.trim()).filter(Boolean) ?? [];
}

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, process.cwd(), 'JOOEVENTS_');
  const allowedHosts = parseAllowedHosts(
    process.env.JOOEVENTS_DEV_ALLOWED_HOSTS ?? environment.JOOEVENTS_DEV_ALLOWED_HOSTS
  );
  const hostPolicy = allowedHosts.length > 0 ? { allowedHosts } : {};
	const operatorWorkspaceRoot = fileURLToPath(new URL(
		mode === 'live'
			? './src/lib/api/composition/operator-workspace-root.live.svelte'
			: './src/lib/api/composition/operator-workspace-root.svelte',
		import.meta.url
	));
	const participantPortalRoot = fileURLToPath(new URL(
		mode === 'live'
			? './src/lib/api/composition/participant-portal-root.live.svelte'
			: './src/lib/api/composition/participant-portal-root.svelte',
		import.meta.url
	));
	const publicSurfaceRoot = fileURLToPath(new URL(
		mode === 'live'
			? './src/lib/api/composition/public-surface-root.live.svelte'
			: './src/lib/api/composition/public-surface-root.sample.svelte',
		import.meta.url
	));
	const publicSurfacePage = fileURLToPath(new URL(
		mode === 'live'
			? './src/lib/api/composition/public-surface-page.live.svelte'
			: './src/lib/features/public/PublicSurfacePage.svelte',
		import.meta.url
	));
	const operatorPage = fileURLToPath(new URL(
		mode === 'live'
			? './src/lib/api/composition/operator-page.live.svelte'
			: './src/lib/api/composition/operator-page.sample.svelte',
		import.meta.url
	));
	const entryDeps = fileURLToPath(new URL(
		mode === 'live'
			? './src/lib/api/composition/entry-deps.live.ts'
			: './src/lib/api/composition/entry-deps.ts',
		import.meta.url
	));

  return {
    plugins: [entrySecurityHeaders, sveltekit()],
		resolve: {
			alias: [
				{
					find: 'jooevents-operator-workspace-root',
					replacement: operatorWorkspaceRoot
				},
				{
					find: 'jooevents-participant-portal-root',
					replacement: participantPortalRoot
				},
				{
					find: 'jooevents-public-surface-root',
					replacement: publicSurfaceRoot
				},
				{
					find: 'jooevents-public-surface-page',
					replacement: publicSurfacePage
				},
				{
					find: 'jooevents-operator-page',
					replacement: operatorPage
				},
				{
					find: 'jooevents-entry-deps',
					replacement: entryDeps
				}
			]
		},
    server: {
      host: '0.0.0.0',
      port: 5176,
      strictPort: true,
      ...hostPolicy,
      proxy: createBackendProxyConfig()
    },
    preview: {
      host: '0.0.0.0',
      port: 5176,
      strictPort: true,
      ...hostPolicy,
      proxy: createBackendProxyConfig()
    }
  };
});
