/**
 * Loopback / origin helpers shared by the monitoring and GUI dashboards.
 *
 * The dashboards expose project paths, symbol names and session data. They bind
 * to 127.0.0.1 by default, but loopback binding alone does not stop a malicious
 * web page in the developer's browser from reaching them (DNS rebinding for HTTP,
 * Cross-Site WebSocket Hijacking for WS, CSRF for side-effecting routes). These
 * helpers implement a loopback-only Host/Origin policy that closes those gaps
 * while still allowing an explicit non-loopback opt-in via PINDEX_BIND_HOST.
 */

/** True if the hostname (no port, brackets stripped) is the loopback interface. */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}

/** Extracts the hostname from a Host/authority header, dropping any port.
 *  Handles bracketed IPv6 literals such as `[::1]:7843`. */
export function hostnameFromHeader(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const bracketed = /^\[([^\]]+)\]/.exec(hostHeader);
  if (bracketed) return bracketed[1];
  return hostHeader.replace(/:\d+$/, '');
}

/** True when the dashboards should enforce a loopback-only Host/Origin policy.
 *  Enforcement is on by default and only disabled when the operator explicitly
 *  binds to a non-loopback interface via PINDEX_BIND_HOST (accepting the risk). */
export function loopbackEnforced(): boolean {
  return isLoopbackHostname(process.env.PINDEX_BIND_HOST ?? '127.0.0.1');
}

/** True if a request with the given Host header is permitted under the policy. */
export function isAllowedHost(hostHeader: string | undefined): boolean {
  if (!loopbackEnforced()) return true;
  return isLoopbackHostname(hostnameFromHeader(hostHeader));
}

/** True if an Origin is acceptable: a loopback origin, or no Origin at all
 *  (non-browser clients such as the CLI / curl never send one). */
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    return isLoopbackHostname(new URL(origin).hostname);
  } catch {
    return false;
  }
}
