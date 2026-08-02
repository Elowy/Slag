/**
 * Slag — belépési pont megosztott tárhelyhez (cPanel „Setup Node.js App”).
 *
 * A cPanel Node-alkalmazása egy indítófájlt vár, és Phusion Passengerrel
 * futtatja. Ez a fájl semmi mást nem csinál, csak elindítja a szoba-relayt.
 *
 * BEÁLLÍTÁS a cPanelben:
 *   Application root          : slag-relay          (a webgyökéren KÍVÜL)
 *   Application URL           : tank.luiz-tech.hu/relay
 *   Application startup file  : app.js
 *   Node.js version           : 18 vagy újabb
 *
 * Az alkalmazás gyökere szándékosan nem a weboldalé: így a `tools/` és a
 * `package.json` nem lesz böngészőből letölthető.
 *
 * `npm install` NEM kell: a projektnek nincs egyetlen függősége sem.
 *
 * A portot a Passenger adja a `PORT` környezeti változóban; a relay ezt
 * magától felveszi. A játék pedig így találja meg a relayt:
 *
 *   <script>window.SLAG_RELAY = 'https://tank.luiz-tech.hu/relay';</script>
 *
 * (Az `index.html`-be, a modul betöltése ELŐTT. Vagy a linkben:
 *  `?relay=https://tank.luiz-tech.hu/relay`.)
 */

import './tools/relay-server.mjs';
