import test from 'node:test';
import assert from 'node:assert/strict';
import { createHandler, crawlCatalog, sha256 } from '../supabase/functions/drive-api/index.js';

const root = '1wnDWCTeL8fMGmo7_hOim6rT1d_omAbcq';
const token = 'a'.repeat(64);
const request = (body, auth = null, origin = 'https://drive.movidasst.com') => new Request('https://example.test', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify(body) });

test('catalog refuses absent or forged sessions before accessing metadata', async () => {
  const calls = [];
  const handler = createHandler({ rpc: async (name) => { calls.push(name); return { ok: false, status: 401 }; } });
  assert.equal((await handler(request({ action: 'catalog' }))).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await handler(request({ action: 'catalog' }, token))).status, 401);
  assert.deepEqual(calls, ['drive_session_v2']);
});

test('login only returns an opaque token and stores its hash', async () => {
  let args;
  const handler = createHandler({ rpc: async (name, input) => { assert.equal(name, 'drive_login_v2'); args = input; return { ok: true, name: 'Prueba', expiresAt: 9999999999999 }; } });
  const response = await handler(request({ action: 'login', cedula: '12345678', codigo: 'ABCD' }));
  const body = await response.json();
  assert.match(body.token, /^[a-f0-9]{64}$/);
  assert.equal(args.p_token_hash, await sha256(body.token));
  assert.notEqual(args.p_token_hash, body.token);
  assert.equal(body.cedula, undefined);
  assert.equal(body.codigo, undefined);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('persistent rate limit is surfaced as HTTP 429 with retry delay', async () => {
  const handler = createHandler({ rpc: async () => ({ ok: false, status: 429, retryAfter: 120 }) });
  const response = await handler(request({ action: 'login', cedula: '12345678', codigo: 'ABCD' }));
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '120');
});

test('foreign origins and oversized or malformed requests are rejected', async () => {
  const handler = createHandler({ rpc: async () => { throw new Error('Must not access database'); } });
  assert.equal((await handler(request({ action: 'catalog' }, token, 'https://evil.test'))).status, 403);
  assert.equal((await handler(request({ action: 'login', codigo: 'x'.repeat(5000) }))).status, 413);
  assert.equal((await handler(new Request('https://example.test', { method: 'POST', body: '{' }))).status, 400);
});

test('catalog traverses nested folders and all pages, excluding external shortcuts', async () => {
  const calls = [];
  const fetcher = async (url) => {
    const parsed = new URL(url); const q = parsed.searchParams.get('q'); const page = parsed.searchParams.get('pageToken'); calls.push([q, page]);
    if (q.includes(root) && !page) return Response.json({ files: [{ id: 'nested', name: 'Carpeta', mimeType: 'application/vnd.google-apps.folder' }], nextPageToken: 'second' });
    if (page) return Response.json({ files: [{ id: 'file1', name: 'Inicio.pdf', mimeType: 'application/pdf' }, { id: 'shortcut', name: 'Enlace', mimeType: 'application/vnd.google-apps.shortcut', shortcutDetails: { targetId: 'outside' } }] });
    if (q.includes('nested')) return Response.json({ files: [], nextPageToken: 'third' });
    throw new Error('Unexpected query');
  };
  // Empty Drive pages with a continuation token are valid.
  const nestedFetch = async url => {
    if (new URL(url).searchParams.get('pageToken') === 'third') return Response.json({ files: [{ id: 'file2', name: 'Interno.pdf', mimeType: 'application/pdf' }] });
    return fetcher(url);
  };
  const data = await crawlCatalog({ root, key: 'test' }, nestedFetch);
  assert.equal(data.folders.length, 2);
  assert.equal(data.items.filter(file => file.mimeType !== 'application/vnd.google-apps.folder').length, 3);
  assert.equal(data.items.find(file => file.id === 'file2').parentId, 'nested');
  assert.equal(data.items.some(file => file.id === 'outside'), false);
});

test('incomplete listing never replaces a complete catalog', async () => {
  const calls = [];
  const rpc = async (name, input) => {
    calls.push(input?.p_action || name);
    if (name === 'drive_session_v2') return { ok: true, expiresAt: 9999999999999 };
    if (input.p_action === 'read') return { catalog: { items: [{ id: 'kept' }], folders: [] }, updatedAt: '2020-01-01T00:00:00Z' };
    if (input.p_action === 'claim') return { claimed: true };
    if (input.p_action === 'config') return { root, key: 'test' };
    return { ok: true };
  };
  const handler = createHandler({ rpc, fetcher: async () => Response.json({ files: [], incompleteSearch: true }) });
  const response = await handler(request({ action: 'catalog' }, token));
  assert.equal((await response.json()).items[0].id, 'kept');
  assert.equal(calls.includes('commit'), false);
  assert.equal(calls.includes('fail'), true);
});

test('renew and logout are validated server-side and never read catalog', async () => {
  const calls = [];
  const handler = createHandler({ rpc: async (name, input) => { calls.push([name, input.p_action]); return { ok: true }; } });
  assert.equal((await handler(request({ action: 'renew' }, token))).status, 200);
  assert.equal((await handler(request({ action: 'logout' }, token))).status, 200);
  assert.deepEqual(calls, [['drive_session_v2', 'renew'], ['drive_session_v2', 'logout']]);
});
