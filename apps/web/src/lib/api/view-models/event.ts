export interface EventView {
	readonly id: string;
	readonly name: string;
	readonly timezone: string;
	readonly startDate: string;
	readonly endDate: string;
	readonly version: number;
}

export type CurrentEventView =
	| {
			readonly kind: 'no_event';
			readonly eventSetVersion: number;
	  }
	| {
			readonly kind: 'current_event';
			readonly eventSetVersion: number;
			readonly event: EventView;
	  };

