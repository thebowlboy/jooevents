import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';

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

  return {
    plugins: [entrySecurityHeaders, sveltekit()],
    server: {
      host: '0.0.0.0',
      port: 5176,
      strictPort: true,
      ...hostPolicy,
      proxy: { '/api': 'http://127.0.0.1:5177' }
    },
    preview: {
      host: '0.0.0.0',
      port: 5176,
      strictPort: true,
      ...hostPolicy,
      proxy: { '/api': 'http://127.0.0.1:5177' }
    }
  };
});
