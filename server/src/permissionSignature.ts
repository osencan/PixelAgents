/**
 * Proof that a permission decision really came from the Pixel Agents server
 * the hook asked: the hook sends a fresh nonce, the server signs
 * `nonce:decision` with its decision key (which the hook reads from the
 * local registry; it never crosses the network, unlike the bearer token), and
 * the hook prints a decision only when the signature matches.
 * Shared by the hook script and the server.
 */
import * as crypto from 'crypto';

/** Request header carrying the hook's nonce. */
export const PERMISSION_NONCE_HEADER = 'x-pixel-agents-nonce';

export function signDecision(token: string, nonce: string, decision: string): string {
  return crypto.createHmac('sha256', token).update(`${nonce}:${decision}`).digest('hex');
}

export function verifyDecision(
  token: string,
  nonce: string,
  decision: string,
  signature: unknown,
): boolean {
  if (typeof signature !== 'string') return false;
  const expected = Buffer.from(signDecision(token, nonce, decision), 'hex');
  const actual = Buffer.from(signature, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
