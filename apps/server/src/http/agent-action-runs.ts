import type { AgentActionRunRepository } from '@jooevents/application';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

const commandSchema = z.strictObject({
	batchId: z.uuid(),
	expectedVersion: z.number().int().positive()
});
const approveSchema = commandSchema.extend({
	expectedPlanDigestSha256: z.string().regex(/^[a-f0-9]{64}$/)
});

export function createAgentActionRunsHttpAdapter(input: {
	readonly repository: AgentActionRunRepository;
	readonly authenticateEligibleHuman: (request: Request) => Promise<string | undefined>;
	readonly allowedOrigins: readonly string[];
	readonly now: () => string;
}) {
	const app = new Hono();
	const allowedOrigins = new Set(input.allowedOrigins);

	async function principal(request: Request): Promise<string | undefined> {
		const resolved = await input.authenticateEligibleHuman(request);
		return typeof resolved === 'string' && resolved.length > 0 ? resolved : undefined;
	}
	async function body(request: Request): Promise<unknown> {
		try { return await request.json(); } catch { return undefined; }
	}
	async function mutationPrincipal(request: Request): Promise<string | undefined> {
		const origin = request.headers.get('origin');
		return origin && allowedOrigins.has(origin) ? principal(request) : undefined;
	}
	function failure(context: Context, error: unknown) {
		const code = error instanceof Error ? error.message : 'agent_action_command_refused';
		return context.json({ message: code.includes('stale')
			? 'This action run changed. Review the current plan before trying again.'
			: 'This action-run request was refused.' }, 409);
	}

	app.get('/api/agent-actions', async (context) => {
		if (!await principal(context.req.raw)) return context.json({ message: 'Sign in with eligible organizer access to view action runs.' }, 401);
		return context.json(input.repository.list({ limit: 50 }));
	});

	app.get('/api/agent-actions/:batchId', async (context) => {
		if (!await principal(context.req.raw)) return context.json({ message: 'Sign in with eligible organizer access to view this action run.' }, 401);
		const view = input.repository.inspect(context.req.param('batchId'));
		return view ? context.json(view) : context.json({ message: 'Action run not found.' }, 404);
	});

	app.post('/api/agent-actions/:batchId/approve', async (context) => {
		const approvedByPrincipalId = await mutationPrincipal(context.req.raw);
		if (!approvedByPrincipalId) return context.json({ message: 'Only an eligible signed-in human can approve this plan.' }, 401);
		const parsed = approveSchema.safeParse(await body(context.req.raw));
		if (!parsed.success || parsed.data.batchId !== context.req.param('batchId')) return context.json({ message: 'The approval request was invalid.' }, 400);
		const current = input.repository.inspect(parsed.data.batchId);
		if (!current) return context.json({ message: 'Action run not found.' }, 404);
		const approvedAt = input.now();
		const approvalExpiresAt = new Date(Math.min(
			Date.parse(current.plan.bounds.expiresAt),
			Date.parse(approvedAt) + 15 * 60_000
		)).toISOString();
		try {
			return context.json(input.repository.approve({
				batchId: parsed.data.batchId,
				expectedVersion: parsed.data.expectedVersion,
				expectedPlanDigestSha256: parsed.data.expectedPlanDigestSha256,
				approval: {
					approvedByPrincipalId,
					planDigestSha256: parsed.data.expectedPlanDigestSha256,
					approvedAt,
					approvalExpiresAt,
					approvalPolicy: { key: 'agent-action.eligible-human', version: 1 },
					approvedBounds: current.plan.bounds
				}
			}));
		} catch (error) { return failure(context, error); }
	});

	for (const action of ['pause', 'resume', 'cancel'] as const) {
		app.post(`/api/agent-actions/:batchId/${action}`, async (context) => {
			if (!await mutationPrincipal(context.req.raw)) return context.json({ message: 'Only an eligible signed-in human can control this action run.' }, 401);
			const parsed = commandSchema.safeParse(await body(context.req.raw));
			if (!parsed.success || parsed.data.batchId !== context.req.param('batchId')) return context.json({ message: 'The action-run request was invalid.' }, 400);
			try {
				const at = input.now();
				return context.json(action === 'pause'
					? input.repository.requestPause({ ...parsed.data, at })
					: action === 'resume'
						? input.repository.resume({ ...parsed.data, at })
						: input.repository.requestCancel({ ...parsed.data, at }));
			} catch (error) { return failure(context, error); }
		});
	}
	return app;
}
