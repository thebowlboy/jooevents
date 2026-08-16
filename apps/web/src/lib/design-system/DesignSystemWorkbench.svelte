<script lang="ts">
  import { flip } from 'svelte/animate';
  import { tick } from 'svelte';
  import {
    AlertTriangle,
    ArrowDown,
    ArrowRight,
    Bell,
    CalendarDays,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Clock,
    Columns2,
    Command,
    Copy,
    Download,
    Eye,
    EyeOff,
    FileText,
    Filter,
    GripVertical,
    Inbox,
    Layers,
    Link,
    ListFilter,
    Mail,
    Menu,
    MessageSquareText,
    MoreHorizontal,
    Palette,
    PanelRight,
    Plus,
    Search,
    Send,
    Settings2,
    SlidersHorizontal,
    Sparkles,
    Trash2,
    Upload,
    UserCheck,
    Users,
    WandSparkles,
    X
  } from 'lucide-svelte';
  import {
    Alert,
    Avatar,
    Badge,
    Button,
    Checkbox,
    createRowDrag,
    motionMs,
    ClampedText,
    DatePicker,
    DescribedSelect,
    Field,
    Marked,
    Modal,
    Popover,
    Meter,
    Progress,
    Radio,
    markArrival,
    revealTarget,
    statusIcon,
    Switch,
    Term,
    TimezoneCombobox
  } from '$lib/ui';
  import { matchFields, parseSearch, type MatchRange } from '$lib/api/search';
  import type { Density } from '$lib/theme/theme-contract';
  import SectionHeading from './SectionHeading.svelte';
  import ShowcaseCard from './ShowcaseCard.svelte';
  import ThemeStudio from './ThemeStudio.svelte';
  import TokenSwatch from './TokenSwatch.svelte';

  /* One query per row, because each row demonstrates a different reach: a hit
     in the title, a hit in body text the title never showed, and a hit on a
     name that plain ASCII should still reach. Terms combine with AND across a
     record, so a single query spanning all three would have to appear in all
     three — which is a different claim than the one being made here. */
  const SEARCH_SPECIMEN = [
    {
      query: 'kubernetes',
      title: 'Scaling Kubernetes Without a Platform Team',
      abstract: 'What broke first, what we kept, and the runbook that survived.',
      speaker: 'Marc Dubois'
    },
    {
      query: 'queue',
      title: 'Durable Agent Jobs: A Queueing Confession',
      abstract: 'Retries at scale, and the queue we should have built instead.',
      speaker: 'Tomás Rivera'
    },
    {
      query: 'sorensen',
      title: 'Consensus Under Partition',
      abstract: 'Where quorum maths stops helping and operations starts.',
      speaker: 'Mikkel Sørensen'
    }
  ];

  /* The whole row is matched at once, exactly as a real row does it, so the
     specimen cannot drift from the behaviour it is demonstrating. */
  function specimenMatch(row: (typeof SEARCH_SPECIMEN)[number]) {
    return matchFields(
      [
        { text: row.title, space: 'body', weight: 'primary' },
        { text: row.abstract, space: 'body', weight: 'secondary' },
        { text: row.speaker, space: 'identity', weight: 'primary' }
      ],
      parseSearch(row.query)
    );
  }

  function fieldRanges(
    match: ReturnType<typeof specimenMatch>,
    index: number
  ): readonly MatchRange[] {
    return match?.fields[index]?.ranges ?? [];
  }

  const navItems = [
    { id: 'foundations', label: 'Foundations', hint: 'Color, type, spacing' },
    { id: 'hierarchy', label: 'Hierarchy', hint: 'Attention and rhythm' },
    { id: 'actions', label: 'Actions', hint: 'Buttons and shortcuts' },
    { id: 'inputs', label: 'Input fields', hint: 'Text and rich entry' },
    { id: 'selection', label: 'Selection', hint: 'Choice and scheduling' },
    { id: 'feedback', label: 'Feedback', hint: 'Status and progress' },
    { id: 'navigation', label: 'Navigation', hint: 'Tabs and wayfinding' },
    { id: 'data', label: 'Dense data', hint: 'Tables and toolbars' },
    { id: 'overlays', label: 'Overlays', hint: 'Dialogs and drawers' },
    { id: 'patterns', label: 'Product patterns', hint: 'Access and submissions' },
    { id: 'theming', label: 'Theme contract', hint: 'Agent-safe styling' }
  ];

  const palette = [
    { name: 'Canvas', value: '#faf8f5' },
    { name: 'Page', value: '#f5f2ee' },
    { name: 'Surface', value: '#ffffff' },
    { name: 'Ink', value: '#2a2522', foreground: '#ffffff' },
    { name: 'Coral', value: '#b05a4f', foreground: '#ffffff' },
    { name: 'Lavender', value: '#c2b3df' },
    { name: 'Sea', value: '#8dc4c8' },
    { name: 'Success', value: '#6fa07f' }
  ];

  let density = $state<Density>('compact');
  let themeStudioOpen = $state(false);
  let mobileNavOpen = $state(false);
  let commandOpen = $state(false);
  let commandQuery = $state('');
  let commandInput = $state<HTMLInputElement>();
  let activeTab = $state('Details');

  /* Four rows of the same bar, so the ladder is comparable in one glance: the
     nearly-full amber one exists to show that the fill answers the clock and
     not the fraction. */
  const meterExamples = [
    { label: 'Round 1 reviews', value: 62, digits: '224 of 360', tone: 'positive' as const, word: 'On pace' },
    { label: 'Round 2 reviews', value: 97, digits: '583 of 600', tone: 'caution' as const, word: 'Behind' },
    { label: 'Decisions sent', value: 38, digits: '6 of 16', tone: 'caution' as const, word: 'Behind' },
    { label: 'Sessions placed', value: 95, digits: '18 of 19', tone: 'negative' as const, word: 'Blocked' }
  ];
  let currentPage = $state(1);
  let editorMode = $state('Write');
  let reviewMode = $state('assigned');
  let showPassword = $state(false);
  let modalOpen = $state(false);
  let compareOpen = $state(false);
  let drawerOpen = $state(false);
  let toastVisible = $state(false);
  let announcement = $state('');
  let notificationsEnabled = $state(true);

  /* Marking demo: an applied filter, a scoped badge, and picked rows, shown
     beside the action colour they used to borrow. */
  const markFilters = ['Everyone', 'Needs cover', 'Invited'];
  const markRows = ['Ada Okafor', 'Ravi Menon', 'Jonna Virtanen'];
  let markFilter = $state('Needs cover');
  let markSelected = $state(['Ravi Menon']);

  /* Drag-to-reorder demo: a local list, the shared row-drag primitive, and a
     FLIP settle on the motion tokens — the same recipe the field lists use. */
  let reorderItems = $state(['Talk title', 'Abstract', 'Track', 'Anything else?']);
  const reorderDrag = createRowDrag({
    rowSelector: '.ds-dragrow',
    onMove: (from, to) => {
      const next = [...reorderItems];
      const [picked] = next.splice(from, 1);
      next.splice(to, 0, picked);
      reorderItems = next;
    }
  });
  let publishImmediately = $state(false);
  let abstractText = $state(
    'A practical session about designing event operations that remain calm when schedules, speakers, and plans change at the same time.'
  );
  let selectedTracks = $state(['Operations', 'Design']);

  let speakers = $state([
    { id: 'spk-1042', selected: false, name: 'Avery Chen', email: 'avery@example.com', proposal: 'Calm systems under pressure', track: 'Operations', status: 'Confirmed', score: 4.8, owner: 'ML' },
    { id: 'spk-1043', selected: true, name: 'Marisol Vega', email: 'marisol@example.com', proposal: 'The participatory program', track: 'Community', status: 'Needs reply', score: 4.4, owner: 'AK' },
    { id: 'spk-1044', selected: false, name: 'Rowan Adeyemi', email: 'rowan@example.com', proposal: 'Agents as event collaborators', track: 'AI', status: 'In review', score: 4.6, owner: 'JS' },
    { id: 'spk-1045', selected: false, name: 'Nadia Ibrahim', email: 'nadia@example.com', proposal: 'Accessibility beyond the checklist', track: 'Design', status: 'Waitlisted', score: 4.2, owner: 'ML' },
    { id: 'spk-1046', selected: false, name: 'Theo Laurent', email: 'theo@example.com', proposal: 'A schedule people can trust', track: 'Operations', status: 'Cancelled', score: 4.7, owner: 'AK' }
  ]);

  const selectedCount = $derived(speakers.filter((speaker) => speaker.selected).length);
  const allSelected = $derived(selectedCount === speakers.length);
  const someSelected = $derived(selectedCount > 0 && !allSelected);
  const abstractCount = $derived(abstractText.length);
  const filteredCommands = $derived(
    navItems.filter((item) => `${item.label} ${item.hint}`.toLowerCase().includes(commandQuery.toLowerCase()))
  );

  $effect(() => {
    document.documentElement.dataset.density = density;
  });

  async function openCommand() {
    commandOpen = true;
    commandQuery = '';
    await tick();
    commandInput?.focus();
  }

  function goToSection(id: string) {
    commandOpen = false;
    mobileNavOpen = false;
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      void openCommand();
    }
    if (event.key === 'Escape') {
      commandOpen = false;
      mobileNavOpen = false;
      drawerOpen = false;
    }
  }

  function selectAll(checked: boolean) {
    for (const speaker of speakers) speaker.selected = checked;
  }

  function showToast(message = 'Speaker changes saved') {
    announcement = message;
    toastVisible = true;
    window.setTimeout(() => (toastVisible = false), 3200);
  }

  function removeTrack(track: string) {
    selectedTracks = selectedTracks.filter((candidate) => candidate !== track);
  }

  // The arrival mark is time-based, so the specimen is driven rather than static:
  // pressing "Take me to it" marks the row exactly as a scoped link would, and the
  // release behaviour (hold, then go on the next real activity) is the thing to
  // watch. `markArrival` returns its own release, so the demo needs no timer.
  let arrivalRow = $state<HTMLElement>();
  function demoArrival() {
    markArrival(arrivalRow ?? null);
  }

  // The declared-host specimen. `revealTarget` is handed the *name block*, the
  // way a surface hands it whatever element it can address; the ring lands on
  // the row above it because the row declares `data-arrival-host`. Marking the
  // middle row is what makes the point — the two beside it look the same.
  const arrivalPeople = [
    { name: 'Priya Raghavan', email: 'priya@example.org', scope: 'Everything', load: '9 / 14' },
    { name: 'Tomás Iglesias', email: 'tomas@example.org', scope: 'Platform track', load: '6 / 11' },
    { name: 'Dana Whitfield', email: 'dana@example.org', scope: 'Everything', load: '12 / 12' }
  ];
  const arrivalNames: Record<string, HTMLElement | undefined> = $state({});
  function demoRowArrival() {
    revealTarget(arrivalNames['tomas@example.org'] ?? null);
  }

  function badgeTone(status: string): 'success' | 'warning' | 'danger' | 'info' | 'lavender' {
    if (status === 'Confirmed') return 'success';
    if (status === 'Needs reply') return 'warning';
    if (status === 'Cancelled') return 'danger';
    if (status === 'In review') return 'info';
    return 'lavender';
  }
</script>

<svelte:head>
  <title>JooEvents design system</title>
  <meta name="description" content="The production reference for JooEvents components, density, accessibility, and theme layers." />
</svelte:head>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="ds-shell">
  <header class="ds-topbar">
    <div class="ds-brand">
      <button class="ds-mobile-menu" type="button" aria-label="Open section navigation" onclick={() => (mobileNavOpen = !mobileNavOpen)}><Menu /></button>
      <a class="ds-brand__mark" href="#top" aria-label="JooEvents design system home">JE</a>
      <div class="ds-brand__copy">
        <strong>JooEvents</strong>
        <span>Design system</span>
      </div>
      <Badge tone="action">v0.1</Badge>
    </div>

    <button class="ds-command-trigger" type="button" onclick={openCommand}>
      <Search />
      <span>Jump to a component…</span>
      <kbd>⌘ K</kbd>
    </button>

    <div class="ds-topbar__actions">
      <div class="ui-segmented ds-density-control" role="group" aria-label="Preview density">
        <button class="ui-segmented__item" type="button" aria-pressed={density === 'compact'} onclick={() => (density = 'compact')}>Compact</button>
        <button class="ui-segmented__item" type="button" aria-pressed={density === 'comfortable'} onclick={() => (density = 'comfortable')}>Comfort</button>
      </div>
      <Button variant="secondary" size="sm" onclick={() => (themeStudioOpen = true)}><Palette /> Theme</Button>
    </div>
  </header>

  <aside class:ds-sidebar--open={mobileNavOpen} class="ds-sidebar">
    <div class="ds-sidebar__heading">
      <span>Reference</span>
      <button type="button" aria-label="Close navigation" onclick={() => (mobileNavOpen = false)}><X /></button>
    </div>
    <nav aria-label="Design system sections">
      {#each navItems as item, index}
        <a href="#{item.id}" onclick={() => (mobileNavOpen = false)}>
          <span class="ds-sidebar__index">{String(index + 1).padStart(2, '0')}</span>
          <span><strong>{item.label}</strong><small>{item.hint}</small></span>
        </a>
      {/each}
    </nav>
    <div class="ds-sidebar__surfaces">
      <span>Whole surfaces</span>
      <a href="/design-system/portal-shell">Participant portal</a>
      <a href="/design-system/participant-portal">Portal states</a>
      <a href="/design-system/entry-links">Sign-in link states</a>
      <a href="/design-system/dashboard">Operator shell</a>
      <a href="/design-system/loading">Waiting treatments</a>
    </div>

    <div class="ds-sidebar__note">
      <Sparkles />
      <p><strong>Stable baseline</strong><br />Change semantic tokens first. Keep component states and structure intact.</p>
    </div>
  </aside>

  {#if mobileNavOpen}<button class="ds-sidebar-backdrop" type="button" aria-label="Close navigation" onclick={() => (mobileNavOpen = false)}></button>{/if}

  <main class="ds-main" id="top">
    <section class="ds-hero">
      <div class="ds-hero__copy">
        <p class="ds-kicker"><span></span> Production reference · Svelte 5</p>
        <h1>Operations, without<br />the visual noise.</h1>
        <p>One dense, accessible baseline for humans and agents to build from. Brand layers can change the atmosphere; interaction contracts keep the product trustworthy.</p>
        <div class="ds-hero__actions">
          <Button onclick={() => goToSection('inputs')}><ArrowDown /> Explore components</Button>
          <Button variant="secondary" onclick={() => (themeStudioOpen = true)}><WandSparkles /> Create a style layer</Button>
        </div>
      </div>
      <div class="ds-hero__principles">
        <div><strong>4 px</strong><span>spacing grid</span></div>
        <div><strong>32–48</strong><span>control height</span></div>
        <div><strong>AA</strong><span>contrast target</span></div>
        <div><strong>1 API</strong><span>semantic tokens</span></div>
      </div>
    </section>

    <section class="ds-section" id="foundations">
      <SectionHeading index="01" title="Foundations" description="A warm operational palette, disciplined type, and a density system that scales from review queues to public forms." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Semantic color" description="The same palette supports brand, state, and dense data without overloading coral." full>
          <div class="token-grid">
            {#each palette as token}<TokenSwatch {...token} />{/each}
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Typography" description="Merriweather creates a few human moments. Inter does the operational work.">
          <div class="type-specimens">
            <div class="type-specimens__display"><span>Display / 700</span><strong>A schedule people trust.</strong></div>
            <div><span>Body / 400</span><p>Speaker information remains readable even when the surrounding interface is dense.</p></div>
            <div class="type-specimens__labels"><span>Label / 650</span><strong>Submission status</strong><code>event_speaker.status</code></div>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Spacing & geometry" description="Small fixed scales make agent-generated layouts more predictable.">
          <div class="geometry-specimen">
            {#each [4, 8, 12, 16, 24, 32] as space}<div><span style:width="{space}px"></span><code>{space}</code></div>{/each}
          </div>
          <div class="radius-specimen">
            {#each [4, 6, 10, 14, 20] as radius}<span style:border-radius="{radius}px"><code>{radius}</code></span>{/each}
          </div>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="hierarchy">
      <SectionHeading index="02" title="Hierarchy" description="Color and space assign importance before any component is chosen: one L1 per surface, gaps tiered by relationship, accent spent once." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Attention levels" description="Every element gets a level before styling: L1 the one thing, L2 orientation, L3 support, L4 metadata. Exactly one L1.">
          <div class="hierarchy-levels">
            <div><span class="ds-level-tag">L2</span><strong class="hierarchy-levels__heading">Publish the schedule</strong></div>
            <div><span class="ds-level-tag">L3</span><p>Twelve sessions are ready. Publishing replaces the public agenda immediately.</p></div>
            <div><span class="ds-level-tag ds-level-tag--one">L1</span><Button>Publish schedule</Button></div>
            <div><span class="ds-level-tag">L4</span><small>Last published 2 days ago · v14</small></div>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Space is relationship" description="A gap states how related two things are. Interior gaps stay smaller than exterior gaps; a uniform gap flattens every relationship." full>
          <div class="rhythm-pair">
            <figure class="rhythm-example">
              <div class="rhythm-card rhythm-card--flat">
                <strong>Avery Chen</strong>
                <span>avery@example.com</span>
                <span>Track · Operations</span>
                <span>Format · Talk, 45 min</span>
                <div class="rhythm-card__actions"><Button size="sm">Confirm</Button><Button variant="ghost" size="sm">Decline</Button></div>
              </div>
              <figcaption>Uniform 16px — identity, facts, and actions read as one undifferentiated list.</figcaption>
            </figure>
            <figure class="rhythm-example">
              <div class="rhythm-card rhythm-card--tiered">
                <div class="rhythm-card__identity"><strong>Avery Chen</strong><span>avery@example.com</span></div>
                <div class="rhythm-card__facts"><span>Track · Operations</span><span>Format · Talk, 45 min</span></div>
                <div class="rhythm-card__actions"><Button size="sm">Confirm</Button><Button variant="ghost" size="sm">Decline</Button></div>
              </div>
              <figcaption>Tiered 4 / 8 / 24 — three groups separate at a glance before anything is read.</figcaption>
            </figure>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="The accent budget" description="Accent marks the L1 and interaction; it is spent, not applied. One accent-dominant element per region.">
          <div class="budget-pair">
            <figure class="rhythm-example">
              <div class="budget-row">
                <Button size="sm">Approve</Button><Button size="sm">Email</Button><Button size="sm">Export</Button>
              </div>
              <figcaption>Spent everywhere — nothing leads.</figcaption>
            </figure>
            <figure class="rhythm-example">
              <div class="budget-row">
                <Button size="sm">Approve</Button><Button variant="secondary" size="sm">Email</Button><Button variant="ghost" size="sm">Export</Button>
              </div>
              <figcaption>Spent once — the decision leads, the rest supports.</figcaption>
            </figure>
          </div>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="actions">
      <SectionHeading index="03" title="Actions" description="Actions are explicit about hierarchy and consequence. Only one primary action should dominate a local surface." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Button hierarchy" description="Five semantic variants cover the routine action vocabulary." full>
          <div class="button-matrix">
            <div class="button-row"><span>Primary</span><Button><Plus /> Add speaker</Button><Button size="sm">Save changes</Button><Button loading>Saving</Button></div>
            <div class="button-row"><span>Secondary</span><Button variant="secondary"><Filter /> Filter</Button><Button variant="secondary" size="sm"><Download /> Export</Button><Button variant="secondary" disabled>Unavailable</Button></div>
            <div class="button-row"><span>Soft</span><Button variant="soft"><Sparkles /> Ask agent</Button><Button variant="soft" size="sm">Suggest tracks</Button></div>
            <div class="button-row"><span>Ghost</span><Button variant="ghost"><Copy /> Duplicate</Button><Button variant="ghost" size="sm">Cancel</Button></div>
            <div class="button-row"><span>Danger</span><Button variant="danger"><Trash2 /> Delete event</Button><Button variant="danger" size="sm">Revoke access</Button></div>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Sizes & icon actions" description="Compact screens keep 32px controls; touch layouts promote controls automatically.">
          <div class="component-row component-row--center">
            <Button size="sm">Small</Button><Button>Default</Button><Button size="lg">Large</Button>
          </div>
          <div class="component-row component-row--center">
            <Button variant="secondary" size="sm" iconOnly aria-label="Notifications"><Bell /></Button>
            <Button variant="secondary" iconOnly aria-label="Settings"><Settings2 /></Button>
            <Button variant="primary" size="lg" iconOnly aria-label="Add item"><Plus /></Button>
            <Button variant="ghost" iconOnly aria-label="More actions"><MoreHorizontal /></Button>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Keyboard affordances" description="Shortcuts accompany labels; they never replace accessible names.">
          <div class="shortcut-list">
            <button type="button"><span><Command /> Command menu</span><kbd>⌘ K</kbd></button>
            <button type="button"><span><Plus /> New submission</span><span><kbd>C</kbd></span></button>
            <button type="button"><span><Search /> Global search</span><kbd>/</kbd></button>
          </div>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="inputs">
      <SectionHeading index="04" title="Input fields" description="The field shell owns labels, descriptions, validation, and spacing. Native controls keep behavior dependable." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Text entry" description="Default, prefixed, validated, read-only, and disabled states." full>
          <div class="form-grid form-grid--three">
            <Field id="event-name" label="Event name" required description="Shown to organizers and attendees.">
              {#snippet children({ id, describedBy, invalid })}<input class="ui-control" {id} aria-describedby={describedBy} aria-invalid={invalid} value="Future of Care Summit" />{/snippet}
            </Field>
            <Field id="work-email" label="Speaker email" success="Verified Google address">
              {#snippet children({ id, describedBy })}<input class="ui-control" data-valid="true" type="email" {id} aria-describedby={describedBy} value="avery@example.com" />{/snippet}
            </Field>
            <Field id="public-slug" label="Public URL" error="That URL is already in use.">
              {#snippet children({ id, describedBy, invalid })}
                <div class="ui-input-group"><span class="ui-input-addon">events.io/</span><input class="ui-control" {id} aria-describedby={describedBy} aria-invalid={invalid} value="future-care" /></div>
              {/snippet}
            </Field>
            <Field id="speaker-search" label="Search" optional>
              {#snippet children({ id, describedBy })}<div class="ui-input-wrap ui-input-wrap--leading"><Search class="ui-input-wrap__icon" /><input class="ui-control" type="search" {id} aria-describedby={describedBy} placeholder="Name, company, or proposal" /></div>{/snippet}
            </Field>
            <Field id="account-password" label="Temporary secret" meta="Demo only">
              {#snippet children({ id, describedBy })}
                <div class="ui-input-wrap ui-input-wrap--trailing"><input class="ui-control" type={showPassword ? 'text' : 'password'} {id} aria-describedby={describedBy} value="event-setup-2026" /><Button class="ui-input-wrap__action" variant="ghost" size="sm" iconOnly aria-label={showPassword ? 'Hide secret' : 'Show secret'} onclick={() => (showPassword = !showPassword)}>{#if showPassword}<EyeOff />{:else}<Eye />{/if}</Button></div>
              {/snippet}
            </Field>
            <Field id="external-id" label="App record ID">
              {#snippet children({ id, describedBy })}<input class="ui-control ui-mono" {id} aria-describedby={describedBy} readonly value="0198e315-4fb0-7b2b" />{/snippet}
            </Field>
            <Field id="disabled-field" label="Inherited timezone" description="Controlled by the parent event.">
              {#snippet children({ id, describedBy })}<input class="ui-control" {id} aria-describedby={describedBy} disabled value="Asia/Singapore" />{/snippet}
            </Field>
            <Field id="phone-field" label="Contact number" optional>
              {#snippet children({ id, describedBy })}<input class="ui-control" type="tel" {id} aria-describedby={describedBy} placeholder="+65 6123 4567" />{/snippet}
            </Field>
            <Field id="capacity-field" label="Room capacity" meta="people">
              {#snippet children({ id, describedBy })}<input class="ui-control" type="number" min="1" max="5000" {id} aria-describedby={describedBy} value="240" />{/snippet}
            </Field>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Select & combobox" description="Use native select first; graduate to an ARIA combobox only when search is necessary.">
          <div class="form-stack">
            <Field id="event-track" label="Track">
              {#snippet children({ id, describedBy })}<select class="ui-select" {id} aria-describedby={describedBy}><option>Operations</option><option>Design</option><option>AI</option><option>Community</option></select>{/snippet}
            </Field>
            <Field id="busy-select" label="Applying a change" description="The waiting control marks itself; its siblings merely disable.">
              {#snippet children({ id, describedBy })}<span class="ui-select-wait"><select class="ui-select" {id} aria-describedby={describedBy} disabled aria-busy="true"><option>Speaker Reviewer</option></select><span class="ui-select-wait__spinner" aria-hidden="true"><span class="ui-spinner"></span></span></span>{/snippet}
            </Field>
            <Field id="speaker-company" label="Company" description="Browser-native autocomplete in the baseline.">
              {#snippet children({ id, describedBy })}<input class="ui-control" {id} list="companies" aria-describedby={describedBy} value="Aperture Labs" /><datalist id="companies"><option value="Aperture Labs"></option><option value="Northstar Studio"></option><option value="Common Ground"></option></datalist>{/snippet}
            </Field>
            <Field id="assigned-owner" label="Assigned owner">
              {#snippet children({ id, describedBy })}<select class="ui-select" {id} aria-describedby={describedBy}><option>Mina Lee</option><option>Arun Kumar</option><option>Jamie Smith</option></select>{/snippet}
            </Field>
            <Field id="described-visibility" label="Visibility" description="A described select explains each choice before it is made; touch gets a full-height sheet to read through.">
              {#snippet children({ id, describedBy })}
                <DescribedSelect
                  {id}
                  {describedBy}
                  label="Visibility"
                  value="team"
                  options={[
                    { value: 'draft', label: 'Draft', description: 'Only you can see it while it takes shape.' },
                    { value: 'team', label: 'Team', description: 'Every workspace member can read it; owners can edit.' },
                    { value: 'public', label: 'Public', description: 'Published to the event page for anyone with the link.' }
                  ]} />
              {/snippet}
            </Field>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Long-form & multi-value" description="Long content receives vertical room; tags stay structured rather than comma-separated.">
          <div class="form-stack">
            <Field id="proposal-abstract" label="Abstract" required meta="{abstractCount}/600">
              {#snippet children({ id, describedBy })}<textarea class="ui-textarea" {id} aria-describedby={describedBy} bind:value={abstractText}></textarea>{/snippet}
            </Field>
            <Field id="track-tags" label="Related tracks" description="Two selected. Type to add another.">
              {#snippet children({ id, describedBy })}
                <div class="tag-input" tabindex="-1">
                  {#each selectedTracks as track}<span>{track}<button type="button" aria-label="Remove {track}" onclick={() => removeTrack(track)}><X /></button></span>{/each}
                  <input {id} aria-describedby={describedBy} placeholder="Add track…" />
                </div>
              {/snippet}
            </Field>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Attachments" description="A visible drop target complements the native file picker; uploads surface progress separately.">
          <label class="ui-file-drop">
            <input type="file" multiple accept=".pdf,.ppt,.pptx,image/*" />
            <Upload />
            <strong>Drop a deck or headshot</strong>
            <span>PDF, PPTX, PNG or JPG · up to 25 MB</span>
          </label>
          <div class="upload-row">
            <span class="upload-row__icon"><FileText /></span>
            <div><strong>speaker-deck.pdf</strong><Progress label="Uploading" value={64} /></div>
            <Button variant="ghost" size="sm" iconOnly aria-label="Cancel upload"><X /></Button>
          </div>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="selection">
      <SectionHeading index="05" title="Selection & scheduling" description="Choice controls remain compact, label-forward, and generous enough to understand before acting." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Checks & switches" description="Checkboxes select; switches change a setting immediately.">
          <div class="choice-stack">
            <Checkbox label="Include speaker bio" description="Show the approved public biography." checked />
            <Checkbox label="Require travel details" description="Adds a required onboarding step." />
            <Checkbox label="Partial selection" mixed />
            <Checkbox label="Unavailable option" disabled />
          </div>
          <div class="choice-divider"></div>
          <div class="choice-stack">
            <Switch label="Email notifications" description="Notify me about speaker replies." bind:checked={notificationsEnabled} />
            <Switch label="Publish immediately" description="Bypasses the draft schedule." bind:checked={publishImmediately} />
          </div>
        </ShowcaseCard>
        <ShowcaseCard title="Drag to reorder" description="The handle owns the gesture — vertical drag or arrow keys — and a slot line names the landing.">
          <ul class="ds-draglist" use:reorderDrag.container>
            {#each reorderItems as item (item)}
              <li class="ds-dragrow" animate:flip={{ duration: motionMs('normal') }}>
                <span>{item}</span>
                <button
                  type="button"
                  class="ui-button ui-button--ghost ui-button--icon ui-button--sm ui-drag-handle"
                  aria-label={`Reorder “${item}” — drag, or press the arrow keys`}
                  use:reorderDrag.handle>
                  <GripVertical size={14} aria-hidden="true" />
                </button>
              </li>
            {/each}
          </ul>
        </ShowcaseCard>

        <ShowcaseCard title="Radio groups" description="Use when exactly one visible option is required.">
          <fieldset class="choice-fieldset">
            <legend>Review queue</legend>
            <Radio name="review-mode" value="assigned" bind:group={reviewMode} label="Assigned to me" description="Only proposals you own." />
            <Radio name="review-mode" value="unreviewed" bind:group={reviewMode} label="All unreviewed" description="Across your permitted events." />
            <Radio name="review-mode" value="all" bind:group={reviewMode} label="Everything" description="Includes completed reviews." />
          </fieldset>
        </ShowcaseCard>

        <ShowcaseCard title="Segmented control" description="A small set of peer modes—not a substitute for tabs between pages.">
          <div class="ui-segmented" role="group" aria-label="Editor mode">
            {#each ['Write', 'Preview', 'Diff'] as mode}<button class="ui-segmented__item" type="button" aria-pressed={editorMode === mode} onclick={() => (editorMode = mode)}>{mode}</button>{/each}
          </div>
          <div class="mode-preview"><span>{editorMode} mode</span><p>{editorMode === 'Write' ? 'Fields are editable and autosave as a draft.' : editorMode === 'Preview' ? 'This is how the public session will appear.' : 'Review changes against the last published version.'}</p></div>
        </ShowcaseCard>

        <ShowcaseCard title="Date picker" description="Compact fixed-size popover with month and year grids two taps away; the input accepts typing; min/max and the opening month are set per context. Coarse pointers get the platform's native picker." full>
          <div class="form-grid form-grid--four">
            <Field id="dp-open" label="Any date">
              {#snippet children({ id, describedBy })}<DatePicker {id} {describedBy} label="any date" value="2026-10-15" />{/snippet}
            </Field>
            <Field id="dp-future" label="Future only" description="Past days are disabled, not hidden.">
              {#snippet children({ id, describedBy })}<DatePicker {id} {describedBy} label="future date" min="2026-08-10" />{/snippet}
            </Field>
            <Field id="dp-window" label="Within the event" description="Opens at the event's first day.">
              {#snippet children({ id, describedBy })}<DatePicker {id} {describedBy} label="event date" min="2026-10-15" max="2026-10-16" defaultFocus="2026-10-15" />{/snippet}
            </Field>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Date, time & range" description="Dates inherit the event timezone and show it beside—not hidden inside—the control." full>
          <div class="form-grid form-grid--four">
            <Field id="session-date" label="Session date" required>{#snippet children({ id, describedBy })}<input class="ui-control" type="date" {id} aria-describedby={describedBy} value="2026-09-18" />{/snippet}</Field>
            <Field id="start-time" label="Starts" meta="SGT">{#snippet children({ id, describedBy })}<input class="ui-control" type="time" {id} aria-describedby={describedBy} value="09:30" />{/snippet}</Field>
            <Field id="end-time" label="Ends" meta="45 min">{#snippet children({ id, describedBy })}<input class="ui-control" type="time" {id} aria-describedby={describedBy} value="10:15" />{/snippet}</Field>
            <Field id="event-timezone" label="Timezone">{#snippet children({ id, describedBy })}<TimezoneCombobox {id} {describedBy} value="Asia/Singapore" />{/snippet}</Field>
          </div>
          <div class="range-field">
            <div><strong>Minimum review score</strong><span>4.2 and above</span></div>
            <input class="ui-range" type="range" min="1" max="5" value="4.2" step="0.1" aria-label="Minimum review score" />
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Marking vs. action" description="Chosen among peers — an applied filter, a reviewer's scope, a picked row — is its own colour family, never the action colour. The default action ramp is coral and the danger family shares its hue, so an action-tinted selection reads as an error: an applied filter looked like a failed one. Marking answers in sea, which carries no status meaning. Action stays coral for the thing that commits." full>
          <div class="component-row component-row--wrap">
            {#each markFilters as entry}
              <button
                type="button"
                class="ds-mark-chip"
                class:ds-mark-chip--on={markFilter === entry}
                aria-pressed={markFilter === entry}
                onclick={() => (markFilter = entry)}>{entry}</button>
            {/each}
          </div>
          <div class="component-row component-row--wrap">
            <Badge tone="mark">Scoped to Platform track</Badge>
            <Badge tone="danger" dot>Cancelled</Badge>
            <Badge tone="action" dot>Active</Badge>
          </div>
          <div class="ds-mark-rows">
            {#each markRows as row}
              <div class="ds-mark-row" data-selected={markSelected.includes(row) ? 'true' : undefined}>
                <Checkbox
                  label={row}
                  checked={markSelected.includes(row)}
                  onchange={() =>
                    (markSelected = markSelected.includes(row)
                      ? markSelected.filter((entry) => entry !== row)
                      : [...markSelected, row])} />
              </div>
            {/each}
          </div>
          <div class="component-row">
            <button class="ui-button ui-button--primary" type="button">Assign {markSelected.length} reviewers</button>
          </div>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="feedback">
      <SectionHeading index="06" title="Feedback & status" description="State always has text, not just color. Calm surfaces reserve stronger interruption for consequential failures." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Status badges" description="Short nouns or past-tense facts work best. Solid emphasis badges are the act-now tier — spend them on states that demand a response." full>
          <div class="component-row component-row--wrap">
            <Badge>Draft</Badge><Badge tone="action" dot>Active</Badge><Badge tone="success" dot>Confirmed</Badge><Badge tone="warning" dot>Needs reply</Badge><Badge tone="danger" dot>Cancelled</Badge><Badge tone="info">In review</Badge><Badge tone="lavender">Waitlisted</Badge><Badge tone="sea">Synced</Badge>
          </div>
          <div class="component-row component-row--wrap">
            <Badge tone="danger" emphasis>Act now</Badge><Badge tone="warning" emphasis>Due soon</Badge><Badge tone="success" emphasis>Go</Badge>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Status glyphs" description="A badge may lead with a glyph from the shared statusIcon vocabulary so the state is recognised before it is read. The word still carries the state and the glyph is aria-hidden, so this is recognition support, never the encoding. One meaning keeps one symbol on every surface — Waitlisted and Invited share the hourglass because both mean waiting on someone else. The glyph supersedes the dot; never render both." full>
          <div class="component-row component-row--wrap">
            <Badge tone="success" icon={statusIcon.accepted}>Accepted</Badge><Badge tone="lavender" icon={statusIcon.waitlisted}>Waitlisted</Badge><Badge tone="neutral" icon={statusIcon.declined}>Declined</Badge><Badge tone="neutral" icon={statusIcon.withdrawn}>Withdrawn</Badge><Badge tone="info" icon={statusIcon.invited}>Invited</Badge><Badge tone="sea" icon={statusIcon.published}>Public</Badge><Badge tone="neutral" icon={statusIcon.unpublished}>Hidden</Badge>
          </div>
          <div class="component-row component-row--wrap">
            <Badge tone="neutral" icon={statusIcon.draft}>Draft</Badge><Badge tone="info" icon={statusIcon.scheduled}>Scheduled</Badge><Badge tone="success" icon={statusIcon.sent}>Sent</Badge><Badge tone="warning" icon={statusIcon.held} emphasis>Held</Badge><Badge tone="warning" icon={statusIcon.unnotified} emphasis>Result not sent</Badge><Badge tone="danger" icon={statusIcon.blocking} emphasis>Blocking</Badge>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Attention surfaces" description="Area treatments for the act-now tier: color arrives before reading. The tinted card with an emphasis plate is the banner default; thin edge stripes are reserved for cards inside dense grids." full>
          <div class="ds-attention-stack">
            <div class="ds-attention ds-attention--tinted">
              <span class="ds-attention__plate" aria-hidden="true"><AlertTriangle size={16} /></span>
              <div class="ds-attention__copy">
                <p class="ds-attention__title">Speaker requested cancellation</p>
                <p class="ds-attention__detail">Tinted surface + emphasis plate — the banner default.</p>
              </div>
              <Button variant="primary" size="sm">Review</Button>
            </div>
            <div class="ds-attention ds-attention--tinted je-critical">
              <span class="ds-attention__plate" aria-hidden="true"><AlertTriangle size={16} /></span>
              <div class="ds-attention__copy">
                <p class="ds-attention__title">Hard deadline in 6 hours — 3 required tasks open</p>
                <p class="ds-attention__detail">Critical halo — reserved tier, dormant by default. It attaches only via the escalation registry, at most one per view, and reduced motion renders the ring static.</p>
              </div>
              <Button variant="primary" size="sm">Open tasks</Button>
            </div>
            <div class="ds-attention ds-attention--ring">
              <div class="ds-attention__copy">
                <p class="ds-attention__title">2 blocking conflicts before publish</p>
                <p class="ds-attention__detail">Emphasis ring — when the surface must stay white, e.g. directly above dense data.</p>
              </div>
              <Button variant="secondary" size="sm">Open conflicts</Button>
            </div>
            <div class="ds-attention ds-attention--stripe">
              <div class="ds-attention__copy">
                <p class="ds-attention__title">Edge stripe</p>
                <p class="ds-attention__detail">Not a banner treatment. Reserved for schedule/grid cards where only an edge fits.</p>
              </div>
            </div>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Ghost — the draft layer" description="Proposed-but-uncommitted state renders in the real surface with one treatment (.je-ghost): a dashed action boundary over a soft action wash. The schedule's placement aim preview uses it; agent-drafted placements and imports reuse it, so “not committed yet” reads identically everywhere. Content stays full-ink — a ghost is being adjusted, not disabled." full>
          <div class="ds-ghost-demo">
            <div class="ds-ghost-demo__card ds-ghost-demo__card--committed">
              <p class="ds-ghost-demo__title">Opening Keynote</p>
              <p class="ds-ghost-demo__time">09:00–10:00 · committed</p>
            </div>
            <div class="ds-ghost-demo__card je-ghost">
              <p class="ds-ghost-demo__title">Context Caching Without Tears</p>
              <p class="ds-ghost-demo__time">10:00–10:30 · Right after “Opening Keynote”</p>
            </div>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Inline alerts" description="Messages explain impact and next action, not merely the error category." full>
          <div class="alert-stack">
            <Alert tone="success" title="Schedule published" message="The public agenda and Airtable projection are up to date." />
            <Alert tone="info" title="Mapping review ready" message="The agent matched 31 of 34 fields. Three decisions need a human." dismissible />
            <Alert tone="warning" title="Speaker reply overdue" message="No response for seven days. Review the draft reminder before sending." />
            <Alert tone="danger" title="Room conflict" message="Studio A already contains a session from 10:00–10:45." />
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Unavailable, explained in place" description="An action the system would refuse stays visible and says why before anything is attempted. The control keeps its place and takes aria-disabled rather than disabled, so it stays focusable and the reason is reachable by keyboard; the reason itself is the same reviewed sentence the server would answer with, shown on hover or focus and mirrored to a live region. Hiding the control would delete the “why”, and when the refusal is permanent the why is the one thing worth teaching. Rows whose action is genuinely available carry the live control." full>
          <ul class="ds-unavailable">
            <li class="ds-unavailable__row">
              <span class="ds-unavailable__text">
                <span class="ds-unavailable__name">Applied AI</span>
                <span class="ds-unavailable__meta">18 submissions · 4 sessions</span>
              </span>
              <button
                type="button"
                class="ui-button ui-button--secondary ui-button--sm"
                aria-label="Delete Applied AI"
                aria-disabled="true"
                aria-describedby="ds-unavailable-reason"
                onclick={() => showToast('18 submissions and sessions reference this track. Retire it to stop new use — everything already using it keeps rendering.')}>Delete</button>
              <p class="ds-unavailable__reason" id="ds-unavailable-reason">
                18 submissions and sessions reference this track. Retire it to stop new use — everything already using it keeps rendering.
              </p>
            </li>
            <li class="ds-unavailable__row">
              <span class="ds-unavailable__text">
                <span class="ds-unavailable__name">Fireside</span>
                <span class="ds-unavailable__meta">not used yet</span>
              </span>
              <Button variant="secondary" size="sm" aria-label="Delete Fireside" onclick={() => showToast('Deleted track “Fireside”')}>Delete</Button>
            </li>
          </ul>
        </ShowcaseCard>

        <ShowcaseCard title="Reason on press, never on hover" description="A reason that varies per row lives behind the mark that carries it: a real button with aria-expanded, opened by press or keyboard, closed by Escape, and mirrored to the polite live region. Hover is not an option — on a touch device it never happens, and on a disabled control a native tooltip never arrives at all. The panel is positioned against the viewport so it survives inside a scrolling table or a schedule grid. The affordance follows the medium: a mark is already a box and takes the ring, a word takes an underline, and a figure — a chart or a bare numeral, which is neither — takes a soft plate built from padding and a cancelling negative margin, so hovering it cannot move the row." full>
          <div class="ds-popovers">
            <Popover
              label="Product pitch 0.88 — why this signal is on “Ship Faster With Our DevEx Platform”"
              onreveal={() => showToast('Product pitch 0.88. Vendor demo with pricing; no transferable technique. Source: Screen run #4. Confidence 0.88.')}>
              {#snippet trigger()}<span class="ui-badge ui-badge--warning">Product pitch 0.88</span>{/snippet}
              {#snippet children()}
                <p class="ds-popover__body">Vendor demo with pricing; no transferable technique.</p>
                <p class="ds-popover__meta">Screen run #4 · confidence 0.88</p>
              {/snippet}
            </Popover>
            <Popover
              label="Conflict — why “Ship It Anyway” is blocking"
              onreveal={() => showToast('Ship It Anyway is blocking: overlaps “Edge Caching Without Tears” in Main Hall.')}>
              {#snippet trigger()}<span class="ui-badge ui-badge--danger ui-badge--solid">Conflict</span>{/snippet}
              {#snippet children()}
                <p class="ds-popover__body">Overlaps “Edge Caching Without Tears” in Main Hall.</p>
                <p class="ds-popover__meta">Publication stays blocked until this is resolved.</p>
              {/snippet}
            </Popover>
            <!-- A bare numeral is neither a box nor running text: the ring would
                 hug it at zero padding, an underline would say nothing. -->
            <Popover
              kind="figure"
              label="4.6 of 5 — standing details"
              onreveal={() => showToast('4.6 average of 3 reviews. Higher than 93% of 46 scored.')}>
              {#snippet trigger()}<span class="ds-figure">4.6</span>{/snippet}
              {#snippet children()}
                <p class="ds-popover__body">4.6 average of 3 reviews.</p>
                <p class="ds-popover__meta">Higher than 93% of 46 scored · median 3.8</p>
              {/snippet}
            </Popover>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="A term of art carries its own definition" description="Product vocabulary is a loan against future exposure: it pays off for people who come back every cycle, and never for someone here once for one round. So a term of art may be used, but it owes its meaning where it is used. Dotted underline at rest, solid on hover, focus, and while open — the same grammar as every other in-place disclosure, where solid and action-coloured navigates and dotted and ink tells you more right here. Inside a sentence it sits on the text baseline and stays selectable through a drag, though it is atomic: it moves to the next line whole rather than breaking across one, so a term has to fit its narrowest column. A badge is a box, not a word, so it takes the ring instead." full>
          <div class="ds-terms">
            <p class="ds-term-prose">
              Reviews close in 18 days. Ask the <Term
                term="chair"
                definition="The person running this review round — they set the plan up and decide who reviews what."
                onreveal={() => showToast('Chair: the person running this review round.')} /> to
              distribute the remaining submissions, then <Term
                term="commit"
                definition="Committing finalises your score and comment, and unlocks the other reviewers'. Drafts save as you type; nothing is committed until you press the button."
                onreveal={() => showToast('Commit finalises your review and unlocks peer reviews.')} /> yours
              before the deadline. Late entries go to the <Term
                term="CFP"
                expansion="Call for Proposals"
                definition="The open window where speakers submit talks. It closes on a date you set, and late arrivals land in their own tray."
                onreveal={() => showToast('CFP: call for proposals, the open submission window.')} /> overflow
              tray.
            </p>
            <div class="ds-table-wrap ui-table-wrap">
              <table class="ui-table">
                <thead>
                  <tr><th>Reviewer</th><th class="ui-table__number">Done</th></tr>
                </thead>
                <tbody>
                  <tr>
                    <td>
                      <span class="ui-table__primary"><strong>Elif Aydın</strong></span>
                      <span class="ds-term-gap">
                        <Popover
                          label="2 need another reviewer — why"
                          onreveal={() => showToast('2 reviews nobody is covering. Elif Aydın stepped back from 2 over a conflict of interest.')}>
                          {#snippet trigger()}
                            <Badge tone="warning" icon={statusIcon.needsReviewer}>2 need another reviewer</Badge>
                          {/snippet}
                          {#snippet children()}
                            <p class="ds-popover__body">2 reviews nobody is covering. Elif Aydın stepped back from 2 in this plan because of a conflict of interest — they know or work with the submitter.</p>
                          {/snippet}
                        </Popover>
                      </span>
                    </td>
                    <td class="ui-table__number">12 / 40</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="A search says what it looked at" description="Three things a list owes anyone who types into it. The marks answer “why is this row here” in place, which also teaches the scope without a legend — a hit landing in the abstract is how you learn the abstract is searched. The count answers it for the result set, in past tense, naming the fields rather than leaving them to be guessed. And folding is part of the contract, not a nicety: NFKD decomposes José but leaves Sørensen, Aydın, and Straße untouched, so those letters carry an explicit map and plain ASCII reaches them. Marks paint behind the text in the row's own ink, holding their space with a cancelling negative margin, so a marked title still reads as a title and nothing on the line moves." full>
          <div class="ds-search">
            <p class="ds-search-status">
              <strong>3</strong> of 14 submissions match
              <span class="ds-search-scope">· searched title, abstract, and speaker</span>
            </p>
            <div class="ds-table-wrap ui-table-wrap">
              <table class="ui-table ui-table--multiline">
                <thead>
                  <tr><th>Query</th><th>Submission</th><th>Speaker</th></tr>
                </thead>
                <tbody>
                  {#each SEARCH_SPECIMEN as row (row.title)}
                    {@const match = specimenMatch(row)}
                    <tr>
                      <td><span class="ds-search-query">“{row.query}”</span></td>
                      <td>
                        <span class="ui-table__primary">
                          <Marked text={row.title} ranges={fieldRanges(match, 0)} />
                        </span>
                        <span class="ui-table__secondary">
                          <Marked text={row.abstract} ranges={fieldRanges(match, 1)} />
                        </span>
                      </td>
                      <td><Marked text={row.speaker} ranges={fieldRanges(match, 2)} /></td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <p class="ds-search-note">
              The last row is the one that matters: the query is plain ASCII, and the mark lands on
              the spelling the person actually wrote.
            </p>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Clamped text & disclosure" description="Rows take their natural height; the marker anchors to the first text line, so the rail stays straight and nothing moves when an entry expands. The timestamp ends the sentence inline. The footer line and its toggle render only for text genuinely cut off; on touch the whole entry activates it." full>
          <ul class="ds-clamp-list">
            <li class="ds-clamp-row">
              <span class="ui-avatar ui-avatar--sm" aria-hidden="true">SB</span>
              <ClampedText lines={2} expandFromSurface label="Sofia Berg">
                {#snippet children()}<strong>Sofia Berg</strong> committed 6 reviews in Round 1 <span class="ds-clamp-time">· 24 min ago</span>{/snippet}
              </ClampedText>
            </li>
            <li class="ds-clamp-row">
              <span class="ui-avatar ui-avatar--sm" aria-hidden="true">JW</span>
              <ClampedText lines={2} expandFromSurface label="Jonas Weber">
                {#snippet children()}<strong>Jonas Weber</strong> accepted 3 submissions <span class="ds-clamp-time">· 2 h ago</span>{/snippet}
              </ClampedText>
            </li>
            <li class="ds-clamp-row">
              <span class="ui-avatar ui-avatar--sm" aria-hidden="true">SI</span>
              <ClampedText lines={2} expandFromSurface label="Schedule import">
                {#snippet children()}<strong>Schedule import</strong> planned 24 placements across 3 rooms from “agenda-draft.xlsx” — 2 unresolved room names (“Main Hall B”, “Studio 2”) and 1 possible duplicate session need a decision before the approved run can proceed <span class="ds-clamp-time">· 1 h ago</span>{/snippet}
              </ClampedText>
            </li>
          </ul>
        </ShowcaseCard>

        <ShowcaseCard title="Progress & loading" description="Known progress uses a bar; unknown waits use a compact spinner or reserved structure. This bar measures work in flight — an upload, a sync — so it carries no status tone. A ratio that has a state (behind, blocked, healthy) is a Meter, below.">
          <div class="progress-stack">
            <Progress label="Speaker profiles complete" value={76} />
            <Progress label="Airtable reconciliation" value={42} />
            <div class="loading-line"><span class="ui-spinner"></span><span>Checking schedule conflicts…</span></div>
          </div>
        </ShowcaseCard>

        <ShowcaseCard
          title="Meter — a ratio against a limit"
          description="The fill answers the state, never the fraction: 97% due tomorrow is amber, 20% with three weeks left is green. The track is a lighter step of the same ramp, so a nearly-empty bar still reads its state. Digits stay beside it — the bar is a second channel, never the only one.">
          <div class="meter-stack">
            {#each meterExamples as example (example.label)}
              <div class="meter-row">
                <span class="meter-row__label">{example.label}</span>
                <Meter
                  value={example.value}
                  label={example.label}
                  valueText={example.digits}
                  tone={example.tone} />
                <span class="meter-row__digits">{example.digits}</span>
                <Badge tone={example.tone}>{example.word}</Badge>
              </div>
            {/each}
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Reserved loading" description="Skeletons preview structure only when they reduce movement.">
          <div class="skeleton-card" aria-label="Loading speaker record">
            <span class="ui-skeleton skeleton-card__avatar"></span>
            <div><span class="ui-skeleton" style:width="42%"></span><span class="ui-skeleton" style:width="68%"></span></div>
            <span class="ui-skeleton" style:width="100%"></span><span class="ui-skeleton" style:width="87%"></span>
          </div>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="navigation">
      <SectionHeading index="07" title="Navigation" description="Wayfinding stays quiet and stable so dense content—not chrome—holds attention." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Tabs" description="Tabs preserve context within one entity." full>
          <div class="ui-tabs" role="tablist" aria-label="Speaker sections">
            {#each ['Details', 'Submissions', 'Messages', 'Activity'] as tab}<button class="ui-tab" type="button" role="tab" aria-selected={activeTab === tab} onclick={() => (activeTab = tab)}>{tab}{#if tab === 'Messages'}<Badge tone="warning">2</Badge>{/if}</button>{/each}
          </div>
          <div class="tab-panel"><Badge tone="info">{activeTab}</Badge><p>The active panel keeps its controls in the same top-left reading position.</p></div>
        </ShowcaseCard>

        <ShowcaseCard title="Breadcrumbs" description="Use for hierarchy, not browser history.">
          <nav class="ui-breadcrumbs" aria-label="Breadcrumb"><a href="#top">Events</a><ChevronRight /><a href="#patterns">Future of Care</a><ChevronRight /><span aria-current="page">Speakers</span></nav>
          <nav class="ui-breadcrumbs" aria-label="Breadcrumb"><a href="#top">Settings</a><ChevronRight /><span aria-current="page">Airtable connection</span></nav>
        </ShowcaseCard>

        <ShowcaseCard
          title="Arrival mark"
          description="What a scoped link leaves behind. Landing is not arriving: among rows that look alike, the scroll moves the view but not the answer to “which one?”. A still ring in the action colour, held — never a pulse, because a mark that keeps animating keeps re-asking for attention already given. It releases on the first press, key, wheel, or real pointer travel, and never before its minimum, so it cannot strobe away unseen. Mark only where the destination cannot answer for itself: not a named panel, not a list filtered to one match. It is decoration over a navigation that already worked, so anywhere it cannot draw cleanly — inline boxes, elements already using ::after — it draws nothing at all."
          full>
          <div class="component-row">
            <Button variant="secondary" size="sm" onclick={demoArrival}>Take me to it</Button>
            <span class="ds-hint">Then move the pointer, or press a key, to release it.</span>
          </div>
          <ul class="ds-arrival-list">
            <li class="ds-arrival-row">Panel: Who Owns Frontend Performance?</li>
            <li class="ds-arrival-row" bind:this={arrivalRow} tabindex="-1">
              Closing Panel: Ship It Anyway
            </li>
            <li class="ds-arrival-row">Opening Keynote: The Boring Web Wins</li>
          </ul>
        </ShowcaseCard>

        <ShowcaseCard
          title="Arrival mark: the host is declared, not assumed"
          description="A surface addresses a record by whatever element it can name — here the name block inside the first cell. That is the anchor: where the scroll and the caret stop, kept deliberately precise so a table that scrolls sideways still opens on the column the link was about. What a person recognises as “the record” is bigger, so the row declares itself with data-arrival-host and wears the mark. A row is the one host drawn on its own cells rather than on a single pseudo-element — position: relative on a tr is exactly the case engines disagree about — and it carries no halo, which would print a seam down every column boundary."
          full>
          <div class="component-row">
            <Button variant="secondary" size="sm" onclick={demoRowArrival}>Take me to the row</Button>
            <span class="ds-hint">The ring bands the whole row; the caret lands on the name.</span>
          </div>
          <div class="ui-table-wrap ds-arrival-table">
            <table class="ui-table">
              <thead>
                <tr><th>Reviewer</th><th>Reviews</th><th>Load</th></tr>
              </thead>
              <tbody>
                {#each arrivalPeople as person (person.email)}
                  <tr data-arrival-host>
                    <td>
                      <div class="ui-table__primary" bind:this={arrivalNames[person.email]}>
                        <strong>{person.name}</strong>
                        <span class="ui-table__secondary">{person.email}</span>
                      </div>
                    </td>
                    <td>{person.scope}</td>
                    <td class="ui-table__number">{person.load}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Pagination" description="Cursor-backed APIs can retain the same visual contract.">
          <nav class="ui-pagination" aria-label="Pagination">
            <button class="ui-pagination__item" type="button" aria-label="Previous page" onclick={() => (currentPage = Math.max(1, currentPage - 1))}><ChevronLeft /></button>
            {#each [1, 2, 3, 4] as page}<button class="ui-pagination__item" type="button" aria-current={currentPage === page ? 'page' : undefined} onclick={() => (currentPage = page)}>{page}</button>{/each}
            <button class="ui-pagination__item" type="button" aria-label="Next page" onclick={() => (currentPage = Math.min(4, currentPage + 1))}><ChevronRight /></button>
          </nav>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="data">
      <SectionHeading index="08" title="Dense data" description="Power-user views maximize scanability through alignment, restrained color, sticky context, and compact actions." />
      <ShowcaseCard title="Speaker operations" description="One row carries identity, proposal, workflow state, quality, ownership, and action without becoming a dashboard of cards." full flush>
        {#snippet actions()}<Badge tone={selectedCount ? 'action' : 'neutral'}>{selectedCount} selected</Badge>{/snippet}
        <div class="ui-toolbar">
          <div class="ui-input-wrap ui-input-wrap--leading table-search"><Search class="ui-input-wrap__icon" /><input class="ui-control" aria-label="Search speakers" placeholder="Search 148 speakers" /></div>
          <Button variant="secondary" size="sm"><ListFilter /> Status <ChevronDown /></Button>
          <Button variant="secondary" size="sm"><Filter /> Track <ChevronDown /></Button>
          <span class="ui-toolbar__spacer"></span>
          {#if selectedCount}<Button variant="soft" size="sm"><Mail /> Email {selectedCount}</Button>{/if}
          <Button size="sm"><Plus /> Add speaker</Button>
        </div>
        <div class="ui-table-wrap">
          <table class="ui-table ui-table--multiline">
            <thead><tr><th class="table-check"><Checkbox label="Select all speakers" hideLabel checked={allSelected} mixed={someSelected} onchange={selectAll} /></th><th>Speaker</th><th>Proposal <ArrowDown /></th><th>Track</th><th>Status</th><th>Score</th><th>Owner</th><th><span class="ui-sr-only">Actions</span></th></tr></thead>
            <tbody>
              {#each speakers as speaker}
                <tr data-selected={speaker.selected}>
                  <td class="table-check"><Checkbox label="Select {speaker.name}" hideLabel bind:checked={speaker.selected} /></td>
                  <td><div class="table-person"><Avatar name={speaker.name} size="sm" /><div class="ui-table__primary"><strong>{speaker.name}</strong><span class="ui-table__secondary">{speaker.email}</span></div></div></td>
                  <td><div class="ui-table__primary"><strong>{speaker.proposal}</strong><span class="ui-table__secondary">45-minute session</span></div></td>
                  <td>{speaker.track}</td>
                  <td><Badge tone={badgeTone(speaker.status)} dot>{speaker.status}</Badge></td>
                  <td class="ui-table__number"><strong>{speaker.score}</strong></td>
                  <td><Avatar name={speaker.owner} size="sm" /></td>
                  <td><Button variant="ghost" size="sm" iconOnly aria-label="Actions for {speaker.name}"><MoreHorizontal /></Button></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="table-footer"><span>1–5 of 148 speakers</span><div class="ui-pagination"><button class="ui-pagination__item" type="button" aria-label="Previous table page"><ChevronLeft /></button><button class="ui-pagination__item" type="button" aria-current="page">1</button><button class="ui-pagination__item" type="button">2</button><button class="ui-pagination__item" type="button">3</button><button class="ui-pagination__item" type="button" aria-label="Next table page"><ChevronRight /></button></div></div>
      </ShowcaseCard>
    </section>

    <section class="ds-section" id="overlays">
      <SectionHeading index="09" title="Overlays" description="Dialogs interrupt for a decision; drawers preserve context for inspection; toasts confirm completed background work." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Overlay triggers" description="Every overlay is functional in this workbench." full>
          <div class="component-row component-row--wrap">
            <Button onclick={() => (modalOpen = true)}><Trash2 /> Open confirmation</Button>
            <Button variant="secondary" onclick={() => (compareOpen = true)}><Columns2 /> Open comparison</Button>
            <Button variant="secondary" onclick={() => (drawerOpen = true)}><PanelRight /> Open inspector</Button>
            <Button variant="soft" onclick={() => showToast()}><Bell /> Show toast</Button>
            <Button variant="ghost" onclick={openCommand}><Command /> Command menu <kbd>⌘ K</kbd></Button>
          </div>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="patterns">
      <SectionHeading index="10" title="Product patterns" description="Primitives earn their place by supporting real event operations, not isolated component demos." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Access review" eyebrow="Admin pattern" description="Identity evidence, requested scope, and the decision stay visible together.">
          <div class="access-card">
            <div class="access-card__person"><Avatar name="Priya Raman" size="lg" /><div><strong>Priya Raman</strong><span>priya.raman@example.com</span></div><Badge tone="warning" dot>Pending</Badge></div>
            <dl><div><dt>Requested</dt><dd>12 minutes ago</dd></div><div><dt>Google identity</dt><dd>Verified email</dd></div><div><dt>Prior access</dt><dd>None</dd></div></dl>
            <div class="form-grid form-grid--two">
              <Field id="access-role" label="Workspace role">{#snippet children({ id })}<select class="ui-select" {id}><option>Organizer</option><option>Reviewer</option><option>Speaker manager</option></select>{/snippet}</Field>
              <Field id="access-scope" label="Event scope">{#snippet children({ id })}<select class="ui-select" {id}><option>Future of Care Summit</option><option>All events</option></select>{/snippet}</Field>
            </div>
            <div class="access-card__actions"><Button variant="ghost" size="sm">Defer</Button><Button size="sm" onclick={() => showToast('Priya was approved and notified')}><UserCheck /> Approve access</Button></div>
          </div>
        </ShowcaseCard>

        <ShowcaseCard title="Submission editor" eyebrow="Organizer pattern" description="A clear editing path with status and consequence separated from field entry.">
          <div class="submission-card">
            <div class="submission-card__status"><div><Badge tone="info" dot>In review</Badge><span>Autosaved 24s ago</span></div><Button variant="ghost" size="sm"><MoreHorizontal /> More</Button></div>
            <Field id="pattern-title" label="Session title" required>{#snippet children({ id })}<input class="ui-control" {id} value="Agents as event collaborators" />{/snippet}</Field>
            <Field id="pattern-format" label="Format">{#snippet children({ id })}<select class="ui-select" {id}><option>Talk · 45 min</option><option>Workshop · 90 min</option><option>Panel · 60 min</option></select>{/snippet}</Field>
            <Alert tone="warning" title="One scheduling question" message="The speaker is unavailable before 11:00 on day two." />
            <div class="submission-card__actions"><Button variant="secondary" size="sm">Save draft</Button><Button size="sm"><Send /> Send decision</Button></div>
          </div>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="theming">
      <SectionHeading index="11" title="Theme contract" description="A narrow, semantic styling surface gives people and agents creative range without sacrificing baseline behavior." />
      <div class="theme-contract">
        <div class="theme-contract__copy">
          <p class="ds-kicker"><span></span> Designed for extension</p>
          <h3>Style the atmosphere.<br />Keep the interaction contract.</h3>
          <p>Custom layers load after the system and override documented <code>--je-*</code> tokens. Controls still own focus, validation, disabled state, hit area, and density. Agents get a small target instead of thousands of incidental CSS decisions.</p>
          <div class="theme-contract__rules">
            <div><span>01</span><p><strong>Tokens first</strong>Change color, type, radii, and control metrics.</p></div>
            <div><span>02</span><p><strong>States stay complete</strong>Every override is checked across hover, focus, invalid, and disabled.</p></div>
            <div><span>03</span><p><strong>Composition is free</strong>Product pages combine primitives without copying their internals.</p></div>
          </div>
          <Button onclick={() => (themeStudioOpen = true)}><Palette /> Open live theme studio</Button>
        </div>
        <div class="theme-contract__code">
          <div class="layer-stack">
            {#each ['app.overrides', 'je.utilities', 'je.components', 'je.base', 'je.tokens', 'reset'] as layer, index}<div style:--layer-index={index}><Layers /><span>{layer}</span>{#if index === 0}<Badge tone="action">Your layer</Badge>{/if}</div>{/each}
          </div>
          <pre class="ui-code">{`@layer app.overrides {
  :root[data-theme="festival"] {
    --je-color-action: #3d7377;
    --je-color-canvas: #f4f8f8;
    --je-radius-control: 8px;
    --je-font-display: "Your Display Font";
  }
}`}</pre>
        </div>
      </div>
    </section>

    <footer class="ds-footer">
      <div class="ds-brand__mark">JE</div>
      <p><strong>JooEvents design system</strong><span>Production reference for every human and agent-built interface.</span></p>
      <a href="#top">Back to top <ArrowDown /></a>
    </footer>
  </main>
</div>

<ThemeStudio bind:open={themeStudioOpen} bind:density />

<Modal bind:open={modalOpen} title="Cancel this session?">
  <p class="modal-copy">The public schedule will remain unchanged until this cancellation is approved. The speaker manager and scheduler will be notified.</p>
  <Field id="cancel-reason" label="Reason" required>
    {#snippet children({ id, describedBy })}<textarea class="ui-textarea" {id} aria-describedby={describedBy} placeholder="Explain why the session is being cancelled…"></textarea>{/snippet}
  </Field>
  {#snippet footer(close)}<Button variant="ghost" onclick={close}>Keep session</Button><Button variant="danger" onclick={() => { close(); showToast('Cancellation request created'); }}>Request cancellation</Button>{/snippet}
</Modal>

<!-- The inspection variant: wide enough to hold a reference beside the set it is
     read against, and left by a press outside because looking is finished when
     you stop looking. A decision dialog keeps the default width and stays. -->
<Modal bind:open={compareOpen} title="Line-up: “Calm systems under pressure”" size="lg" dismissible>
  <div class="compare">
    <div class="compare__card compare__card--anchor">
      <p class="compare__role">Anchor</p>
      <h3 class="compare__title">Calm systems under pressure</h3>
      <p class="compare__meta">Platform engineering</p>
      <span class="compare__score">4</span>
      <div class="component-row"><Button variant="secondary" size="sm">Revise score</Button></div>
    </div>
    <div class="compare__list">
      <div class="compare__card">
        <h3 class="compare__title">Deterministic replay for distributed bugs</h3>
        <p class="compare__meta">Platform engineering</p>
        <span class="compare__score">5</span>
        <div class="component-row"><Button variant="secondary" size="sm">Revise score</Button></div>
      </div>
      <div class="compare__card">
        <h3 class="compare__title">The type system ate my deadline</h3>
        <p class="compare__meta">Platform engineering</p>
        <span class="compare__score">3</span>
        <div class="component-row"><Button variant="secondary" size="sm">Revise score</Button></div>
      </div>
    </div>
  </div>
</Modal>

{#if drawerOpen}
  <button class="ds-overlay-backdrop" type="button" aria-label="Close speaker inspector" onclick={() => (drawerOpen = false)}></button>
  <aside class="ds-inspector" aria-label="Speaker inspector">
    <header><div><p>Speaker inspector</p><h2>Avery Chen</h2></div><Button variant="ghost" size="sm" iconOnly aria-label="Close inspector" onclick={() => (drawerOpen = false)}><X /></Button></header>
    <div class="ds-inspector__body">
      <div class="inspector-person"><Avatar name="Avery Chen" size="lg" /><div><strong>Avery Chen</strong><span>Product systems · Aperture Labs</span></div><Badge tone="success" dot>Confirmed</Badge></div>
      <div class="inspector-section"><h3>Contact</h3><a href="mailto:avery@example.com"><Mail /> avery@example.com</a><a href="#overlays"><Link /> linkedin.com/in/averychen</a></div>
      <div class="inspector-section"><h3>Event status</h3><dl><div><dt>Session</dt><dd>Calm systems under pressure</dd></div><div><dt>Next action</dt><dd>Travel details due Aug 18</dd></div><div><dt>Owner</dt><dd>Mina Lee</dd></div></dl></div>
      <Alert tone="info" title="Synced with Airtable" message="Last reconciled 4 minutes ago." />
    </div>
    <footer><Button variant="secondary">View full profile</Button><Button><MessageSquareText /> Send message</Button></footer>
  </aside>
{/if}

{#if commandOpen}
  <button class="ds-command-backdrop" type="button" aria-label="Close command menu" onclick={() => (commandOpen = false)}></button>
  <div class="ds-command-menu" role="dialog" aria-modal="true" aria-label="Jump to a component">
    <div class="ds-command-menu__input"><Search /><input bind:this={commandInput} bind:value={commandQuery} placeholder="Type a component or pattern…" aria-label="Search design system" /><kbd>ESC</kbd></div>
    <div class="ds-command-menu__results">
      <p>Navigate</p>
      {#each filteredCommands as item, index}<button type="button" onclick={() => goToSection(item.id)}><span class="ds-sidebar__index">{String(index + 1).padStart(2, '0')}</span><span><strong>{item.label}</strong><small>{item.hint}</small></span><ArrowRight /></button>{/each}
      {#if !filteredCommands.length}<div class="ds-command-empty"><Inbox /><span>No matching component</span></div>{/if}
    </div>
  </div>
{/if}

{#if toastVisible}
  <div class="ds-toast" role="status"><span><Check /></span><div><strong>{announcement}</strong><small>The operation is recorded in activity.</small></div><button type="button" aria-label="Dismiss notification" onclick={() => (toastVisible = false)}><X /></button></div>
{/if}

<div class="ui-sr-only" aria-live="polite">{announcement}</div>
