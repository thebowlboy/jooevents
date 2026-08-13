import type {
	SessionCatalogDto,
	SessionDraftData,
	SessionHeadDto,
	SessionSafeDiffDto
} from '@jooevents/contracts/sessions';

/**
 * Browser-owned, immutable copies of canonical Session projections.
 *
 * The canonical names stay intact on purpose. A Session head's program-target
 * and roster fields are retained evidence (typed references plus versions and
 * digests), not display material: a nullable track states "no track chosen",
 * roster participants are person references without names or addresses, and a
 * display adapter must not replace either absence with made-up values.
 */
type SessionScalar = string | number | boolean | bigint | symbol | null | undefined;

export type SessionView<Value> =
	Value extends SessionScalar
		? Value
		: Value extends (...args: never[]) => unknown
		? Value
		: Value extends readonly (infer Item)[]
			? readonly SessionView<Item>[]
			: Value extends object
				? { readonly [Key in keyof Value]: SessionView<Value[Key]> }
				: Value;

export type SessionHeadView = SessionView<SessionHeadDto>;
export type SessionCatalogView = SessionView<SessionCatalogDto>;
export type SessionSafeDiffView = SessionView<SessionSafeDiffDto>;
export type SessionDraftView = SessionView<SessionDraftData>;

export interface SessionChangeSelectorView {
	readonly changesetId: string;
	readonly revisionId: string;
	readonly revisionDigest: string;
}

/**
 * One authored Session change after its draft was proposed and committed
 * through the generic changeset lifecycle. `session` is the committed after
 * image the reviewed safe diff stated; only `create` and `transition` cross
 * the web boundary ('restore' is internal compensation).
 */
export interface SessionChangeCommittedView {
	readonly action: 'create' | 'transition';
	readonly selector: SessionChangeSelectorView;
	readonly changesetHead: {
		readonly proposedVersion: number;
		readonly committedVersion: number;
	};
	readonly session: SessionHeadView;
	readonly safeDiff: SessionSafeDiffView;
}
