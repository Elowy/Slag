/**
 * Slag — gépi ellenfelek (botok).
 *
 * A bot NEM kap külön szabályokat: pontosan ugyanazt az input-alakot állítja
 * elő, amit egy kontroller (`moveX/moveY/moveMag`, `aimX/aimY/aimMag`,
 * `fireHeld`), és a `Tank.update()` ugyanúgy dolgozza fel. Így a bot nem tud
 * gyorsabban gyorsulni, élesebben fordulni vagy sűrűbben lőni, mint egy ember
 * — a nehézség kizárólag a döntések minőségéből jön, nem csalásból.
 *
 * DÖNTÉS vs. KIMENET
 * A drága rész (célválasztás, látóvonal, akadálykerülő próbasugarak) csak
 * `THINK_HZ`-enként fut, a kimenet viszont minden lépésben frissül. A botok
 * indulási fázisa el van csúsztatva egymáshoz képest, hogy ne ugyanabban a
 * lépésben gondolkodjon mind a három.
 *
 * MIÉRT NEM PATTANÓ LÖVÉS
 * A bot csak akkor tüzel, ha a cél közvetlen látóvonalban van. Falról
 * visszapattanó lövést szándékosan nem tervez: kiszámíthatatlanná tenné a
 * nehézséget, és a játékos számára érthetetlen halálokat okozna.
 */

import { CONFIG } from './config.js';
import { pathBlocked, pathClearance } from './arena.js';
import { clamp, rand, angleDiff, dist } from './util.js';

const TAU = Math.PI * 2;

/** Döntési frekvencia. 20 Hz bőven elég, és 3 botnál is elhanyagolható. */
const THINK_INTERVAL = 1 / 20;

/** Meddig előre nézünk, amikor egy irány járhatóságát próbáljuk. */
const PROBE_DIST = 115;

/** Hány irányjelöltet vizsgálunk az akadálykerülésnél (párosával, +/-). */
const PROBE_CANDIDATES = 9;
const PROBE_STEP = Math.PI / 8;

/** Ennél lassabban haladva (px/s) a bot beszorultnak tekinti magát. */
const STUCK_SPEED = 24;
const STUCK_TIME = 0.9;

/** Lövedék-kitérés: eddig a távolságig nézünk előre a becsapódó lövedékkel. */
const DODGE_LOOKAHEAD = 300;
const DODGE_MARGIN = 26;

/** Ezen belül érdemes ládáért letérni. */
const PICKUP_RANGE = 320;

/**
 * Nehézségi szintek.
 *
 * `aimError`  — radiánban mért célzási hiba. LÖVÉSENKÉNT sorsolódik újra és
 *               a lövésig rögzített marad, különben a torony rááll a hibás
 *               szögre, a hiba közben elsodródik, és a bot kicélozza magát.
 * `reaction`  — másodperc, amíg új cél megjelenése után egyáltalán tüzelni kezd
 * `lead`      — mennyire vezeti meg a mozgó célt (0 = egyáltalán nem, 1 = pontosan)
 * `fireArc`   — ekkora szögeltérésen belül húzza meg a ravaszt
 * `fireGap`   — kényszerített szünet két lövés között. FIGYELEM: csak akkor
 *               számít, ha nagyobb a `CONFIG.tank.reloadTime`-nál (0.42 s) —
 *               az alatti érték nem lassítja a botot, mert úgyis a reload a
 *               szűk keresztmetszet. A `0` jelenti a "csak a reload korlátoz".
 * `throttle`  — gázadás felső korlátja
 * `dodge`     — mennyire tér ki a felé tartó lövedék elől (0..1)
 * `range`     — a preferált harci távolság
 */
export const BOT_LEVELS = Object.freeze([
  Object.freeze({
    id: 'easy', name: 'Könnyű',
    aimError: 0.55, reaction: 0.55, lead: 0.25, fireArc: 0.34,
    fireGap: 0.85, throttle: 0.65, dodge: 0.10, range: 380,
  }),
  Object.freeze({
    id: 'normal', name: 'Közepes',
    aimError: 0.30, reaction: 0.30, lead: 0.70, fireArc: 0.22,
    fireGap: 0.50, throttle: 0.85, dodge: 0.45, range: 325,
  }),
  Object.freeze({
    id: 'hard', name: 'Nehéz',
    aimError: 0.145, reaction: 0.12, lead: 1.0, fireArc: 0.16,
    fireGap: 0, throttle: 1.0, dodge: 0.9, range: 290,
  }),
]);

/** @returns {object} a szint definíciója; ismeretlen id esetén a Közepes. */
export function botLevel(id) {
  for (let i = 0; i < BOT_LEVELS.length; i++) {
    if (BOT_LEVELS[i].id === id) return BOT_LEVELS[i];
  }
  return BOT_LEVELS[1];
}

/** Semleges, kontroller-alakú input. A mezőnevek `input.js`-t követik. */
function makeBotState() {
  return {
    moveX: 0, moveY: 0, moveMag: 0,
    aimX: 0, aimY: 0, aimMag: 0,
    fire: 0, fireHeld: false, firePressed: false,
    confirmPressed: false, cancelPressed: false,
    prevPressed: false, nextPressed: false, startPressed: false,
    upPressed: false, downPressed: false, anyPressed: false,
  };
}

function neutralise(s) {
  s.moveX = 0; s.moveY = 0; s.moveMag = 0;
  s.aimX = 0; s.aimY = 0; s.aimMag = 0;
  s.fire = 0; s.fireHeld = false; s.firePressed = false;
}

/**
 * Egyetlen bot "agya". Egy tankhoz tartozik, és a meccs végéig él.
 *
 * @example
 *   const brain = new BotBrain('normal', 2);
 *   tank.update(dt, brain.update(tank, world, dt), world);
 */
export class BotBrain {
  /**
   * @param {string} levelId `BOT_LEVELS` valamelyik id-je
   * @param {number} [seed] slot index — csak a botok fázisának szétszórására
   */
  constructor(levelId, seed = 0) {
    this.level = botLevel(levelId);

    // A gondolkodás fázisa botonként eltolva, hogy ne egyszerre fussanak.
    this._think = (seed % 4) * (THINK_INTERVAL / 4);

    this._targetIndex = -1;
    this._aimAngle = 0;
    this._aimErr = 0;
    /** Kér-e új célzási hibát (lövés után és célváltáskor igen). */
    this._newAim = true;
    this._desired = rand(0, TAU);
    this._throttle = 0;
    this._canFire = false;

    this._reaction = 0;
    this._shotGap = 0;

    this._strafeDir = (seed % 2) ? 1 : -1;
    this._strafeTimer = rand(1.2, 2.8);

    this._wander = rand(0, TAU);
    this._stuck = 0;
    this._unstuck = 0;

    this._out = makeBotState();
  }

  /**
   * Egy lépésnyi döntés.
   * @param {object} tank a bot saját tankja
   * @param {object} world a teljes világ (tanks, bullets, pickups, arena)
   * @param {number} dt másodperc
   * @returns {object} kontroller-alakú input, amit a `Tank.update()` megeszik
   */
  update(tank, world, dt) {
    const out = this._out;
    neutralise(out);

    if (!tank || !tank.alive) {
      this._canFire = false;
      this._reaction = this.level.reaction;
      return out;
    }

    this._shotGap = Math.max(0, this._shotGap - dt);
    this._reaction = Math.max(0, this._reaction - dt);

    this._strafeTimer -= dt;
    if (this._strafeTimer <= 0) {
      this._strafeDir = -this._strafeDir;
      this._strafeTimer = rand(1.4, 3.0);
    }

    this._think -= dt;
    if (this._think <= 0) {
      this._think = THINK_INTERVAL;
      this._decide(tank, world);
    }

    // Beszorulás: ha gázt adunk, de alig mozgunk, egy időre random irányba
    // fordulunk. Enélkül egy sarokban végtelenségig nyomná a falat.
    const speed = Math.hypot(tank.vx, tank.vy);
    if (this._throttle > 0.2 && speed < STUCK_SPEED) this._stuck += dt;
    else this._stuck = 0;

    if (this._stuck > STUCK_TIME) {
      // A kiszabadulás iránya NEM lehet vaktában választott: a régi változat
      // random szöget húzott, ami ugyanolyan eséllyel mutatott vissza a falba,
      // és a bot ott ragadt. A `_decide` a következő tickben a legszabadabb
      // irányt adja; addig egyszerűen hátramenetben tolatunk el a faltól.
      this._unstuck = rand(0.45, 0.95);
      this._wander = Math.atan2(-Math.sin(tank.angle), -Math.cos(tank.angle));
      this._stuck = 0;
    }
    if (this._unstuck > 0) this._unstuck -= dt;

    // Beszorulás közben is kerüljük a falat — enélkül a kiszabadító irány
    // maga is nekivihette a tankot egy másik falnak.
    const walls = (world.arena && world.arena.walls) || [];
    const heading = this._unstuck > 0
      ? this._avoidWalls(tank, this._wander, walls)
      : this._desired;
    out.moveX = Math.cos(heading);
    out.moveY = Math.sin(heading);
    out.moveMag = this._unstuck > 0 ? this.level.throttle : this._throttle;

    out.aimX = Math.cos(this._aimAngle);
    out.aimY = Math.sin(this._aimAngle);
    out.aimMag = 1;

    // A `fireGap` csak akkor induljon, ha a lövés tényleg el is megy: ha a
    // reload még jár, a ravasz húzása nem "használ el" egy lövésközt.
    const ready = tank.reload <= 0;
    const shoot = this._canFire && ready && this._reaction <= 0 && this._shotGap <= 0;
    if (shoot) {
      out.fireHeld = true;
      out.fire = 1;
      this._shotGap = this.level.fireGap;
      // A következő lövés új hibát kap — nem "belövi magát" sorozatban.
      this._newAim = true;
    }

    return out;
  }

  /**
   * A drága rész: célválasztás, célzás, tüzelési engedély és haladási irány.
   * @private
   */
  _decide(tank, world) {
    const walls = (world.arena && world.arena.walls) || [];
    const level = this.level;

    const target = this._pickTarget(tank, world, walls);

    if (!target) {
      // Senki sincs életben rajtunk kívül: csak ne álljunk meg butén.
      this._canFire = false;
      this._desired = this._avoidWalls(tank, this._wander, walls);
      this._throttle = level.throttle * 0.5;
      return;
    }

    if (target.index !== this._targetIndex) {
      this._targetIndex = target.index;
      this._reaction = level.reaction;
      this._newAim = true;
    }

    // ---- célzás: becsapódási pont megvezetéssel -----------------------------
    const d = dist(tank.x, tank.y, target.x, target.y);
    const shotSpeed = tank.rocketAmmo > 0 ? CONFIG.rocket.speed : CONFIG.bullet.speed;
    const flight = (d / shotSpeed) * level.lead;
    const px = target.x + (target.vx || 0) * flight;
    const py = target.y + (target.vy || 0) * flight;

    // A célzási hiba LÖVÉSENKÉNT rögzített, nem folyamatosan sodródó.
    //
    // Sodródó hibával a bot sokkal pontosabb volt, mint a beállítás sugallta:
    // a torony ráállt a hibás szögre, a `fireArc` addig nem engedett tüzelni,
    // és mire összeért a kettő, a hiba már elsodródott a valódi irány felé —
    // vagyis a bot kicélozta magát. Rögzített hibával a cső tényleg a mellé
    // mutató irányba áll be, és oda is lő.
    if (this._newAim) {
      this._aimErr = rand(-level.aimError, level.aimError);
      this._newAim = false;
    }
    this._aimAngle = Math.atan2(py - tank.y, px - tank.x) + this._aimErr;

    // ---- tüzelési engedély --------------------------------------------------
    const bl = CONFIG.tank.barrelLength;
    const mx = tank.x + Math.cos(tank.turretAngle) * bl;
    const my = tank.y + Math.sin(tank.turretAngle) * bl;
    const clear = !pathBlocked(mx, my, px, py, walls);
    const aligned = Math.abs(angleDiff(this._aimAngle, tank.turretAngle)) < level.fireArc;
    // Sebezhetetlen (frissen újraéledt) célra lőni tiszta lőszerpazarlás.
    this._canFire = clear && aligned && !(target.invulnTimer > 0);

    // ---- haladási irány -----------------------------------------------------
    const toTarget = Math.atan2(target.y - tank.y, target.x - tank.x);
    let wantX;
    let wantY;

    const crate = this._nearestCrate(tank, world, walls);
    if (crate && d > level.range * 0.75) {
      // Van láda a közelben és nem vagyunk közelharcban: érte megyünk.
      const a = Math.atan2(crate.y - tank.y, crate.x - tank.x);
      wantX = Math.cos(a);
      wantY = Math.sin(a);
    } else if (d > level.range * 1.35) {
      wantX = Math.cos(toTarget); wantY = Math.sin(toTarget);
    } else if (d < level.range * 0.6) {
      wantX = -Math.cos(toTarget); wantY = -Math.sin(toTarget);
    } else {
      const a = toTarget + this._strafeDir * (Math.PI / 2);
      wantX = Math.cos(a); wantY = Math.sin(a);
    }

    // Kitérés a felénk tartó lövedékek elől, a kívánt irányra rákeverve.
    const esc = this._dodge(tank, world);
    if (esc) {
      const w = level.dodge;
      wantX = wantX * (1 - w) + esc.x * w * 1.6;
      wantY = wantY * (1 - w) + esc.y * w * 1.6;
    }

    const want = Math.atan2(wantY, wantX);
    this._desired = this._avoidWalls(tank, want, walls);
    this._throttle = level.throttle;
  }

  /**
   * Legjobb célpont: a látható és közeli ellenfél nyer. A jelenlegi célpont
   * kap egy kis bónuszt, különben két egyforma távoli ellenfél között
   * oda-vissza kapkodna.
   * @private
   */
  _pickTarget(tank, world, walls) {
    const tanks = world.tanks || [];
    let best = null;
    let bestScore = -Infinity;

    for (let i = 0; i < tanks.length; i++) {
      const t = tanks[i];
      if (!t || t === tank || !t.alive) continue;

      const d = dist(tank.x, tank.y, t.x, t.y);
      const visible = !pathBlocked(tank.x, tank.y, t.x, t.y, walls);
      let score = -d;
      if (visible) score += 1400;
      if (t.index === this._targetIndex) score += 200;
      // Sebezhetetlen célpont kevésbé vonzó, de nem tiltott: érdemes felé
      // menni, mire lejár a védettsége.
      if (t.invulnTimer > 0) score -= 500;

      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  /**
   * Egy irány szabadsága 0..1 között, a hull szélességét is figyelembe véve.
   * Három párhuzamos sugár (közép + a két oldal), a legrosszabb számít.
   * @private
   */
  _clearance(tank, angle, walls) {
    const r = tank.radius;
    const cx = Math.cos(angle);
    const cy = Math.sin(angle);
    const nx = -cy * r;
    const ny = cx * r;
    const ex = tank.x + cx * PROBE_DIST;
    const ey = tank.y + cy * PROBE_DIST;

    return Math.min(
      pathClearance(tank.x, tank.y, ex, ey, walls),
      pathClearance(tank.x + nx, tank.y + ny, ex + nx, ey + ny, walls),
      pathClearance(tank.x - nx, tank.y - ny, ex - nx, ey - ny, walls),
    );
  }

  /**
   * A kívánt irányból kiindulva megkeresi a legjárhatóbb irányt.
   *
   * FONTOS: nem igen/nem "torlaszolt" alapon dönt, hanem TÁVOLSÁGGAL. A
   * korábbi változat minden torlaszolt irányt egyformán rossznak (-1000)
   * tekintett, így egy sarokban — ahol minden irány torlaszolt — a legkisebb
   * eltérésű, vagyis az egyenesen előre mutató irányt választotta: a bot
   * nekihajtott a falnak és ott maradt. A szabad hányad mérésével mindig a
   * legtöbb helyet adó irány nyer.
   * @private
   */
  _avoidWalls(tank, want, walls) {
    let best = want;
    let bestScore = -Infinity;

    for (let i = 0; i < PROBE_CANDIDATES; i++) {
      // 0, +1, -1, +2, -2 ... lépésekben távolodunk a kívánt iránytól.
      const step = Math.ceil(i / 2) * ((i % 2) ? 1 : -1);
      const a = want + step * PROBE_STEP;
      const clear = this._clearance(tank, a, walls);

      // A szabad hányad dominál, az iránytartás csak finomhangol.
      const score = clear * 100 - Math.abs(step) * 6;
      if (score > bestScore) { bestScore = score; best = a; }
      // Teljesen szabad és egyenes előre: ennél jobb nem lesz.
      if (clear >= 1 && step === 0) break;
    }

    // Minden irány erősen zárt (beszorult sarok): teljes körben keresünk
    // kiutat, akár hátrafelé is.
    if (bestScore < 25) {
      for (let i = 0; i < 16; i++) {
        const a = want + Math.PI + (i - 8) * (Math.PI / 8);
        const clear = this._clearance(tank, a, walls);
        const score = clear * 100 - Math.abs(i - 8) * 2;
        if (score > bestScore) { bestScore = score; best = a; }
      }
    }
    return best;
  }

  /**
   * Egységvektor a legfenyegetőbb lövedéktől OLDALRA, vagy null.
   * Csak az számít, ami felénk tart és nagyjából el is talál.
   * @private
   */
  _dodge(tank, world) {
    const bullets = world.bullets || [];
    let bestAlong = Infinity;
    let esc = null;

    for (let i = 0; i < bullets.length; i++) {
      const b = bullets[i];
      if (!b || b.dead || b.ownerIndex === tank.index) continue;

      const sp = Math.hypot(b.vx, b.vy);
      if (sp < 1e-3) continue;
      const ux = b.vx / sp;
      const uy = b.vy / sp;

      const rx = tank.x - b.x;
      const ry = tank.y - b.y;

      // Menetirány szerinti távolság: negatív = már elhaladt mellettünk.
      const along = rx * ux + ry * uy;
      if (along <= 0 || along > DODGE_LOOKAHEAD || along >= bestAlong) continue;

      // Oldalirányú eltérés: ennyivel megy el mellettünk.
      const side = rx * -uy + ry * ux;
      if (Math.abs(side) > tank.radius + DODGE_MARGIN) continue;

      // Arra lépünk ki, amerre már amúgy is állunk a lövedék vonalához képest.
      const dir = side >= 0 ? 1 : -1;
      esc = { x: -uy * dir, y: ux * dir };
      bestAlong = along;
    }
    return esc;
  }

  /**
   * A legközelebbi felvehető láda, ha közel van és el is érhető.
   * @private
   */
  _nearestCrate(tank, world, walls) {
    const pickups = world.pickups || [];
    let best = null;
    let bestD = PICKUP_RANGE;

    for (let i = 0; i < pickups.length; i++) {
      const p = pickups[i];
      // A zuhanó láda még nem vehető fel — nincs értelme alá állni.
      if (!p || p.dead || p.state !== 'idle') continue;

      const d = dist(tank.x, tank.y, p.x, p.y);
      if (d >= bestD) continue;
      if (pathBlocked(tank.x, tank.y, p.x, p.y, walls)) continue;

      bestD = d;
      best = p;
    }
    return best;
  }
}

/** Bot nevek a lobbihoz és a HUD-hoz. */
export function botName(slotIndex) {
  return `${clamp(slotIndex, 0, 3) + 1}. gép`;
}
