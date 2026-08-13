<script lang="ts">
	import type { SafeUser, SafeWorkspace } from '@jooevents/contracts';
	import { tick, type Snippet } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import {
		CalendarDays,
		CodeXml,
		FileText,
		Inbox,
		LayoutDashboard,
		LayoutTemplate,
		ListChecks,
		Menu,
		Send,
		Settings,
		Stamp,
		UserPen,
		Users,
		X
	} from 'lucide-svelte';
	import wordmarkUrl from '$lib/assets/brand/jooevents-wordmark-login-256.png';
	import { signOut as signOutRequest } from '$lib/api/auth';
	import AccountMenu from './AccountMenu.svelte';

	let {
		user,
		workspace,
		children
	}: {
		readonly user: SafeUser;
		readonly workspace: SafeWorkspace;
		readonly children: Snippet;
	} = $props();

	const navigationGroups = Object.freeze([
		Object.freeze({
			label: 'Workspace',
			items: Object.freeze([{ label: 'Overview', href: '/app', icon: LayoutDashboard }])
		}),
		Object.freeze({
			label: 'Program',
			items: Object.freeze([
				{ label: 'Submissions', href: '/app/submissions', icon: Inbox },
				{ label: 'Review', href: '/app/review', icon: ListChecks },
				{ label: 'Decisions', href: '/app/decisions', icon: Stamp }
			])
		}),
		Object.freeze({
			label: 'People',
			items: Object.freeze([
				{ label: 'Speakers', href: '/app/speakers', icon: Users },
				{ label: 'Reviewers', href: '/app/reviewers', icon: UserPen },
				{ label: 'Tasks', href: '/app/tasks', icon: ListChecks }
			])
		}),
		Object.freeze({
			label: 'Event',
			items: Object.freeze([
				{ label: 'Schedule', href: '/app/schedule', icon: CalendarDays },
				{ label: 'Communications', href: '/app/messages', icon: Send },
				{ label: 'Forms', href: '/app/forms', icon: FileText },
				{ label: 'Templates', href: '/app/templates', icon: LayoutTemplate },
				{ label: 'Embeds', href: '/app/embeds', icon: CodeXml }
			])
		}),
		Object.freeze({
			label: 'Administration',
			items: Object.freeze([{ label: 'Settings', href: '/app/settings', icon: Settings }])
		})
	]);
	const navigation = navigationGroups.flatMap((group) => group.items);

	let navOpen = $state(false);
	let isNarrow = $state(false);
	let navElement = $state<HTMLElement>();
	let closeButton = $state<HTMLButtonElement>();
	let menuButton = $state<HTMLButtonElement>();
	const presentedPath = $derived(page.url.pathname);
	const title = $derived(
		[...navigation]
			.sort((left, right) => right.href.length - left.href.length)
			.find((item) => pathIsActive(presentedPath, item.href))?.label ?? 'Workspace'
	);
	/**
	 * The confirmed sign-out discipline: the adapter answers before anything
	 * local moves, and the support code is the server's own correlation ID.
	 */
	async function accountSignOut(): Promise<{ ok: boolean; correlationId?: string }> {
		const result = await signOutRequest();
		if (result.kind === 'success') return { ok: true };
		return {
			ok: false,
			...(result.error.correlationId ? { correlationId: result.error.correlationId } : {})
		};
	}

	afterNavigate(() => {
		navOpen = false;
	});

	async function openNav() {
		navOpen = true;
		await tick();
		closeButton?.focus();
	}

	async function closeNav() {
		navOpen = false;
		await tick();
		menuButton?.focus();
	}

	function pathIsActive(pathname: string, href: string): boolean {
		return href === '/app'
			? pathname === href
			: pathname === href || pathname.startsWith(`${href}/`);
	}

	function onKeydown(event: KeyboardEvent) {
		if (!navOpen || !isNarrow) return;
		if (event.key === 'Escape') {
			void closeNav();
			return;
		}
		if (event.key !== 'Tab' || !navElement) return;
		const focusable = Array.from(
			navElement.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
		).filter((element) => !element.hidden && element.getClientRects().length > 0);
		const first = focusable[0];
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (event.shiftKey && (document.activeElement === first || !navElement.contains(document.activeElement))) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}

	$effect(() => {
		const query = window.matchMedia('(max-width: 920px)');
		const apply = () => {
			isNarrow = query.matches;
			if (!query.matches) navOpen = false;
		};
		apply();
		query.addEventListener('change', apply);
		return () => query.removeEventListener('change', apply);
	});

	$effect(() => {
		if (!navOpen || !isNarrow) return;
		const root = document.documentElement;
		const body = document.body;
		const rootOverflow = root.style.overflow;
		const bodyOverflow = body.style.overflow;
		root.style.overflow = 'hidden';
		body.style.overflow = 'hidden';
		return () => {
			root.style.overflow = rootOverflow;
			body.style.overflow = bodyOverflow;
		};
	});
</script>

<svelte:window onkeydown={onKeydown} />

<div class="live-shell">
	<aside
		bind:this={navElement}
		class:live-nav--open={navOpen}
		class="live-nav"
		inert={isNarrow && !navOpen}
		role={isNarrow && navOpen ? 'dialog' : undefined}
		aria-modal={isNarrow && navOpen ? 'true' : undefined}
		aria-label={isNarrow && navOpen ? 'Workspace navigation' : 'Live workspace navigation'}>
		<div class="live-nav__brand-row">
			<a href="/app" class="live-nav__brand">
				<img src={wordmarkUrl} alt="JooEvents" width="120" height="21" />
			</a>
			<button
				type="button"
				class="ui-button ui-button--ghost ui-button--icon ui-button--sm live-nav__close"
				aria-label="Close navigation"
				bind:this={closeButton}
				onclick={() => void closeNav()}>
				<X size={16} />
			</button>
		</div>

		<div class="live-nav__workspace">
			<span class="live-nav__workspace-label">Workspace</span>
			<strong>{workspace.name}</strong>
		</div>

		<nav class="live-nav__links" aria-label="Workspace">
			{#each navigationGroups as group (group.label)}
				<span class="live-nav__group">{group.label}</span>
				{#each group.items as item (item.href)}
					<a
						class:live-nav__link--active={pathIsActive(page.url.pathname, item.href)}
						class="live-nav__link"
						href={item.href}
						aria-current={pathIsActive(page.url.pathname, item.href) ? 'page' : undefined}>
						<item.icon size={16} aria-hidden="true" />
						{item.label}
					</a>
				{/each}
			{/each}
		</nav>

	</aside>

	{#if navOpen}
		<button
			type="button"
			class="live-shell__scrim"
			aria-label="Close navigation"
			onclick={() => void closeNav()}></button>
	{/if}

	<div class="live-shell__body" inert={isNarrow && navOpen}>
		<header class="live-shell__top">
			<button
				type="button"
				class="ui-button ui-button--ghost ui-button--icon live-shell__menu"
				aria-label="Open navigation"
				aria-expanded={navOpen}
				bind:this={menuButton}
				onclick={() => void openNav()}>
				<Menu size={18} />
			</button>
			<h1>{title}</h1>
			<span class="ui-badge ui-badge--neutral">Live data</span>
			<span class="live-shell__account">
				<AccountMenu
					name={user.displayName}
					email={user.primaryEmail ?? ''}
					signOut={accountSignOut} />
			</span>
		</header>
		<main class="live-shell__content">
			{@render children()}
		</main>
	</div>
</div>

<style>
	.live-shell {
		min-block-size: 100svh;
		display: grid;
		grid-template-columns: 15rem minmax(0, 1fr);
		background: var(--je-color-page);
	}

	.live-nav {
		position: sticky;
		inset-block-start: 0;
		z-index: 30;
		block-size: 100svh;
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr) auto;
		gap: var(--je-space-4);
		padding: var(--je-space-4);
		border-inline-end: 1px solid var(--je-color-border);
		background: var(--je-color-surface);
	}

	.live-nav__brand-row,
	.live-shell__top {
		display: flex;
		align-items: center;
	}

	.live-nav__brand-row {
		justify-content: space-between;
		min-block-size: 2.5rem;
	}

	.live-nav__brand {
		display: inline-flex;
	}

	.live-nav__brand img {
		display: block;
		inline-size: 7.5rem;
		block-size: auto;
	}

	.live-nav__close,
	.live-shell__menu {
		display: none;
	}

	.live-nav__workspace {
		display: grid;
		gap: var(--je-space-1);
		padding: var(--je-space-3);
		border: 1px solid var(--je-color-border-subtle);
		border-radius: var(--je-radius-control);
		background: var(--je-color-surface-sunken);
	}

	.live-nav__workspace-label {
		font-size: var(--je-font-size-xs);
		color: var(--je-color-text-muted);
	}

	.live-nav__workspace strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.live-nav__links {
		display: grid;
		align-content: start;
		gap: var(--je-space-1);
		overflow-y: auto;
		overscroll-behavior: contain;
	}

	.live-nav__group {
		padding: var(--je-space-3) var(--je-space-3) var(--je-space-1);
		font-size: var(--je-font-size-xs);
		font-weight: 700;
		letter-spacing: var(--je-tracking-caps);
		text-transform: uppercase;
		color: var(--je-color-text-subtle);
	}

	.live-nav__link {
		display: flex;
		align-items: center;
		gap: var(--je-space-3);
		min-block-size: 2.25rem;
		padding-inline: var(--je-space-3);
		border-radius: var(--je-radius-control);
		color: var(--je-color-text-muted);
		text-decoration: none;
	}

	.live-nav__link:hover,
	.live-nav__link--active {
		background: var(--je-color-surface-sunken);
		color: var(--je-color-text);
	}

	.live-nav__link--active {
		font-weight: 600;
	}

	.live-shell__account {
		display: inline-flex;
	}

	.live-shell__body {
		min-inline-size: 0;
	}

	.live-shell__top {
		position: sticky;
		inset-block-start: 0;
		z-index: 20;
		gap: var(--je-space-3);
		min-block-size: 4rem;
		padding-inline: var(--je-space-6);
		border-block-end: 1px solid var(--je-color-border);
		background: var(--je-color-surface);
	}

	.live-shell__top h1 {
		min-inline-size: 0;
		margin: 0;
		margin-inline-end: auto;
		font-size: var(--je-font-size-xl);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.live-shell__content {
		inline-size: min(100%, 90rem);
		margin-inline: auto;
		padding: var(--je-space-6);
	}

	.live-shell__scrim {
		display: none;
	}

	@media (max-width: 920px) {
		.live-shell {
			display: block;
		}

		.live-nav {
			position: fixed;
			inset: 0 auto 0 0;
			inline-size: min(19rem, calc(100vw - 3rem));
			translate: -100% 0;
			transition: translate var(--je-duration-slow) var(--je-ease-out);
		}

		.live-nav--open {
			translate: 0 0;
		}

		.live-nav__close,
		.live-shell__menu {
			display: inline-grid;
		}

		.live-shell__scrim {
			position: fixed;
			inset: 0;
			z-index: 25;
			display: block;
			border: 0;
			background: var(--je-color-scrim);
		}

		.live-shell__top {
			padding-inline: var(--je-space-4);
		}

		.live-shell__content {
			padding: var(--je-space-4);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.live-nav {
			transition: none;
		}
	}
</style>
