export const MASK = '•••';

const SECRET_NAME = /(key|token|secret|passw|auth|bearer|credential|cookie|session)/i;
const SECRET_PREFIX = /^(sk-|pk-|rk-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[abprs]-|eyJ|AKIA|AIza)[\w\-.]+$/;
const LONG_OPAQUE = /^[A-Za-z0-9_\-+/=]{32,}$/;

export function looksSecret(value: string): boolean {
  return SECRET_PREFIX.test(value) || LONG_OPAQUE.test(value);
}

/** Keeps scheme, host and path. Drops credentials, query string and fragment. */
export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return MASK;
  }
  const path = url.pathname
    .split('/')
    .map((segment) => (looksSecret(segment) ? MASK : segment))
    .join('/');
  return `${url.protocol}//${url.host}${path === '/' ? '' : path}`;
}

/** Masks anything in a command line that could be a credential. */
export function redactCommand(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let maskNext = false;
  for (const token of tokens) {
    if (maskNext) {
      out.push(MASK);
      // "Authorization: Bearer <value>": the scheme word is followed by the secret itself.
      maskNext = /^(bearer|basic)$/i.test(token);
      continue;
    }
    if (/^https?:\/\//i.test(token)) {
      out.push(redactUrl(token));
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 0) {
      const name = token.slice(0, eq);
      const value = token.slice(eq + 1);
      out.push(SECRET_NAME.test(name) || looksSecret(value) ? `${name}=${MASK}` : token);
      continue;
    }
    if (looksSecret(token)) {
      out.push(MASK);
      continue;
    }
    out.push(token);
    if ((token.startsWith('-') || token.endsWith(':')) && SECRET_NAME.test(token)) maskNext = true;
    if (/^(bearer|basic)$/i.test(token)) maskNext = true;
  }
  return out.join(' ');
}
