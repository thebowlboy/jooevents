/**
 * The action-receipt bus: every consequential mutation records what it did in
 * words specific enough to act on, and declares its reversibility — either a
 * compensating `undo` or an explicit reason there is none. Undo affordances
 * read the bus so they can always name exactly what a press would revert.
 */

export interface ActionReceiptInput {
	/** Names the exact object acted on, e.g. `Removed “X” from Thu 10:30`. */
	label: string;
	area: string;
	/** Scoped address of where the result landed, when that is another surface. */
	href?: string;
	/** The door's short verb phrase, e.g. `Place them`; present exactly with `href`. */
	hrefLabel?: string;
	/** Compensating operation; present exactly when the action is undoable. */
	undo?: () => Promise<void>;
	/** Why this action cannot be undone; present exactly when `undo` is not. */
	notUndoableReason?: string;
}

export interface ActionReceipt extends ActionReceiptInput {
	id: number;
	at: number;
}

const CAP = 20;

let sequence = 0;
const receipts = $state<ActionReceipt[]>([]);

export function recordAction(input: ActionReceiptInput): ActionReceipt {
	const receipt: ActionReceipt = { id: (sequence += 1), at: Date.now(), ...input };
	receipts.unshift(receipt);
	if (receipts.length > CAP) receipts.length = CAP;
	return receipt;
}

/** Newest receipt, undoable or not — the receipt surface shows either honestly. */
export function latestReceipt(): ActionReceipt | undefined {
	return receipts[0];
}

/** Runs the receipt's compensator and retires it from the trail. */
export async function undoReceipt(receipt: ActionReceipt): Promise<void> {
	if (!receipt.undo) return;
	await receipt.undo();
	const index = receipts.findIndex((entry) => entry.id === receipt.id);
	if (index >= 0) receipts.splice(index, 1);
}
