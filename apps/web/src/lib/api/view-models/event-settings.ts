/**
 * Browser projection of the canonical Event Settings record. The three version
 * fields stay private to adapters/components that author guarded mutations;
 * `dates` is the sole display-only value.
 */
export interface EventSettingsView {
	readonly eventId: string;
	readonly eventSetVersion: number;
	readonly eventVersion: number;
	readonly name: string;
	readonly timezone: string;
	readonly startDate: string;
	readonly endDate: string;
	readonly location: string;
	readonly venueNote: string;
	readonly dates: string;
}
