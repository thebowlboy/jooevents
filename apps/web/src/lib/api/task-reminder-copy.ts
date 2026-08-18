/**
 * What a task reminder actually says.
 *
 * This lane does not render a stored template: it mails one fixed plain-text
 * body, the same words to everyone, with only the subject supplied by the
 * operator. The string lives here so the sender and the send ceremony read the
 * one owner — a dialog that quoted its own copy could drift from the mail, and
 * a ceremony that promises different words than it sends is worse than one that
 * shows nothing.
 *
 * Changing this string changes what recipients receive. It is product copy, not
 * a placeholder.
 */
export const TASK_REMINDER_BODY =
	'You have one or more outstanding speaker tasks. Open your JooEvents speaker checklist to review and complete them.';
