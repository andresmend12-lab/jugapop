const VERSION = 'v10';
const $ = (id) => document.getElementById(id);
const cfg = window.APP_CONFIG;

const fmt = (iso) => new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });
const fmtShort = (iso) => new Date(iso).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const searchText = (s) => (s.collection ? `la colección «${esc(s.collection)}» de ${esc(storeOf(s.store))}` : `«${esc(s.query)}» en ${esc(storeOf(s.store))}`);
const storeOf = (url) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

function duration(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} días`;
}

const thumb = (item) => (item.imageLocal || item.image
  ? `<img src="${esc(item.imageLocal || item.image)}" alt="" data-fallback="${esc(item.image || '')}">` : '');

function productRow(p) {
  const cls = p.unpublished ? '' : p.inStock === true ? 'in' : p.inStock === false ? 'out' : '';
  const label = p.unpublished ? 'Aún no publicado' : p.inStock === true ? '¡Hay stock!' : p.inStock === false ? 'Agotado' : 'Aún sin comprobar';
  return `<a class="product" href="${esc(p.url)}" target="_blank" rel="noopener">
    ${thumb(p)}
    <div class="info">
      <h2>${esc(p.name || p.url)}</h2>
      <div class="muted">${esc(p.store || storeOf(p.url))}${p.price ? ` · ${esc(p.price)}` : ''}</div>
      <div class="status ${cls}"><span class="dot"></span><span>${label}</span></div>
      ${p.failingSince ? `<div class="warn">⚠️ No se puede comprobar desde ${fmtShort(p.failingSince)}</div>` : ''}
    </div>
    <span class="chev">›</span>
  </a>`;
}

function newsRow(n) {
  return `<a class="product" href="${esc(n.url)}" target="_blank" rel="noopener">
    ${thumb(n)}
    <div class="info">
      <h2>${esc(n.name)}</h2>
      <div class="muted">${esc(storeOf(n.url))}${n.price ? ` · ${esc(n.price)}` : ''} · ${fmtShort(n.foundAt)}</div>
    </div>
    <span class="chev">›</span>
  </a>`;
}

function renderHistory(products) {
  const events = [];
  for (const p of products) {
    const h = p.history || [];
    h.forEach((e, i) => {
      const next = h[i + 1];
      events.push({ ...e, name: p.name || storeOf(p.url), store: p.store, lasted: e.inStock && next ? duration(Date.parse(next.at) - Date.parse(e.at)) : null });
    });
  }
  events.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  $('hist').innerHTML = events.length ? events.slice(0, 40).map((e) => `<div>
    <time>${fmtShort(e.at)}</time>
    <span>${e.inStock ? '✅ Stock' : '❌ Agotado'} · ${esc(e.name)}${e.lasted ? ` <span class="muted">(duró ${e.lasted})</span>` : ''}</span>
  </div>`).join('') : '<p class="muted small">Todavía no hay cambios registrados.</p>';
}

function hookImageFallbacks(root) {
  // Si la copia local aún no existe, probamos con la foto original de la tienda.
  root.querySelectorAll('img[data-fallback]').forEach((img) => {
    img.addEventListener('error', () => {
      if (img.dataset.fallback && img.src !== img.dataset.fallback) img.src = img.dataset.fallback;
    }, { once: true });
  });
}

let namesByUrl = {};

async function loadStatus() {
  try {
    const { products = [], searches = [] } = await (await fetch(`status.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    namesByUrl = Object.fromEntries(products.map((p) => [p.url, p.name]));
    $('list').innerHTML = products.length ? products.map(productRow).join('')
      : '<p class="muted">Aún no hay datos: espera a la primera comprobación.</p>';

    const news = searches.flatMap((s) => s.recent || []).sort((a, b) => Date.parse(b.foundAt) - Date.parse(a.foundAt)).slice(0, 8);
    const failingSearch = searches.find((s) => s.failingSince);
    $('newsTitle').hidden = !searches.length;
    $('news').innerHTML = (news.length ? news.map(newsRow).join('')
      : `<p class="muted small">Sin novedades por ahora. Vigilando ${searches.map(searchText).join(', ')}.</p>`)
      + (failingSearch ? `<div class="warn">⚠️ No se puede buscar en ${esc(storeOf(failingSearch.store))} desde ${fmtShort(failingSearch.failingSince)}</div>` : '');

    hookImageFallbacks(document);
    renderHistory(products);

    // Número en el icono de la app = productos con stock.
    const inStock = products.filter((p) => p.inStock).length;
    if (navigator.setAppBadge) (inStock ? navigator.setAppBadge(inStock) : navigator.clearAppBadge()).catch(() => {});
  } catch {
    $('list').innerHTML = '<p class="muted">No se pudo cargar el estado.</p>';
  }

  // Estado de las comprobaciones (solo funciona si el repositorio es público).
  try {
    const r = await fetch(`https://api.github.com/repos/${cfg.repo}/actions/workflows/${cfg.workflow}/runs?per_page=5`);
    const runs = (await r.json()).workflow_runs || [];
    const active = runs.find((run) => run.status === 'in_progress');
    const last = runs.find((run) => run.status === 'completed');
    if (active) $('lastCheck').textContent = '🟢 Comprobando cada minuto';
    else if (last && Date.now() - Date.parse(last.updated_at) > 20 * 60_000) {
      $('lastCheck').innerHTML = `⚠️ Las comprobaciones están paradas desde ${fmtShort(last.updated_at)}. Reactívalas en GitHub › Actions.`;
    } else if (last) $('lastCheck').textContent = `Última comprobación: ${fmt(last.updated_at)}`;
  } catch { /* opcional */ }
  $('updated').textContent = `Datos cargados a las ${new Date().toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}`;
}

// ---------- Notificaciones ----------

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function showSubscription(sub) {
  $('sub').value = JSON.stringify(sub);
  $('subBox').hidden = false;
  $('enable').textContent = 'Notificaciones activadas ✓';
  $('enable').disabled = true;
}

async function setupPush() {
  const standalone = window.navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

  if (isIOS && !standalone) {
    $('install').hidden = false;
    $('enable').disabled = true;
    $('pushInfo').textContent = 'Primero instala la app en la pantalla de inicio (requiere iOS 16.4 o superior).';
    return;
  }
  if (!supported) {
    $('enable').disabled = true;
    $('pushInfo').textContent = 'Este navegador no admite notificaciones push. En iPhone necesitas iOS 16.4 o superior.';
    return;
  }

  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  if (existing) showSubscription(existing);

  $('enable').onclick = async () => {
    try {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        $('pushInfo').textContent = 'Permiso denegado. Actívalo en Ajustes › Notificaciones › Stock Alerta.';
        return;
      }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
      });
      showSubscription(sub);
    } catch (e) {
      $('pushInfo').textContent = `Error al activar: ${e.message}`;
    }
  };

  $('copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('sub').value); }
    catch { $('sub').select(); document.execCommand('copy'); }
    $('copy').textContent = 'Copiado ✓';
  };
}

// ---------- Añadir y quitar productos y búsquedas (vía API de GitHub) ----------

const prefs = {
  get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};
const msg = (t) => { $('watchMsg').textContent = t; };
const toB64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const fromB64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, '')), (c) => c.charCodeAt(0)));

async function gh(path, opts = {}) {
  const token = prefs.get('ghToken');
  const res = await fetch(`https://api.github.com/repos/${cfg.repo}/contents/${path}`, {
    ...opts,
    headers: { Accept: 'application/vnd.github+json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...opts.headers },
    cache: 'no-store',
  });
  if (!res.ok) {
    const denied = res.status === 401 || res.status === 403 || (res.status === 404 && opts.method);
    throw new Error(denied ? 'La clave de GitHub no es válida o no tiene permiso de escritura.' : `GitHub respondió ${res.status}`);
  }
  return res.json();
}

async function readList(path) {
  const file = await gh(path);
  return { list: JSON.parse(fromB64(file.content)), sha: file.sha };
}

async function editList(path, change, message) {
  if (!prefs.get('ghToken')) { msg('Primero guarda tu clave de GitHub (abajo).'); return false; }
  msg('Guardando…');
  try {
    const { list, sha } = await readList(path);
    const next = change(list);
    await gh(path, {
      method: 'PUT',
      body: JSON.stringify({ message, content: toB64(JSON.stringify(next, null, 2) + '\n'), sha }),
    });
    msg('Guardado ✓ Se comprobará en el próximo minuto.');
    await renderWatchLists();
    return true;
  } catch (e) {
    msg(`No se pudo guardar: ${e.message}`);
    return false;
  }
}

async function renderWatchLists() {
  try {
    const [{ list: products }, { list: searches }] = await Promise.all([readList('products.json'), readList('searches.json')]);
    $('watchProducts').innerHTML = products.map((u, i) => `<div class="row">
      <span>${esc(storeOf(u))} · ${esc(namesByUrl[u] || decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() || ''))}</span>
      <button class="secondary" data-del-product="${i}">✕</button></div>`).join('') || '<p class="muted small">Ninguno.</p>';
    $('watchSearches').innerHTML = searches.map((s, i) => `<div class="row">
      <span>${searchText(s)}</span>
      <button class="secondary" data-del-search="${i}">✕</button></div>`).join('') || '<p class="muted small">Ninguna.</p>';

    document.querySelectorAll('[data-del-product]').forEach((b) => {
      b.onclick = () => confirm('¿Dejar de vigilar este producto?') && editList('products.json',
        (l) => l.filter((u) => u !== products[b.dataset.delProduct]), 'Quita un producto desde la app');
    });
    document.querySelectorAll('[data-del-search]').forEach((b) => {
      b.onclick = () => confirm('¿Quitar esta búsqueda?') && editList('searches.json',
        (l) => l.filter((s) => JSON.stringify(s) !== JSON.stringify(searches[b.dataset.delSearch])),
        'Quita una búsqueda desde la app');
    });
  } catch (e) {
    $('watchProducts').innerHTML = `<p class="muted small">No se pudo leer la lista: ${esc(e.message)}</p>`;
  }
}

function validUrl(text) {
  try { const u = new URL(text.trim()); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
}

function setupWatch() {
  $('token').value = prefs.get('ghToken') || '';
  $('saveToken').onclick = () => {
    prefs.set('ghToken', $('token').value.trim());
    msg('Clave guardada en este iPhone ✓');
  };
  $('addProduct').onclick = async () => {
    const url = validUrl($('newProduct').value);
    if (!url) { msg('Pega un enlace válido (empieza por https://).'); return; }
    if (await editList('products.json', (l) => (l.includes(url) ? l : [...l, url]), `Añade ${storeOf(url)} desde la app`)) {
      $('newProduct').value = '';
    }
  };
  $('addSearch').onclick = async () => {
    const storeUrl = validUrl($('newSearchStore').value);
    const query = $('newSearchQuery').value.trim();
    // Un enlace a una colección de Shopify (…/collections/pokemon) o a una categoría de
    // WooCommerce (…/categoria/pokemon/cajas/) vigila la colección entera.
    const collection = storeUrl && new URL(storeUrl).pathname.match(/\/(?:collections|categoria|product-category)\/(?:[^?#]*\/)?([^/?#]+)\/?$/)?.[1];
    if (!storeUrl || (!query && !collection)) { msg('Indica la tienda (https://…) y qué buscar, o pega el enlace de una colección.'); return; }
    const entry = collection ? { store: new URL(storeUrl).origin, collection, page: storeUrl } : { store: new URL(storeUrl).origin, query };
    if (await editList('searches.json', (l) => (l.some((s) => JSON.stringify(s) === JSON.stringify(entry)) ? l : [...l, entry]),
      `Añade ${collection ? `la colección ${collection}` : `búsqueda «${query}»`} desde la app`)) {
      $('newSearchQuery').value = '';
    }
  };
}

// ---------- Paneles ----------

function toggle(panel, btn) {
  const show = $(panel).hidden;
  for (const [p, b] of [['push', 'settingsBtn'], ['historyPanel', 'historyBtn']]) {
    $(p).hidden = true; $(b).classList.remove('on');
  }
  $(panel).hidden = !show;
  $(btn).classList.toggle('on', show);
  if (show) $(panel).scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (show && panel === 'push') renderWatchLists();
}
$('settingsBtn').onclick = () => toggle('push', 'settingsBtn');
$('historyBtn').onclick = () => toggle('historyPanel', 'historyBtn');

// Mantener la app al día: buscar versión nueva al abrirla y recargar cuando se instale.
$('version').textContent = VERSION;
let swReg = null;
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((r) => { swReg = r; }).catch(() => {});
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!reloaded) { reloaded = true; location.reload(); }
  });
}

function refresh() {
  swReg?.update().catch(() => {});
  loadStatus();
}

$('refreshBtn').onclick = async () => {
  $('refreshBtn').classList.add('on');
  await swReg?.update().catch(() => {});
  location.reload();
};

loadStatus();
setupPush();
setupWatch();
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
window.addEventListener('pageshow', (e) => { if (e.persisted) refresh(); });
setInterval(() => { if (!document.hidden) loadStatus(); }, 60_000);
