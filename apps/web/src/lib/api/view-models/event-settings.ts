/**
 * Browser projection of the canonical Event Settings record. The three version
 * fields stay private to adapters/components that author guarded mutations;
 * `dates` is the sole display-only value. The schedule-grid geometry triple is
 * present together or all null; all-null means the event has no grid window.
 */
export interface EventSettingsView {
	readonly eventId: string;
	readonly eventSetVersion: number;
	readonly eventVersion: number;
	readonly profileContentReview: boolean;
	readonly name: string;
	readonly timezone: string;
	readonly startDate: string;
	readonly endDate: string;
	readonly location: string;
	readonly venueNote: string;
	readonly dayStart: string | null;
	readonly dayEnd: string | null;
	readonly slotMinutes: number | null;
	readonly dates: string;
}
