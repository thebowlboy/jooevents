import adapter from '@sveltejs/adapter-static';

const outputDirectory = process.env.JOOEVENTS_WEB_BUILD_KIND === 'live'
  ? 'build-live'
  : 'build';
const routesDirectory = process.env.JOOEVENTS_WEB_BUILD_KIND === 'live'
  ? 'src/.live-routes'
  : 'src/routes';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
		files: {
			routes: routesDirectory
		},
    adapter: adapter({
			pages: outputDirectory,
			assets: outputDirectory,
      fallback: 'index.html',
      strict: false
    })
  }
};

export default config;
