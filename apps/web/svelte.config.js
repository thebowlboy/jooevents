import adapter from '@sveltejs/adapter-static';

const outputDirectory = process.env.JOOEVENTS_WEB_BUILD_KIND === 'live'
  ? 'build-live'
  : 'build';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    adapter: adapter({
			pages: outputDirectory,
			assets: outputDirectory,
      fallback: 'index.html',
      strict: false
    })
  }
};

export default config;
