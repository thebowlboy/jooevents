import type { WorkspaceApi } from './workspace-gateway';
import type { FormRuleAuthorInput } from '@jooevents/contracts';
import type { FormPublishPreparation, FormPublishReview, FormsPagePort } from './forms-page-port';

/** Keeps the tuned Forms page on the resettable fixture without entering live's import graph. */
export function createSampleFormsPagePort(api: WorkspaceApi): FormsPagePort {
	const pending = new Map<string, FormPublishReview>();
	const rules = new Map<string, FormRuleAuthorInput[]>();
	return Object.freeze({
		templates: Object.freeze({
			async applicationFormSurfaceId(): Promise<string | null> {
				const { surfaces } = await api.templates.list();
				return surfaces.find((surface) => surface.kind === 'application-form')?.id ?? null;
			},
			async applicationSurfacePublication() {
				// The sample public pages serve whenever their surface exists, so
				// every form lens is an honest sample address.
				const { surfaces } = await api.templates.list();
				return surfaces.some((surface) => surface.kind === 'application-form')
					? { kind: 'any' as const }
					: { kind: 'none' as const };
			}
		}),
		vocab: Object.freeze({ tracks: api.vocab.tracks, formats: api.vocab.formats }),
		schedule: Object.freeze({
			async sessions() {
				const schedule = await api.schedule.state();
				return schedule.sessions.map((session) => Object.freeze({
					id: session.id,
					title: session.title,
					state: session.state
				}));
			}
		}),
		forms: Object.freeze({
			list: api.forms.list,
			get: api.forms.get,
			fields: api.forms.fields,
			async ruleOptions(id: string) {
				const rows = await api.forms.fields(id);
				return rows?.flatMap((row) => row.options?.length
					? [{ fieldId: row.field.id, options: row.options.map((option) => ({
						id: option.id, name: option.name
					})) }]
					: []) ?? null;
			},
			async rules(id: string) { return rules.get(id)?.map((rule) => structuredClone(rule)) ?? []; },
			create: api.forms.create,
			setComposition: api.forms.setComposition,
			async setRules(id: string, next: readonly FormRuleAuthorInput[]) {
				if (!await api.forms.get(id)) return { ok: false as const, reason: 'This form no longer exists.' };
				rules.set(id, next.map((rule) => structuredClone(rule)));
				return { ok: true as const };
			},
			setClosing: api.forms.setClosing,
			setStatus: api.forms.setStatus,
			async preparePublish(id: string): Promise<FormPublishPreparation> {
				const form = await api.forms.get(id);
				if (!form) return { ok: false, reason: 'This form no longer exists.' };
				if (form.status !== 'draft') return { ok: false, reason: 'Only a draft Form can be published and opened.' };
				const draftId = crypto.randomUUID();
				const revisionId = crypto.randomUUID();
				const review: FormPublishReview = Object.freeze({ action: 'publish_and_open',
					selector: Object.freeze({ draftId, revisionId,
						revisionDigestSha256: revisionId.replaceAll('-', '').padEnd(64, '0') }),
					formId: id, formName: form.name, versionNumber: form.version + 1,
					resultingStatus: 'open', surfaceSuccessorCount: 1 });
				pending.set(draftId, review);
				return { ok: true, review };
			},
			async publish(review: FormPublishReview) {
				const retained = pending.get(review.selector.draftId);
				if (!retained || retained.selector.revisionId !== review.selector.revisionId
					|| retained.selector.revisionDigestSha256 !== review.selector.revisionDigestSha256) {
					return { ok: false, reason: 'This Form review is no longer current. Review it again.' };
				}
				const outcome = await api.forms.setStatus(review.formId, 'open');
				if (outcome.ok) pending.delete(review.selector.draftId);
				return outcome;
			}
		}),
		fields: Object.freeze({
			move: api.fields.move,
			remove: api.fields.remove,
			restore: api.fields.restore,
			add: api.fields.add
		})
	});
}
