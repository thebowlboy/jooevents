import { portalLiveManifestFixture } from '../src/lib/api/files/manifest-fixture';

/**
 * Prints the files-vertical operation manifest fixture (plus the portal's
 * core snapshot/respond operations) as one JSON document. The `.live.ts` e2e
 * specs shell out to this (Playwright's Node transform does not compile
 * workspace TypeScript packages, bun does) and serve the result at
 * `/api/operations/manifest`, so the browser exercises the real
 * binding-resolution path against digests recomputed from the contracts.
 */
process.stdout.write(JSON.stringify(portalLiveManifestFixture()));
