import type {
	EmailProviderConnectionProjection,
	OrganizerEmailReadinessProjection
} from '@jooevents/contracts';

/** Browser-owned immutable copies of provider-neutral communication read projections. */
export type CommunicationProviderReadView<Value> =
	Value extends string | number | boolean | bigint | symbol | null | undefined
		? Value
		: Value extends (...args: never[]) => unknown
			? Value
			: Value extends readonly (infer Item)[]
				? readonly CommunicationProviderReadView<Item>[]
				: Value extends object
					? { readonly [Key in keyof Value]: CommunicationProviderReadView<Value[Key]> }
					: Value;

/** Safe connection metadata only; restricted configuration remains an opaque reference. */
export type EmailProviderConnectionView =
	CommunicationProviderReadView<EmailProviderConnectionProjection>;

/**
 * `provider` absence and every outbound state remain canonical facts. Callers must not
 * turn an unconfigured `unknown` projection into provider or delivery readiness.
 */
export type EmailProviderReadinessView =
	CommunicationProviderReadView<OrganizerEmailReadinessProjection>;
