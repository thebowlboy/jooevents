<script lang="ts">
	import type { FormRuleAuthorInput, TransientApplicationAnswerInput } from '@jooevents/contracts';
	import { Button, Checkbox, Field } from '$lib/ui';
	import { effectiveFormFieldStates } from '$lib/api/view-models/public-application-form';
	import type { FormFieldRow, MutationOutcome } from '$lib/api/types';

	interface Props {
		rows: readonly FormFieldRow[];
		rules: readonly FormRuleAuthorInput[];
		ruleOptions: readonly {
			readonly fieldId: string;
			readonly options: readonly { readonly id: string; readonly name: string }[];
		}[];
		disabled?: boolean;
		onSave: (rules: readonly FormRuleAuthorInput[]) => Promise<MutationOutcome>;
	}

	let { rows, rules, ruleOptions, disabled = false, onSave }: Props = $props();
	let editing = $state<number | null>(null);
	let sourceId = $state('');
	let checkedValue = $state(true);
	let choiceIds = $state<string[]>([]);
	let effectKind = $state<'show' | 'hide' | 'require'>('show');
	let targetIds = $state<string[]>([]);
	let previewMatches = $state(true);
	let saving = $state(false);
	let note = $state('');
	let newRuleKey = $state(`rule-${crypto.randomUUID()}`);

	const sources = $derived(rows.filter((row) =>
		row.field.kind === 'checkbox'
		|| ((row.field.kind === 'select' || row.field.kind === 'multiselect')
			&& ruleOptions.some((entry) => entry.fieldId === row.field.id && entry.options.length > 0))
	));
	const source = $derived(sources.find((row) => row.field.id === sourceId) ?? null);
	const sourceOptions = $derived(ruleOptions.find((entry) => entry.fieldId === sourceId)?.options ?? []);
	const targets = $derived(rows.filter((row) => row.field.id !== sourceId));
	const ready = $derived(Boolean(source && targetIds.length > 0
		&& (source.field.kind === 'checkbox' || choiceIds.length > 0)));

	function reset(): void {
		editing = null;
		sourceId = sources[0]?.field.id ?? '';
		checkedValue = true;
		choiceIds = [];
		effectKind = 'show';
		targetIds = [];
		previewMatches = true;
		newRuleKey = `rule-${crypto.randomUUID()}`;
	}

	$effect(() => {
		if (!sourceId && sources[0]) sourceId = sources[0].field.id;
	});

	function edit(index: number): void {
		const rule = rules[index];
		if (!rule) return;
		editing = index;
		sourceId = rule.condition.sourceFieldId;
		checkedValue = rule.condition.kind === 'checked_is' ? rule.condition.value : true;
		choiceIds = rule.condition.kind === 'selected_any' ? [...rule.condition.choiceIds] : [];
		effectKind = rule.effect.kind;
		targetIds = [...rule.effect.targetFieldIds];
		previewMatches = true;
		note = '';
	}

	function toggle(list: string[], id: string, checked: boolean): string[] {
		return checked ? [...new Set([...list, id])] : list.filter((entry) => entry !== id);
	}

	function authoredRule(): FormRuleAuthorInput | null {
		if (!source || !ready) return null;
		return {
			key: editing === null ? newRuleKey : rules[editing]!.key,
			condition: source.field.kind === 'checkbox'
				? { kind: 'checked_is', sourceFieldId: source.field.id, value: checkedValue }
				: { kind: 'selected_any', sourceFieldId: source.field.id, choiceIds: [...choiceIds].sort() },
			effect: { kind: effectKind, targetFieldIds: [...targetIds].sort() }
		};
	}

	async function save(event: SubmitEvent): Promise<void> {
		event.preventDefault();
		const rule = authoredRule();
		if (!rule || saving) return;
		const next = [...rules];
		if (editing === null) next.push(rule);
		else next[editing] = rule;
		saving = true;
		const outcome = await onSave(next);
		saving = false;
		if (outcome.ok) reset();
		note = outcome.ok ? 'Rule saved.' : outcome.reason;
	}

	async function remove(index: number): Promise<void> {
		if (saving) return;
		saving = true;
		const outcome = await onSave(rules.filter((_, ruleIndex) => ruleIndex !== index));
		saving = false;
		if (outcome.ok) reset();
		note = outcome.ok ? 'Rule removed.' : outcome.reason;
	}

	const previewAnswers = $derived.by((): TransientApplicationAnswerInput[] => {
		if (!source) return [];
		if (source.field.kind === 'checkbox') {
			return [{
				kind: 'checkbox', fieldId: source.field.id,
				checked: previewMatches ? checkedValue : !checkedValue
			}];
		}
		if (!previewMatches) return [];
		const first = choiceIds[0];
		if (!first) return [];
		return source.field.kind === 'multiselect'
			? [{ kind: 'multiselect', fieldId: source.field.id, choiceIds: [first] }]
			: [{ kind: 'select', fieldId: source.field.id, choiceId: first }];
	});
	const previewStates = $derived(effectiveFormFieldStates(
		rows.map((row) => ({
			id: row.field.id,
			initiallyVisible: !(effectKind === 'show' && targetIds.includes(row.field.id)),
			required: row.required
		})),
		authoredRule() ? [authoredRule()!] : [],
		previewAnswers
	));
</script>

<section class="rules" aria-labelledby="conditional-rules-title">
	<header class="rules__head">
		<div>
			<h3 id="conditional-rules-title">Conditional questions</h3>
			<p>Show, hide, or require questions when someone chooses a particular answer.</p>
		</div>
	</header>

	{#if rules.length > 0}
		<ul class="rules__list">
			{#each rules as rule, index (rule.key)}
				{@const sourceRow = rows.find((row) => row.field.id === rule.condition.sourceFieldId)}
				<li>
					<span><strong>{sourceRow?.field.label ?? 'Unavailable question'}</strong> → {rule.effect.kind}
						{rule.effect.targetFieldIds.length} {rule.effect.targetFieldIds.length === 1 ? 'question' : 'questions'}</span>
					<span class="rules__actions">
						<Button variant="ghost" size="sm" disabled={disabled || saving} onclick={() => edit(index)}>Edit</Button>
						<Button variant="ghost" size="sm" disabled={disabled || saving} onclick={() => void remove(index)}>Remove</Button>
					</span>
				</li>
			{/each}
		</ul>
	{/if}

	{#if sources.length === 0}
		<p class="rules__empty">Add a checkbox or an offered choice question before adding a condition.</p>
	{:else}
		<form class="rules__form" onsubmit={save}>
			<Field id="rule-source" label="Source question">
				{#snippet children({ id, describedBy })}
					<select class="ui-select" {id} aria-describedby={describedBy} bind:value={sourceId}
						disabled={disabled || saving} onchange={() => {
							choiceIds = [];
							targetIds = targetIds.filter((id) => id !== sourceId);
						}}>
						{#each sources as candidate (candidate.field.id)}
							<option value={candidate.field.id}>{candidate.field.label}</option>
						{/each}
					</select>
				{/snippet}
			</Field>

			{#if source?.field.kind === 'checkbox'}
				<Field id="rule-checkbox-value" label="When the answer is">
					{#snippet children({ id, describedBy })}
						<select class="ui-select" {id} aria-describedby={describedBy} bind:value={checkedValue}
							disabled={disabled || saving}>
							<option value={true}>Checked</option><option value={false}>Not checked</option>
						</select>
					{/snippet}
				</Field>
		{:else if sourceOptions.length > 0}
			<fieldset class="rules__choices">
				<legend>When any of these options is chosen</legend>
				{#each sourceOptions as option (option.id)}
					<Checkbox label={option.name} checked={choiceIds.includes(option.id)} disabled={disabled || saving}
						onchange={(checked) => (choiceIds = toggle(choiceIds, option.id, checked))} />
				{/each}
			</fieldset>
		{/if}

		<Field id="rule-effect" label="Then">
			{#snippet children({ id, describedBy })}
				<select class="ui-select" {id} aria-describedby={describedBy} bind:value={effectKind} disabled={disabled || saving}>
					<option value="show">Show</option><option value="hide">Hide</option><option value="require">Show and require</option>
				</select>
			{/snippet}
		</Field>
		<fieldset class="rules__choices">
			<legend>Target questions</legend>
			{#each targets as target (target.field.id)}
				<Checkbox label={target.field.label} checked={targetIds.includes(target.field.id)} disabled={disabled || saving}
					onchange={(checked) => (targetIds = toggle(targetIds, target.field.id, checked))} />
			{/each}
		</fieldset>

		{#if authoredRule()}
			<div class="rules__preview">
				<Checkbox label="Preview with the trigger matched" checked={previewMatches}
					onchange={(checked) => (previewMatches = checked)} />
				<ul>
					{#each targets.filter((target) => targetIds.includes(target.field.id)) as target (target.field.id)}
						{@const state = previewStates.get(target.field.id)}
						<li><span>{target.field.label}</span><strong>{state?.visible ? (state.required ? 'Visible · required' : 'Visible') : 'Hidden'}</strong></li>
					{/each}
				</ul>
			</div>
		{/if}
		<div class="rules__commit">
			<Button type="submit" size="sm" disabled={!ready || disabled || saving} loading={saving}>{editing === null ? 'Add rule' : 'Save rule'}</Button>
			{#if editing !== null}<Button variant="ghost" size="sm" disabled={saving} onclick={reset}>Cancel</Button>{/if}
		</div>
	</form>
	{/if}
	{#if note}<p class="rules__note" role="status">{note}</p>{/if}
</section>

<style>
	.rules { display: grid; gap: var(--je-space-4); padding: var(--je-space-5); border-top: 1px solid var(--je-color-border); }
	.rules__head h3, .rules__head p { margin: 0; }
	.rules__head p, .rules__empty, .rules__note { color: var(--je-color-text-muted); }
	.rules__form { display: grid; gap: var(--je-space-4); max-inline-size: 42rem; }
	.rules__list, .rules__preview ul { list-style: none; padding: 0; margin: 0; display: grid; gap: var(--je-space-2); }
	.rules__list li, .rules__preview li { display: flex; align-items: center; justify-content: space-between; gap: var(--je-space-3); padding: var(--je-space-3); border: 1px solid var(--je-color-border); border-radius: var(--je-radius-control); }
	.rules__actions, .rules__commit { display: flex; flex-wrap: wrap; gap: var(--je-space-2); }
	.rules__choices { display: grid; gap: var(--je-space-2); margin: 0; padding: var(--je-space-3); border: 1px solid var(--je-color-border); border-radius: var(--je-radius-control); }
	.rules__choices legend { padding-inline: var(--je-space-1); font-weight: 650; }
	.rules__preview { display: grid; gap: var(--je-space-3); padding: var(--je-space-4); background: var(--je-color-surface-subtle); border-radius: var(--je-radius-control); }
	@container (max-width: 36rem) { .rules { padding-inline: var(--je-space-4); } .rules__list li, .rules__preview li { align-items: flex-start; flex-direction: column; } }
</style>
