import { redirect } from '@sveltejs/kit';
import { firstSettingsSection } from '$lib/features/settings/sections';

/*
 * Settings is a group of sections, not a page of its own: the address opens on
 * the first section so one URL never presents content another URL owns. Served
 * from the SPA fallback rather than prerendered, because the answer is this
 * redirect.
 */
export const prerender = false;

export function load(): never {
	redirect(307, firstSettingsSection.href);
}
