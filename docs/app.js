const $ = (id) => document.getElementById(id);
const cfg = window.APP_CONFIG;

const fmt = (iso) => new Date(iso).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' });

const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function loadStatus() {
  try {
    const { products = [] } = await (await fetch(`status.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    $('list').innerHTML = products.length ? products.map((p) => {
      const cls = p.inStock === true ? 'in' : p.inStock === false ? 'out' : '';
      const label = p.inStock === true ? '¡Hay stock!' : p.inStock === false ? 'Agotado' : 'Aún sin comprobar';
      return `<section class="card">
        <a class="product" href="${esc(p.url)}" target="_blank" rel="noopener">
          ${p.image ? `<img src="${esc(p.image)}" alt="">` : ''}
          <div>
            <h2>${esc(p.name || p.url)}</h2>
            <div class="muted">${esc(p.store || '')}${p.price ? ` · ${esc(p.price)}` : ''}</div>
            <div class="status ${cls}"><span class="dot"></span><span>${label}</span></div>
            ${p.lastChange ? `<div class="muted">Desde: ${fmt(p.lastChange)}</div>` : ''}
          </div>
        </a>
      </section>`;
    }).join('') : '<p class="muted">Aún no hay datos: espera a la primera comprobación.</p>';
  } catch {
    $('list').innerHTML = '<p class="muted">No se pudo cargar el estado.</p>';
  }

  // Hora de la última comprobación (solo funciona si el repositorio es público).
  try {
    const r = await fetch(`https://api.github.com/repos/${cfg.repo}/actions/workflows/${cfg.workflow}/runs?per_page=1`);
    const run = (await r.json()).workflow_runs?.[0];
    if (run) $('lastCheck').textContent = `Última comprobación: ${fmt(run.updated_at)}`;
  } catch { /* opcional */ }
}

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

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
loadStatus();
setupPush();
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStatus(); });
