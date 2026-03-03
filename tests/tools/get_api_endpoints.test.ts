import { describe, it, expect, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import { createTestDb } from '../helpers/db.js';
import { insertTestFile, insertTestSymbol } from '../helpers/fixtures.js';
import { getApiEndpoints } from '../../src/tools/get_api_endpoints.js';

describe('getApiEndpoints', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  it('returns empty endpoints array when no routes exist', () => {
    const result = getApiEndpoints(db);
    expect(result.endpoints).toEqual([]);
  });

  it('parses "GET /users" into method and path', () => {
    const fileId = insertTestFile(db, { path: 'src/routes/users.ts' });
    insertTestSymbol(db, {
      fileId,
      name: 'GET /users',
      kind: 'route',
      signature: 'app.get("/users", handler)',
      startLine: 10,
    });

    const result = getApiEndpoints(db);
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toEqual({
      method: 'GET',
      path: '/users',
      handler: 'GET /users',
      file: 'src/routes/users.ts',
      line: 10,
    });
  });

  it('parses "POST /api/data" into method and path', () => {
    const fileId = insertTestFile(db, { path: 'src/routes/api.ts' });
    insertTestSymbol(db, {
      fileId,
      name: 'POST /api/data',
      kind: 'route',
      signature: 'app.post("/api/data", handler)',
      startLine: 25,
    });

    const result = getApiEndpoints(db);
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toEqual({
      method: 'POST',
      path: '/api/data',
      handler: 'POST /api/data',
      file: 'src/routes/api.ts',
      line: 25,
    });
  });

  it('handles malformed name (no space) — method is full name, path is signature', () => {
    const fileId = insertTestFile(db, { path: 'src/routes/misc.ts' });
    insertTestSymbol(db, {
      fileId,
      name: 'healthcheck',
      kind: 'route',
      signature: '/health',
      startLine: 5,
    });

    const result = getApiEndpoints(db);
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]).toEqual({
      method: 'healthcheck',
      path: '/health',
      handler: 'healthcheck',
      file: 'src/routes/misc.ts',
      line: 5,
    });
  });

  it('returns multiple routes sorted by file path and start line', () => {
    const fileA = insertTestFile(db, { path: 'src/routes/a.ts', hash: 'aaa' });
    const fileB = insertTestFile(db, { path: 'src/routes/b.ts', hash: 'bbb' });

    // Insert in non-sorted order to verify the ORDER BY clause
    insertTestSymbol(db, {
      fileId: fileB,
      name: 'DELETE /items',
      kind: 'route',
      signature: 'app.delete("/items", handler)',
      startLine: 30,
    });
    insertTestSymbol(db, {
      fileId: fileA,
      name: 'GET /users',
      kind: 'route',
      signature: 'app.get("/users", handler)',
      startLine: 20,
    });
    insertTestSymbol(db, {
      fileId: fileA,
      name: 'POST /users',
      kind: 'route',
      signature: 'app.post("/users", handler)',
      startLine: 10,
    });

    const result = getApiEndpoints(db);
    expect(result.endpoints).toHaveLength(3);

    // Sorted by file path, then start_line
    expect(result.endpoints[0].handler).toBe('POST /users');
    expect(result.endpoints[0].file).toBe('src/routes/a.ts');
    expect(result.endpoints[0].line).toBe(10);

    expect(result.endpoints[1].handler).toBe('GET /users');
    expect(result.endpoints[1].file).toBe('src/routes/a.ts');
    expect(result.endpoints[1].line).toBe(20);

    expect(result.endpoints[2].handler).toBe('DELETE /items');
    expect(result.endpoints[2].file).toBe('src/routes/b.ts');
    expect(result.endpoints[2].line).toBe(30);
  });

  it('ignores non-route symbols', () => {
    const fileId = insertTestFile(db, { path: 'src/utils.ts' });
    insertTestSymbol(db, {
      fileId,
      name: 'helper',
      kind: 'function',
      signature: 'helper(): void',
      startLine: 1,
    });
    insertTestSymbol(db, {
      fileId,
      name: 'GET /api',
      kind: 'route',
      signature: 'app.get("/api", handler)',
      startLine: 10,
    });

    const result = getApiEndpoints(db);
    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0].method).toBe('GET');
  });
});
