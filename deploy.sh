#!/usr/bin/env bash
#
# Slag — feltöltés megosztott tárhelyre (cPanel „Setup Node.js App”).
#
# HASZNÁLAT — a SZERVEREN futtatva, egy git-munkamásolatból:
#
#   cd /tmp/slag && git pull
#   ./deploy.sh /home/luiztecs/tank.luiz-tech.hu
#
# vagy környezeti változóval:
#
#   SLAG_TARGET=/home/luiztecs/tank.luiz-tech.hu ./deploy.sh
#
# MIÉRT VAN RÁ SZÜKSÉG
# A kézi másolásnak három csapdája van, és mindháromba bele lehet lépni:
#
#  1. `cp -r src cél/` — ha a célban MÁR VAN `src/`, ez `cél/src/src`-et csinál
#     belőle, és a játék néma 404-ekkel áll meg. Ezért itt fájlonként másolunk.
#  2. Könnyű kihagyni valamit. Egyszer csak az `app.js` és a `tools/` ment ki,
#     a `src/` nem — a szoba ment, a fénysáv nem.
#  3. A `tmp/restart.txt` az ALKALMAZÁS mappájába kell, nem oda, ahol épp állsz.
#
# A script ezen felül ELLENŐRIZ is: a végén megnézi, hogy a kint lévő fájlok
# tényleg azonosak-e a helyiekkel, és hogy a szoba-kiszolgáló válaszol-e.

set -euo pipefail

TARGET="${1:-${SLAG_TARGET:-}}"
SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -z "$TARGET" ]; then
  echo "Hiba: nincs megadva a célmappa." >&2
  echo "Használat: $0 /home/FELHASZNALO/domain.hu" >&2
  exit 1
fi

if [ ! -d "$TARGET" ]; then
  echo "Hiba: a célmappa nem létezik: $TARGET" >&2
  exit 1
fi

if [ ! -f "$SOURCE/index.html" ] || [ ! -d "$SOURCE/src" ]; then
  echo "Hiba: ez nem egy Slag-munkamásolat: $SOURCE" >&2
  exit 1
fi

echo "Forrás: $SOURCE"
echo "Cél:    $TARGET"
echo

# --- 1. A játék (statikus fájlok) -------------------------------------------
echo "→ index.html, styles.css"
cp -f "$SOURCE/index.html" "$SOURCE/styles.css" "$TARGET/"

echo "→ src/ ($(ls -1 "$SOURCE"/src/*.js | wc -l) modul)"
mkdir -p "$TARGET/src"
cp -f "$SOURCE"/src/*.js "$TARGET/src/"

# --- 2. A kiszolgáló (szobák + statikus kiszolgálás) ------------------------
echo "→ app.js, tools/"
cp -f "$SOURCE/app.js" "$TARGET/"
mkdir -p "$TARGET/tools"
cp -f "$SOURCE"/tools/*.mjs "$TARGET/tools/"

# Egy korábbi `cp -r tools cél/` ide tehetett egy fölösleges mappát.
if [ -d "$TARGET/tools/tools" ]; then
  echo "→ a korábbi másolásból ott maradt tools/tools eltávolítása"
  rm -rf "$TARGET/tools/tools"
fi
if [ -d "$TARGET/src/src" ]; then
  echo "→ a korábbi másolásból ott maradt src/src eltávolítása"
  rm -rf "$TARGET/src/src"
fi

# --- 3. Passenger újraindítása ----------------------------------------------
# Csak a Node-oldal (app.js, tools/) igényli; a statikus fájlokat az Apache
# közvetlenül adja ki. Újraindítani viszont ártalmatlan, ezért mindig megtesszük.
echo "→ újraindítás kérése (tmp/restart.txt)"
mkdir -p "$TARGET/tmp"
touch "$TARGET/tmp/restart.txt"

# --- 4. Ellenőrzés -----------------------------------------------------------
echo
echo "Ellenőrzés:"
fail=0
for f in index.html styles.css app.js; do
  if cmp -s "$SOURCE/$f" "$TARGET/$f"; then
    echo "  ✓ $f"
  else
    echo "  ✗ $f — a kint lévő fájl NEM azonos a helyivel"; fail=1
  fi
done

missing=0
for f in "$SOURCE"/src/*.js; do
  name="$(basename "$f")"
  cmp -s "$f" "$TARGET/src/$name" || { echo "  ✗ src/$name"; missing=$((missing + 1)); fail=1; }
done
[ "$missing" -eq 0 ] && echo "  ✓ src/ — minden modul azonos"

# A szoba-kiszolgáló csak akkor mérhető, ha a domain kívülről is elérhető.
# Ez nem kötelező lépés: enélkül a játék megy, csak az online szoba nem.
if [ -n "${SLAG_URL:-}" ] && command -v curl >/dev/null 2>&1; then
  echo
  echo "→ szoba-kiszolgáló: $SLAG_URL/api/health"
  sleep 3
  if curl -fsS --max-time 15 "$SLAG_URL/api/health" | grep -q '"ok":true'; then
    echo "  ✓ a szobák elérhetők"
  else
    echo "  ✗ a szoba-kiszolgáló nem válaszol — lásd a README hibaelhárítás fejezetét"
    fail=1
  fi
fi

echo
if [ "$fail" -ne 0 ]; then
  echo "KÉSZ, DE HIBÁVAL — nézd át a fenti ✗ sorokat."
  exit 1
fi
echo "KÉSZ — minden fájl a helyén van."
