/**
 * Shared HTML-escaping helper for the monitoring dashboard.
 *
 * Exported as an ESM module so it can be unit-tested (tests/monitoring/esc.test.ts)
 * and imported by dashboard.js. EVERY dynamic value interpolated into innerHTML —
 * tool names, search queries, session labels, observations, file paths — must pass
 * through this, because those fields are derived from MCP tool arguments and are
 * therefore attacker-influenceable (SEC-02 / SEC-07).
 */
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
