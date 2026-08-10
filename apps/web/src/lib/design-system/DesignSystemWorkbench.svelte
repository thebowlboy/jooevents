<script lang="ts">
  import { tick } from 'svelte';
  import {
    ArrowDown,
    ArrowRight,
    Bell,
    CalendarDays,
    Check,
    ChevronDown,
    ChevronLeft,
    ChevronRight,
    Clock,
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
    Field,
    Modal,
    Progress,
    Radio,
    Switch
  } from '$lib/ui';
  import type { Density } from '$lib/theme/theme-contract';
  import SectionHeading from './SectionHeading.svelte';
  import ShowcaseCard from './ShowcaseCard.svelte';
  import ThemeStudio from './ThemeStudio.svelte';
  import TokenSwatch from './TokenSwatch.svelte';

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
  let currentPage = $state(1);
  let editorMode = $state('Write');
  let reviewMode = $state('assigned');
  let showPassword = $state(false);
  let modalOpen = $state(false);
  let drawerOpen = $state(false);
  let toastVisible = $state(false);
  let announcement = $state('');
  let notificationsEnabled = $state(true);
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

        <ShowcaseCard title="Typography" description="Merriweather creates a few human moments. Open Sans does the operational work.">
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
            <Field id="speaker-company" label="Company" description="Browser-native autocomplete in the baseline.">
              {#snippet children({ id, describedBy })}<input class="ui-control" {id} list="companies" aria-describedby={describedBy} value="Aperture Labs" /><datalist id="companies"><option value="Aperture Labs"></option><option value="Northstar Studio"></option><option value="Common Ground"></option></datalist>{/snippet}
            </Field>
            <Field id="assigned-owner" label="Assigned owner">
              {#snippet children({ id, describedBy })}<select class="ui-select" {id} aria-describedby={describedBy}><option>Mina Lee</option><option>Arun Kumar</option><option>Jamie Smith</option></select>{/snippet}
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

        <ShowcaseCard title="Date, time & range" description="Dates inherit the event timezone and show it beside—not hidden inside—the control." full>
          <div class="form-grid form-grid--four">
            <Field id="session-date" label="Session date" required>{#snippet children({ id, describedBy })}<input class="ui-control" type="date" {id} aria-describedby={describedBy} value="2026-09-18" />{/snippet}</Field>
            <Field id="start-time" label="Starts" meta="SGT">{#snippet children({ id, describedBy })}<input class="ui-control" type="time" {id} aria-describedby={describedBy} value="09:30" />{/snippet}</Field>
            <Field id="end-time" label="Ends" meta="45 min">{#snippet children({ id, describedBy })}<input class="ui-control" type="time" {id} aria-describedby={describedBy} value="10:15" />{/snippet}</Field>
            <Field id="event-timezone" label="Timezone">{#snippet children({ id, describedBy })}<select class="ui-select" {id} aria-describedby={describedBy}><option>Asia/Singapore</option><option>Europe/London</option><option>America/New_York</option></select>{/snippet}</Field>
          </div>
          <div class="range-field">
            <div><strong>Minimum review score</strong><span>4.2 and above</span></div>
            <input class="ui-range" type="range" min="1" max="5" value="4.2" step="0.1" aria-label="Minimum review score" />
          </div>
        </ShowcaseCard>
      </div>
    </section>

    <section class="ds-section" id="feedback">
      <SectionHeading index="06" title="Feedback & status" description="State always has text, not just color. Calm surfaces reserve stronger interruption for consequential failures." />
      <div class="ds-showcase-grid">
        <ShowcaseCard title="Status badges" description="Short nouns or past-tense facts work best." full>
          <div class="component-row component-row--wrap">
            <Badge>Draft</Badge><Badge tone="action" dot>Active</Badge><Badge tone="success" dot>Confirmed</Badge><Badge tone="warning" dot>Needs reply</Badge><Badge tone="danger" dot>Cancelled</Badge><Badge tone="info">In review</Badge><Badge tone="lavender">Waitlisted</Badge><Badge tone="sea">Synced</Badge>
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

        <ShowcaseCard title="Progress & loading" description="Known progress uses a bar. Unknown waits use a compact spinner or reserved structure.">
          <div class="progress-stack">
            <Progress label="Speaker profiles complete" value={76} />
            <Progress label="Airtable reconciliation" value={42} />
            <div class="loading-line"><span class="ui-spinner"></span><span>Checking schedule conflicts…</span></div>
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
            <thead><tr><th class="table-check"><Checkbox label="Select all speakers" checked={allSelected} mixed={someSelected} onchange={selectAll} /></th><th>Speaker</th><th>Proposal <ArrowDown /></th><th>Track</th><th>Status</th><th>Score</th><th>Owner</th><th><span class="ui-sr-only">Actions</span></th></tr></thead>
            <tbody>
              {#each speakers as speaker}
                <tr data-selected={speaker.selected}>
                  <td class="table-check"><Checkbox label="Select {speaker.name}" bind:checked={speaker.selected} /></td>
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
