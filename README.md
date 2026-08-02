# SLAG — négyfős tankcsata egy képernyőn

Négy ember, egy kanapé, egy monitor. A **Slag** felülnézetes tankcsata, ami közvetlenül a
böngésződben fut — nincs telepítés, nincs regisztráció, nincs internetkapcsolat.
Mindenki a saját PS5-kontrollerével játszik, ugyanazon a képernyőn.

Egy meccs 3–6 perc. Aki elsőként összeszedi a beállított pontszámot, nyer.

---

## 1. Indítás

Két út vezet a játékig — válaszd azt, amelyik kényelmesebb.

### A) Helyi szerverrel (ajánlott)

Ehhez [Node.js](https://nodejs.org) 18-as vagy újabb verzió kell.

```
npm start
```

Ezután nyisd meg a böngészőben:

```
http://localhost:8080
```

Más porton is futtathatod, ha a 8080 foglalt:

```
npm start -- --port 3000
```

### B) Egyetlen fájlból, szerver nélkül

```
npm run build
```

Ez létrehozza a **`dist/slag.html`** fájlt: egyetlen önálló HTML, amiben benne van az
egész játék. Dupla kattintás, és megy — nem kell hozzá se szerver, se internet.
Nyugodtan másold pendrive-ra vagy küldd el egy barátodnak.

> **Fontos:** magát az `index.html`-t **nem** tudod dupla kattintással megnyitni.
> A böngésző biztonsági okból nem engedi, hogy egy `file://` címről megnyitott oldal
> több JavaScript-modult töltsön be. Erre való a `dist/slag.html`.

### Egyedül, egyetlen kontrollerrel

Nem kell megvárnod a többieket: a lobbiban a **Gépi ellenfelek** sorban 1–3 gépi
tankot ülhetsz a szabad helyekre, a **Gép szintje** sorban pedig **Könnyű**,
**Közepes** vagy **Nehéz** szintet választhatsz. Egy ember + egy gép már elég
egy meccshez.

A gép ugyanazokkal a szabályokkal játszik, mint te: ugyanaz a gyorsulás, a
fordulás, az újratöltés és a lövedékkészlet — nem lát át a falakon, és csak
akkor lő, ha tényleg van rálátása. A nehézség abból jön, hogy mennyire pontosan
céloz, milyen gyorsan reagál, mennyire vezeti meg a mozgó célt, és mennyire tér
ki a feléje tartó lövedék elől.

Ha menet közben beül még egy ember, a gép átadja neki a helyét — az emberek
mindig elsőbbséget élveznek.

---

## 2. Kontroller csatlakoztatása

A játék minden „standard” elrendezésű kontrollert felismer, de PS5 DualSense-re
készült.

### USB kábellel

Dugd be. Kész.

### Bluetooth-szal

1. A kontroller legyen **kikapcsolva**.
2. Tartsd nyomva egyszerre a **PS gombot** és a **Create gombot** (a D-pad fölött,
   balra) kb. **5 másodpercig**, amíg a fénysáv gyorsan villogni nem kezd.
3. A számítógépeden nyisd meg a Bluetooth-beállításokat, és párosítsd a
   *„Wireless Controller”* vagy *„DualSense Wireless Controller”* eszközt.

### Az utolsó lépés: nyomj meg egy gombot!

A böngészők adatvédelmi okból **csak azután látják meg a kontrollert, hogy a játékos
megnyomott rajta egy gombot**. Ezért:

1. Nyisd meg a játékot, és **kattints a kezdőképernyőre** (ez engedélyezi a hangot is).
2. Utána **minden játékos nyomja meg az R2-t** a saját kontrollerén.

Ha ezt megtettétek, a lobbiban azonnal megjelenik mind a négy „Kontroller” felirat.
Minden padot külön-külön be kell „ébreszteni” egy gombnyomással.

---

## 3. Vezérlés

### Kontroller — játék közben

| Gomb | Mit csinál |
|---|---|
| **Jobb stick** | Mozgás. A stick iránya a haladás iránya; a tank arra fordul és elindul. Amennyire kinyomod, olyan gyorsan megy. |
| **R2** (analóg) | Lövés |
| **Bal stick** | *Opcionális* toronycélzás. Alapból a cső előre néz. Ha megmozdítod a bal sticket, a torony külön irányba fordul; ha 3 másodpercig elengeded, visszaáll előrenézésbe. |
| **Options** | Szünet be / ki (a visszaszámlálás alatt még nem él) |

### Szünet

A meccs magától megáll, ha valami elvenné tőletek az irányítást:

- **Lecsatlakozik egy kontroller** (a DualSense pár perc tétlenség után elalszik).
  A tankod különben mozdulatlan célpont lenne. Ha visszacsatlakozik, a meccs
  magától folytatódik; ha nem jönne vissza, az **Options** visszavisz a lobbiba.
- **Elveszti a fókuszt az ablak** (átkattintasz máshova). A böngésző ilyenkor
  befagyasztja a kontroller állapotát az utolsó értéken, vagyis a tankod
  magától menne tovább. Kattints vissza az ablakra, és folytatódik.
- **Valaki Optionst nyom**, mert szünetet kér.

### Kontroller — lobbi

| Gomb | Mit csinál |
|---|---|
| **R2** vagy **Kereszt** | Csatlakozás a szabad helyre, majd „Kész” jelzés |
| **D-pad fel / le** | Váltás a saját szín-sor és a közös beállítások (Pattogó lövedék / Pálya / Cél) között |
| **D-pad bal / jobb** vagy **L1 / R1** | Az aktuális sor értékének állítása (szín vagy beállítás) |
| **Kör** | Először visszavonja a „Kész” jelzést, utána kilépés a helyről |
| **Options** | A meccs indítása (legalább 2 **kész** játékos kell) |

A meccs elindításához **két kész játékos elég**: aki csatlakozott, de nem nyomott
készre, egyszerűen kimarad a meccsből — nem blokkolja a többieket. Ha egy
kontroller lecsatlakozik (lemerül, elveszti a kapcsolatot), a helye piros
kerettel jelzi ezt, és pár másodperc múlva magától felszabadul.

### Kontroller — a meccs végén

| Gomb | Mit csinál |
|---|---|
| **Kereszt** | Azonnali visszavágó ugyanezzel a felállással |
| **Options** vagy **Kör** | Vissza a lobbiba (szín- és beállításváltáshoz) |

### Billentyűzet

Ha nincs elég kontroller, két játékos billentyűzetről is beszállhat. A billentyűzetes
helyek mindig elérhetők a lobbiban.

| | **Billentyűzet A** | **Billentyűzet B** |
|---|---|---|
| Mozgás | `W` `A` `S` `D` | `I` `J` `K` `L` |
| Célzás (torony) | `↑` `←` `↓` `→` | `Numpad 8` `4` `5` `6` |
| Lövés | `Szóköz` | `Numpad 0` |
| Csatlakozás / Kész / OK | `Enter` | `Numpad Enter` |
| Kilépés / Vissza | `Esc` | `Numpad .` vagy `Backspace` |
| Sorváltás a lobbiban | `W` / `S` vagy `↑` / `↓` | `I` / `K` vagy `Numpad 8` / `5` |
| Érték állítása (szín, beállítás) | `Q` / `E` vagy `←` / `→` | `U` / `O` vagy `Numpad 4` / `6` |
| Meccs indítása | `Enter` (már kész állapotban) | `Numpad Enter` (már kész állapotban) |

Az `Enter` egyetlen billentyű két szereppel: amíg nem vagy kész, „Kész”-re
állít, utána — ha már legalább két játékos kész — elindítja a meccset. Egy
lenyomás mindig pontosan egy dolgot csinál; a készt az `Esc` vonja vissza.

### Bárhonnan elérhető gombok

| Gomb | Mit csinál |
|---|---|
| `F` vagy dupla kattintás | Teljes képernyő be / ki |
| `M` | Némítás be / ki |
| `F5` | Újratöltés (ha valami elakadna) |

---

## 4. Játékszabályok

- **Cél:** elsőként összegyűjteni a beállított pontszámot (alapból **15**).
- **Találat:** minden ellenfél kilövése **+1 pont**.
- **Öngól:** ha a saját, falról visszapattant lövedéked talál el, **nem veszítesz pontot**
  — a halál és a 2 másodperces kiesés önmagában elég büntetés. Az öngóljaid külön
  oszlopban látszanak a meccs végi eredménytáblán.
- **Halál után** 2 másodperccel újraéledsz egy szabad kezdőponton, és 2,2 másodpercig
  sebezhetetlen vagy — ilyenkor villog a tank.
- **Pattogó lövedék:** ha be van kapcsolva, a lövedék **kétszer** pattan a falakról,
  utána elpukkad. Kikapcsolva az első falnál megsemmisül. A lobbiban állítható.
- **Egyszerre legfeljebb 5 lövedéked** lehet a levegőben (Gyorstűzzel 8).
- A tankod mellett mindig ott a **sorszámod nagy, kontrasztos számmal** — így akkor is
  megtalálod magad, ha a színeket nehezen különbözteted meg.

### Beállítások a lobbiban

Bármelyik csatlakozott játékos állíthatja őket (D-pad fel/le a sorváltás, bal/jobb az érték):

| Beállítás | Lehetőségek |
|---|---|
| **Pattogó lövedék** | BE / KI |
| **Pálya** | Kereszttűz · Négy Sarok · Labirintus · Oszlopcsarnok · Gyűrű · **Véletlen** |
| **Cél** | 5-től 30 pontig, ötös lépésekben |

A *Véletlen* pálya minden körben új arénát sorsol.

---

## 5. Powerupok

A pályán ládák hevernek, és időnként **ejtőernyős utánpótlás** is érkezik felülről
(esés közben még nem vehető fel — várd meg a becsapódást). A ládához elég hozzáérni.

| Ikon | Név | Mit ad | Meddig tart |
|:---:|---|---|---|
| ⚡ | **Gyorstűz** | Háromszor gyorsabb újratöltés, és 3-mal több lövedék lehet egyszerre a levegőben | 12 másodperc |
| 🚀 | **Rakéta** | A következő **3 lövésed** rakéta: lassabb, nem pattan, viszont becsapódáskor nagy területen robban — és **mindenkit talál a körben, téged is** | 3 lövés |
| 💨 | **Nitró** | Jóval nagyobb végsebesség, gyorsulás és fordulékonyság | 12 másodperc |
| ❤ | **Pajzs** | Elnyeli a következő halálos találatot: nem halsz meg, csak visszalökődsz. Legfeljebb 2 gyűjthető | Amíg el nem használódik |

Az aktív powerupjaidat a saját sarok-kártyádon látod: az időzítetteknél fogyó csík, a
rakétánál a maradék lövések száma, a pajzsnál a szívek.

**Tipp:** a rakéta a saját robbanásával téged is eltalál. Ne lőj vele közelre.

---

## 6. Hangolás

Ha lassúnak, gyorsnak vagy túl kaotikusnak találod a játékot, minden szám egy helyen
van: **`src/config.js`**. Nyisd meg egy szövegszerkesztővel, írd át, mentsd el, és
töltsd újra az oldalt (`F5`). Nem kell semmit újrafordítani.

A leghasznosabb csavarok:

| Beállítás | Alapérték | Mit befolyásol |
|---|---:|---|
| `tank.maxSpeed` | 205 | Mennyire gyors a tank |
| `tank.turnSpeed` | 7.0 | Milyen fürgén fordul a test |
| `tank.reloadTime` | 0.42 | Két lövés közti szünet (kisebb = több golyó) |
| `tank.respawnDelay` | 2.0 | Mennyit kell várni újraéledésre |
| `bullet.speed` | 430 | A lövedék sebessége |
| `bullet.life` | 4.0 | Meddig repül egy lövedék |
| `match.pointsToWin` | 15 | Alapértelmezett pontcél (a lobbiban felülírható) |
| `input.deadzone` | 0.26 | Holtsáv — növeld, ha a stickje „elmászik” |
| `pickup.airdropInterval` | 22 | Milyen sűrűn jön utánpótlás |
| `powerup.rapidTime` | 12 | A Gyorstűz hossza |

A `dist/slag.html`-t a módosítás után újra kell építeni (`npm run build`).

---

## 7. Hibaelhárítás

### A böngésző nem látja a kontrollert

- **Nyomj meg rajta egy gombot** (legjobb az R2). A böngésző addig nem is tud róla,
  amíg nem érkezik tőle bemenet. Ez nem hiba, hanem beépített védelem.
- Előbb **kattints a játék kezdőképernyőjére**, csak utána nyomj gombot.
- Próbáld **USB kábellel** — a Bluetooth-párosítás néha „félig” sikerül.
- Ellenőrizd egy külső teszttel, hogy az operációs rendszer egyáltalán látja-e:
  <https://hardwaretester.com/gamepad>
- Ha fut a **Steam**, a Steam Input néha elrejti a padet a böngésző elől. Zárd be a
  Steamet, vagy kapcsold ki a PlayStation-kontroller támogatását a Steam
  beállításaiban.
- Használj **Chrome-ot vagy Edge-et**. A Firefox máshogy térképezi a gombokat.

### Nincs hang

- A böngésző csak az első kattintás után enged hangot. **Kattints a kezdőképernyőre.**
- Lehet, hogy a játék némítva van: nyomj **`M`**-et.
- Nézd meg, nincs-e maga a böngészőlap némítva (jobb klikk a lapfülön).

### Akadozik, szaggat

- Kapcsolj **teljes képernyőre** (`F`) — így nem kell felskálázni az ablakot.
- Zárd be a többi böngészőlapot, főleg a videósokat.
- Kapcsold be a hardveres gyorsítást: Chrome → Beállítások → Rendszer →
  *„Hardveres gyorsítás használata, ha elérhető”*.
- Egy kisebb böngészőablak is sokat segít gyengébb gépen.

### Dupla kattintással nem indul (`file://`)

Ez így helyes: a böngésző nem engedi, hogy egy fájlrendszerről megnyitott oldal
JavaScript-modulokat töltsön be. Két megoldás:

- `npm start`, majd <http://localhost:8080>, **vagy**
- `npm run build`, és nyisd meg a keletkező **`dist/slag.html`**-t — az egyfájlos
  változat dupla kattintással is működik.

### A 8080-as port foglalt

```
npm start -- --port 3000
```

### Két játékos ugyanazt a színt szeretné

Nem lehet — a lobbi automatikusan átugorja a már foglalt színeket. Nyolc szín van,
négy játékosra bőven elég.

---

## 8. Böngésző-kompatibilitás

| Böngésző | Állapot |
|---|---|
| **Chrome** (asztali) | ✅ Ajánlott — teljes kontroller- és rezgéstámogatás |
| **Edge** (asztali) | ✅ Ajánlott — ugyanaz a motor |
| **Opera, Brave, Vivaldi** | ✅ Működik (Chromium-alapúak) |
| **Firefox** | ⚠️ Elindul, de a kontroller gombkiosztása eltérhet, és a rezgés nem működik |
| **Safari** | ⚠️ Korlátozott gamepad-támogatás, nem ajánlott |
| Mobil / tablet | ❌ Nem támogatott — négy kontrolleres, egy képernyős játék |

A játék semmilyen adatot nem küld el és nem tárol; teljes egészében a te gépeden fut.

---

## 9. Feltöltés webszerverre (linkmegosztás)

A játék **statikus fájlokból** áll — nincs build-lépés és nincs szerveroldali kód —,
így bármelyik webtárhelyre feltölthető, és a linket megoszthatod.

> **Fontos: HTTPS kell, különben nem lesz kontroller.**
> A böngészők a Gamepad API-t csak *biztonságos kontextusban* engedik. Sima
> `http://` címen a kontrollerek **egyáltalán nem jelennek meg** — a játék elindul,
> de csak billentyűzettel játszható. A lobbi ilyenkor piros sávban ki is írja.
> (`localhost` kivétel: ott `http://` is jó, ezért működik a `npm start`.)

### Mit tölts fel

Az egész repó gyökere kell: `index.html`, `styles.css` és a teljes `src/` mappa.
A `tools/`, `dist/` és `.artifacts/` nem szükséges. Alkönyvtárba is teheted
(pl. `pelda.hu/slag/`), mert minden hivatkozás relatív.

Ha egyetlen fájlt szeretnél inkább:

```bash
npm run build      # → dist/slag.html
```

Ez mindent egyetlen HTML-be csomagol — feltöltöd, és kész.

### GitHub Pages (a legegyszerűbb, ingyenes, HTTPS)

A repóban van egy kész workflow (`.github/workflows/pages.yml`). Egyetlen
egyszeri kattintás kell hozzá — ezt a workflow jogosultság híján nem tudja
elvégezni helyetted:

**Settings → Pages → Build and deployment → Source: _GitHub Actions_**

(Amíg ez nincs beállítva, a workflow nem hasal el pirosra: a futás összegzőjében
kiírja, mit kell beállítani.) Utána minden push publikál, és a link ez lesz:

```
https://<felhasználónév>.github.io/<repónév>/
```

### Saját szerver (nginx / Apache)

Másold a fájlokat a webgyökérbe, és **kapcsold be a HTTPS-t** (a Let's Encrypt
ingyenes). Semmilyen egyéb beállítás nem kell — nincs adatbázis, nincs backend.

---

## 10. Online szoba (távoli barátok)

Ha nem egy kanapén ültök: a játékban nyithatsz **szobát**, és a kapott linkkel
mások távolról is beülhetnek ugyanabba a meccsbe.

### Mire van szükség

A játék statikus fájljait bármelyik tárhely kiszolgálja — de **két böngészőt
egyetlen tárhely sem tud összekötni**. Ehhez kell egy futó folyamat, ami a
csomagokat továbbadja. Ez a `tools/relay-server.mjs`: egy kicsi, függőség
nélküli Node-kiszolgáló.

```bash
node tools/relay-server.mjs --port 8090
```

Kétféleképp állíthatod be, hol keresse a játék:

```html
<!-- 1. Az index.html-be, a modul betöltése ELŐTT: -->
<script>window.SLAG_RELAY = 'https://relay.pelda.hu';</script>
```

```
2. Vagy a linkben, beállítás nélkül:
   https://pelda.hu/slag/?relay=https://relay.pelda.hu
```

Ha a játékot és a relayt **ugyanaz a gép** szolgálja ki, semmit nem kell
beállítani: alapból a saját címét használja.

> **HTTPS-oldal csak HTTPS-relayt érhet el.** Ha a játék `https://`-en van, a
> relaynek is annak kell lennie, különben a böngésző letiltja a kapcsolatot.

### Megosztott tárhelyen (cPanel, „Setup Node.js App”)

**`npm install` NEM kell** — a projektnek nincs egyetlen függősége sem. Ha
mégis lefuttatod, a cPanel `activate` szkriptje `--prefix`-szel a virtuális
környezetre irányítja az npm-et, és ezt a hibát kapod:

```
npm error path /home/<user>/nodevenv/<domain>/24/lib/package.json
npm error enoent Could not read package.json
```

Ez nem a te hibád és nem is baj: egyszerűen hagyd ki ezt a lépést.

**1. Töltsd fel a projektet** az alkalmazás mappájába (ez lehet a domain
könyvtára is). Ezek kellenek:

```
index.html   styles.css   src/   app.js   tools/
```

**2. Állítsd be a Node-alkalmazást:**

| Mező | Érték |
|---|---|
| Application root | `tank.luiz-tech.hu` (ahova feltöltötted) |
| Application URL | `tank.luiz-tech.hu` — **a domain gyökere** |
| Application startup file | `app.js` |
| Node.js version | 18 vagy újabb |

**3. Indítsd újra az alkalmazást.** Kész — nincs harmadik lépés.

Az `app.js` **egyszerre szolgálja ki a játékot és a szobákat**. Ezért nem kell
sem `window.SLAG_RELAY`, sem `?relay=` a linkben: minden azonos címről jön, a
játék magától megtalálja a szobákat. A megosztható link is letisztult:
`https://tank.luiz-tech.hu/?szoba=ABC123`.

A kiszolgáló-oldali fájlokat (`tools/`, `app.js`, `package.json`, rejtett
fájlok) a beépített statikus kiszolgáló **nem adja ki** böngészőnek, akkor sem,
ha az alkalmazás mappája egyben a webgyökér.

Ellenőrzés: a `https://tank.luiz-tech.hu/api/health` címnek
`{"ok":true,"rooms":0}`-t kell adnia.

> **404-et kapsz a játékra?** Akkor az `index.html` nincs ott, ahova az
> `app.js`-t tetted — a kettőnek **ugyanabban a mappában** kell lennie.
>
> **A szoba létrejön, de a másik gépen nem frissül semmi?** A tárhely
> webkiszolgálója puffereli a folyamatos választ. A relay ez ellen küldi az
> `X-Accel-Buffering: no` fejlécet, de nem minden beállítás veszi figyelembe;
> ilyenkor a tárhely támogatásától kell kérni a pufferelés (proxy buffering)
> kikapcsolását.

### Ha a tárhelyeden nem futhat Node

Akkor a játék statikus része (`index.html`, `styles.css`, `src/`) önmagában is
felmásolható, és **helyben, egy gépen játszható** — csak az online szobák
maradnak ki, mert azokhoz kell a futó folyamat.

### Hogyan játszotok

1. Egyvalaki megnyomja az **Online szoba → Szoba nyitása** gombot.
2. Elküldi a megjelenő **linket** (vagy a 6 karakteres kódot).
3. A többiek megnyitják a linket — magától csatlakoznak.
4. Innentől minden ugyanaz, mint egy gépen: **R2 / Space** a beüléshez,
   **Kereszt / Enter** a készhez, **Options / Enter** az indításhoz. A távoli
   játékos ugyanúgy elfoglal egy helyet a lobbiban, mint aki melletted ül.
5. Vegyíthető: nálad ülhet két ember egy-egy kontrollerrel, és jöhet még
   kettő távolról. Négy hely van összesen, gépi ellenfelekkel kiegészíthető.

### Hogyan működik, és mi az ára

A **szobát nyitó gépen fut a meccs** — ő az igazság forrása. A távoli
játékosok elküldik, mit nyomnak, és visszakapják a kész képet. Így a két gép
állapota soha nem tud szétcsúszni.

Cserébe **a távoli játékos a saját mozgását is késleltetve látja**: annyival,
amennyi idő alatt a csomag megjárja a relayt oda-vissza. Egy közeli
kiszolgálóval ez alig érezhető, egy másik kontinensen lévővel viszont zavaró.
Tedd a relayt olyan helyre, ami mindkettőtökhöz közel van.

Amit a mostani változat **nem** tud: nincs késleltetés-kompenzáció (a távoli
játékos nem "előre jelzi" a saját mozgását), és ha a szoba gazdája kilép, a
meccs véget ér — nincs gazdaátadás.

> **A böngészőfül maradjon előtérben.** A böngészők lelassítják a háttérben
> lévő lapokat; ilyenkor a távoli játékos irányítása akadozni fog.

---

## 11. Parancsok röviden

| Parancs | Mit csinál |
|---|---|
| `npm start` | Elindítja a helyi szervert a 8080-as porton |
| `npm start -- --port 3000` | Ugyanaz, más porton |
| `npm run build` | Elkészíti az egyfájlos `dist/slag.html`-t |
| `npm run smoke` | Automata önteszt: lejátszik egy kört fejnélküli böngészőben, és képernyőképeket ment a `.artifacts/` mappába |
| `npm run relay` | Elindítja az online szobák kiszolgálóját a 8090-es porton |

Jó csatát!
