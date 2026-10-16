// Comprueba el stock de los productos de products.json (tiendas WooCommerce como
// jugapop.com o Shopify como jjcollection.es) y, cuando uno pasa de "agotado" a
// "disponible", envía una notificación push al iPhone.
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
const PRODUCTS = JSON.parse(await readFile(new URL('./products.json', import.meta.url), 'utf8'));
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

async function get(url, accept) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'es-ES,es;q=0.9' },
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res;
}

const euros = (cents, minor = 2) => `${(Number(cents) / 10 ** minor).toFixed(minor).replace('.', ',')} €`;
const handleOf = (url) => new URL(url).pathname.split('/').filter(Boolean).pop();

// Shopify: /products/<handle>.js devuelve el producto con "available".
async function fromShopify(url) {
  const { origin, pathname } = new URL(url);
  if (!pathname.includes('/products/')) throw new Error('No es una URL de Shopify');
  const p = await (await get(`${origin}/products/${handleOf(url)}.js`, 'application/json')).json();
  if (typeof p.available !== 'boolean') throw new Error('Shopify: respuesta inesperada');
  const img = p.featured_image || p.images?.[0];
  return {
    inStock: p.available || (p.variants || []).some((v) => v.available),
    name: p.title,
    price: p.price != null ? euros(p.price) : null,
    image: img ? (img.startsWith('//') ? `https:${img}` : img) : null,
    source: 'shopify',
  };
}

// WooCommerce: API pública Store API.
async function fromWooStoreApi(url) {
  const { origin } = new URL(url);
  const res = await get(`${origin}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(handleOf(url))}`, 'application/json');
  const [p] = await res.json();
  if (!p) throw new Error('Store API: producto no encontrado');
  return {
    inStock: Boolean(p.is_in_stock && p.is_purchasable !== false),
    name: decodeEntities(p.name),
    price: p.prices?.price ? euros(p.prices.price, p.prices.currency_minor_unit ?? 2) : null,
    image: p.images?.[0]?.src || null,
    source: 'woocommerce',
  };
}

// Respaldo para cualquier tienda: analizar el HTML de la página del producto.
async function fromHtml(url) {
  const html = await (await get(url, 'text/html')).text();
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
    if (/class="[^"]*\bstock\b[^"]*\bout-of-stock\b/i.test(main) || /(Agotado|Sin existencias|Fuera de stock|Sold out)/i.test(main)) inStock = false;
    else if (/class="[^"]*\bstock\b[^"]*\bin-stock\b/i.test(main) || /name="add-to-cart"|single_add_to_cart_button/i.test(main)) inStock = true;
  }
  if (inStock === null) throw new Error('HTML: no se pudo determinar el stock');

  const meta = (prop) => html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`, 'i'))?.[1];
  return {
    inStock,
    name: decodeEntities(meta('og:title') || ''),
    price: null,
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

async function checkProduct(url) {
  const errors = [];
  const strategies = url.includes('/products/') ? [fromShopify, fromHtml] : [fromWooStoreApi, fromHtml];
  for (const fn of strategies) {
    try { return await fn(url); } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors.join(' | '));
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

async function notify({ title, body, url }) {
  const subs = parseSubscriptions();
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = process.env;
  if (subs.length && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(VAPID_SUBJECT || 'https://github.com/andresmend12-lab/jugapop', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(sub, JSON.stringify({ title, body, url }), { TTL: 3600, urgency: 'high' });
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

const prevAll = JSON.parse(await readFile(STATUS_FILE, 'utf8').catch(() => '{}'));
const prevByUrl = Object.fromEntries((prevAll.products || []).map((p) => [p.url, p]));
const now = new Date().toISOString();
const products = [];

for (const url of PRODUCTS) {
  const prev = prevByUrl[url] || { url };
  const store = new URL(url).hostname.replace(/^www\./, '');
  let result;
  try {
    result = await checkProduct(url);
  } catch (e) {
    // Mantenemos el estado anterior: un fallo puntual de la web no debe dar falsos avisos.
    console.log(`::warning::No se pudo comprobar ${url}: ${e.message}`);
    products.push(prev);
    continue;
  }
  console.log(`${result.inStock ? '✅ EN STOCK' : '❌ Agotado'} (${result.source}) — ${result.name || url}`);

  const next = {
    url,
    store,
    name: result.name || prev.name || null,
    image: result.image || prev.image || null,
    imageLocal: await saveImage(result.image || prev.image, prev.imageLocal),
    price: result.price || prev.price || null,
    inStock: result.inStock,
    lastChange: prev.inStock !== result.inStock ? now : prev.lastChange || now,
  };
  products.push(next);

  if (result.inStock && prev.inStock !== true) {
    await notify({
      title: `¡Hay stock en ${store}! 🎉`,
      body: `${next.name || 'Tu producto'}${next.price ? ` — ${next.price}` : ''}. ¡Corre!`,
      url,
    });
  }
}

const nextAll = { products };
if (JSON.stringify(nextAll) !== JSON.stringify(prevAll)) {
  await writeFile(STATUS_FILE, JSON.stringify(nextAll, null, 2) + '\n');
  console.log('Estado actualizado.');
}
