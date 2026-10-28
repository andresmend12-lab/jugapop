// Diagnóstico: muestra qué responde una página de producto y qué detecta check.mjs.
const url = process.argv[2];
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'es-ES,es;q=0.9' }, redirect: 'follow' });
const html = await res.text();
console.log('HTTP', res.status, res.url);
console.log('server:', res.headers.get('server'), '| tamaño:', html.length);
console.log('título:', html.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim());
for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
  console.log('JSON-LD:', m[1].replace(/\s+/g, ' ').slice(0, 600));
}
for (const re of [/availability[^,]{0,80}/gi, /(agotado|sin stock|no disponible|añadir al carrito|add-to-cart|stock)[^<]{0,60}/gi]) {
  console.log(re.source, '→', [...new Set(html.match(re) || [])].slice(0, 10));
}
console.log('inicio:', html.slice(0, 400).replace(/\s+/g, ' '));
// Bloques de producto en páginas de categoría (WooCommerce).
const blocks = [...html.matchAll(/<(?:li|div)[^>]+class="[^"]*\b(?:type-product|wd-product)\b[^"]*"[^>]*>/g)];
console.log('bloques de producto:', blocks.length);
for (const b of blocks.slice(0, 2)) console.log('BLOQUE:', html.slice(b.index, b.index + 1500).replace(/\s+/g, ' '));
console.log('paginación:', [...new Set(html.match(/\/page\/\d+\//g) || [])]);
