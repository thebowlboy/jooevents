/* Local shape check only: it decides whether asking the server is worth a round
   trip, never whether an address exists. The server remains the authority. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

export function isEmailShaped(candidate: string): boolean {
  const value = candidate.trim();
  return value.length <= 254 && EMAIL_SHAPE.test(value);
}
