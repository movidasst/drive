const ALLOWED_ORIGINS = new Set(['https://drive.movidasst.com', 'https://movidasst.github.io']);
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const ROOT = '1wnDWCTeL8fMGmo7_hOim6rT1d_omAbcq';

export async function sha256(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
}

export async function crawlCatalog(config, fetcher = fetch, deadline = Date.now() + 45000) {
  const seen = new Set();
  const items = new Map();
  const folders = [{ id: config.root, name: 'Inicio', parentId: null }];
  let pending = [{ id: config.root, name: 'Inicio' }];
  const folderIds = new Set([config.root]);
  while (pending.length) {
    const batch = pending.splice(0, 6).filter(folder => !seen.has(folder.id));
    for (const folder of batch) seen.add(folder.id);
    await Promise.all(batch.map(async folder => {
      let pageToken = '';
      const pageTokens = new Set();
      do {
        if (Date.now() > deadline) throw new Error('Catalog refresh timed out');
        const params = new URLSearchParams({ key: config.key, q: `'${folder.id}' in parents and trashed = false`, pageSize: '1000', fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,webViewLink,modifiedTime,thumbnailLink,size,resourceKey,shortcutDetails)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
        if (pageToken) params.set('pageToken', pageToken);
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
          response = await fetcher(`https://www.googleapis.com/drive/v3/files?${params}`, { headers: { Referer: 'https://drive.movidasst.com/' }, signal: AbortSignal.timeout(Math.max(1, Math.min(12000, deadline - Date.now()))) });
          if (response.ok || ![429, 500, 502, 503, 504].includes(response.status)) break;
          await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
        }
        if (!response?.ok) throw new Error('Drive listing failed');
        const data = await response.json();
        if (!Array.isArray(data.files) || data.incompleteSearch) throw new Error('Incomplete Drive listing');
        for (const file of data.files) {
          if (!/^[\w-]+$/.test(file.id) || typeof file.name !== 'string') throw new Error('Invalid Drive metadata');
          // Catalog only descendants of ROOT; shortcuts are links, never traversed outside it.
          items.set(file.id, { ...file, parentId: folder.id });
          if (file.mimeType === FOLDER_MIME && !folderIds.has(file.id)) {
            folderIds.add(file.id);
            folders.push({ id: file.id, name: file.name, parentId: folder.id });
            pending.push({ id: file.id, name: file.name });
          }
        }
        pageToken = data.nextPageToken || '';
        if (pageToken && pageTokens.has(pageToken)) throw new Error('Repeated page token');
        pageTokens.add(pageToken);
      } while (pageToken);
    }));
  }
  return { root: config.root, items: [...items.values()], folders };
}

export function createHandler({ rpc, waitUntil = null, fetcher = fetch, now = () => Date.now() }) {
  async function refresh(owner) {
    try {
      const config = await rpc('drive_catalog_api_v2', { p_action: 'config' });
      if (config.root !== ROOT || !config.key) throw new Error('Missing server configuration');
      const catalog = await crawlCatalog(config, fetcher);
      await rpc('drive_catalog_api_v2', { p_action: 'commit', p_payload: { owner, catalog } });
    } catch {
      await rpc('drive_catalog_api_v2', { p_action: 'fail', p_payload: { owner } });
    }
  }
  return async function handler(req) {
    const origin = req.headers.get('origin');
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin', 'Access-Control-Allow-Headers': 'content-type, authorization, apikey', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    if (origin && ALLOWED_ORIGINS.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
    const reply = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), { status, headers: { ...headers, ...extra } });
    if (origin && !ALLOWED_ORIGINS.has(origin)) return reply({ message: 'Origen no autorizado.' }, 403);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return reply({ message: 'Método no permitido.' }, 405);
    try {
      if (Number(req.headers.get('content-length') || 0) > 4096) return reply({ message: 'Solicitud demasiado grande.' }, 413);
      const raw = await req.text();
      if (raw.length > 4096) return reply({ message: 'Solicitud demasiado grande.' }, 413);
      let body;
      try { body = JSON.parse(raw); } catch { return reply({ message: 'Solicitud inválida.' }, 400); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return reply({ message: 'Solicitud inválida.' }, 400);
      const action = body.action;
      if (action === 'login') {
        const identity = String(body.cedula || '').replace(/\D/g, '');
        const code = String(body.codigo || '').trim().toUpperCase();
        if (!/^\d{6,12}$/.test(identity) || code.length < 4 || code.length > 80) return reply({ message: 'Revisa tu cédula y código.' }, 400);
        const token = [...crypto.getRandomValues(new Uint8Array(32))].map(n => n.toString(16).padStart(2, '0')).join('');
        const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('cf-connecting-ip') || 'unknown';
        const result = await rpc('drive_login_v2', { p_identity: identity, p_code: code, p_ip_hash: await sha256(ip), p_token_hash: await sha256(token) });
        if (!result?.ok) {
          if (result?.status === 429) return reply({ message: 'Demasiados intentos. Inténtalo nuevamente en unos minutos.', retryAfter: result.retryAfter }, 429, { 'Retry-After': String(result.retryAfter) });
          return reply({ message: 'Cédula o código incorrectos, o acceso no autorizado.' }, 401);
        }
        return reply({ token, name: result.name, expiresAt: result.expiresAt });
      }
      if (!['session', 'renew', 'logout', 'catalog'].includes(action)) return reply({ message: 'Acción no válida.' }, 400);
      const token = req.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      if (!token) return reply({ message: 'Inicia sesión para consultar la biblioteca.' }, 401);
      const session = await rpc('drive_session_v2', { p_token_hash: await sha256(token), p_action: action === 'renew' || action === 'logout' ? action : 'validate' });
      if (!session?.ok) return reply({ message: 'Tu sesión finalizó. Ingresa nuevamente.' }, 401);
      if (action !== 'catalog') return reply(session);
      let data = await rpc('drive_catalog_api_v2', { p_action: 'read' });
      const stale = !data.updatedAt || now() - Date.parse(data.updatedAt) > 3600000;
      let refreshing = Boolean(data.refreshing);
      if (stale || body.refresh === true) {
        const owner = crypto.randomUUID();
        const claim = await rpc('drive_catalog_api_v2', { p_action: 'claim', p_payload: { owner } });
        if (claim.claimed) {
          refreshing = true;
          const job = refresh(owner);
          if (waitUntil && data.updatedAt) waitUntil(job);
          else { await job; data = await rpc('drive_catalog_api_v2', { p_action: 'read' }); refreshing = Boolean(data.refreshing); }
        }
      }
      if (!data.updatedAt) return reply({ message: 'La biblioteca se está preparando. Inténtalo nuevamente en unos momentos.' }, 503);
      return reply({ ...data.catalog, updatedAt: data.updatedAt, refreshing, stale, notice: data.lastError || null, expiresAt: session.expiresAt });
    } catch {
      // Never log credentials, tokens, keys, upstream URLs, or database errors.
      console.error('drive-api: request failed');
      return reply({ message: 'No fue posible completar la solicitud. Inténtalo nuevamente.' }, 503);
    }
  };
}

if (typeof Deno !== 'undefined') {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const rpc = async (name, args) => {
    if (!url || !serviceKey) throw new Error('Missing runtime configuration');
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }, body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error('Database request failed');
    return response.json();
  };
  Deno.serve(createHandler({ rpc, waitUntil: typeof EdgeRuntime !== 'undefined' ? promise => EdgeRuntime.waitUntil(promise) : null }));
}
