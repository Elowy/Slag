/**
 * Slag — indítófájl megosztott tárhelyhez (cPanel „Setup Node.js App”).
 *
 * MIÉRT ILYEN RÖVID EZ A FÁJL
 * A Node egy `.js` fájlt alapból régi (CommonJS) modulként futtat, és csak
 * akkor kezeli ES-modulként, ha a mappában ott van a `package.json` a
 * `"type": "module"` sorral. Tárhelyre feltöltéskor ez a fájl könnyen
 * lemarad — és akkor az `import` soroktól az egész alkalmazás elszáll
 * (500-as hiba, „Cannot use import statement outside a module”).
 *
 * A DINAMIKUS `import()` viszont MINDKÉT módban érvényes. Ezért itt nincs
 * se `import`, se `require`: csak ez az egy hívás, ami betölti az igazi
 * kiszolgálót. Így mindegy, milyen módban indul a fájl, és nem kell mellé
 * semmilyen további fájl.
 *
 * BEÁLLÍTÁS a cPanelben:
 *   Application root          : tank.luiz-tech.hu   (ahova a fájlokat tetted)
 *   Application URL           : tank.luiz-tech.hu   (a domain gyökere)
 *   Application startup file  : app.js
 *   Node.js version           : 18 vagy újabb
 *
 * `npm install` NEM kell: a projektnek nincs egyetlen függősége sem.
 */

import('./tools/web-server.mjs').catch((err) => {
  console.error('[slag] A kiszolgáló nem indult el:', err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
