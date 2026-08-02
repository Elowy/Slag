/**
 * Slag — az online szoba kezelőfelülete.
 *
 * Csak DOM: gombok, egy szövegmező a kódnak és egy másolható link. A játék
 * állapotáról semmit nem tud, csak a `NetPlay`-t szólítja meg, és a saját
 * paneljét frissíti.
 */

import { NetPlay } from './netplay.js';
import { relayReachable, defaultRelay } from './net.js';

const el = {};
let installed = false;

function $(id) { return document.getElementById(id); }

function setError(text) {
  if (!el.error) return;
  if (!text) { el.error.hidden = true; el.error.textContent = ''; return; }
  el.error.hidden = false;
  el.error.textContent = text;
}

function setStatus(text) {
  if (el.status) el.status.textContent = text;
}

/** A panel tartalma mindig a `NetPlay` állapotát tükrözi. */
function refresh() {
  if (!installed) return;
  const live = NetPlay.mode !== 'off';

  el.idle.hidden = live;
  el.room.hidden = !live;
  el.toggle.classList.toggle('live', live);

  if (live) {
    el.toggle.textContent = NetPlay.mode === 'host'
      ? `Szoba: ${NetPlay.code}`
      : `Csatlakozva: ${NetPlay.code}`;
    el.code.textContent = NetPlay.code || '------';
    el.link.value = NetPlay.link || '';
    el.link.hidden = !NetPlay.link;

    if (NetPlay.mode === 'host') {
      const n = NetPlay.peers.size;
      el.peers.textContent = n === 0
        ? 'Még senki nem csatlakozott. Küldd el a linket!'
        : `${n} játékos csatlakozott. Ők a lobbiban ugyanúgy beülnek egy helyre, mint aki melletted ül.`;
      setStatus('A szoba nyitva van. Nálad fut a meccs.');
    } else {
      el.peers.textContent = 'A gazda gépén fut a meccs — te az ő képét látod.';
      setStatus(NetPlay.status || 'Csatlakozva');
    }
  } else {
    el.toggle.textContent = 'Online szoba';
    setStatus('Játssz egy gépen, vagy hívj be másokat egy linkkel.');
  }

  if (NetPlay.error) setError(NetPlay.error);
}

function openPanel(open) {
  el.body.hidden = !open;
  el.toggle.setAttribute('aria-expanded', String(!!open));
}

async function hostRoom() {
  setError('');
  el.hostBtn.disabled = true;
  setStatus('Szoba nyitása…');
  try {
    if (!(await relayReachable())) {
      throw new Error(
        `Nem érem el a kiszolgálót (${defaultRelay()}). Indítsd el a relayt, `
        + 'vagy add meg a címét a link végén: ?relay=https://...',
      );
    }
    await NetPlay.openRoom();
    setError('');
  } catch (err) {
    setError(err.message || String(err));
  } finally {
    el.hostBtn.disabled = false;
    refresh();
  }
}

async function joinRoom(code) {
  setError('');
  el.joinBtn.disabled = true;
  setStatus('Csatlakozás…');
  try {
    await NetPlay.joinRoom(code);
    setError('');
  } catch (err) {
    setError(err.message || String(err));
  } finally {
    el.joinBtn.disabled = false;
    refresh();
  }
}

function leaveRoom() {
  NetPlay.close();
  setError('');
  refresh();
}

async function copyLink() {
  const text = el.link.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    el.copyBtn.textContent = 'Kész!';
  } catch {
    // Vágólap-engedély nélkül is legyen kiút: kijelöljük, hadd másolja kézzel.
    el.link.select();
    el.copyBtn.textContent = 'Ctrl+C';
  }
  setTimeout(() => { el.copyBtn.textContent = 'Másol'; }, 1400);
}

/** Beköti a panelt. A linkben kapott szobakódra magától felajánlja a belépést. */
export function installOnlineUI() {
  const root = $('online');
  if (!root) return;

  el.root = root;
  el.toggle = $('online-toggle');
  el.body = $('online-body');
  el.status = $('online-status');
  el.idle = $('online-idle');
  el.room = $('online-room');
  el.hostBtn = $('online-host');
  el.joinBtn = $('online-join');
  el.codeInput = $('online-code');
  el.code = $('online-room-code');
  el.link = $('online-link');
  el.copyBtn = $('online-copy');
  el.peers = $('online-peers');
  el.leaveBtn = $('online-leave');
  el.error = $('online-error');

  installed = true;
  root.hidden = false;

  el.toggle.addEventListener('click', () => openPanel(el.body.hidden));
  el.hostBtn.addEventListener('click', hostRoom);
  el.joinBtn.addEventListener('click', () => joinRoom(el.codeInput.value));
  el.copyBtn.addEventListener('click', copyLink);
  el.leaveBtn.addEventListener('click', leaveRoom);
  el.codeInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); joinRoom(el.codeInput.value); }
  });
  // A játék WASD/Space billentyűit ne a szövegmező nyelje el.
  el.codeInput.addEventListener('keydown', (ev) => ev.stopPropagation());

  window.addEventListener('beforeunload', () => NetPlay.close());

  const invited = NetPlay.pendingRoomCode;
  if (invited) {
    el.codeInput.value = invited;
    openPanel(true);
    setStatus(`Meghívtak a(z) ${invited} szobába — csatlakozás…`);
    joinRoom(invited);
  }

  refresh();
  setInterval(refresh, 1000);
}

/** A meccs alatt halványabb és összecsukott, hogy ne takarja a játékteret. */
export function setOnlinePlaying(playing) {
  if (!installed) return;
  el.root.classList.toggle('playing', !!playing);
  if (playing) openPanel(false);
}
