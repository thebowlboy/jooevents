import type {
	SubmissionTriageAttribution,
	SubmissionTriageListDto,
	SubmissionTriageProjectionDto,
	SubmissionTriageQueryGuardDto,
	SubmissionTriageReadDto,
	SubmissionTriageVisibleTray
} from '@jooevents/contracts/submission-triage';

export type SubmissionTriageAttributionView =
	| { readonly kind: 'manual' }
	| {
			readonly kind: 'registered_run';
			readonly standingPolicy: Readonly<{ readonly key: string; readonly version: number }>;
	  };

export interface SubmissionTriageSourceView {
	readonly id: string;
	readonly formId: string;
	readonly formVersionId: string;
	readonly target: SubmissionTriageProjectionDto['source']['summary']['target'];
	readonly title: string;
	readonly primaryParticipantName: string | null;
	readonly submittedAt: string;
	readonly source: SubmissionTriageProjectionDto['source']['source'];
	readonly abstract: string | null;
	readonly track: Readonly<{ readonly id: string; readonly label: string }> | null;
	readonly format: Readonly<{ readonly id: string; readonly label: string }> | null;
	readonly detail: SubmissionTriageProjectionDto['source']['detail'];
}

export interface SubmissionTriageRowView {
	readonly source: SubmissionTriageSourceView;
	readonly head: Readonly<{
		readonly version: number;
		readonly state: SubmissionTriageProjectionDto['triage']['state'];
		readonly setAsideAttribution: SubmissionTriageAttributionView | null;
		readonly updatedAt: string;
	}>;
	readonly arrival: SubmissionTriageProjectionDto['arrival'];
	readonly visibleTray: SubmissionTriageVisibleTray;
	readonly queryGuard: SubmissionTriageQueryGuardDto;
}

export interface SubmissionTriagePageView {
	readonly rows: readonly SubmissionTriageRowView[];
	readonly trayTotals: Readonly<Record<SubmissionTriageVisibleTray, number>>;
	readonly search: SubmissionTriageListDto['search'];
	readonly queryGuard: SubmissionTriageQueryGuardDto;
}

function unreachable(value: never): never {
	throw new TypeError(`Unsupported submission-triage contract variant: ${JSON.stringify(value)}`);
}

/** Drops opaque principal/run evidence while retaining the server-stated attribution class. */
export function mapSubmissionTriageAttribution(
	attribution: SubmissionTriageAttribution | null
): SubmissionTriageAttributionView | null {
	if (attribution === null) return null;
	if (attribution.kind === 'manual') return Object.freeze({ kind: 'manual' as const });
	if (attribution.kind === 'registered_run') {
		return Object.freeze({
			kind: 'registered_run' as const,
			standingPolicy: Object.freeze({ ...attribution.standingPolicy.reference })
		});
	}
	return unreachable(attribution);
}

function mapSource(row: SubmissionTriageProjectionDto): SubmissionTriageSourceView {
	return Object.freeze({
		id: row.source.summary.id,
		formId: row.source.summary.formId,
		formVersionId: row.source.summary.formVersionId,
		target: structuredClone(row.source.summary.target),
		title: row.source.summary.title ?? 'Untitled submission',
		primaryParticipantName: row.source.summary.primaryParticipantName,
		submittedAt: row.source.summary.submittedAt,
		source: row.source.source,
		// Nullable canonical facts remain nullable. This layer never replaces an
		// absent value with presentation copy or a neutral business value.
		abstract: row.source.abstract,
		track: row.source.track === null ? null : Object.freeze({ ...row.source.track }),
		format: row.source.format === null ? null : Object.freeze({ ...row.source.format }),
		detail: structuredClone(row.source.detail)
	});
}

function mapRow(
	row: SubmissionTriageProjectionDto,
	queryGuard: SubmissionTriageQueryGuardDto
): SubmissionTriageRowView {
	return Object.freeze({
		source: mapSource(row),
		head: Object.freeze({
			version: row.triage.version,
			state: row.triage.state,
			setAsideAttribution: mapSubmissionTriageAttribution(row.triage.setAsideAttribution),
			updatedAt: row.triage.updatedAt
		}),
		arrival: structuredClone(row.arrival),
		visibleTray: row.visibleTray,
		queryGuard
	});
}

export function mapSubmissionTriageList(data: SubmissionTriageListDto): SubmissionTriagePageView {
	return Object.freeze({
		rows: Object.freeze(data.rows.map((row) => mapRow(row, data.queryGuard))),
		trayTotals: Object.freeze({ ...data.trayTotals }),
		search: data.search === null ? null : Object.freeze({ ...data.search }),
		queryGuard: data.queryGuard
	});
}

export function mapSubmissionTriageRead(data: SubmissionTriageReadDto): SubmissionTriageRowView {
	return mapRow(data.row, data.queryGuard);
}
