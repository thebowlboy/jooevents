/**
 * A record address is minted from data, so the static build cannot enumerate
 * its pages. The app is a client-rendered SPA behind an `index.html` fallback,
 * which serves every one of them — the same arrangement the workspace's
 * catch-all destination already uses.
 */
export const prerender = false;
