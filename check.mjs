// Vigila productos (products.json) y búsquedas de novedades (searches.json) en
// tiendas WooCommerce como jugapop.com o Shopify como jjcollection.es, y avisa
// con notificaciones push al iPhone de:
//   - stock nuevo, producto agotado de nuevo y bajadas de precio,
//   - productos nuevos que aparecen en una búsqueda,
//   - comprobaciones que fallan durante más de 10 minutos (y cuando se recuperan).
//
// Variables de entorno:
//   VAPID_PUBLIC_KEY         clave pública VAPID (la misma que docs/config.js)
//   VAPID_PRIVATE_KEY        clave privada VAPID (secreto)
//   VAPID_SUBJECT            contacto (mailto: o https:)
//   PUSH_SUBSCRIPTIONS       JSON con una suscripción o una lista (secreto)
//   NTFY_TOPIC               (opcional) tema de ntfy.sh como aviso de respaldo
//   TEST_NOTIFICATION=true   envía una notificación de prueba y no toca el estado

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import webpush from 'web-push';

const STATUS_FILE = new URL('./docs/status.json', import.meta.url);
const readJson = async (name, fallback) =>
  JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8').catch(() => JSON.stringify(fallback)));
const PRODUCTS = await readJson('./products.json', []);
const SEARCHES = await readJson('./searches.json', []);
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FAIL_ALERT_MS = 10 * 60_000; // avisar si una comprobación lleva 10 min fallando
const HISTORY_MAX = 30;
const RECENT_MAX = 15;

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'es-ES,es;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

const euros = (value) => (value == null ? null : `${value.toFixed(2).replace('.', ',')} €`);
const handleOf = (url) => new URL(url).pathname.split('/').filter(Boolean).pop();
const absolute = (src, origin) => (!src ? null : src.startsWith('//') ? `https:${src}` : new URL(src, origin).href);

// Shopify: /products/<handle>.js devuelve el producto con "available".
async function fromShopify(url) {
  const { origin, pathname } = new URL(url);
  if (!pathname.includes('/products/')) throw new Error('No es una URL de Shopify');
  const p = await (await get(`${origin}/products/${handleOf(url)}.js`, 'application/json')).json();
  if (typeof p.available !== 'boolean') throw new Error('Shopify: respuesta inesperada');
  return {
    inStock: p.available || (p.variants || []).some((v) => v.available),
    name: p.title,
    priceValue: p.price != null ? p.price / 100 : null,
    image: absolute(p.featured_image || p.images?.[0], origin),
    source: 'shopify',
  };
}

const wooItem = (p) => ({
  url: p.permalink,
  inStock: Boolean(p.is_in_stock && p.is_purchasable !== false),
  name: decodeEntities(p.name),
  priceValue: p.prices?.price ? Number(p.prices.price) / 10 ** (p.prices.currency_minor_unit ?? 2) : null,
  image: p.images?.[0]?.src || null,
});

// WooCommerce: API pública Store API.
async function fromWooStoreApi(url) {
  const { origin } = new URL(url);
  const res = await get(`${origin}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(handleOf(url))}`, 'application/json');
  const [p] = await res.json();
  if (!p) throw new Error('Store API: producto no encontrado');
  return { ...wooItem(p), source: 'woocommerce' };
}

// Respaldo para cualquier tienda: analizar el HTML de la página del producto.
async function fromHtml(url) {
  const html = await (await get(url, 'text/html')).text();
  if (/<title>\s*Just a moment/i.test(html)) throw new Error('La tienda bloquea las comprobaciones automáticas');
  let inStock = null;

  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const avail = m[1].match(/"availability"\s*:\s*"([^"]+)"/i)?.[1];
    if (avail) {
      inStock = /InStock|LimitedAvailability|PreOrder|OnlineOnly/i.test(avail) ? true
        : /OutOfStock|SoldOut|Discontinued/i.test(avail) ? false : null;
      if (inStock !== null) break;
    }
  }
  if (inStock === null) {
    // Solo miramos el bloque principal del producto (antes de "relacionados").
    const main = html.split(/class="[^"]*related/i)[0];
    if (/class="[^"]*\bstock\b[^"]*\bout-of-stock\b/i.test(main) || /(Agotado|Sin existencias|Fuera de stock|Sold out|Producto no disponible)/i.test(main)) inStock = false;
    else if (/class="[^"]*\bstock\b[^"]*\bin-stock\b/i.test(main) || /name="add-to-cart"|single_add_to_cart_button/i.test(main)) inStock = true;
  }
  if (inStock === null) throw new Error('No se pudo determinar el stock');

  const meta = (prop) => html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, 'i'))?.[1];
  const price = meta('product:price:amount') || html.match(/"price"\s*:\s*"?(\d+(?:[.,]\d+)?)/)?.[1];
  return {
    inStock,
    name: decodeEntities(meta('og:title') || ''),
    priceValue: price ? Number(price.replace(',', '.')) : null,
    image: meta('og:image') || null,
    source: 'html',
  };
}

const NAMED = {
  aacute: 'á', eacute: 'é', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ', uuml: 'ü',
  Aacute: 'Á', Eacute: 'É', Iacute: 'Í', Oacute: 'Ó', Uacute: 'Ú', Ntilde: 'Ñ',
  ordm: 'º', ordf: 'ª', iexcl: '¡', iquest: '¿', ndash: '–', mdash: '—', euro: '€',
};

function decodeEntities(s = '') {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n] ?? m).trim();
}

async function tryAll(strategies, arg) {
  const errors = [];
  for (const fn of strategies) {
    try { return await fn(arg); } catch (e) { errors.push(e.message); }
  }
  throw new Error([...new Set(errors)].join(' | '));
}

const checkProduct = (url) =>
  tryAll(url.includes('/products/') ? [fromShopify, fromHtml] : [fromWooStoreApi, fromHtml], url);

// Búsquedas de novedades: lista de productos que encajan con una búsqueda en la tienda.
async function searchWoo({ store, query }) {
  const { origin } = new URL(store);
  const res = await get(`${origin}/wp-json/wc/store/v1/products?search=${encodeURIComponent(query)}&per_page=40&orderby=date&order=desc`, 'application/json');
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('WooCommerce: respuesta inesperada');
  return list.map(wooItem);
}

async function searchShopify({ store, query }) {
  const { origin } = new URL(store);
  const res = await get(`${origin}/search/suggest.json?q=${encodeURIComponent(query)}&resources[type]=product&resources[limit]=10&resources[options][unavailable_products]=last`, 'application/json');
  const list = (await res.json())?.resources?.results?.products;
  if (!Array.isArray(list)) throw new Error('Shopify: respuesta inesperada');
  return list.map((p) => ({
    url: new URL(p.url.split('?')[0], origin).href,
    inStock: p.available,
    name: p.title,
    priceValue: p.price != null ? Number(p.price) : null,
    image: absolute(p.image || p.featured_image?.url, origin),
  }));
}

// Guarda una copia de la foto dentro de docs/img para que la app la muestre
// aunque la tienda bloquee las imágenes enlazadas desde otras webs.
async function saveImage(src, prevLocal) {
  if (!src) return prevLocal || null;
  const ext = (new URL(src).pathname.match(/\.(jpe?g|png|webp|gif|avif)$/i)?.[1] || 'jpg').toLowerCase();
  const local = `img/${createHash('sha1').update(src).digest('hex').slice(0, 12)}.${ext}`;
  const file = new URL(`./docs/${local}`, import.meta.url);
  try { await access(file); return local; } catch { /* hay que descargarla */ }
  try {
    const res = await get(src, 'image/*');
    await mkdir(new URL('./docs/img/', import.meta.url), { recursive: true });
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
    return local;
  } catch (e) {
    console.log(`::warning::No se pudo descargar la imagen ${src}: ${e.message}`);
    return prevLocal || null;
  }
}

function parseSubscriptions() {
  const raw = process.env.PUSH_SUBSCRIPTIONS?.trim();
  if (!raw) return [];
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function notify({ title, body, url, badge }) {
  const subs = parseSubscriptions();
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (subs.length && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT || 'https://github.com/andresmend12-lab/jugapop', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, JSON.stringify({ title, body, url, badge }), { TTL: 3600, urgency: 'high' });
        console.log('Push enviado a', new URL(sub.endpoint).host);
      } catch (e) {
        console.log(`::warning::Push falló (${e.statusCode ?? '?'}): ${e.body || e.message}`);
        if (e.statusCode === 404 || e.statusCode === 410) {
          console.log('::warning::La suscripción ha caducado: vuelve a activar las notificaciones en la app y actualiza el secreto PUSH_SUBSCRIPTIONS.');
        }
      }
    }
  } else {
    console.log('::warning::Sin suscripciones push o claves VAPID configuradas.');
  }

  if (process.env.NTFY_TOPIC) {
    await fetch(`https://ntfy.sh/${encodeURIComponent(process.env.NTFY_TOPIC)}`, {
      method: 'POST',
      headers: { Title: encodeURIComponent(title), Click: url, Priority: 'high', Tags: 'rotating_light' },
      body,
    }).then((r) => console.log('ntfy:', r.status), (e) => console.log('::warning::ntfy falló:', e.message));
  }
}

if (process.env.TEST_NOTIFICATION === 'true') {
  await notify({ title: '🔔 Prueba de Stock Alerta', body: 'Si ves esto, las notificaciones funcionan.', url: PRODUCTS[0] });
  process.exit(0);
}

const prevAll = await readJson('./docs/status.json', {});
const prevProducts = Object.fromEntries((prevAll.products || []).map((p) => [p.url, p]));
const searchKey = (s) => `${new URL(s.store).origin}|${s.query.toLowerCase()}`;
const prevSearches = Object.fromEntries((prevAll.searches || []).map((s) => [s.key, s]));
const now = new Date().toISOString();
const outbox = [];
const shortName = (name) => (name && name.length > 60 ? `${name.slice(0, 57)}…` : name);

// Lleva la cuenta de fallos seguidos y avisa si duran más de 10 minutos.
function trackFailure(prev, label, url, error) {
  const failingSince = prev.failingSince || now;
  let failAlerted = prev.failAlerted || false;
  if (!failAlerted && Date.parse(now) - Date.parse(failingSince) >= FAIL_ALERT_MS) {
    failAlerted = true;
    outbox.push({ title: `⚠️ No puedo comprobar ${label}`, body: `Lleva más de 10 minutos fallando: ${error}`, url });
  }
  // El texto del error solo se guarda al empezar a fallar, para no guardar cambios cada minuto.
  return { failingSince, failAlerted, error: prev.error || error };
}

function trackRecovery(prev, label, url) {
  if (prev.failAlerted) outbox.push({ title: `✅ Vuelvo a comprobar ${label}`, body: 'Las comprobaciones funcionan otra vez.', url });
}

const products = [];
for (const url of PRODUCTS) {
  const prev = prevProducts[url] || { url };
  const store = new URL(url).hostname.replace(/^www\./, '');
  let result;
  try {
    result = await checkProduct(url);
  } catch (e) {
    // Mantenemos el estado anterior: un fallo puntual de la web no debe dar falsos avisos.
    console.log(`::warning::No se pudo comprobar ${url}: ${e.message}`);
    products.push({ ...prev, store, ...trackFailure(prev, prev.name ? shortName(prev.name) : store, url, e.message) });
    continue;
  }
  trackRecovery(prev, prev.name ? shortName(prev.name) : store, url);
  console.log(`${result.inStock ? '✅ EN STOCK' : '❌ Agotado'} (${result.source}) — ${result.name || url}`);

  const name = result.name || prev.name || null;
  const priceValue = result.priceValue ?? prev.priceValue ?? null;
  const changed = prev.inStock !== result.inStock;
  const history = [...(prev.history || [])];
  if (changed || !history.length) history.push({ at: changed ? now : prev.lastChange || now, inStock: result.inStock });

  products.push({
    url,
    store,
    name,
    image: result.image || prev.image || null,
    imageLocal: await saveImage(result.image || prev.image, prev.imageLocal),
    price: euros(priceValue),
    priceValue,
    inStock: result.inStock,
    lastChange: changed ? now : prev.lastChange || now,
    history: history.slice(-HISTORY_MAX),
  });

  const label = `${shortName(name) || 'Tu producto'}${priceValue != null ? ` — ${euros(priceValue)}` : ''}`;
  if (result.inStock && prev.inStock !== true) {
    outbox.push({ title: `¡Hay stock en ${store}! 🎉`, body: `${label}. ¡Corre!`, url });
  } else if (!result.inStock && prev.inStock === true) {
    outbox.push({ title: `😢 Se ha agotado en ${store}`, body: `${shortName(name) || 'Tu producto'}. Te aviso si vuelve.`, url });
  }
  if (prev.priceValue != null && result.priceValue != null && result.priceValue < prev.priceValue - 0.005) {
    outbox.push({
      title: `💸 Ha bajado de precio en ${store}`,
      body: `${shortName(name) || 'Tu producto'}: ${euros(prev.priceValue)} → ${euros(result.priceValue)}`,
      url,
    });
  }
}

const searches = [];
for (const s of SEARCHES) {
  const key = searchKey(s);
  const prev = prevSearches[key];
  const store = new URL(s.store).hostname.replace(/^www\./, '');
  const label = `«${s.query}» en ${store}`;
  let items;
  try {
    items = await tryAll([searchWoo, searchShopify], s);
  } catch (e) {
    console.log(`::warning::No se pudo buscar ${label}: ${e.message}`);
    searches.push({ ...(prev || { key, store: s.store, query: s.query, seen: [], recent: [] }), ...trackFailure(prev || {}, label, s.store, e.message) });
    continue;
  }
  if (prev) trackRecovery(prev, label, s.store);

  const seen = new Set(prev?.seen || []);
  const fresh = items.filter((i) => i.url && !seen.has(i.url));
  console.log(`🔎 ${label}: ${items.length} resultados, ${prev ? fresh.length : 0} nuevos`);
  const recent = [...(prev?.recent || [])];
  // La primera vez solo memorizamos lo que ya existe, sin avisar.
  if (prev) {
    for (const i of fresh) {
      recent.unshift({
        url: i.url, name: i.name, image: i.image, imageLocal: await saveImage(i.image, null),
        price: euros(i.priceValue), inStock: i.inStock, foundAt: now,
      });
      outbox.push({
        title: `🆕 Nuevo en ${store}`,
        body: `${shortName(i.name)}${i.priceValue != null ? ` — ${euros(i.priceValue)}` : ''}${i.inStock ? ' · ¡con stock!' : ' · aún sin stock'}`,
        url: i.url,
      });
    }
  }
  for (const i of items) seen.add(i.url);
  searches.push({ key, store: s.store, query: s.query, seen: [...seen].slice(-300), recent: recent.slice(0, RECENT_MAX) });
}

const badge = products.filter((p) => p.inStock).length;
for (const n of outbox) await notify({ ...n, badge });

const nextAll = { products, searches };
if (JSON.stringify(nextAll) !== JSON.stringify(prevAll)) {
  await writeFile(STATUS_FILE, JSON.stringify(nextAll, null, 2) + '\n');
  console.log('Estado actualizado.');
}
