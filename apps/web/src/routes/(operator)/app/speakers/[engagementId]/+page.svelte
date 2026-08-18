<script lang="ts">
	import OperatorPage from 'jooevents-operator-page';
	import { page } from '$app/state';

	/*
	 * The first record route. It sits under the Speakers area rather than beside
	 * it, so the rail keeps Speakers selected while a record is open — a record
	 * belongs to the surface that lists it — and `destinationLabel` titles the
	 * destination from the same subtree rule.
	 *
	 * The parameter is read here and handed down as a prop: the record page then
	 * takes its subject like any other component, with no router underneath it.
	 */
	const engagementId = $derived(page.params.engagementId ?? '');
</script>

<svelte:head><title>Speaker record · JooEvents</title></svelte:head>

<OperatorPage area="speaker_record" {engagementId} />
