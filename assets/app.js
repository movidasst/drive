
    'use strict';

    const CONFIG = Object.freeze({
      ROOT_FOLDER: '1wnDWCTeL8fMGmo7_hOim6rT1d_omAbcq',
      SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_bRnkA6PA8-v073nrw9zxiQ_8rVGiOn1',
      API_URL: 'https://lfdmbkzghnwvsapxypvt.supabase.co/functions/v1/drive-api',
      SESSION_KEY: 'movida_drive_session_v2',
      VIEW_KEY: 'movida_drive_view_v2',
      SORT_KEY: 'movida_drive_sort_v1',
      NAMES_KEY: 'movida_drive_full_names_v1',
      SESSION_WARNING: 5 * 60 * 1000
    });

    const state = {
      files: [],
      catalog: [], folderMap: new Map(), catalogMeta: null, catalogGeneration: 0, catalogPoll: null, pollCount: 0, visibleLimit: 60, previewGeneration: 0, previewReturnFocus: null,
      stack: [{ id: CONFIG.ROOT_FOLDER, name: 'Inicio' }],
      currentFolderId: CONFIG.ROOT_FOLDER,
      view: safeGet(localStorage, CONFIG.VIEW_KEY) === 'list' ? 'list' : 'grid',
      sort: safeGet(localStorage, CONFIG.SORT_KEY) || 'name-asc',
      filter: 'all',
      collection: 'browse', favorites: new Set(), favoritesKey: null, folderStats: new Map(), fullNames: safeGet(localStorage, CONFIG.NAMES_KEY) === 'true',
      driveReady: false,
      sessionTimer: null,
      toastTimer: null,
      warningDismissed: false,
      activeFile: null
    };

    const $ = (id) => document.getElementById(id);
    function safeGet(storage, key) { try { return storage.getItem(key); } catch { return null; } }
    function safeSet(storage, key, value) { try { storage.setItem(key, value); return true; } catch { return false; } }
    function safeRemove(storage, key) { try { storage.removeItem(key); } catch {} }
    async function api(action, payload = {}, token = readSession()?.token) {
      const response = await fetch(CONFIG.API_URL, {
        method: 'POST', headers: { 'Content-Type': 'application/json', apikey: CONFIG.SUPABASE_PUBLISHABLE_KEY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ action, ...payload }), signal: AbortSignal.timeout(55000)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (response.status === 401 && action !== 'login') logout(data.message, false);
        const error = new Error(data.message || 'No fue posible completar la solicitud.');
        error.status = response.status; error.retryAfter = data.retryAfter; throw error;
      }
      return data;
    }
    const normalizeSearch = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('es');
    function pathForFolder(id) {
      const output = []; const seen = new Set();
      while (id && !seen.has(id)) { seen.add(id); const folder = state.folderMap.get(id); if (!folder) break; output.unshift({ id: folder.id, name: folder.name }); id = folder.parentId; }
      return output.length ? output : [{ id: CONFIG.ROOT_FOLDER, name: 'Inicio' }];
    }
    function originPath(file) { return pathForFolder(file.parentId).map(folder => folder.name).join(' / '); }
    function isGlobalSearch() { return Boolean($('search-input').value.trim()) && $('search-scope').value === 'all'; }
    function updateCatalogStatus(data = state.catalogMeta) {
      if (!data?.updatedAt) return;
      const date = new Intl.DateTimeFormat('es-VE', { dateStyle: 'short' }).format(new Date(data.updatedAt));
      $('catalog-status').textContent = `Actualizado: ${date}${data.refreshing ? ' · Actualizando…' : data.notice ? ' · Se conserva la última versión.' : ''}`;
      $('refresh-catalog').disabled = Boolean(data.refreshing);
    }
    async function refreshCatalog(manual = false) {
      const token = readSession()?.token; if (!token) return;
      const generation = ++state.catalogGeneration;
      $('refresh-catalog').disabled = true;
      try {
        const data = await api('catalog', { refresh: manual }, token);
        if (generation !== state.catalogGeneration || readSession()?.token !== token) return;
        state.catalog = data.items || []; state.folderMap = new Map((data.folders || []).map(folder => [folder.id, folder])); state.catalogMeta = data; rebuildFolderStats();
        updateCatalogStatus();
        const id = state.folderMap.has(state.currentFolderId) ? state.currentFolderId : CONFIG.ROOT_FOLDER;
        await loadFolder(id, { preserveSearch: true });
        clearTimeout(state.catalogPoll);
        if (data.refreshing && state.pollCount++ < 20) state.catalogPoll = setTimeout(() => refreshCatalog(), 3000);
        else {
          state.pollCount = 0;
          state.catalogPoll = setTimeout(() => refreshCatalog(), data.notice ? 300000 : Math.max(60000, 3600000 - (Date.now() - Date.parse(data.updatedAt))));
        }
        if (manual && !data.refreshing) showToast('Catálogo disponible. Las actualizaciones se comprueban cada cinco minutos como máximo.');
      } catch (error) {
        if (error.status !== 401) {
          if (!state.catalog.length) showError('No pudimos cargar la biblioteca. Inténtalo nuevamente.'); else showToast(error.message);
          if (readSession()?.token === token) { clearTimeout(state.catalogPoll); state.catalogPoll = setTimeout(() => refreshCatalog(), 300000); }
        }
      } finally { $('refresh-catalog').disabled = Boolean(state.catalogMeta?.refreshing); }
    }

    const normalizeCedula = (value) => String(value || '').replace(/\D/g, '');
    const normalizeCode = (value) => String(value || '').trim().toUpperCase();
    const isFolder = (file) => file.mimeType === 'application/vnd.google-apps.folder';
    const isImage = (file) => String(file.mimeType || '').startsWith('image/');
    const isPdf = (file) => file.mimeType === 'application/pdf';

    function showLoginMessage(message, type = 'error') {
      const box = $('login-message');
      box.className = 'mt-5 rounded-2xl border px-4 py-3 text-sm font-bold';
      if (type === 'success') {
        box.classList.add('border-emerald-200', 'bg-emerald-50', 'text-emerald-700');
      } else {
        box.classList.add('border-red-200', 'bg-red-50', 'text-red-700');
      }
      box.textContent = message;
      box.classList.remove('hidden');
    }

    function clearLoginMessage() {
      $('login-message').classList.add('hidden');
      $('login-message').textContent = '';
    }

    function setLoginLoading(loading) {
      $('login-button').disabled = loading;
      $('login-button-text').textContent = loading ? 'Verificando acceso...' : 'Ingresar a la biblioteca';
      $('login-icon').classList.toggle('animate-spin', loading);
    }

    function readSession() {
      try {
        const raw = safeGet(sessionStorage, CONFIG.SESSION_KEY); if (!raw) return null;
        const session = JSON.parse(raw);
        if (!/^[a-f0-9]{64}$/.test(session?.token || '') || !Number.isFinite(session.expiresAt) || Date.now() >= session.expiresAt) { safeRemove(sessionStorage, CONFIG.SESSION_KEY); return null; }
        return session;
      } catch { safeRemove(sessionStorage, CONFIG.SESSION_KEY); return null; }
    }

    function saveSession(data) {
      const session = { token: data.token, name: data.name || 'Integrante', expiresAt: data.expiresAt, favoritesScope: data.favoritesScope || null };
      if (!safeSet(sessionStorage, CONFIG.SESSION_KEY, JSON.stringify(session))) throw new Error('Permite el almacenamiento de sesión en tu navegador para ingresar.');
      return session;
    }

    function formatRemaining(milliseconds) {
      const minutesTotal = Math.max(0, Math.ceil(milliseconds / 60000));
      const hours = Math.floor(minutesTotal / 60);
      const minutes = minutesTotal % 60;
      return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
    }

    function setUserIdentity(session) {
      const name = session.name || 'Integrante';
      $('header-user-name').textContent = name;
      $('menu-user-name').textContent = name;
      $('profile-initial').textContent = name.trim().charAt(0).toUpperCase() || 'M';
    }

    function scheduleSession(session) {
      clearInterval(state.sessionTimer); state.warningDismissed = false;
      let lastValidation = Date.now();
      const update = () => {
        const current = readSession();
        if (!current || current.token !== session.token) { logout('Tu sesión finalizó.', false); return; }
        const remaining = current.expiresAt - Date.now();
        const label = formatRemaining(remaining); $('menu-session-time').textContent = label; $('warning-session-time').textContent = label;
        if (remaining <= CONFIG.SESSION_WARNING && !state.warningDismissed) $('session-warning').classList.remove('hidden');
        if (navigator.onLine && Date.now() - lastValidation >= 60000) {
          lastValidation = Date.now();
          api('session').catch(() => {});
        }
      };
      update(); state.sessionTimer = setInterval(update, 15000);
    }

    function openApp(session) {
      $('auth-screen').classList.add('hidden'); $('app-shell').classList.remove('hidden');
      setUserIdentity(session); loadFavorites(session); scheduleSession(session); updateViewControls(); $('sort-select').value = state.sort;
      initDrive();
    }

    function logout(message = '', revoke = true) {
      const token = readSession()?.token;
      safeRemove(sessionStorage, CONFIG.SESSION_KEY); clearInterval(state.sessionTimer); clearTimeout(state.catalogPoll); state.catalogGeneration++;
      if (revoke && token) api('logout', {}, token).catch(() => {});
      closePreview(); closeProfileMenu(); closeFileMenu(); $('session-warning').classList.add('hidden'); $('app-shell').classList.add('hidden'); $('auth-screen').classList.remove('hidden');
      $('login-code').value = ''; state.stack = [{ id: CONFIG.ROOT_FOLDER, name: 'Inicio' }]; state.currentFolderId = CONFIG.ROOT_FOLDER; state.files = []; state.catalog = []; state.folderMap.clear(); state.catalogMeta = null; state.driveReady = false; state.favorites.clear(); state.favoritesKey = null; state.collection = 'browse'; state.folderStats.clear();
      $('folder-container').replaceChildren(); $('file-container').replaceChildren(); $('home-file-count').textContent = '—'; $('home-folder-count').textContent = '—';
      if (message) showLoginMessage(message); else clearLoginMessage();
      setTimeout(() => $('login-cedula').focus(), 50);
    }

    async function handleLogin(event) {
      event.preventDefault(); clearLoginMessage();
      if ($('login-button').disabled) return;
      const cedula = normalizeCedula($('login-cedula').value); const codigo = normalizeCode($('login-code').value); $('login-cedula').value = cedula;
      if (!/^\d{6,12}$/.test(cedula) || codigo.length < 4 || codigo.length > 80) { showLoginMessage('Revisa tu cédula y código de integrante.'); return; }
      setLoginLoading(true);
      try { const data = await api('login', { cedula, codigo }, null); const session = saveSession(data); $('login-code').value = ''; openApp(session); }
      catch (error) { showLoginMessage(error.message || 'No fue posible validar el acceso.'); }
      finally { setLoginLoading(false); }
    }

    async function initDrive() {
      if (!readSession()) { logout('Tu sesión finalizó.', false); return; }
      showLoading(); state.driveReady = true;
      const target = new URLSearchParams(location.hash.slice(1)).get('folder');
      state.currentFolderId = target || CONFIG.ROOT_FOLDER;
      await refreshCatalog(); replaceHistoryState();
    }





    async function loadFolder(folderId, options = {}) {
      if (!readSession()) return;
      if (!state.folderMap.has(folderId)) folderId = CONFIG.ROOT_FOLDER;
      state.currentFolderId = folderId; state.stack = pathForFolder(folderId); state.files = state.catalog.filter(file => file.parentId === folderId);
      if (!options.preserveSearch) { state.filter = 'all'; state.collection = 'browse'; $('search-input').value = ''; $('clear-search').classList.add('hidden'); state.visibleLimit = 60; }
      updateFilterChips(); renderContent();
      if (options.updateHistory) pushHistoryState(); else replaceHistoryState();
    }

    function navigateToFolder(id, name) {
      closeFileMenu(); loadFolder(id, { updateHistory: true }); window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function navigateToStackIndex(index, updateHistory = true) {
      const folder = state.stack[index]; if (folder) loadFolder(folder.id, { updateHistory }); window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    function goBackFolder() {
      if (state.stack.length > 1) navigateToStackIndex(state.stack.length - 2);
    }

    function historyPayload() {
      return {
        movidaDrive: true,
        stack: state.stack.map((item) => ({ id: item.id, name: item.name }))
      };
    }

    function replaceHistoryState() {
      history.replaceState(historyPayload(), '', `#folder=${encodeURIComponent(state.currentFolderId)}`);
    }

    function pushHistoryState() {
      history.pushState(historyPayload(), '', `#folder=${encodeURIComponent(state.currentFolderId)}`);
    }

    function renderNavigation() {
      const isRoot = state.stack.length === 1;
      $('back-folder-button').classList.toggle('hidden', isRoot);
      $('back-folder-button').classList.toggle('flex', !isRoot);
      $('home-hero').classList.toggle('hidden', !isRoot || state.collection !== 'browse');
      $('library-totals').classList.toggle('hidden', !isRoot || state.collection !== 'browse');
      $('folder-summary').classList.toggle('hidden', isRoot);
      $('current-folder-title').textContent = state.stack[state.stack.length - 1]?.name || 'Carpeta';

      const container = $('breadcrumbs');
      container.innerHTML = '';
      state.stack.forEach((folder, index) => {
        if (index > 0) {
          const separator = document.createElement('span');
          separator.className = 'px-1 text-slate-300';
          separator.textContent = '›';
          container.appendChild(separator);
        }
        if (index === state.stack.length - 1) {
          const current = document.createElement('span');
          current.className = 'max-w-[220px] flex-none truncate rounded-xl bg-slate-100 px-3 py-2 text-xs font-extrabold text-movida-ink';
          current.textContent = folder.name;
          current.title = folder.name;
          container.appendChild(current);
        } else {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'flex-none rounded-xl px-2.5 py-2 text-xs font-bold text-slate-500 transition hover:bg-slate-100 hover:text-movida-petrol';
          button.textContent = folder.name;
          button.addEventListener('click', () => navigateToStackIndex(index, true));
          container.appendChild(button);
        }
      });
    }

    function getType(file) {
      const mime = String(file.mimeType || '');
      if (isFolder(file)) return 'folders';
      if (mime === 'application/pdf') return 'pdf';
      if (mime.startsWith('image/')) return 'images';
      if (mime.startsWith('video/')) return 'videos';
      if (mime.startsWith('audio/')) return 'audio';
      if (/spreadsheet|sheet|excel|csv/.test(mime)) return 'sheets';
      if (/presentation|powerpoint/.test(mime)) return 'slides';
      if (/document|word|text\/plain|rtf|opendocument.text/.test(mime)) return 'docs';
      return 'other';
    }
    function getTypeLabel(file) {
      return { folders: 'Carpeta', pdf: 'PDF', images: 'Imagen', videos: 'Video', audio: 'Audio', sheets: 'Hoja de cálculo', slides: 'Presentación', docs: 'Documento', other: 'Archivo' }[getType(file)];
    }
    function loadFavorites(session) {
      state.favoritesKey = session.favoritesScope ? `movida_drive_favorites_v1_${session.favoritesScope}` : null;
      try { const ids = JSON.parse(state.favoritesKey ? safeGet(localStorage, state.favoritesKey) || '[]' : '[]'); state.favorites = new Set(Array.isArray(ids) ? ids.filter(id => typeof id === 'string').slice(0, 5000) : []); } catch { state.favorites = new Set(); }
    }
    function toggleFavorite(file, button) {
      if (!state.favoritesKey) { showToast('Vuelve a ingresar para guardar tus favoritos.'); return; }
      const updated = new Set(state.favorites); const saved = !updated.has(file.id);
      if (saved) updated.add(file.id); else updated.delete(file.id);
      if (!safeSet(localStorage, state.favoritesKey, JSON.stringify([...updated]))) { showToast('El navegador no permite guardar favoritos.'); return; }
      state.favorites = updated;
      if (state.collection === 'favorites') renderContent(); else { button.setAttribute('aria-pressed', String(saved)); button.setAttribute('aria-label', `${saved ? 'Quitar de' : 'Guardar en'} favoritos: ${file.name}`); updateCollections(); }
      showToast(saved ? 'Guardado en favoritos.' : 'Quitado de favoritos.');
    }
    function createFavoriteButton(file) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'utility-icon favorite-button';
      const saved = state.favorites.has(file.id); button.setAttribute('aria-pressed', String(saved)); button.setAttribute('aria-label', `${saved ? 'Quitar de' : 'Guardar en'} favoritos: ${file.name}`);
      button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3L12 17.5l-5.7 3 1.1-6.3L2.8 9.7l6.4-.9L12 3Z" fill="currentColor" stroke="currentColor" stroke-width="1.2"/></svg>';
      button.addEventListener('click', event => { event.stopPropagation(); toggleFavorite(file, button); }); return button;
    }
    function rebuildFolderStats() {
      state.folderStats = new Map([...state.folderMap.keys()].map(id => [id, { files: 0, directFiles: 0, subfolders: 0 }]));
      for (const file of state.catalog) {
        const direct = state.folderStats.get(file.parentId); if (!direct) continue;
        if (isFolder(file)) { direct.subfolders++; continue; }
        direct.directFiles++; let id = file.parentId; const seen = new Set();
        while (id && !seen.has(id)) { seen.add(id); const stats = state.folderStats.get(id); if (stats) stats.files++; id = state.folderMap.get(id)?.parentId; }
      }
    }
    function updateCollections() {
      document.querySelectorAll('[data-collection]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.collection === state.collection)));
      $('favorites-count').textContent = String(state.catalog.filter(file => state.favorites.has(file.id)).length);
      $('recent-mode-control').classList.toggle('hidden', state.collection !== 'recent');
      $('sort-select').disabled = state.collection === 'recent';
      $('search-scope').disabled = state.collection !== 'browse';
      $('toggle-full-names').setAttribute('aria-pressed', String(state.fullNames));
      $('collection-help').textContent = state.collection === 'favorites' ? 'Tus favoritos de toda la biblioteca, guardados para tu cuenta en este navegador.' : state.collection === 'recent' ? ($('recent-mode').value === 'added' ? 'Nuevas incorporaciones detectadas desde que se activó este registro; no es la fecha de creación del archivo.' : 'Archivos de toda la biblioteca, ordenados por su última modificación en Google Drive.') : '';
    }
    async function shareFolder(file) {
      const url = `https://drive.movidasst.com/#folder=${encodeURIComponent(file.id)}`;
      if (navigator.share) { try { await navigator.share({ title: file.name, text: 'Carpeta de la Biblioteca Movida SST', url }); return; } catch (error) { if (error.name === 'AbortError') return; } }
      await copyText(url);
    }
    function fileMeta(file) {
      const values = [getTypeLabel(file), `Modificado ${formatDate(file.modifiedTime)}`, formatSize(file.size)];
      if (state.collection === 'recent' && $('recent-mode').value === 'added' && file.addedAt) values.push(`Incorporado ${formatDate(file.addedAt)}`);
      if (isGlobalSearch() || state.collection !== 'browse') values.push(originPath(file));
      return values.filter(Boolean).join(' · ');
    }

    function formatDate(value) {
      if (!value) return 'Sin fecha';
      return new Intl.DateTimeFormat('es-VE', { day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(value));
    }

    function formatSize(value) {
      const bytes = Number(value);
      if (!Number.isFinite(bytes) || bytes <= 0) return '';
      const units = ['B', 'KB', 'MB', 'GB'];
      let size = bytes;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
    }

    function sortFiles(files) {
      const copy = [...files];
      if (state.sort === 'recent') {
        return copy.sort((a, b) => new Date(b.modifiedTime || 0) - new Date(a.modifiedTime || 0));
      }
      if (state.sort === 'oldest') {
        return copy.sort((a, b) => new Date(a.modifiedTime || 0) - new Date(b.modifiedTime || 0));
      }
      return copy.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
    }

    function filteredItems() {
      const term = normalizeSearch($('search-input').value.trim());
      const source = state.collection !== 'browse' || isGlobalSearch() ? state.catalog : state.files;
      let items = source.filter(file => !term || normalizeSearch(file.name).includes(term));
      if (state.collection === 'favorites') items = items.filter(file => state.favorites.has(file.id));
      if (state.collection === 'recent') items = items.filter(file => !isFolder(file) && ($('recent-mode').value !== 'added' || file.addedAt));
      if (state.filter !== 'all') items = items.filter(file => getType(file) === state.filter);
      if (state.collection === 'recent') { const field = $('recent-mode').value === 'added' ? 'addedAt' : 'modifiedTime'; return [...items].sort((a,b) => new Date(b[field] || 0) - new Date(a[field] || 0)); }
      return sortFiles(items);
    }

    function iconMarkup(file, size = 'h-9 w-9') {
      const type = getType(file);
      if (type === 'folders') {
        return `<svg class="${size} text-amber-400" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 6a2 2 0 012-2h5l2 2h7a2 2 0 012 2v9a3 3 0 01-3 3H6a3 3 0 01-3-3V6z"></path></svg>`;
      }
      if (type === 'pdf') {
        return `<svg class="${size} text-red-500" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 2h8l4 4v16H6V2zm7 1.5V7h3.5L13 3.5zM8 11v7h2v-2h1.1a2.5 2.5 0 000-5H8zm2 2h1a.5.5 0 010 1h-1v-1zm3 5h2.1a3.1 3.1 0 000-6H13v6zm2-4h.2a1.1 1.1 0 010 2H15v-2z"></path></svg>`;
      }
      if (type === 'images') {
        return `<svg class="${size} text-violet-500" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 3h16a2 2 0 012 2v14a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2zm1 16h14l-4.5-6-3.5 4.5-2.5-3L5 19zm4-10a2 2 0 100-4 2 2 0 000 4z"></path></svg>`;
      }
      if (getTypeLabel(file) === 'Hoja de cálculo') {
        return `<svg class="${size} text-emerald-600" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 2h10l4 4v16H5V2zm9 1.5V7h3.5L14 3.5zM8 10v8h8v-8H8zm2 2h1v1h-1v-1zm3 0h1v1h-1v-1zm-3 3h1v1h-1v-1zm3 0h1v1h-1v-1z"></path></svg>`;
      }
      return `<svg class="${size} text-blue-600" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 2h8l4 4v16H6V2zm7 1.5V7h3.5L13 3.5zM8 11h8v2H8v-2zm0 4h8v2H8v-2z"></path></svg>`;
    }

    function createFolderCard(file, index) {
      const article = document.createElement('article'); article.className = 'folder-card';
      const button = document.createElement('button'); button.type = 'button'; button.className = 'folder-open';
      const icon = document.createElement('span'); icon.className = 'folder-icon'; icon.innerHTML = iconMarkup(file, 'h-6 w-6');
      const info = document.createElement('span'); info.className = 'min-w-0 flex-1';
      const title = document.createElement('span'); title.className = `${state.fullNames ? 'full-resource-name' : 'line-clamp-2'} block text-sm font-extrabold leading-snug text-movida-ink`; title.textContent = file.name; title.title = file.name;
      const stats = state.folderStats.get(file.id) || { files: 0, subfolders: 0 };
      const count = document.createElement('span'); count.className = 'mt-1 block text-xs font-semibold text-movida-petrol'; count.textContent = `${stats.files} ${stats.files === 1 ? 'archivo' : 'archivos'} en total${stats.subfolders ? ` · ${stats.subfolders} ${stats.subfolders === 1 ? 'subcarpeta' : 'subcarpetas'}` : ''}`;
      info.append(title, count);
      if (isGlobalSearch() || state.collection !== 'browse') { const route = document.createElement('span'); route.className = 'mt-1 block text-xs text-slate-600 full-resource-name'; route.textContent = originPath(file); info.appendChild(route); }
      button.append(icon, info); button.addEventListener('click', () => navigateToFolder(file.id, file.name));
      const actions = document.createElement('div'); actions.className = 'folder-actions';
      const share = document.createElement('button'); share.type = 'button'; share.className = 'utility-icon share-folder'; share.setAttribute('aria-label', `Compartir carpeta: ${file.name}`);
      share.innerHTML = '<svg class="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4m-6.8 7 6.8 4"/></svg>';
      share.addEventListener('click', () => shareFolder(file)); actions.append(createFavoriteButton(file), share); article.append(button, actions); return article;
    }

    function createOpenButton(file, label = 'Abrir') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-movida-navy px-3 text-xs font-extrabold text-white transition hover:bg-movida-petrol';
      button.innerHTML = `<span>${label}</span><svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m9 18 6-6-6-6"></path></svg>`;
      button.addEventListener('click', () => openFile(file));
      return button;
    }

    function createMoreButton(file) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'flex h-11 w-11 flex-none items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-movida-petrol';
      button.setAttribute('aria-label', `Más acciones para ${file.name}`);
      button.innerHTML = `<svg class="h-5 w-5" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>`;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        openFileMenu(file, button);
      });
      return button;
    }

    function createGridFileCard(file, index) {
      const article = document.createElement('article');
      article.className = 'fade-up group flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card transition hover:-translate-y-1 hover:border-movida-petrol/20 hover:shadow-lift';
      article.style.animationDelay = `${Math.min(index * 28, 260)}ms`;

      const visualButton = document.createElement('button');
      visualButton.type = 'button';
      visualButton.className = 'relative block aspect-[4/3] w-full overflow-hidden bg-slate-50 text-left';
      visualButton.setAttribute('aria-label', `Abrir ${file.name}`);
      visualButton.addEventListener('click', () => openFile(file));

      if (isImage(file) && file.thumbnailLink) {
        const image = document.createElement('img');
        image.src = file.thumbnailLink.replace(/=s\d+/, '=s700');
        image.alt = '';
        image.loading = 'lazy';
        image.className = 'h-full w-full object-cover transition duration-500 group-hover:scale-105';
        image.addEventListener('error', () => {
          visualButton.innerHTML = `<span class="flex h-full items-center justify-center bg-violet-50">${iconMarkup(file, 'h-12 w-12')}</span>`;
        });
        visualButton.appendChild(image);
      } else {
        visualButton.innerHTML = `<span class="flex h-full items-center justify-center bg-gradient-to-br from-slate-50 to-blue-50">${iconMarkup(file, 'h-12 w-12')}</span>`;
      }

      const badge = document.createElement('span');
      badge.className = 'pointer-events-none absolute left-2.5 top-2.5 rounded-full border border-white/70 bg-white/90 px-2.5 py-1 text-[10px] font-extrabold uppercase tracking-wide text-slate-600 shadow-sm backdrop-blur';
      badge.textContent = getTypeLabel(file);
      visualButton.appendChild(badge);

      const body = document.createElement('div');
      body.className = 'flex flex-1 flex-col p-3.5';
      const title = document.createElement('h3');
      title.className = `${state.fullNames ? 'full-resource-name' : 'line-clamp-3'} text-sm font-extrabold leading-snug text-movida-ink`;
      title.textContent = file.name;
      title.title = file.name;
      const meta = document.createElement('p');
      meta.className = 'mt-2 text-[11px] font-semibold text-slate-600';
      meta.textContent = fileMeta(file);
      const actions = document.createElement('div');
      actions.className = 'mt-auto flex items-center gap-2 pt-4';
      const openButton = createOpenButton(file);
      openButton.classList.add('flex-1');
      actions.append(openButton, createMoreButton(file));
      body.append(title, meta, actions);
      const visual = document.createElement('div'); visual.className = 'file-visual'; visual.append(visualButton, createFavoriteButton(file)); article.append(visual, body);
      return article;
    }

    function createListFileCard(file, index) {
      const article = document.createElement('article');
      article.className = 'fade-up flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-card transition hover:-translate-y-0.5 hover:border-movida-petrol/20 hover:shadow-lift';
      article.style.animationDelay = `${Math.min(index * 22, 220)}ms`;

      const openArea = document.createElement('button');
      openArea.type = 'button';
      openArea.className = 'flex min-w-0 flex-1 items-center gap-3 text-left';
      openArea.addEventListener('click', () => openFile(file));

      const visual = document.createElement('span');
      visual.className = 'flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-xl bg-slate-50';
      if (isImage(file) && file.thumbnailLink) {
        const image = document.createElement('img');
        image.src = file.thumbnailLink;
        image.alt = '';
        image.loading = 'lazy';
        image.className = 'h-full w-full object-cover';
        image.addEventListener('error', () => { visual.innerHTML = iconMarkup(file, 'h-8 w-8'); });
        visual.appendChild(image);
      } else {
        visual.innerHTML = iconMarkup(file, 'h-8 w-8');
      }

      const text = document.createElement('span');
      text.className = 'min-w-0 flex-1';
      const title = document.createElement('span');
      title.className = `${state.fullNames ? 'full-resource-name' : 'line-clamp-2'} block text-sm font-extrabold leading-snug text-movida-ink`;
      title.title = file.name;
      title.textContent = file.name;
      const meta = document.createElement('span');
      meta.className = 'mt-1 block text-[11px] font-semibold text-slate-600';
      meta.textContent = fileMeta(file);
      text.append(title, meta);
      openArea.append(visual, text);

      const desktopOpen = createOpenButton(file);
      desktopOpen.classList.add('hidden', 'sm:inline-flex');
      article.append(openArea, desktopOpen, createFavoriteButton(file), createMoreButton(file));
      return article;
    }

    function renderContent() {
      $('loading-state').classList.add('hidden');
      $('error-state').classList.add('hidden');
      renderNavigation(); updateCollections();

      const allFolders = state.catalog.filter(isFolder);
      const allFiles = state.catalog.filter((file) => !isFolder(file));
      $('home-folder-count').textContent = String(allFolders.length);
      $('home-file-count').textContent = String(allFiles.length);
      $('current-item-count').textContent = String(state.files.length);

      const items = filteredItems();
      const folders = items.filter(isFolder);
      const files = items.filter((file) => !isFolder(file));
      const isSearch = $('search-input').value.trim().length > 0;

      $('visible-folder-count').textContent = `${folders.length} ${folders.length === 1 ? 'carpeta' : 'carpetas'}`;
      $('visible-file-count').textContent = `${files.length} ${files.length === 1 ? 'recurso' : 'recursos'}`;

      const showFolders = folders.length > 0 && (state.filter === 'all' || state.filter === 'folders');
      const showFiles = files.length > 0 && state.filter !== 'folders';
      $('folder-section').classList.toggle('hidden', !showFolders);
      $('file-section').classList.toggle('hidden', !showFiles);

      const folderContainer = $('folder-container');
      folderContainer.innerHTML = '';
      folders.forEach((file, index) => folderContainer.appendChild(createFolderCard(file, index)));

      const fileContainer = $('file-container');
      fileContainer.innerHTML = '';
      fileContainer.className = state.view === 'grid'
        ? 'file-grid grid gap-3 sm:grid-cols-2 sm:gap-5 lg:grid-cols-4 xl:grid-cols-5'
        : 'flex flex-col gap-3';
      files.slice(0, state.visibleLimit).forEach((file, index) => {
        fileContainer.appendChild(state.view === 'grid' ? createGridFileCard(file, index) : createListFileCard(file, index));
      });

      $('load-more').classList.toggle('hidden', files.length <= state.visibleLimit);
      $('results-status').textContent = state.collection !== 'browse' ? `${items.length} ${state.collection === 'favorites' ? 'favoritos' : 'archivos recientes'} en toda la biblioteca` : isSearch ? `${items.length} resultado(s) ${isGlobalSearch() ? 'en toda la biblioteca' : 'en esta carpeta'}` : `${state.files.length} elementos en esta carpeta`;
      const hasVisible = showFolders || showFiles;
      $('empty-state').classList.toggle('hidden', hasVisible);
      if (!hasVisible) {
        $('empty-title').textContent = state.collection === 'favorites' && !isSearch && state.filter === 'all' ? 'Todavía no tienes favoritos' : state.collection === 'recent' && $('recent-mode').value === 'added' && !isSearch && state.filter === 'all' ? 'Aquí aparecerán las nuevas incorporaciones' : isSearch ? 'No encontramos resultados' : !state.files.length ? 'Esta carpeta está vacía' : 'No hay recursos con este filtro';
        $('empty-text').textContent = state.collection === 'favorites' && !isSearch && state.filter === 'all' ? 'Pulsa la estrella de un archivo o carpeta para guardarlo aquí.' : state.collection === 'recent' && $('recent-mode').value === 'added' && !isSearch && state.filter === 'all' ? 'Puedes consultar ahora los archivos modificados recientemente.' : isSearch ? 'Prueba otra palabra o cambia el alcance de búsqueda.' : !state.files.length ? 'Vuelve a Inicio para explorar otras carpetas.' : 'Selecciona otro tipo de recurso.';
      }
    }

    function showLoading() {
      $('loading-state').classList.remove('hidden');
      $('error-state').classList.add('hidden');
      $('empty-state').classList.add('hidden');
      $('folder-section').classList.add('hidden');
      $('file-section').classList.add('hidden');
    }

    function showError(message) {
      $('loading-state').classList.add('hidden');
      $('empty-state').classList.add('hidden');
      $('folder-section').classList.add('hidden');
      $('file-section').classList.add('hidden');
      $('error-text').textContent = message;
      $('error-state').classList.remove('hidden');
    }

    function updateFilterChips() { $('type-filter').value = state.filter; }

    function updateViewControls() {
      const isGrid = state.view === 'grid';
      $('grid-view').className = isGrid ? 'min-h-11 min-w-11 rounded-lg bg-white p-2 text-movida-petrol shadow-sm' : 'min-h-11 min-w-11 rounded-lg p-2 text-slate-400';
      $('list-view').className = !isGrid ? 'min-h-11 min-w-11 rounded-lg bg-white p-2 text-movida-petrol shadow-sm' : 'min-h-11 min-w-11 rounded-lg p-2 text-slate-400';
      $('grid-view').setAttribute('aria-pressed', String(isGrid));
      $('list-view').setAttribute('aria-pressed', String(!isGrid));
    }

    function openFile(file) {
      if (isFolder(file)) {
        navigateToFolder(file.id, file.name);
      } else if (isImage(file) || isPdf(file)) {
        openPreview(file);
      } else {
        openExternal(file.webViewLink);
      }
    }

    function openExternal(url) {
      const safe = safeDriveUrl(url);
      if (!safe) { showToast('Este archivo no tiene un enlace válido disponible.'); return; }
      window.open(safe, '_blank', 'noopener,noreferrer');
    }
    function safeDriveUrl(value) {
      try { const url = new URL(value); return url.protocol === 'https:' && ['drive.google.com', 'docs.google.com'].includes(url.hostname) ? url.href : null; } catch { return null; }
    }

    function openPreview(file) {
      const generation = ++state.previewGeneration; state.previewReturnFocus = document.activeElement;
      $('preview-title').textContent = file.name;
      const external = safeDriveUrl(file.webViewLink); $('preview-external').href = external || '#'; $('preview-external').classList.toggle('hidden', !external);
      const body = $('preview-body'); body.replaceChildren();
      const notice = document.createElement('p'); notice.className = 'absolute top-3 rounded-xl bg-slate-900 px-4 py-2 text-sm text-white'; notice.textContent = 'Cargando vista previa…'; notice.setAttribute('role', 'status'); body.appendChild(notice);
      $('preview-modal').classList.remove('hidden'); document.body.style.overflow = 'hidden'; $('close-preview').focus();
      const valid = () => generation === state.previewGeneration && !$('preview-modal').classList.contains('hidden');
      const failed = () => { if (valid()) notice.textContent = 'No se pudo mostrar la vista previa. Usa “Abrir en Google Drive”.'; };
      if (isImage(file) && file.thumbnailLink) {
        const image = new Image(); image.alt = file.name; image.className = 'max-h-full max-w-full rounded-xl object-contain';
        image.onload = () => { if (valid()) body.replaceChildren(image); }; image.onerror = failed;
        try { const url = new URL(file.thumbnailLink); if (url.protocol !== 'https:' || !(url.hostname.endsWith('.googleusercontent.com') || url.hostname === 'googleusercontent.com')) { failed(); return; } image.src = url.href.replace(/=s\d+/, '=s1600'); } catch { failed(); }
      } else {
        const iframe = document.createElement('iframe'); iframe.title = file.name; iframe.referrerPolicy = 'strict-origin-when-cross-origin';
        iframe.src = `https://drive.google.com/file/d/${encodeURIComponent(file.id)}/preview${file.resourceKey ? '?resourcekey=' + encodeURIComponent(file.resourceKey) : ''}`;
        iframe.className = 'h-full w-full rounded-xl border-0 bg-white';
        iframe.onload = () => { if (valid()) notice.remove(); }; iframe.onerror = failed;
        body.appendChild(iframe);
      }
      clearTimeout(state.previewTimer); state.previewTimer = setTimeout(failed, 15000);
    }

    function closePreview() {
      const wasOpen = !$('preview-modal').classList.contains('hidden'); state.previewGeneration++; clearTimeout(state.previewTimer);
      $('preview-modal').classList.add('hidden'); $('preview-body').replaceChildren(); document.body.style.overflow = '';
      if (wasOpen && state.previewReturnFocus?.isConnected) state.previewReturnFocus.focus();
    }

    function openFileMenu(file, anchor) {
      state.activeFile = file;
      const menu = $('file-menu');
      const rect = anchor.getBoundingClientRect();
      const width = 208;
      const left = Math.min(window.innerWidth - width - 12, Math.max(12, rect.right - width));
      const estimatedHeight = 150;
      const below = rect.bottom + 8;
      const top = below + estimatedHeight > window.innerHeight ? Math.max(12, rect.top - estimatedHeight - 8) : below;
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.classList.add('menu-open');
    }

    function closeFileMenu() {
      $('file-menu').classList.remove('menu-open');
      state.activeFile = null;
    }

    function toggleProfileMenu() {
      const menu = $('profile-menu');
      const open = !menu.classList.contains('menu-open');
      menu.classList.toggle('menu-open', open);
      $('profile-button').setAttribute('aria-expanded', String(open));
    }

    function closeProfileMenu() {
      $('profile-menu').classList.remove('menu-open');
      $('profile-button').setAttribute('aria-expanded', 'false');
    }

    async function copyText(text) {
      if (!text) {
        showToast('No hay enlace disponible.');
        return;
      }
      try {
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.opacity = '0';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          textarea.remove();
        }
        showToast('Enlace copiado.');
      } catch {
        showToast('No se pudo copiar el enlace.');
      }
    }

    async function shareFile(file) {
      const url = safeDriveUrl(file?.webViewLink);
      if (!url) {
        showToast('No hay enlace disponible.');
        return;
      }
      const data = { title: file.name, text: 'Te comparto este recurso de La Movida SST.', url };
      try {
        if (navigator.share) {
          await navigator.share(data);
          return;
        }
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
      window.open(`https://api.whatsapp.com/send?text=${encodeURIComponent(`${data.text}\n${file.name}\n${url}`)}`, '_blank', 'noopener,noreferrer');
    }

    function showToast(message) {
      $('toast-text').textContent = message;
      $('toast').classList.add('toast-show');
      clearTimeout(state.toastTimer);
      state.toastTimer = setTimeout(() => $('toast').classList.remove('toast-show'), 2800);
    }

    function updateConnectionStatus() {
      const online = navigator.onLine;
      $('connection-dot').className = online ? 'h-2 w-2 rounded-full bg-emerald-500' : 'h-2 w-2 rounded-full bg-amber-500';
      $('connection-label').textContent = online ? 'En línea' : 'Sin conexión';
    }

    function initEvents() {
      $('login-form').addEventListener('submit', handleLogin);
      $('login-cedula').addEventListener('input', (event) => { event.target.value = normalizeCedula(event.target.value); });
      $('toggle-code').addEventListener('click', () => {
        const input = $('login-code');
        const reveal = input.type === 'password';
        input.type = reveal ? 'text' : 'password';
        $('toggle-code').setAttribute('aria-label', reveal ? 'Ocultar código' : 'Mostrar código');
      });

      $('profile-button').addEventListener('click', (event) => {
        event.stopPropagation();
        closeFileMenu();
        toggleProfileMenu();
      });
      $('profile-menu').addEventListener('click', (event) => event.stopPropagation());
      $('logout-button').addEventListener('click', () => logout());
      $('back-folder-button').addEventListener('click', goBackFolder);
      $('retry-button').addEventListener('click', () => refreshCatalog());
      $('refresh-catalog').addEventListener('click', () => refreshCatalog(true));
      $('load-more').addEventListener('click', () => { state.visibleLimit += 60; renderContent(); });
      $('search-scope').addEventListener('change', () => { state.visibleLimit = 60; renderContent(); });

      $('search-input').addEventListener('input', () => {
        state.visibleLimit = 60; clearTimeout(state.searchTimer);
        $('clear-search').classList.toggle('hidden', !$('search-input').value.trim());
        state.searchTimer = setTimeout(renderContent, 160);
      });
      $('clear-search').addEventListener('click', () => {
        $('search-input').value = '';
        $('clear-search').classList.add('hidden');
        $('search-input').focus();
        renderContent();
      });

      $('type-filter').addEventListener('change', () => { state.filter = $('type-filter').value; state.visibleLimit = 60; renderContent(); });
      document.querySelectorAll('[data-collection]').forEach(button => button.addEventListener('click', () => { state.collection = button.dataset.collection; if (state.collection !== 'browse') $('search-scope').value = 'all'; state.visibleLimit = 60; renderContent(); }));
      $('recent-mode').addEventListener('change', () => { state.visibleLimit = 60; renderContent(); });
      $('toggle-full-names').addEventListener('click', () => { state.fullNames = !state.fullNames; safeSet(localStorage, CONFIG.NAMES_KEY, String(state.fullNames)); renderContent(); });
      $('share-current-folder').addEventListener('click', () => shareFolder({ id: state.currentFolderId, name: state.stack.at(-1)?.name || 'Inicio' }));

      $('sort-select').addEventListener('change', () => {
        state.sort = $('sort-select').value;
        safeSet(localStorage, CONFIG.SORT_KEY, state.sort);
        renderContent();
      });

      $('grid-view').addEventListener('click', () => {
        state.view = 'grid';
        safeSet(localStorage, CONFIG.VIEW_KEY, state.view);
        updateViewControls();
        renderContent();
      });
      $('list-view').addEventListener('click', () => {
        state.view = 'list';
        safeSet(localStorage, CONFIG.VIEW_KEY, state.view);
        updateViewControls();
        renderContent();
      });

      $('menu-open-drive').addEventListener('click', () => { if (state.activeFile) openExternal(state.activeFile.webViewLink); closeFileMenu(); });
      $('menu-share').addEventListener('click', () => { if (state.activeFile) shareFile(state.activeFile); closeFileMenu(); });
      $('menu-copy').addEventListener('click', () => { if (state.activeFile) copyText(state.activeFile.webViewLink); closeFileMenu(); });

      $('dismiss-session-warning').addEventListener('click', async () => {
        const button = $('dismiss-session-warning'); button.disabled = true;
        try { const session = readSession(); if (!session) return; const data = await api('renew'); const updated = saveSession({ ...session, ...data }); scheduleSession(updated); $('session-warning').classList.add('hidden'); showToast('Sesión renovada.'); } catch (error) { showToast(error.message); } finally { button.disabled = false; }
      });
      $('warning-logout').addEventListener('click', () => logout());

      $('close-preview').addEventListener('click', closePreview);
      $('preview-modal').addEventListener('click', (event) => { if (event.target === $('preview-modal')) closePreview(); });

      document.addEventListener('click', () => {
        closeProfileMenu();
        closeFileMenu();
      });
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Tab' && !$('preview-modal').classList.contains('hidden')) { const targets = [...$('preview-modal').querySelectorAll('button, a[href], iframe')].filter(el => !el.classList.contains('hidden')); const first = targets[0], last = targets[targets.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
        if (event.key === 'Escape') {
          closeProfileMenu();
          closeFileMenu();
          if (!$('preview-modal').classList.contains('hidden')) closePreview();
        }
      });

      window.addEventListener('resize', closeFileMenu);
      window.addEventListener('scroll', closeFileMenu, { passive: true });
      window.addEventListener('online', updateConnectionStatus);
      window.addEventListener('offline', updateConnectionStatus);
      const restoreLocation = () => { if (!readSession() || !state.catalog.length) return; const target = new URLSearchParams(location.hash.slice(1)).get('folder'); loadFolder(target || CONFIG.ROOT_FOLDER); };
      window.addEventListener('popstate', restoreLocation); window.addEventListener('hashchange', restoreLocation);

    }

    async function bootstrap() {
      initEvents(); updateConnectionStatus(); updateFilterChips(); updateViewControls(); $('sort-select').value = state.sort;
      safeRemove(sessionStorage, 'movida_drive_session_v1');
      const session = readSession();
      if (session) { try { const data = await api('session', {}, session.token); openApp(saveSession({ ...session, ...data })); } catch { logout('Ingresa para consultar la biblioteca.', false); } }
      else $('login-cedula').focus();
    }

    bootstrap();
