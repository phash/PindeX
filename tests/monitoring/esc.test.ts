import { describe, it, expect } from 'vitest';
import { escHtml } from '../../src/monitoring/ui/esc.js';

describe('escHtml (SEC-02 / SEC-07)', () => {
  it('coerces null and undefined to an empty string', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });

  it('entity-encodes the five dangerous characters', () => {
    expect(escHtml('&')).toBe('&amp;');
    expect(escHtml('<')).toBe('&lt;');
    expect(escHtml('>')).toBe('&gt;');
    expect(escHtml('"')).toBe('&quot;');
    expect(escHtml("'")).toBe('&#39;');
  });

  it('leaves benign text untouched', () => {
    expect(escHtml('search_symbols')).toBe('search_symbols');
    expect(escHtml('src/index.ts')).toBe('src/index.ts');
  });

  it('coerces non-string values to their string form first', () => {
    expect(escHtml(42 as unknown as string)).toBe('42');
  });

  it('neutralizes an img-onerror XSS payload', () => {
    const out = escHtml('<img src=x onerror=alert(1)>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toContain('&lt;img');
    expect(out).toContain('&gt;');
  });

  it('encodes attribute-breaking quotes so they cannot escape an attribute', () => {
    const out = escHtml('" onmouseover="alert(1)');
    expect(out).not.toContain('"');
    expect(out).toContain('&quot;');
  });

  it('regression: a stored-XSS session label <script> tag becomes inert', () => {
    const out = escHtml('<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
