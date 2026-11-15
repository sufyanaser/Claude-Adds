import type { AccountInfo } from '../../shared/types';

/**
 * Parses `claude auth status --json`. Only the sign-in flag, method, email and
 * organization name are kept. Tokens are not part of this output and no other
 * field is read.
 */
export function parseAuthStatus(json: string): AccountInfo {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return { loggedIn: null };
  }
  if (typeof data?.loggedIn !== 'boolean') return { loggedIn: null };
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    loggedIn: data.loggedIn,
    method: text(data.authMethod),
    email: text(data.email),
    organization: text(data.orgName),
  };
}
