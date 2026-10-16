# 🔔 Stock Alerta

App web instalable en el iPhone (PWA) que te avisa con una notificación cuando
vuelve a haber stock de:

- [Pokémon TCG 30º aniversario – Caja de Entrenador Élite (Jugapop)](https://jugapop.com/product/pokemon-tcg-30o-aniversario-caja-de-entrenador-elite-6-anos/)
- [Pokémon TCG Elite Trainer Box 30th Celebration, inglés (JJ Collection)](https://www.jjcollection.es/products/pokemon-tcg-elite-trainer-box-30th-celebration-ingles)

## Cómo funciona

Un iPhone no deja que una web se quede comprobando cosas en segundo plano, así que el trabajo se reparte en dos partes:

1. **GitHub Actions** (`.github/workflows/check-stock.yml`) mira las tiendas **cada minuto** (cada ejecución dura ~55 min comprobando una vez por minuto y la siguiente arranca al terminar):
   - Jugapop (WooCommerce): usa la API pública de la tienda y, si falla, lee la página.
   - JJ Collection (Shopify): usa `…/products/<producto>.js`.
   - Guarda el resultado en `docs/status.json`. Cuando un producto pasa de *agotado* a *disponible*, envía una **notificación push** a tu iPhone.
2. **La app** (`docs/`, publicada con GitHub Pages) muestra el estado y activa las notificaciones.

## Puesta en marcha (una sola vez)

### 1. Publicar la app con GitHub Pages
GitHub Pages solo es gratis en repositorios **públicos**. En el repositorio no hay nada secreto (las claves van en *Secrets*), así que puedes hacerlo público:

1. *Settings → General → Danger Zone → Change visibility → Public*.
2. *Settings → Pages → Build and deployment*: **Deploy from a branch**, rama `main`, carpeta `/docs`.
3. Al minuto tendrás la app en `https://andresmend12-lab.github.io/jugapop/`.

### 2. Añadir la clave privada
*Settings → Secrets and variables → Actions → New repository secret*:

| Nombre | Valor |
|---|---|
| `VAPID_PRIVATE_KEY` | la clave privada VAPID que te he pasado (pareja de la pública de `docs/config.js`) |

> Si quieres claves nuevas: `npx web-push generate-vapid-keys`, pon la pública en `docs/config.js` y en el workflow, y la privada en el secreto.

### 3. Instalar la app en el iPhone (iOS 16.4 o superior)
1. Abre `https://andresmend12-lab.github.io/jugapop/` en **Safari**.
2. **Compartir → Añadir a pantalla de inicio**.
3. Abre la app desde el icono y pulsa **Activar notificaciones** → *Permitir*.
4. Pulsa **Copiar código**.

### 4. Registrar tu iPhone
Crea otro secreto llamado `PUSH_SUBSCRIPTIONS` y pega el código copiado.
Para varios dispositivos, pon una lista: `[{…iPhone…}, {…iPad…}]`.

### 5. Probar
*Actions → Comprobar stock → Run workflow*, marca **Enviar notificación de prueba** y ejecútalo. Te debería llegar un aviso.

## Opcional: aviso de respaldo con ntfy
Instala la app gratuita **ntfy** en el iPhone, suscríbete a un tema con un nombre difícil de adivinar (p. ej. `pokemon-ana-8f3k2`) y crea el secreto `NTFY_TOPIC` con ese nombre. Recibirás los avisos por las dos vías.

## Añadir o quitar productos
Edita `products.json` (una URL por línea). Sirven tiendas WooCommerce (`/product/…`), Shopify (`/products/…`) y, en general, cualquier página con datos de disponibilidad estándar.

## A tener en cuenta
- GitHub ejecuta las tareas programadas **solo en la rama por defecto** (`main`) y puede retrasarlas unos minutos en horas punta.
- Si el repositorio pasa **60 días sin actividad**, GitHub pausa las tareas programadas; basta con reactivarlas en la pestaña *Actions*.
- Si una tienda bloquea las peticiones, el aviso aparecerá como *warning* en el registro de *Actions* y se mantiene el último estado conocido (sin falsas alarmas).
- Si cambias de iPhone o borras la app, repite los pasos 3 y 4.
