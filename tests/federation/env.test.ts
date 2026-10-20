import { describe, it, expect } from 'vitest';
import path from 'node:path';
import {
  parseFederationRepos,
  formatFederationRepos,
  resolveFederatedName,
} from '../../src/federation/env.js';

describe('parseFederationRepos / formatFederationRepos', () => {
  it('round-trips Windows drive paths with the win32 delimiter', () => {
    const d = path.win32.delimiter;
    const value = formatFederationRepos(['E:\\a', 'E:\\b'], d);
    expect(value).toBe('E:\\a;E:\\b');
    expect(parseFederationRepos(value, d)).toEqual(['E:\\a', 'E:\\b']);
  });

  it('round-trips posix paths with the posix delimiter', () => {
    const d = path.posix.delimiter;
    expect(parseFederationRepos(formatFederationRepos(['/a', '/b'], d), d)).toEqual(['/a', '/b']);
  });

  it('still parses a legacy colon-separated posix value by default on posix', () => {
    expect(parseFederationRepos('/a:/b', ':')).toEqual(['/a', '/b']);
  });

  it('parses a JSON array string', () => {
    expect(parseFederationRepos('["/a","/b"]')).toEqual(['/a', '/b']);
    expect(parseFederationRepos('["E:\\\\a"]', ';')).toEqual(['E:\\a']);
  });

  it('returns [] for empty, undefined-like or malformed JSON input', () => {
    expect(parseFederationRepos('')).toEqual([]);
    expect(parseFederationRepos('[not json')).toEqual([]);
  });

  it('round-trips a posix path containing a comma (legacy separator)', () => {
    const value = formatFederationRepos(['/a,b', '/c'], ':');
    expect(value.startsWith('[')).toBe(true);
    expect(parseFederationRepos(value, ':')).toEqual(['/a,b', '/c']);
  });

  it('formats as JSON array when a path contains the delimiter', () => {
    const value = formatFederationRepos(['/a:b', '/c'], ':');
    expect(value.startsWith('[')).toBe(true);
    expect(parseFederationRepos(value, ':')).toEqual(['/a:b', '/c']);
  });
});

describe('resolveFederatedName', () => {
  const entries = [
    { path: '/p', name: 'proj', federatedRepos: [{ path: '/t', name: 'my-alias' }] },
    { path: '/t', name: 'target', federatedRepos: [] },
  ];

  it('prefers the alias stored in the primary project federatedRepos', () => {
    expect(resolveFederatedName('/t', entries[0]!, entries, new Set(['proj']))).toBe('my-alias');
  });

  it('falls back to the target registry name, then to an auto-generated one', () => {
    expect(resolveFederatedName('/t', undefined, entries, new Set())).toBe('target');
    expect(resolveFederatedName('/x/unknown', undefined, entries, new Set())).toBe('unknown');
  });
});
