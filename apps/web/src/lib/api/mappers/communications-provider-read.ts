import type {
	EmailProviderConnectionProjection,
	OrganizerEmailReadinessProjection
} from '@jooevents/contracts';
import type {
	CommunicationProviderReadView,
	EmailProviderConnectionView,
	EmailProviderReadinessView
} from '../view-models/communications-provider-read';

function freezeJson(value: unknown): void {
	if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return;
	for (const child of Object.values(value)) freezeJson(child);
	Object.freeze(value);
}

/** Severs wire aliases while retaining every safe canonical field and absence. */
function immutableCopy<Value>(value: Value): CommunicationProviderReadView<Value> {
	const copy = structuredClone(value);
	freezeJson(copy);
	return copy as CommunicationProviderReadView<Value>;
}

export function mapEmailProviderConnection(
	value: EmailProviderConnectionProjection
): EmailProviderConnectionView {
	return immutableCopy(value);
}

export function mapEmailProviderReadiness(
	value: OrganizerEmailReadinessProjection
): EmailProviderReadinessView {
	return immutableCopy(value);
}
