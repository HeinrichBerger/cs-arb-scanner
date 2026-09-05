// ==UserScript==
// @name         VBSB CS-Arb Scanner
// @namespace    vbsb.csarb.scanner
// @version      8.71.3
// @description  Pinnacle-Back (CS 1:1 / BTTS / H2H) vs Betfair Surebet-Scanner. Benoetigt Browser-VPN. Sendet Snapshots an die VBSB-App (127.0.0.1:8765).
// @match        https://www.betfair.com/*
// @match        https://www.pinnacle.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_info
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @updateURL    http://127.0.0.1:8765/cs_arb_scanner.user.js
// @downloadURL  http://127.0.0.1:8765/cs_arb_scanner.user.js
// ==/UserScript==

(function () {
  'use strict';

// ---------- Reine Matching-Logik (in Node testbar) ----------
  // Semantisch unveraendert aus dem Monolithen extrahiert. Lebt im geteilten
  // IIFE-Scope des Userscripts (wird VOR main.js eingefuegt) und ist parallel
  // standalone testbar: test/matching.test.js laedt diese Datei per Node-vm.
  // Deshalb sind die testbaren Funktionen `function`-Deklarationen (die vm-
  // Sandbox exponiert sie als Globals), Konstanten bleiben `const` (intern sichtbar).
  const COMM = 0.03;           // Betfair-Lay-Kommission (3 %)

  const STOPW = new Set(['ff','fk','if','cf','sk','bk','ac','fc','sc','sv','es','de','og','nk','ud','id','ds']);
  // Vereins-Suffixe (FC/SC/AC/FK/...). norm() entfernt sie weiterhin als Noise,
  // aber toks() behaelt sie als Marker-Tokens. Sonst kollabiert "Suwon FC" auf
  // das geteilte Stadt-Praefix "suwon" und teamMatch() verwechselt es mit
  // "Suwon Bluewings"/"Suwon Samsung Bluewings" (Kollision -> Lay-Seite verworfen).
  const MARKER = new Set(['ac','bk','cf','fc','ff','fk','if','nk','sc','sk','sv','ud']);
  const TEAM_MATCH_RATIO = 0.6;        // Min. Token-Overlap fuer teamMatch()

  // ---------- Preis-Helfer ----------
  function dec(p) { return p > 0 ? 1 + p / 100 : 1 - 100 / p; }
  function toDecU(raw) { return (raw && raw !== 0) ? dec(raw) : 0; }
  function price(back, lay) { return Math.abs(Math.log(lay / back)); }
  // Effektive BF-Quote nach Kommission (fuer BB-/Cross-Arbs).
  function bfEffQ(q) { return q > 1.01 ? 1 + (q - 1) * (1 - COMM) : 0; }
  // Cross-Edge zweier Back-Quoten (PIN + BF), 0 wenn keine Marge.
  function crossBackEdge(a, b) {
    const inv = 1 / a + 1 / b;
    return inv < 1 ? (1 - inv) * 100 : 0;
  }
  // Pinnacle-Preis-Plausibilitaetscheck: > 1.01 (kein toter Preis) und
  // < 1000 (kein Extrempreis, z.B. back=110 tote Maerkte).
  function isValidPrice(p) { return p > 1.01 && p < 1000; }
  // Nur wenn der BF-Lay unter dem PIN-Back liegt, kann ein Back-Lay-Arb
  // entstehen (sonst gibt es nie eine Marge).
  function arbDir(back, lay) { return isValidPrice(back) && lay > 0 && lay < back; }

  // ---------- Edge-Formeln (Snapshots, in Node testbar) ----------
  // Effektive BF-Quote nach Kommission (Back-Back/Cross; mathematisch identisch
  // zu bfEffQ). Wird von computeBBEdge und edgeOf genutzt.
  const effQ = q => q * (1 - COMM) + COMM;
  // Back-Back-Edge: PIN-Back vs BF-Back (Kommission auf BF-Seite).
  // Komplementaere Ereignisse: verliert PIN, gewinnt BF (oder umgekehrt).
  // Formel: (pinBack - 1) - pinBack / effQ(bfBack)
  const computeBBEdge = (pinBack, bfBack) => (pinBack - 1) - pinBack / effQ(bfBack);
  // Edge einer Snapshot-Zeile (Back-Lay / Back-Back / 3-Wege-Cross). Kanonisch
  // fuer den Browser; pvb_odds_pipe.compute_edge muss dieselben Formeln liefern
  // (wird in test_kind_catalog_consistency.py / test_pvb_odds_pipe.py abgeglichen).
  function edgeOf(r) {
    // Tenscore-Lock-Zeilen (Tennis Satz-Score, v8.60.21/8.60.24): back und lay
    // sind hier zwei VERSCHIEDENE Ereignisse, die nur zusammen als Boost-Lock
    // funktionieren (Lay X <Score> + Back Gegner-ML bzw. +1,5/+2,5) — einzeln
    // sind sie kein Komplement (z.B. ist der Gegen-Back zu B-ML in Bo3
    // {A 2:0, A 2:1}, aber der Lay „X 2-1" deckt nur A 2:1 ab; A kann auch
    // 2:0 gewinnen — User-Befund Mirra Andreeva v Janice Tjen). Kein Edge,
    // keine Fake-Surebet; die Rows bleiben als Daten fuer den Boost-Arb-Dialog.
    // so45 (v8.68.0): BF „Number of Sets" Five-Lay + 3/4-Sets-Back (Boost
    // „Mehr als 4,5 Sätze") — reine BF-Legs ohne PIN-Gegenstueck, kein PvB-Paar.
    if (['s51A', 's51B', 'sd15PlusA', 'sd15PlusB',
      's21A', 's21B', 's32A', 's32B', 'so45'].indexOf(r.kind) >= 0) return 0;
    // H2H Back-Back: kein Commission auf PIN, BF-Lay Commission in effQ
    if (r.kind === 'bbA' || r.kind === 'bbB' || /^ouBB/.test(r.kind) || /^hfouBB/.test(r.kind) ||
        r.kind === 'bbTqA' || r.kind === 'bbTqB' ||
        r.kind === 'bttsBBY' || r.kind === 'bttsBBN' ||
        r.kind === 'oeBBY' || r.kind === 'oeBBN' ||
        r.kind === 'w2nBBY' || r.kind === 'w2nBBN' ||
        r.kind === 'fdBBY' || r.kind === 'fdBBN' ||
        r.kind === 'ptsBB' ||
        r.kind === 'sdPlusA' || r.kind === 'sdPlusB' ||
        r.kind === 'sd5PlusA' || r.kind === 'sd5PlusB' ||
        r.kind === 'dnbCross' ||
        /^euh1[HA]\+[HB]$/.test(r.kind) ||
        /^euhAH\d+[HA][+-][HB]$/.test(r.kind) ||
        /^sw[12]BB[AB]$/.test(r.kind))
      return computeBBEdge(r.back, r.lay);
    // 3-Wege-Cross-Arbs: PIN DC + BF Einzel oder PIN Einzel + BF DC
    // Formula: back / (1 + back/(back+lay)) - lay fuer korrekte Edge-Berechnung
    if (r.kind === 'dc1xB' || r.kind === 'dcX2A' || r.kind === 'dc12D' ||
        r.kind === 'A dcX2' || r.kind === 'B dc1x' || r.kind === 'D dc12') {
      const p = r.back, q = r.lay;
      if (p <= 1.01 || q <= 1.01) return 0;
      return 1 - (1 / p + 1 / q);
    }
    // Standard Back-vs-Lay (kanonisch; identisch zu
    // pvb_odds_pipe.compute_edge / calculators_core.berechne_back_lay_standard):
    // Der Lay-Einsatz wird fuer Equal-Profit normalisiert, damit die Edge wie in
    // der App erscheint (frueher: Equal-Stakes-Approximation statt Hedge -> die
    // Browser-Log-Edges wichen 15-107 % von der App ab).
    return (r.back - 1) - r.back * (r.lay - 1) / (r.lay - COMM);
  }

  // ---------- Token-Normalisierung + teamMatch ----------
  // Memoization-Caches fuer norm()/toks() (pure Funktionen; begrenzt durch die
  // Anzahl distinkter Team-/Liga-Namen, nicht durch die Scan-Menge).
  const NORM_CACHE = new Map();
  const TOKS_CACHE = new Map();
  function normBase(s) {
    return String(s).toLowerCase().normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '').replace(/\u00f8/g, 'o').replace(/\u00e6/g, 'ae')
      .replace(/\u00df/g, 'ss').replace(/\u00f0/g, 'd').replace(/\u00fe/g, 'th')
      .replace(/[^a-z0-9 ]/g, ' ').split(' ').filter(Boolean);
  }
  function norm(s) {
    // Memoization: norm wird bei jedem teamMatch-/toks-Aufruf gebraucht und
    // lief frueher fuer jeden Vergleich neu durch die Regex-Normalisierung
    // (CPU-Flaschenhals bei O(lays x games) findH ueber ~140 Ligen). Pure
    // Funktion -> Ergebnisse sind deterministisch und cachebar.
    let r = NORM_CACHE.get(s);
    if (r === undefined) {
      r = normBase(s).filter(w => !STOPW.has(w)).join(' ');
      NORM_CACHE.set(s, r);
    }
    return r;
  }
  // Kurznamen-Aliase fuer Token-Matching (Nominierung im norm-Raum).
  // Betfair nutzt fuer J1-Events Kurznamen ("G-Osaka", "Yokohama FM"), gegen
  // die PIN nur Vollnamen fuehrt - einmal hier hinterlegt, gilt das Alias fuer
  // JEDEN teamMatch()-Aufruf (findH, sideLay, mo3Clean, hfSide, evMatch, ...).
  // __SYNONYMS_SIDEALIAS_BEGIN__
  const SIDE_ALIAS = {
    "a ali": "aali club",
    "abu qair semad": "abo qair semads",
    "ael limassol": "a e l",
    "al ahli doha": "al ahli qat",
    "al ahli uae": "shabab al ahli",
    "al arabi doha": "al arabi qat",
    "al hazem": "al hazm ksa",
    "al ittihad al sakandary": "al ittihad egy",
    "al khaldiya": "al khalidiyah",
    "al sulaibikhat": "al salibikhaet",
    "al tadamon": "al tadhamon",
    "al wakrah": "al wakra",
    "alianza panama": "alianza fc pan",
    amedspor: "amed sportif faaliyetler",
    "america mineiro": "america mg",
    "antigua and barbuda falcons": "antigua barbuda falcs",
    "arema fc": "arema cronus",
    "arzignano valchiampo": "arzignanochiampo",
    "athletico paranaense": "athletico pr",
    "atlanta united": "atlanta utd",
    "atletico fc": "atletico rojiblanco",
    "atletico goianiense": "atletico go",
    "atletico mineiro": "atletico mg",
    "austria vienna": "austria wien",
    "b 93": "b93 copenhagen",
    "banga gargzdai": "fk banga gargzdu",
    "barcelona sc": "barcelona ecu",
    "benfica ii": "benfica b",
    "bokelj kotor": "fk bokelj",
    "boston united": "boston utd",
    "cambuur leeuwaarden": "cambuur leeuwarden",
    "celta vigo ii": "celta vigo b",
    "chernomorets 1919 burgas": "chernomorets bourgas",
    "chungbuk cheongju": "cheongju fc",
    "club america": "cf america",
    "corvinul hunedoara": "fc hunedoara",
    "csikszereda miercurea ciuc": "csikszereda w",
    "d c united": "dc utd",
    "dagenham and redbridge": "dag and red",
    "deportivo maipu": "cd maipu",
    "dinamo bucuresti": "dinamo bucharest",
    "dundee united": "dundee utd",
    egersunds: "egersund",
    "el geish": "talaea el gaish",
    "el mansoura": "el mansurah",
    "el sekka el hadid": "el seka elhadeed",
    erzurumspor: "erzurum bb",
    "escorpiones belen": "escorpiones fc",
    "fa siauliai": "fk siauliai",
    "fc bacau": "acs fotbal club bacau",
    "fc gangneung": "gangneung city",
    "ferrocarril midland": "fc midland",
    "fh hafnarfjordur": "hafnarfjordur w",
    "flora tallinn": "tallinna fc flora",
    "fortaleza ceif": "fortaleza fc",
    "g osaka": "gamba osaka",
    "glasgow cosmics": "glasgow cosmic",
    "gloria bistrita": "cs bistrita",
    "grasshopper club zurich": "grasshoppers zurich",
    "guarani par": "club guarani",
    "hertha bsc": "hertha berlin",
    "hilal alsahil": "al sahil",
    "huracan fc": "huracan del paso",
    "incheon united": "incheon utd",
    "independiente del valle": "independiente ecu",
    "independiente medellin": "ind medellin",
    "internacional de palmira": "inter palmir",
    internazionale: "inter",
    "internazionale u23": "inter milan",
    "istra 1961": "nk istra",
    "iwaki fc": "iwaki sc",
    "jagiellonia bialystok": "jagiellonia bialystock",
    "jeju sk": "jeju utd",
    "juventus next gen": "juventus b",
    "kagoshima united": "kagoshima utd",
    "kansas city current": "kansas city w",
    karlsruher: "karlsruhe",
    "khor fakkan club": "al khaleej khor fakkan",
    "kolos kovalivka": "kolos kovalyovka",
    "kolos kovalivka ii": "fc kolos kovalivka 2",
    kristianstad: "kristianstads",
    "kts k luzino": "wiked luzino",
    "levadia tallinn": "fci tallinn",
    "lokomotiv gorna oryahovitsa": "lokomotiv go",
    "los angeles galaxy": "la galaxy",
    "ludogorets razgrad ii": "ludogorets razgrad b",
    "m'gladbach": "borussia monchengladbach",
    "machida zelvia": "fc machida",
    "maleyet kafr el zayiat": "maleyeit kafr el zayiat",
    "man city": "manchester city",
    "man utd": "manchester united",
    "mb rouisset": "mb rouissat",
    mgladbach: "borussia monchengladbach",
    "minnesota united": "minnesota utd",
    "mornar bar": "fk mornar",
    "nacional asuncion": "nacional par",
    "nacional de football": "nacional uru",
    "neftchi fergona": "neftchi fargona",
    "nk celik zenika": "celik zenica",
    "nomme united": "nomme utd",
    "nongkseh ss cc": "nongkseh scc",
    "nottingham forest": "nottm forest",
    "notts county": "notts co",
    "o higgins": "ohiggins",
    "odd bk": "odds bk",
    "operario ferroviario": "operario pr",
    ostiamare: "ostia mare lido",
    "oxford united": "oxford utd",
    paksi: "paks",
    "paris saint germain": "paris st g",
    pats: "patriots",
    "plaza amador ii": "plaza amador res",
    "polonia warsaw": "polonia warszawa",
    "popesti leordeni": "gloria leordeni",
    "porto ii": "porto b",
    "qadsia sc": "al qadsia",
    "racing club de montevideo": "racing club uru",
    "rapid bucuresti": "rapid bucharest",
    "real sociedad ii": "sociedad b",
    "rfc liege": "fc liege",
    "river plate montevideo": "river plate uru",
    "ross county": "ross co",
    royals: "tridents",
    "rz pellets wac": "wolfsberger ac",
    "sabah fk": "fc sabah",
    "saint etienne": "st etienne",
    "sc poltava": "sk poltava",
    "sd atletico nacional": "atletico nacional pan",
    "seraing utd": "seraing",
    "sfk 2000 sarajevo": "sfa 2000 sarajevo w",
    "sheffield wednesday": "sheff wed",
    "sint truidense": "sint truiden",
    "sonnenhof grossaspach": "sg sonnenhof",
    "sporting cp": "sporting lisbon",
    "sporting lisbon ii": "sporting lisbon b",
    "stade lavallois": "laval",
    "stockholm internazionale": "fc stockholm",
    "sutton united": "sutton utd",
    "tauro ii": "tauro fc res",
    "tochigi city": "tochigi uva fc",
    "tokyo verdy": "tokyo v",
    "top oss": "fc oss",
    "tra united": "tabora united fc",
    united: "utd",
    "universidad catolica del ecuador": "univ catolica ecu",
    "universidad de concepcion": "univ de concepcion",
    vanspor: "van buyuksehir belediyespor",
    "vilnius zalgiris": "vmfd zalgiris",
    vushtrria: "kosova vushtrri",
    "wallern st marienkirchen": "sv wallern",
    "walter ferretti": "cd walter ferreti",
    "welwalo adigrat university": "welwalu adigrat",
    "west bromwich albion": "west brom",
    wolves: "wolverhampton",
    "wsg tirol": "wsg wattens",
    "yantra gabrovo": "fc yantra",
    "yeoju citizen": "yeoju fc",
    "yokohama fm": "yokohama f marinos",
    ypsonas: "digenis ypsona"
  };
  // __SYNONYMS_SIDEALIAS_END__
  // CPL (Cricket): PIN "St. Kitts and Nevis Patriots" / "Barbados Royals" vs
  // BF "St Kitts & Nevis Pats" / "Barbados Tridents" (v8.60.33) — die Aliasse
  // oben werden vom Build aus synonyms.json regeneriert.
  // Negative Namens-Aliase: Paare, die NIE als identisch gelten duerfen, obwohl
  // der Token-Match sie als Teilmenge erkennen wuerde (z.B. "Dundee Utd" vs
  // "Dundee", "CA Independiente" vs "Independiente Rivadavia" - verschiedene
  // Teams, ein Name ist Token-Teilmenge des anderen). Kontextfrei generisch
  // nicht loesbar -> Einzelfall-Liste (User-Info 2026-08-21). teamMatch()
  // prueft beide Richtungen (a in b / b in a).
  // __SYNONYMS_SIDEBLOCK_BEGIN__
  const SIDE_BLOCK = {
    "dundee utd": ["dundee"],
    "dundee united": ["dundee"],
    "ca independiente": ["independiente rivadavia"],
    internazionale: ["inter miami"]
  };
  // __SYNONYMS_SIDEBLOCK_END__
  // Runtime-Aliase (v8.61.0): die VBSB-GUI kann per /cmd alias-set einen
  // bestaetigten Name-Mismatch (Name-Matching-Tab) sofort an den laufenden
  // Scanner pushen — ohne Rebuild/Tampermonkey-Update. Sie gelten wie
  // SIDE_ALIAS in JEDEM teamMatch()-Aufruf; der naechste Build uebernimmt
  // die bestaetigten Aliase dauerhaft via synonyms.json.
  const RUNTIME_ALIAS = {};
  function setRuntimeAlias(from, to) {
    const k = String(from || '').trim().toLowerCase();
    const v = String(to || '').trim().toLowerCase();
    if (!k || !v || k === v) return false;
    RUNTIME_ALIAS[k] = v;
    TOKS_CACHE.clear();  // aliasExp laeuft in toks() -> Cache invalidiert
    return true;
  }
  function aliasExp(s) {
    let out = s;
    const apply = map => {
      for (const [k, v] of Object.entries(map)) {
        out = out.replace(new RegExp('(^| )' + k.replace(/ /g, ' +') + '(?= |$)', 'g'),
          m => m.replace(k, v));
      }
    };
    apply(SIDE_ALIAS);
    apply(RUNTIME_ALIAS);
    return out;
  }
  function toks(s) {
    let set = TOKS_CACHE.get(s);
    if (!set) {
      set = new Set(aliasExp(norm(s)).split(' ').filter(Boolean));
      for (const w of normBase(s)) if (MARKER.has(w)) set.add(w);
      TOKS_CACHE.set(s, set);
    }
    return set;
  }
  // Token-Kompatibilitaet fuer teamMatch: exakt oder Praefix-Variante (min 3
  // Zeichen). Erlaubt BF-Kurzformen wie "Gim La Plata" <-> "Gimnasia La Plata",
  // ohne dass zwei verschiedene Teams mit gemeinsamem Stadt-Suffix ("Estudiantes
  // de La Plata" vs "Gimnasia La Plata", nur "la plata" gemeinsam) als identisch
  // gelten.
  function tokCompat(x, y) {
    return x === y ||
      (x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x)));
  }
  // Initial-Kompatibilitaet (v8.62.1): 1-2-Zeichen-Initiale (ggf. mit Punkt)
  // als Praefix eines laengeren Tokens — BF-Schreibweise bei Einzelsportarten
  // (Tennis/UFC): "A Zverev" / "Li Tagger" / "Be Shelton" vs PIN "Alexander
  // Zverev" / "Lilli Tagger" / "Ben Shelton" (User-Befund 2026-09-01: US-Open-
  // Unmatched-Flut). Ab 3 Zeichen uebernimmt tokCompat den Praefix-Vergleich;
  // hier geht es NUR um echte Initialen, damit "li" nicht jedes Token ab
  // "li..." matcht. Der Nachname muss weiterhin exakt (letztes Token) treffen.
  function initCompat(x, y) {
    const a = String(x).replace(/\./g, '');
    const b = String(y).replace(/\./g, '');
    if (!a || !b || a === b) return false;
    if (a.length <= 2 && b.length >= 3 && b.startsWith(a)) return true;
    if (b.length <= 2 && a.length >= 3 && a.startsWith(b)) return true;
    return false;
  }
  // Negative Namens-Blockliste: wenn eines der beiden Teams in SIDE_BLOCK
  // steht und das andere in seiner Verbotsliste, ist das KEIN Match - auch
  // wenn die Token-Menge (Teilmenge) es erlauben wuerde.
  function sideBlocked(a, b) {
    const na = norm(a), nb = norm(b);
    return (SIDE_BLOCK[na] && SIDE_BLOCK[na].includes(nb)) ||
      (SIDE_BLOCK[nb] && SIDE_BLOCK[nb].includes(na));
  }
  function teamMatch(a, b) {
    if (sideBlocked(a, b)) return false;
    const A = toks(a), B = toks(b);
    if (!A.size || !B.size) return false;
    // Treffer zaehlen: exakt ODER praefix-kompatibel (tokCompat, >= 3 Zeichen)
    // ODER Initial-Praefix (initCompat, 1-2 Zeichen). So matchen BF-Kurzformen
    // ("Gim La Plata", "Ben Shelton", "Li Tagger") gegen PIN-Vollnamen — der
    // Kollisions-Schutz unten (Erst-Token praefix-kompatibel + letztes Token
    // exakt) verhindert weiterhin Stadt-Praefix-/Suffix-Verwechslungen.
    let hit = 0;
    for (const t of A) {
      if (B.has(t)) { hit++; continue; }
      if ([...B].some(u => tokCompat(t, u) || initCompat(t, u))) hit++;
    }
    if (hit < Math.ceil(Math.min(A.size, B.size) * TEAM_MATCH_RATIO)) return false;
    // Kollisions-Schutz (Praefix UND Suffix): Das ERSTE Token des kuerzeren
    // Namens muss praefix-kompatibel mit einem Token des laengeren sein, UND
    // das letzte Token muss exakt vorkommen. Verhindert, dass verschiedene
    // Teams mit gemeinsamem Stadt-Namenspraefix (z.B. "New York Red Bulls" vs
    // "New York City FC") oder gemeinsamem Stadt-Suffix (z.B. "Estudiantes de
    // La Plata" vs "Gimnasia La Plata", beide enden auf "la plata") als
    // identisch gelten -> sonst Home/Away-Mix in Specs (w2ns/btsws/resous/hfs).
    const [S, L] = A.size <= B.size ? [A, B] : [B, A];
    const Sarr = [...S];
    if (![...L].some(t => tokCompat(Sarr[0], t) || initCompat(Sarr[0], t))) return false;
    return L.has(Sarr[Sarr.length - 1]);
  }

  // ---------- Near-Miss-Erkennung (Name-Candidates, v8.61.0) ----------
  // Schicht 1 des Name-Matching-Konzepts: BF-Events, die findH nicht besteht,
  // werden gegen die PIN-Matchups der Liga fuzzy-gescort. Eindeutige
  // Beinahe-Treffer landen als Kandidaten im Snapshot -> Name-Matching-Tab
  // der App -> einmal bestaetigt, wird das Alias dauerhaft (synonyms.json)
  // + sofort (Runtime-Push) aktiv. Radikale Umbennungen (RZ Pellets WAC,
  // Royals/Tridents) erkennt der Score bewusst NICHT — die bleiben beim
  // reaktiven Pfad (User meldet -> Alias manuell).
  const NAME_NEAR_MISS_MIN = 0.5;  // Vorschlags-Schwelle

  function editDist(a, b) {
    const A = String(a), B = String(b);
    const n = A.length, m = B.length;
    if (!n) return m;
    if (!m) return n;
    let prev = new Array(m + 1);
    for (let j = 0; j <= m; j++) prev[j] = j;
    for (let i = 1; i <= n; i++) {
      const cur = [i];
      for (let j = 1; j <= m; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
          prev[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[m];
  }

  function bigramSim(a, b) {
    const g = s => {
      const out = new Set();
      const t = String(s).replace(/\s/g, '');
      for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
      return out;
    };
    const A = g(a), B = g(b);
    if (!A.size || !B.size) return 0;
    let h = 0;
    for (const x of A) if (B.has(x)) h++;
    return h / Math.min(A.size, B.size);
  }

  // Fuzzy-Aehnlichkeit zweier Teamnamen im norm-Raum (0..1). Kombiniert
  // Token-Overlap (inkl. Praefix-Kompatibilitaet), Bigram-Overlap (kurze
  // Kuerzel wie "Pats"/"Patriots"), normalisierte Edit-Distanz und den
  // Nachnamen-Praefix. Bewusst OHNE aliasExp — hier geht es um die rohe
  // Namensverwandtschaft, nicht um bereits bekannte Aliase.
  function teamFuzzy(a, b) {
    const na = norm(a), nb = norm(b);
    const A = (na || '').split(' ').filter(Boolean);
    const B = (nb || '').split(' ').filter(Boolean);
    if (!A.length || !B.length) return 0;
    let ov = 0;
    for (const t of A) if (B.some(u => tokCompat(t, u) || initCompat(t, u))) ov++;
    const ratio = ov / Math.min(A.length, B.length);
    const lenNorm = editDist(na, nb) / Math.max(na.length, nb.length, 1);
    const snA = A[A.length - 1], snB = B[B.length - 1];
    const sn = (snA && snB && tokCompat(snA, snB)) ? 1 : 0;
    return Math.min(1, ratio * 0.45 + bigramSim(na, nb) * 0.30 +
      (1 - lenNorm) * 0.15 + sn * 0.10);
  }

  // Liefert den EINDEUTIGEN Near-Miss-Kandidaten eines BF-Event-Namens gegen
  // die PIN-Matchups einer Liga: { matchup, pinTeam, bfTeam, score } fuer das
  // am besten passende Matchup — oder null (kein Kandidat / mehrdeutig).
  // pinTeam/bfTeam = das Team-Paar, das teamMatch NICHT besteht (der eigent-
  // liche Blocker); score = schlechtestes Paar des Matchups (matcht ein Paar
  // bereits, zaehlt es als 1.0).
  function nearMissCand(bfName, matchups) {
    const halves = String(bfName || '').split(/\s+v\s+/i).filter(Boolean);
    if (halves.length !== 2) return null;
    const hits = [];
    for (const m of (matchups || [])) {
      const t = (m.teams || []).filter(Boolean);
      if (t.length < 2) continue;
      let best = null;
      for (const [i, j] of [[0, 1], [1, 0]]) {
        const p1 = { pin: t[i], bf: halves[0] };
        const p2 = { pin: t[j], bf: halves[1] };
        const m1 = teamMatch(p1.pin, p1.bf);
        const m2 = teamMatch(p2.pin, p2.bf);
        if (m1 && m2) continue;  // dieses Matchup matcht bereits
        const s1 = m1 ? 1 : teamFuzzy(p1.pin, p1.bf);
        const s2 = m2 ? 1 : teamFuzzy(p2.pin, p2.bf);
        const worst = Math.min(s1, s2);
        if (worst < NAME_NEAR_MISS_MIN) continue;
        // Blocker = das Paar, das teamMatch nicht besteht; bestehen beide
        // nicht, das mit dem niedrigeren Score.
        const bi = !m1 ? 0 : (!m2 ? 1 : (s1 <= s2 ? 0 : 1));
        const cand = {
          matchup: m,
          pinTeam: bi === 0 ? p1.pin : p2.pin,
          bfTeam: bi === 0 ? p1.bf : p2.bf,
          score: worst
        };
        if (!best || cand.score > best.score) best = cand;
      }
      if (best) hits.push(best);
    }
    // Mehrdeutigkeit: passt das Event auf mehrere Matchups (Score >= Schwelle),
    // ist es KEIN sauberer Kandidat — gleiche Falle wie findH n===2 -> null.
    if (hits.length !== 1) return null;
    return hits[0];
  }

  // ---------- BF-Marktklassifizierung ----------
  // Ein Ort fuer Filter und Loop statt Doppelpruefung. Tags entsprechen exakt
  // dem Markt-Filter von bfLays (nur Marktnamen, keine Runner-Klassifikation).
  function classifyMarket(name) {
    const n = name || '';
    const tags = new Set();
    if (/correct/i.test(n)) {
      // "Half Time Correct Score" / "Correct Score 1st Half" -> eigener Tag
      if (/half|1st|first/i.test(n) && !/2nd|second/i.test(n)) tags.add('htcs');
      else tags.add('cs');
    } else if (/^half time score$/i.test(n)) {
      // BF nennt den HT-CS-Markt "Half Time Score" (ohne "Correct")
      tags.add('htcs');
    }
    if (/^both teams to score/i.test(n) && !/half|period/i.test(n)) tags.add('btts');
    if (/^either team to score/i.test(n)) tags.add('eitherTTS');
    if (/^exact total goals/i.test(n)) tags.add('exactGoals');
    if ((/^total goals$/i.test(n) && !/half|period/i.test(n)) ||
      (/^over\/under \d/i.test(n) && !/half|period|handicap/i.test(n))) tags.add('tot');
    // Corners O/U (Soccer): eigener Kanal, damit "Corners Over/Under 8.5" nie
    // gegen Tore-Totals paart (8.5-Kollision). Getrennt von tot!
    if (/^corners over\/under \d/i.test(n) && !/half|period/i.test(n)) tags.add('corners');
    // Team-Totals (Soccer): "Malaga Over/Under 0.5 Goals" etc. — eigener Kanal,
    // getrennt von den Match-Totals (^over/under, ohne Teamnamen-Praefix) und
    // Corners. Der Teamname-Praefix unterscheidet ihn; "Match Odds and Over/
    // Under" bleibt resou, "First Half Goals" hfTot, "Corners ..." corners.
    if (/^.+ over\/under \d+(\.\d+)? goals$/i.test(n) &&
      !/half|period|handicap|match odds|corners/i.test(n)) tags.add('ttot');
    if (/^total goals odd\/even$/i.test(n) && !/half|period/i.test(n)) tags.add('oe');
    if (/over\/under \d|total goals|first half goals/i.test(n) &&
      /half|1st/i.test(n) && !/2nd|second/i.test(n) &&
      !/both|in both/i.test(n)) tags.add('hfTot');
    if (/^(match odds|regular time match odds|match result)$/i.test(n) &&
      !/half|period|2nd|3rd|1st|2nd half/i.test(n)) tags.add('mo3');
    if (/^(half time|first half|1st half)$/i.test(n)) tags.add('mo3h');
    if (/^half time\/full time$/i.test(n)) tags.add('hf');
    if (/^asian handicap$/i.test(n)) tags.add('ah');
    // Europaeisches Handicap (3-Weg, Soccer): BF "Blackburn +1"/"Millwall +3"
    // (Team ±N, Draw, Gegner ∓N — 3 Runner inkl. Draw). Der Marktname endet
    // auf "±Ganzzahl"; 2-Wege-Spreads (Basketball/Dezimal-Linien) passen
    // nicht ins Muster. Die Draw-Runner-Pruefung (3 Runner) macht api_bf.
    if (/^.+ [+-]\d+$/.test(n) &&
      !/win to nil|over\/under|goals|handicap|to score|to qualify|correct|half|period|corners/i.test(n))
      tags.add('euh');
    if (/win ?to ?nil/i.test(n) && !/half|period/i.test(n)) tags.add('w2n');
    if (/^draw no bet$/i.test(n)) tags.add('dnb');
    if (/^double chance$/i.test(n)) tags.add('dc');
    if (/match odds/i.test(n) && /both teams to score/i.test(n) &&
      !/half|period/i.test(n)) tags.add('btsw');
    if (/match odds/i.test(n) && /over\/under/i.test(n) &&
      !/half|period|1st|2nd/i.test(n)) tags.add('resou');
    // To Qualify (K.o.-Duell, 2-Wege "wer kommt weiter", z.B. UEFA-Qualifikation):
    // eigener Kanal, nie mit dem p0-Moneyline mischen. Synonyme bei Betfair:
    // "To Qualify" und "To Lift The Trophy" (Pokal-/K.o.-Turniere).
    if (/^(to qualify|to lift the trophy)$/i.test(n)) tags.add('tq');
    // Player To Score (Torschuetze, Soccer): nur der exakte Markt "Player To Score"
    // (Runner = Spielernamen, z.B. "Kai Havertz"). Abgrenzung: "Player To Score 2 Goals
    // or More", "Player To Score a Hat-trick?" und "Player First Goalscorer" sind
    // andere Maerkte und duerfen nie in diesen Kanal.
    if (/^player to score$/i.test(n)) tags.add('pts');
    return tags;
  }

  // ---------- Event-Matching ----------
  // Matcht ein BF-Event gegen PIN-Teams: Event-Name am " v " splitten und
  // JEDE Haelfte strikt gegen eines der PIN-Teams matchen. Gegen die volle
  // Event-Zeile wuerde teamMatch() bei Namensvarianten (z.B. PIN "LDU Quito"
  // vs BF "LDU") faelschlich scheitern; echter COMP-Reuse (fremde Teams)
  // faellt weiterhin durch.
  function evMatch(pinTeams, evName) {
    // Am ORIGINAL-Namen splitten (nicht normiert), damit Bindestriche in
    // Teamnamen (z.B. "Tokyo-V") nicht zu extra Tokens werden, die die
    // " v "-Splitting verfaelschen ("tokyo v" statt "tokyo-v").
    const halves = evName.split(/\s+v\s+/i).filter(Boolean);
    if (halves.length !== 2) return false;
    return halves.every(h => pinTeams.some(t => teamMatch(t, h)));
  }
// ---------- Util: async-Helfer + reine String-Helfer ----------
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function pool(items, worker, n) {
    const out = new Array(items.length);
    let i = 0;
    const run = async () => {
      for (;;) {
        const k = i++;
        if (k >= items.length) return;
        try { out[k] = await worker(items[k], k); } catch (e) {
          out[k] = undefined;
          // Worker-Fehler vorher stumm verschluckt -> Ligen verschwanden in der
          // Discovery ohne jede Spur (kein VORSCHLAG/Deny/Miss). Fehler sichtbar
          // machen statt zu schlucken.
          try { devlog('pool worker Fehler: ' +
            (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : e)); } catch (e2) {}
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
    return out;
  }

  // Adaptive Pool: Erhoeht Concurrency bei vielen Items (> 50) automatisch.
  // Reduziert API-Wartezeiten bei grossen Batches (z.B. Ligen-Scan).
  const adaptivePool = async (items, worker, base) => {
    const n = items.length > 50 ? Math.min(base * 2, 16) : base;
    return pool(items, worker, n);
  };

  // Globale API-Concurrency-Begrenzung: Pinnacle/Betfair drosseln bei zu vielen
  // parallelen Requests mit 429 -> Retry-Stuerme (Backoff bis >3s) haben Scans
  // auf mehrere Minuten gedehnt. Ein Semaphor begrenzt die gleichzeitigen
  // Requests je API hart, statt sie in die Retry-Schleife zu zwingen.
  const makeSem = n => {
    let running = 0;
    const wait = [];
    const take = () => new Promise(r => {
      if (running < n) { running++; r(); }
      else wait.push(r);
    });
    const release = () => {
      running--;
      const next = wait.shift();
      if (next) { running++; next(); }
    };
    return async fn => {
      await take();
      try { return await fn(); }
      finally { release(); }
    };
  };
  const backoff = (base, attempt, cap) => Math.min(base * Math.pow(2, attempt), cap || 30000) + Math.random() * 500;


  // ---------- String-Helfer ----------
  // Loescht Klammern + fuehrt Mehrfach-Spaces zusammen (z.B. fuer BF-COMP-Suchen).
  const clean = q => String(q).replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim();

  // PIN-Preis-Designation (home/away/over/...) als lowercase String.
  const desig = p => String(p.designation || '').toLowerCase();

  const scoreOf = m => {
    const st = (m && m.state) || {};
    for (const k of ['periodScore', 'score', 'scores', 'totalScore']) {
      const v = st[k];
      if (v !== undefined && v !== null) {
        const h = v.home ?? v.a ?? v[0];
        const a = v.away ?? v.b ?? v[1];
        if (h !== undefined && a !== undefined && h !== null && a !== null)
          return h + ':' + a;
      }
    }
    return '';
  };
// ---------- Konstanten, Tuning, API-Session-Zustand ----------
  // ---------- Konstanten ----------
  // v1.41.5
  const VERSION = (typeof GM_info !== 'undefined' && GM_info && GM_info.script) ?
    GM_info.script.version : '?';
  const PB = 'https://guest.api.arcadia.pinnacle.com/0.1';
  const API_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';
  // _ak-Access-Key: Betfair rotiert den Token periodisch. Der Wert hier ist nur
  // der Fallback; die fetch-/XHR-Proxys unten uebernehmen den aktuellen Key aus
  // den Requests der Betfair-Seite selbst (__akSniff).
  let AK = 'nzIFcwyWhrlwYMrh';
  const PIPE = 'http://127.0.0.1:8765'; // VBSB-Odds-Pipe (App, Port aus config.py)
  const HOURS_BACK = 1;        // Spiele bis 1h vor dem Start tolerieren
  const DAYS_AHEAD = 4; // Default-Scan-Horizont in Tagen voraus (im Panel einstellbar)
  const DAYS_AHEAD_KEY = 'vbsb_csarb_daysahead';
  let daysAhead = (() => {
    try {
      const v = parseInt(localStorage.getItem(DAYS_AHEAD_KEY), 10);
      return Number.isInteger(v) && v >= 1 && v <= 30 ? v : DAYS_AHEAD;
    } catch (e) { return DAYS_AHEAD; }
  })();

  // ---------- Tuning-Konstanten ----------
  const PRICE_MATCH_THRESHOLD = 0.5;   // Max. Log-Ratio-Abweichung fuer Preis-Matching
  // (nur noch grobe Identitaetsfehler/Name-Collisions filtern: 0.5 = Back/Lay-
  // Verhaeltnis bis ~1.65. Echte Arbs mit grosser Marge — z.B. Back 2.5 / Lay
  // 2.0 -> log-ratio 0.22 — bleiben jetzt erhalten statt als 'kein Preismatch'
  // verworfen zu werden.)
  // Nur wenn der BF-Lay unter dem PIN-Back liegt, kann ein Back-Lay-Arb entstehen
  // (sonst gibt es nie eine Marge). Back-Lay-Zeilen mit Lay >= Back werden nicht erzeugt.
  const POOL_CONCURRENCY = 12;         // Max. parallele API-Worker
  const SPECIALS_CONCURRENCY = 6;      // Specials-Fetch je Liga (glattere Bursts, global via pinSem begrenzt)
  const PIN_MAX_CONCURRENCY = 12;      // Globale Obergrenze gleichzeitiger PIN-Requests (429-Schutz)
  const BF_MAX_CONCURRENCY = 10;       // Globale Obergrenze gleichzeitiger BF-Requests (429-Schutz)
  const MAX_LAY_PRICE = 200;           // Lay-Preise above this werden ignoriert (kein echtes Liquidity)
  const MAX_CS_SCORE = 6;              // Max. Correct-Score-Wert (0-6 pro Seite; v8.54.0:
                                       // Muster Nr. 7 „Over X ∧ Team Under 0,5“ braucht
                                       // 4:0/5:0/6:0 für den CS-Lay-Hedge, beide Lieferanten
                                       // PIN (CS-Backs) + BF (CS-Lays))
  const MAX_OU_LINE_PIN = 300;         // Max. O/U-Line von Pinnacle (total goals)
  const MAX_OU_LINE_BF = 7.5;          // Max. O/U-Line von Betfair
  const MAX_CORNERS_LINE_BF = 12.5;    // Max. Corners-O/U-Line von Betfair (8.5/9.0/.../11.0)
  const MAX_AH_LINE = 4.0;             // Max. AH-Linie pro Seite (Viertel-Linien inklusive)
  const STALE_MAX_AGE_MIN = 60;        // PIN-Maerkte ohne Preis-Aenderung länger als X Min werden uebersprungen
  const LEAGUE_SLEEP_MS = 20;          // Pause zwischen Ligen (ms)
  const QUEUE_MAX = 20;                // Max. Snapshots in der localStorage-Offline-Queue
  const MS_PER_HOUR = 36e5;            // Millisekunden pro Stunde
  const MS_PER_DAY = 864e5;            // Millisekunden pro Tag
  const DEBUG_MODE = location.search.includes('debug') || location.hostname === 'localhost';
  // Detaillierte Scan-DEBUG-Zeilen nur bei ?debug, localhost oder gesetztem
  // localStorage-Flag ('vbsb_csarb_debug' = '1'). Bei Dauerbetrieb (Auto-Scan)
  // bleiben sie sonst aus — weniger Log-Volumen/Overhead, Fehler bleiben sichtbar.
  const DBG = DEBUG_MODE || (() => {
    try { return localStorage.getItem('vbsb_csarb_debug') === '1'; } catch (e) { return false; }
  })();
  // Auf pinnacle.com nur Konsole-Helper + Schnueffler; KEIN Panel, kein League-Map-Load,
  // kein automatischer Scan. Betfair behaelt das volle Verhalten. Der Fehler-Stats-Flush
  // laeuft seit v7.86.2 auf BEIDEN Seiten (der PIN-Tab zaehlt eigene Helper-Calls mit).
  const IS_BETFAIR = /betfair\.com/.test(location.hostname);

  // ---------- API-Concurrency + Caches ----------
  const pinSem = makeSem(PIN_MAX_CONCURRENCY);
  const bfSem = makeSem(BF_MAX_CONCURRENCY);
  const API_TIMEOUT_MS = 15000;
  const BF_CACHE_TTL_MS = 60000;       // Cross-Scan-Cache-TTL fuer bfLays/bfH2H (60s)

  // ---------- Request-/Fehler-Statistik (pro Scan-Lauf) ----------
  // Zaehler fuer die API-Last und -Fehler je Lauf; werden vom Panel und von
  // scan_metrics ausgewertet (Engpass-Diagnose: 429er/Timeouts/5xx je API).
  const reqStats = {
    pin: 0, pin429: 0, pinTimeout: 0, pin5xx: 0,
    bf: 0, bf429: 0, bfTimeout: 0, bf5xx: 0, bf403: 0,
  };
  const reqStatsReset = () => {
    reqStats.pin = 0; reqStats.pin429 = 0; reqStats.pinTimeout = 0; reqStats.pin5xx = 0;
    reqStats.bf = 0; reqStats.bf429 = 0; reqStats.bfTimeout = 0; reqStats.bf5xx = 0; reqStats.bf403 = 0;
  };
  // ---------- Pinnacle: Straight-Markt-Cache ----------
  // Cache je Matchup-ID: gleiche Straight-Fetches innerhalb eines Scan-Laufs
  // nur einmal ausfuehren (BTTS, OE, O/U, HT-O/U nutzen dieselben Daten).
  // Clear bei jedem Scan.
  const straightCache = new Map();
  // ---------- Betfair: 1:1-, BTTS- und O/U-Lays je Spiel ----------
  // Cross-Scan-Cache je COMP: Eintraege ueber Scans hinweg gueltig (TTL 60s).
  // Mehrere Ligen koennen auf denselben COMP zeigen (z.B. Regionalliga Ost/West).
  // Clear nur bei Verify/WHY — NICHT bei normalem Scan-Start.
  const bfLaysCache = new Map();
  // H2H-Cross-Scan-Cache je Liga (2-Wege-Maerkte): gleiche Fetches ueber
  // Scans hinweg gueltig (TTL 60s). Clear nur bei Verify/WHY.
  const bfH2HCache = new Map();
// ---------- Pinnacle: API-Transport + Matchups ----------
  async function pinGet(path, tries) {
    const attempts = tries || 0;
    reqStats.pin++;
    let r;
    try {
      await pinSem(async () => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
        try {
          r = await fetch(PB + path, { headers: { 'X-API-Key': API_KEY }, signal: ac.signal });
        } finally { clearTimeout(timer); }
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        reqStats.pinTimeout++;
        if (attempts < 3) { await sleep(backoff(500, attempts)); return pinGet(path, attempts + 1); }
        throw new Error('Pinnacle Timeout ' + path);
      }
      if (attempts < 3) { await sleep(backoff(500, attempts)); return pinGet(path, attempts + 1); }
      throw e;
    }
    if (r.status === 429 || r.status >= 500) {
      if (r.status === 429) reqStats.pin429++;
      else reqStats.pin5xx++;
      if (attempts < 3) {
        await sleep(backoff(800, attempts));
        return pinGet(path, attempts + 1);
      }
    }
    if (!r.ok) throw new Error('Pinnacle ' + r.status + ' ' + path);
    return r.json();
  }

  // ---------- Stale-Odds-Guard ----------
  // PIN-Maerkte, deren letzter Preiswechsel aelter als STALE_MAX_AGE_MIN Minuten ist,
  // werden uebersprungen (eingefrorene Quoten -> Fehl-Arbs). Fehlt der Timestamp oder
  // ist er unlesbar, gilt der Markt als frisch (konservativ, kein fahrlaessiges Droppen).
  const staleAge = m => {
    const raw = (m && (m.pricesUpdatedAt ?? m.marketsUpdatedAt)) ?? null;
    if (raw == null) return 0;
    let t;
    if (typeof raw === 'number') {
      t = raw;
      // Epoch-Sekunden -> Millisekunden normalisieren (10-11 Stellen vs. 13 Stellen)
      if (t < 1e12) t *= 1000;
    } else {
      t = new Date(raw).getTime();
    }
    if (isNaN(t) || t <= 0) return 0;
    return Date.now() - t;
  };
  // Filtert veraltete Maerkte aus einem PIN-Markt-Array, loggt je sid die Zahl der
  // verworfenen Maerkte. Bei undefined/null wird der Input unveraendert geliefert.
  function freshMkts(mkts, sid, log, src) {
    if (!Array.isArray(mkts) || !mkts.length) return mkts;
    const maxAge = STALE_MAX_AGE_MIN * 60000;
    let drop = 0, lastTs = '';
    const kept = [];
    for (const m of mkts) {
      const age = staleAge(m);
      if (age > maxAge) { drop++; lastTs = lastTs || String(m.pricesUpdatedAt ?? m.marketsUpdatedAt); continue; }
      kept.push(m);
    }
    if (drop) {
      const label = src ? ' [' + src + ']' : '';
      log('  STALE-MARKT ' + sid + ' ' + lastTs + label +
        ' (' + drop + '/' + mkts.length + ' Market(s) älter als ' + STALE_MAX_AGE_MIN + 'min)');
    }
    return kept;
  }

  // Gemeinsamer Pinnacle-Straight-Fetch (CS-Specs, H2H, BTTS): Markt-Rohdaten laden
  // und ueber freshMkts filtern. onErr ueberschreibt die Fehlerbehandlung
  // (Standard: null zurueckgeben), onRaw liefert das Roh-Ergebnis fuer Diagnose-Logs.
  async function fetchStraight(sid, log, src, onErr, onRaw) {
    // Cache-Check
    const cached = straightCache.get(sid);
    if (cached) {
      if (onRaw) onRaw(cached.raw);
      return cached.filtered;
    }
    // Fetch
    const raw = await pinGet('/matchups/' + sid + '/markets/straight')
      .catch(onErr || (() => null));
    if (onRaw) onRaw(raw);
    const filtered = freshMkts(raw, sid, log, src || 'pin');
    // Cache speichern
    straightCache.set(sid, { raw, filtered });
    return filtered;
  }

  // Match-Status-Guard: liefert Grund (fuer Log) wenn das Spiel nicht handelbar ist,
  // sonst null. "pending" ist normal fuer zukuenftige Spiele; geskippt wird nur bei
  // "closed" oder "pending" + alle Perioden closed (= unterbrochen/abgebrochen).
  function matchSkipReason(m) {
    const mStatus = (m.status || '').toLowerCase();
    const allPeriodsClosed = m.periods && m.periods.length &&
      m.periods.every(p => (p.status || '').toLowerCase() === 'closed');
    if (mStatus === 'closed') return 'status=closed';
    if (mStatus === 'pending' && allPeriodsClosed) return 'pending+alle Perioden closed';
    return null;
  }

  // ---------- Pinnacle: CS-Back (alle Scores 0,0-3,3) + Yes/No-Specials je Spiel ----------
  // CS 0:0 Merge-Helfer: Lay-Preis fuer 0:0 mergen (CS 0-0, Under 0.5, Either TTS=No, Exact Goals=0)
  function mergeCs00(rows, evn, layPrice, laySize, marketId, live, isU05) {
    const cs00row = rows.find(r => r.name === evn && r.kind === 'cs00');
    if (cs00row) {
      if (layPrice < cs00row.lay) {
        cs00row.lay = layPrice;
        cs00row.vol = laySize;
        cs00row.marketId = marketId;
      }
    } else {
      rows.push({ name: evn, kind: 'cs00', lay: layPrice, vol: laySize,
        marketId, live, u05: isU05 || false });
    }
  }
  async function pinGames(lid, log, st) {
    const mus = await pinGet('/leagues/' + lid + '/matchups').catch(() => []);
    if (st) st.pinRaw = (mus || []).filter(m => m.type === 'matchup' && !m.parentId).length;
    // Child-Matchup-Mapping (child.id -> parent.id). Soccer-Corners liegen als
    // eigenes Child-Matchup ("Arsenal (Corners) v ...") im lg-straight unter der
    // CHILD-ID, nicht unter der Spiel-ID — genauso wie Tennis-Games-Totals.
    const childOf = new Map();
    for (const c of (mus || []))
      if (c.type === 'matchup' && c.parentId)
        childOf.set(String(c.id), String(c.parentId));
    // Soccer-Corners (Eckball-O/U): Die Corners-Totals (6.5-13.5) sind isAlternate
    // und liegen NUR im lg-straight/related-straight, nicht im Kern-straight.
    // Einmal je Liga laden (wie pinH2H) und pro Spiel als eigener Kanal extrahieren.
    const soccer = sportVonLiga(lid) === 'Soccer';
    let lgStraight = null;
    if (soccer) {
      lgStraight = await pinGet('/leagues/' + lid + '/markets/straight').catch(() => null);
      const allTot = (Array.isArray(lgStraight) ? lgStraight : []).filter(x =>
        x && x.type === 'total' && Number(x.period) === 0);
      const corners = allTot.filter(x =>
        (x.prices || []).some(p => cornerLine(p.points)));
      log('  DEBUG pinGames[' + lid + '] lg-straight(soccer): ' +
        (Array.isArray(lgStraight) ? lgStraight.length : 'typ=' + typeof lgStraight) +
        ' | total-p0=' + allTot.length + ' | corners(6.5-13.5)=' + corners.length +
        (corners.length
          ? ' | ' + corners.map(c => c.key + ' mu=' + c.matchupId +
            ' pts=' + JSON.stringify((c.prices || []).map(p => p.points))).join(' | ')
          : ''));
    }
    const now = Date.now(), soon = now + daysAhead * MS_PER_DAY;
    const out = {};
    const htDbg = { n: 0, p1: 0, noBack: 0, games: {}, probe: 0 };
    const specs = (mus || []).filter(s => s.type === 'special' && s.parentId);
    // CS-Special: Teilnehmer enthalten "X,Y" (0,0 bis MAX_CS_SCORE,MAX_CS_SCORE) oder
    // "TeamX A, TeamY B" (PIN-Format, z.B. "Wolfsburg 0, Kaiserslautern 1") oder "Yes & Under"
    const CS_RE = new RegExp('^([0-' + MAX_CS_SCORE + ']),([0-' + MAX_CS_SCORE + '])$');
    const CS2_RE = new RegExp('^(.+) ([0-' + MAX_CS_SCORE + ']), (.+) ([0-' + MAX_CS_SCORE + '])$');
    const csKeyOf = nm => {
      const m1 = CS_RE.exec(nm);
      if (m1) return m1[1] + ',' + m1[2];
      const m2 = CS2_RE.exec(nm);
      if (m2) return m2[2] + ',' + m2[4];
      return null;
    };
    const isCS = ps => ps.some(p => csKeyOf(p.name) || /Yes & Under|No & Over/.test(p.name));
    const isYesNo = ps => ps.length === 2 && ps.some(p => p.name === 'Yes') &&
      ps.some(p => p.name === 'No');
    const isHfShape = ps => ps.length === 9 && ps.some(p => / - Draw$/.test(p.name || ''));
    // BTSW: 6 Teilnehmer "Yes & Team" / "No & Team" (Team kann Draw sein)
    const BTSW_RE = /^(yes|no) & (.+)$/i;
    const isBtswShape = ps => ps.length === 6 &&
      ps.every(p => BTSW_RE.test(p.name || ''));
    // RESOU (Result + O/U): 6 Teilnehmer "Team & Over X" / "Draw & Under X"
    const RESOU_RE = /^(.+) & (over|under) (\d+\.?\d*)$/i;
    const isResouShape = ps => ps.length === 6 &&
      ps.every(p => RESOU_RE.test(p.name || ''));
    const isOeShape = ps => ps.length === 2 && ps.some(p => p.name === 'Odd') &&
      ps.some(p => p.name === 'Even');
    // DC (Double Chance): 3 Teilnehmer "<TeamA> Or Draw" / "Draw Or <TeamB>" /
    // "<TeamA> Or <TeamB>". PIN liefert DC als Special (desc="Double Chance"),
    // nicht als Markt-Typ "double chance".
    const DC_RE = /^(.+) or (.+)$/i;
    const isDcShape = ps => ps.length === 3 && ps.every(p => DC_RE.test(p.name || '')) &&
      ps.some(p => / or draw$/i.test(p.name || '')) &&
      ps.some(p => /^draw or /i.test(p.name || ''));
    // Europaeisches Handicap (3-Weg): desc "3-Way Handicap <Team> <±N>",
    // 3 Teilnehmer "<Team> (±N)" | "Draw - (<Team> ±N)" | "<Gegner> (∓N)".
    // Braucht eigenen Shape-Test, damit die Preise gefetcht werden (wanted).
    const isEuhShape = s => {
      const ps = s.participants || [];
      if (ps.length !== 3) return false;
      const desc = String((s.special && s.special.description) || s.name || '');
      if (!/^3-way handicap\s+/i.test(desc)) return false;
      // Klammer-Zahl am ENDE: "Team (+1)" und "Draw - (Team +1)" (Draw-Teilnehmer
      // traegt den Teamnamen in der Klammer) — Zahl nicht direkt nach "(".
      return ps.some(p => /^draw/i.test((p.name || '').replace(/\s*\([^)]*\)\s*$/, ''))) &&
        ps.every(p => /\([^)]*[+-]\d+\s*\)\s*$/.test(p.name || ''));
    };
    // Exact Total Goals: Teilnehmer sind reine Tore-Zaehler ("0"..."7" bzw. "7+").
    // NUR der FT-Markt (desc exakt "Exact Total Goals") gehoert hierher —
    // "Exact Total Goals 1st Half", "<Team> Goals" (Team-Tore) und
    // "Exact Total Runs" (Baseball) duerfen weder gefetcht noch verarbeitet werden.
    const isExactGoalsShape = ps => ps.length >= 2 && ps.length <= 8 &&
      ps.every(p => /^(\d+)\+?$/.test(p.name || ''));
    const isExactGoalsFT = s => isExactGoalsShape(s.participants || []) &&
      /^exact total goals$/i.test(String((s.special && s.special.description) || s.name || ''));
    const isExactGoalsHT = s => isExactGoalsShape(s.participants || []) &&
      /^exact total goals 1st half$/i.test(String((s.special && s.special.description) || s.name || ''));
    const oeSpecs = specs.filter(s => isOeShape(s.participants || []));
    const exSpecs = specs.filter(s => isExactGoalsShape(s.participants || []));
    if (exSpecs.length)
      log('  DEBUG pinGames[' + lid + '] exGoals=' + exSpecs.length + ': ' +
        exSpecs.slice(0, 3).map(s => 'id=' + s.id + ' desc="' +
          String((s.special && s.special.description) || s.name || '') + '" | ' +
          (s.participants || []).map(p => p.name).join('/')).join(' ;; '));
    // 3-Way-Handicap-Specials (euh): liegen NUR im related-Pfad
    // (/matchups/{mid}/related), nicht im /leagues/{lid}/matchups-Endpoint
    // (probematch-Befund: "PIN Related-Liste (47)" inkl. der 3-Way-Handicap-
    // Specials). Fuer Soccer je Match im Scan-Fenster einmal related abrufen
    // und die euh-Specials zu specs ergaenzen, damit ihre Preise via
    // fetchStraight geladen und im Loop verarbeitet werden.
    // ACHTUNG Last-Schutz (v8.21.5): pro Liga nur max. 2 Matches proben, damit
    // nicht hunderte related-Calls je Scan laufen (FD-/Thread-Last auf der App).
    // Sobald die Probe zeigt, dass der Endpoint euh-Specials liefert, wird auf
    // alle Fenster-Matches skaliert.
    const relEuhSpecs = [];
    if (soccer) {
      const relSeen = new Set();
      const relMids = (mus || []).filter(m => m.type === 'matchup' && !m.parentId)
        .filter(m => {
          const t = new Date(m.startTime || 0).getTime();
          return t >= now - HOURS_BACK * MS_PER_HOUR && t <= soon && !matchSkipReason(m);
        })
        .slice(0, 2);
      await pool(relMids, async m => {
        const rel = await pinGet('/matchups/' + m.id + '/related').catch(() => null);
        if (!Array.isArray(rel)) return;
        for (const s of rel) {
          if (!s || s.type !== 'special' || !s.parentId) continue;
          if (relSeen.has(String(s.id))) continue;
          relSeen.add(String(s.id));
          if (isEuhShape(s)) relEuhSpecs.push(s);
        }
      }, 2);
    }
    specs.push(...relEuhSpecs);
    const wanted = specs.filter(s => isCS(s.participants || []) || isYesNo(s.participants || []) ||
      isHfShape(s.participants || []) || isBtswShape(s.participants || []) ||
      isResouShape(s.participants || []) || isOeShape(s.participants || []) ||
      isDcShape(s.participants || []) || isExactGoalsFT(s) || isExactGoalsHT(s) ||
      isEuhShape(s));
    const hfSpecs = specs.filter(s => isHfShape(s.participants || []));
    if (hfSpecs.length)
      log('  DEBUG pinGames[' + lid + '] specs=' + specs.length + ' hfShape=' + hfSpecs.length +
        ' oeSpecs=' + oeSpecs.length +
        ' z.B. id=' + hfSpecs[0].id + ' | ' + (hfSpecs[0].participants || [])
          .map(p => p.name).join(' | '));
    else if (specs.length)
      log('  DEBUG pinGames[' + lid + '] specs=' + specs.length + ' hfShape=0' +
        ' oeSpecs=' + oeSpecs.length + ', Probe: ' +
        (specs.slice(0, 2).map(s => 'id=' + s.id + ' n=' + (s.participants || []).length +
          ' | ' + (s.participants || []).slice(0, 4).map(p => p.name).join(' | ')).join(' ;; ')));
    // Fenster-Filter VOR dem Specials-Fetch: Nur Specials der Spiele laden, die
    // im Scan-Fenster liegen — out-of-window-Specials wurden im Loop eh verworfen
    // (spart bei kurzem Horizont den Grossteil der PIN-Straight-Calls).
    const winMuIds = new Set();
    for (const m of (mus || [])) {
      if (m.type !== 'matchup' || m.parentId) continue;
      const t = new Date(m.startTime || 0).getTime();
      if (t < now - HOURS_BACK * MS_PER_HOUR || t > soon) continue;
      if (matchSkipReason(m)) continue;
      winMuIds.add(String(m.id));
    }
    const wantedInWin = wanted.filter(s => winMuIds.has(String(s.parentId)));
    const straightById = {};
    await pool(wantedInWin, async s => {
      straightById[s.id] = await fetchStraight(s.id, log, 'spec');
    }, SPECIALS_CONCURRENCY);
    const hfFetchFail = hfSpecs.filter(s => winMuIds.has(String(s.parentId)) && !straightById[s.id]);
    if (hfFetchFail.length)
      log('  DEBUG pinGames[' + lid + '] HF-straight-FETCH FEHLGESCHLAGEN: ' +
        hfFetchFail.map(s => s.id).join(','));
    for (const m of (mus || [])) {
      if (m.type !== 'matchup' || m.parentId) continue;
      const t = new Date(m.startTime || 0).getTime();
      if (t < now - HOURS_BACK * MS_PER_HOUR || t > soon) continue;
      // Status-Filter: "pending" ist normal fuer zukuenftige Spiele.
      const skipReason = matchSkipReason(m);
      if (skipReason) {
        log('  DEBUG pinGames SKIP ' + skipReason + ': ' +
          (m.participants || []).map(p => p.name).join(' v '));
        continue;
      }
      let best = 0, src = '';
      const csDbg = {};
      const yn = [], ous = [], hfs = [], w2ns = [], btsws = [], resous = [], oes = [], dcs = [], pts = [], euhs = [];
      const csBacks = {};   // "0,0" -> back price
      const htCsBacks = {}; // "0,0" -> back price (Halbzeit-CS, period 1)
      const cs00Backs = []; // cs00-aquivalente Back-Preise (Under 0.5, Either TTS=No, Exact Goals=0, First TTS=Neither)
      const cs11Backs = []; // cs11-aquivalente Back-Preise (Yes & Under = BTTS Yes + Under 2.5 = exakt 1:1)
      let exactMax = null;  // Exact Total Goals: Max-Bucket "N+" = Over (N-0.5), analog Total Goals Range
      let exactMin = null;  // Total Goals Range: Low-Bucket "0 - N" = Under (N+0.5), z.B. "0 - 1" = Under 1.5
      let htExact0 = 0;     // Exact Total Goals 1st Half "0" = kein Tor in 1. HZ = HT Under 0.5
      let htNeither = 0;    // "First Team To Score 1st Half" NEITHER = kein Tor in 1. HZ
                            // (= HT Under 0.5) -> alternative/bessere PIN-Back-Quelle
      for (const s of specs) {
        if (s.parentId !== m.id) continue;
        const pr = straightById[s.id];
        if (!pr) continue;
        const ps = s.participants || [];
        if (ps.some(p => csKeyOf(p.name) || /Yes & Under|No & Over/.test(p.name))) {
          const nameById = {};
          ps.forEach(p => { nameById[p.id] = p.name; });
          const csDesc = String((s.special && s.special.description) || s.name || '');
          const prHt = (pr || []).some(mkt => Number(mkt.period || 0) === 1);
          const isHtCs = prHt || /1st half|first half|half time/i.test(csDesc);
          if (isHtCs) {
            htDbg.n++;
            if (prHt) htDbg.p1++;
            if (htDbg.probe === 0) {
              htDbg.probe = 1;
              log('  DEBUG pinGames[' + lid + '] ' + m.id + ' HT-CS-Probe ' + s.id +
                ' desc=' + JSON.stringify(csDesc) + ' p1Markets=' +
                (pr || []).filter(mk => Number(mk.period || 0) === 1).length +
                ' ps=[' + (ps || []).slice(0, 4).map(p => p.name).join(' | ') + ']');
            }
          }
          const csT = isHtCs ? htCsBacks : csBacks;
          const htBefore = Object.keys(htCsBacks).length;
          for (const mkt of pr) for (const px of (mkt.prices || [])) {
            const nm = nameById[px.participantId] || '';
            const d = dec(px.price);
            const ck = csKeyOf(nm);
            if (ck) {
              // Exakter Score: Back-Preis speichern
              if (!csT[ck] || d > csT[ck]) csT[ck] = d;
              // Fuer 1:1 auch als best (Rueckwaertskompatibilitaet, nur FT)
              if (!isHtCs && ck === '1,1' && d > best) { best = d; src = s.name || String(s.id); }
            } else if (/Yes & Under/.test(nm) && !isHtCs) {
              // Yes & Under: BTTS Yes + Under 2.5 = exakt 1:1 -> als 1:1-Back-Quelle
              // (max mit CS 1:1 bildet scan.js, analog cs00). Nur FT, nur 2.5-Linie.
              const yuLine = /Yes & Under\s*(\d+\.?\d*)/i.exec(nm);
              if (yuLine && Math.abs(parseFloat(yuLine[1]) - 2.5) < 0.01 && d > 1.01)
                cs11Backs.push({ back: d, src: 'Yes & Under ' + yuLine[1] });
              if (d > best) { best = d; src = s.name || String(s.id) + ' (Y&U)'; }
            }
          }
          if (Object.keys(htCsBacks).length && !csDbg[lid + ':' + m.id + ':' + s.id])
            log('  DEBUG pinGames[' + lid + '] ' + m.id + ' HT-CS special ' + s.id +
              ' (period1=' + prHt + ') backs=' +
              Object.keys(htCsBacks).map(k => k + '=' + htCsBacks[k].toFixed(2)).join(' '));
          if (isHtCs) {
            const htn = Object.keys(htCsBacks).length;
            if (htn === htBefore) htDbg.noBack++;
            if (htn) htDbg.games[m.id] = 1;
          }
        } else if (ps.length === 2 && ps.some(p => p.name === 'Odd') &&
          ps.some(p => p.name === 'Even')) {
          const desc = String((s.special && s.special.description) || s.name || '');
          if (/^total goals odd\/even$/i.test(desc) && !/1st half/i.test(desc)) {
            oes.push({ sid: s.id,
              oddId: ps.find(p => p.name === 'Odd').id,
              evenId: ps.find(p => p.name === 'Even').id, desc });
          }
        } else if (ps.length === 2 && ps.some(p => p.name === 'Yes') &&
          ps.some(p => p.name === 'No')) {
          const yesId = ps.find(p => p.name === 'Yes').id;
          const noId = ps.find(p => p.name === 'No').id;
          const desc = String((s.special && s.special.description) || s.name || '');
          if (/both teams to score/i.test(desc) && !/1st half/i.test(desc)) {
            yn.push({ sid: s.id, yesId, noId, desc });
          }
          if (/Either Team To Score/i.test(desc)) {
            const px = {};
            for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
            if (px[noId]) cs00Backs.push({ back: dec(px[noId]), src: 'Either TTS=No' });
          }
          if (/To Win to Nil\?$/i.test(desc)) {
            const px = {};
            for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
            const m0 = (pr || []).find(mkt => (mkt.period || 0) === 0);
            if (m0 && px[yesId] && px[noId]) {
              const teamName = desc.replace(/ To Win to Nil\?.*$/i, '').trim();
              const team = (m.participants || []).find(t => teamMatch(t.name, teamName));
              if (team)
                w2ns.push({ sid: s.id, team: team.name,
                  yes: dec(px[yesId]), no: dec(px[noId]) });
            }
          }
          // Torschuetze: desc endet exakt mit " To Score" (z.B. "Kai Havertz To
          // Score", Teilnehmer Yes/No). Abgrenzung: "Either Team To Score" (BTTS)
          // und "First Team To Score 1st Half" sind andere Maerkte, ebenso
          // "To Score 2 Goals or More"/"To Score a Hat-trick?" (andere Endung).
          if (/^(.+) to score$/i.test(desc) && !/either team|first team/i.test(desc)) {
            const player = desc.replace(/ to score$/i, '').trim();
            const px = {};
            for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
            const y = dec(px[yesId] || 0), n = dec(px[noId] || 0);
            if (player && y > 1.01 && n > 1.01)
              pts.push({ sid: s.id, player, yes: y, no: n, desc });
          }
        } else if (isBtswShape(ps)) {
          // BTSW: kombinierter Ausgang "Yes & Team"/"No & Team" mit EIGENER Quote
          // (Team = Draw oder ein Teilnehmer des Spiels). Back-Preis je Ausgang.
          const nameById = {};
          ps.forEach(p => { nameById[p.id] = p.name; });
          const desc = String((s.special && s.special.description) || s.name || '');
          const outs = [];
          for (const mkt of pr) for (const p of (mkt.prices || [])) {
            const nm = nameById[p.participantId] || '';
            const mm = BTSW_RE.exec(nm);
            if (!mm) continue;
            const d = dec(p.price);
            if (d <= 1.01) continue;
            const teamName = mm[2].trim();
            const isDraw = /^(draw|tie)$/i.test(teamName);
            const team = isDraw ? 'Draw' :
              ((m.participants || []).find(t => teamMatch(t.name, teamName)) || {}).name;
            if (!team) continue;
            outs.push({ yn: mm[1].toLowerCase(), team, back: d });
          }
          if (outs.length)
            btsws.push({ sid: s.id, desc, outs });
        } else if (isResouShape(ps)) {
          // RESOU (Result + O/U): kombinierter Ausgang "Team & Over X"/"Draw & Under X"
          // mit EIGENER Quote je Ausgang (Team = Draw oder ein Teilnehmer des Spiels).
          const nameById = {};
          ps.forEach(p => { nameById[p.id] = p.name; });
          const desc = String((s.special && s.special.description) || s.name || '');
          const outs = [];
          for (const mkt of pr) for (const p of (mkt.prices || [])) {
            const nm = nameById[p.participantId] || '';
            const mm = RESOU_RE.exec(nm);
            if (!mm) continue;
            const d = dec(p.price);
            if (d <= 1.01) continue;
            const teamName = mm[1].trim();
            const isDraw = /^(draw|tie)$/i.test(teamName);
            const team = isDraw ? 'Draw' :
              ((m.participants || []).find(t => teamMatch(t.name, teamName)) || {}).name;
            if (!team) continue;
            const line = parseFloat(mm[3]);
            outs.push({ side: mm[2].toLowerCase(), line, team, back: d });
          }
          if (outs.length)
            resous.push({ sid: s.id, desc, outs });
        } else if (isDcShape(ps)) {
          // PIN Double Chance Special (desc="Double Chance", period=0):
          // "<TeamA> Or Draw" -> 1X, "Draw Or <TeamB>" -> X2,
          // "<TeamA> Or <TeamB>" -> 12. Nur FT (period 0), nie "1st Half".
          const desc = String((s.special && s.special.description) || s.name || '');
          if (/^double chance$/i.test(desc) && !/1st half|first half|half time/i.test(desc)) {
            const nameById = {};
            ps.forEach(p => { nameById[p.id] = p.name; });
            const dc = {};
            for (const mkt of pr) {
              if (Number(mkt.period || 0) !== 0) continue;
              for (const p of (mkt.prices || [])) {
                const nm = nameById[p.participantId] || '';
                const mm = DC_RE.exec(nm);
                if (!mm) continue;
                const d = dec(p.price);
                if (d <= 1.01) continue;
                const left = mm[1].trim().toLowerCase();
                const right = mm[2].trim().toLowerCase();
                if (/^draw$/i.test(right)) dc['1x'] = d;
                else if (/^draw$/i.test(left)) dc['x2'] = d;
                else dc['12'] = d;
              }
            }
            if (Object.keys(dc).length)
              dcs.push({ sid: s.id, desc, dc });
          }
        } else if (ps.length === 3 && /^3-way handicap\s+/i.test(
            String((s.special && s.special.description) || s.name || ''))) {
          // Europaeisches Handicap (3-Weg): desc "3-Way Handicap <Team> <±N>",
          // Teilnehmer "<Team> (±N)" | "Draw - (<Team> ±N)" | "<Gegner> (∓N)".
          // Nur FT (period 0), Ganzzahl-Linien >= 1; 3 Preise erforderlich.
          // NOTE: desc MUSS hier neu abgeleitet werden (const ist block-scoped und
          // in den vorherigen else-if-Zweigen definiert — hier sonst undefiniert).
          const desc = String((s.special && s.special.description) || s.name || '');
          if (!/1st half|first half|half time/i.test(desc)) {
            const m = /^3-way handicap\s+(.+?)\s+([+-]\d+)$/i.exec(desc);
            if (m) {
              const line = parseFloat(m[2]);
              const teamName = m[1].trim();
              if (Number.isInteger(line) && Math.abs(line) >= 1 && Math.abs(line) <= 9) {
                const nameById = {};
                ps.forEach(p => { nameById[p.id] = p.name; });
                const prices = {};
                for (const mkt of pr) {
                  if (Number(mkt.period || 0) !== 0) continue;
                  for (const p of (mkt.prices || [])) {
                    const nm = nameById[p.participantId] || '';
                    const d = dec(p.price);
                    if (d <= 1.01) continue;
                    prices[nm] = d;
                  }
                }
                // Ausgaenge klassifizieren: Side (desc-Team ±N), Draw, Opp (∓N).
                const outs = {};
                for (const nm of Object.keys(prices)) {
                  const base = nm.replace(/\s*\([^)]*\)\s*$/, '').trim();
                  if (/^draw/i.test(base)) outs.draw = prices[nm];
                  else if (teamMatch(base, teamName)) outs.side = prices[nm];
                  else outs.opp = prices[nm];
                }
                if (outs.side && outs.draw && outs.opp) {
                  euhs.push({ sid: s.id, line, team: teamName,
                    side: outs.side, draw: outs.draw, opp: outs.opp, desc });
                }
              }
            }
          }
        } else if (ps.length === 2 && ps.some(p => /^over \d/.test(p.name || '')) &&
          ps.some(p => /^under \d/.test(p.name || ''))) {
          const over = ps.find(p => /^over \d/.test(p.name));
          const lm = /^over (\d+\.?\d*)$/i.exec(over.name);
          const line = lm ? parseFloat(lm[1]) : NaN;
          if (line >= 0.5 && line <= MAX_OU_LINE_PIN)
            ous.push({ sid: s.id, overId: over.id,
              underId: ps.find(p => /^under \d/.test(p.name)).id, line });
          if (Math.abs(line - 0.5) < 0.01) {
            const underId = ps.find(p => /^under \d/.test(p.name)).id;
            const px = {};
            for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
            if (px[underId]) cs00Backs.push({ back: dec(px[underId]), src: 'Under 0.5' });
          }
        } else if (ps.length === 9 && ps.every(p => {
          const parts = String(p.name || '').split(' - ');
          if (parts.length !== 2) return false;
          return parts.every(s => s === 'Draw' ||
            (m.participants || []).some(t => teamMatch(t.name, s)));
        })) {
          const px = {};
          for (const mkt of pr) for (const p of (mkt.prices || [])) {
            if (typeof p.price === 'number') px[p.participantId ?? p.id] = p.price;
          }
          const outs = (s.participants || []).map(pp => ({
            name: pp.name, back: dec(px[pp.id] || 0) }))
            .filter(o => o.back > 1.01);
          if (outs.length) hfs.push({ sid: s.id, outs });
        } else if (isExactGoalsShape(ps)) {
          // Exact Total Goals: Teilnehmer sind Tore-Zaehler ("0"..."7" bzw. "7+").
          // NUR zwei Märkte sind relevant:
          //   FT  "Exact Total Goals": "0" = Under 0.5 (cs00-Quelle + Cross-Leg
          //       ueber 0.5), Max-Bucket "N+" = Over (N-0.5) analog Total-Goals-Range.
          //   HT  "Exact Total Goals 1st Half": nur "0" = kein Tor in 1. HZ =
          //       HT Under 0.5 (Quelle fuer den Halbzeit-O/U-Kanal).
          // "<Team> Goals" (Team-Tore) und "Exact Total Runs" (Baseball) gehoeren
          // nicht hierher (weder FT noch HT).
          const desc = String((s.special && s.special.description) || s.name || '');
          if (/^exact total goals$/i.test(desc)) {
            const px = {};
            for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
            const zeroP = ps.find(p => p.name === '0');
            if (zeroP && px[zeroP.id]) {
              const b0 = dec(px[zeroP.id]);
              if (b0 > 1.01) cs00Backs.push({ back: b0, src: 'Exact Goals=0' });
            }
            let topN = -1, topId = null;
            for (const p of ps) {
              const mm = /^(\d+)\+?$/.exec(p.name || '');
              if (!mm) continue;
              const n = Number(mm[1]);
              if (n > topN) { topN = n; topId = p.id; }
            }
            if (topN >= 1 && topId != null && px[topId]) {
              const topBack = dec(px[topId]);
              if (topBack > 1.01 && (!exactMax || topBack > exactMax.back))
                exactMax = { line: topN - 0.5, back: topBack };
            }
          } else if (/^exact total goals 1st half$/i.test(desc)) {
            // HT: nur "0" auswerten (= kein Tor in 1. Halbzeit = HT Under 0.5).
            const zeroP = ps.find(p => p.name === '0');
            if (zeroP) {
              const px = {};
              for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
              if (px[zeroP.id]) {
                const b0 = dec(px[zeroP.id]);
                if (b0 > 1.01 && b0 > htExact0) htExact0 = b0;
              }
            }
          }
        } else if (/^total goals range$/i.test(String((s.special && s.special.description) || s.name || ''))) {
          // Total Goals Range: Teilnehmer sind Buckets wie "0 - 3", "4 - 6",
          // "7+". Max-Bucket "N+" = BF "Over (N-0.5)"; Low-Bucket "0 - N"
          // (Start bei 0) = BF "Under (N+0.5)", z.B. "0 - 1" = Under 1.5.
          // Nur FT (period 0) — HT-Ranges laufen ueber htExact0-Kanal.
          const px = {};
          for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
          let topN = -1, topId = null;
          for (const p of ps) {
            const rm = /^(\d+)\s*\+$/i.exec(p.name || '');
            if (!rm) continue;
            const n = Number(rm[1]);
            if (n > topN) { topN = n; topId = p.id; }
          }
          if (topN >= 1 && topId != null && px[topId]) {
            const topBack = dec(px[topId]);
            if (topBack > 1.01 && (!exactMax || topBack > exactMax.back))
              exactMax = { line: topN - 0.5, back: topBack };
          }
          // Low-Bucket "0 - N": deckt die Tore 0..N ab = Under (N+0.5). Das ist
          // die gesuchte "Total Goals Range 0-1" (= Under 1.5). Analog exactMax
          // nur als Under-Quelle; Preise kommen als Fallback in den O/U-Matcher,
          // wenn die straight-Linie (N+0.5) fehlt oder teurer ist.
          let lowN = -1, lowId = null;
          for (const p of ps) {
            const rm = /^0\s*-\s*(\d+)$/.exec(p.name || '');
            if (!rm) continue;
            const n = Number(rm[1]);
            if (n > lowN) { lowN = n; lowId = p.id; }
          }
          if (lowN >= 0 && lowId != null && px[lowId]) {
            const lowBack = dec(px[lowId]);
            if (lowBack > 1.01 && (!exactMin || lowBack > exactMin.back))
              exactMin = { line: lowN + 0.5, back: lowBack };
          }
        } else if (ps.some(p => /^neither$/i.test(p.name || '')) &&
          /^first team to score/i.test(String((s.special && s.special.description) || s.name || ''))) {
          // First Team To Score = NEITHER: "kein Team erzielt das erste Tor".
          //   - 1st Half (desc-Hinweis): kein Tor in der 1. Halbzeit = HT Under 0.5
          //     -> htNeither als alternative/bessere PIN-Under-0.5-Quelle gegen BF
          //     "First Half Goals 0.5" (hfou5U / hfouBB5U).
          //   - Full Time (period-0-Markt): kein Tor im ganzen Spiel = exakt 0:0
          //     -> weitere cs00-Quelle fuer die 0:0-Max-Auswertung (cs00 MAX),
          //     aequivalent zu Either TTS=No / Under 0.5 / Exact Goals=0.
          //   - 2nd Half (period 2) faellt durch beide Zweige -> kein 0:0-Bezug.
          const nth = ps.find(p => /^neither$/i.test(p.name || ''));
          if (nth) {
            const px = {};
            for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
            const nb = dec(px[nth.id]);
            if (nb > 1.01) {
              const desc = String((s.special && s.special.description) || s.name || '');
              if (/1st half|first half|half time/i.test(desc)) {
                if (nb > htNeither) htNeither = nb;
              } else if ((pr || []).some(mkt => Number(mkt.period || 0) === 0)) {
                cs00Backs.push({ back: nb, src: 'First TTS=Neither' });
              }
            }
          }
        }
      }
      // Zeitbasierte Heuristik: Wenn ein Spiel laenger als 4 Stunden live ist,
      // wird es wahrscheinlich abgebrochen/walkover sein -> Quoten verwaist.
      if (m.isLive && m.startTime) {
        const startMs = new Date(m.startTime).getTime();
        const nowMs = Date.now();
        const hoursSinceStart = (nowMs - startMs) / (1000 * 60 * 60);
        if (hoursSinceStart > 4) {
          log('  DEBUG pinGames SKIP stale live: ' + 
            (m.participants || []).map(x => x.name).join(' v ') +
            ' (seit ' + hoursSinceStart.toFixed(1) + 'h live)');
          continue;
        }
      }
      const htKeys = Object.keys(htCsBacks);
      // Soccer-Corners-Kanal: Corners-Totals aus dem lg-straight dieses Spiels
      // (nur Linien 6.5–13.5, damit Tore-Totals und Nicht-Corners-Totals wie
      // 75.5 nie hier landen). Getrennt von goalsOu, damit BF-Corners-8.5 nie
      // gegen PIN-Tore-8.5 paart. Die Ecken liegen als Child-Matchup unter der
      // CHILD-ID im lg-straight -> zusaetzlich childOf-Zuordnung pruefen.
      let cornersOu = null;
      if (soccer && Array.isArray(lgStraight)) {
        const tid = String(m.id);
        const totOwn = lgStraight.filter(x =>
          x && x.type === 'total' && Number(x.period) === 0 &&
          (String(x.matchupId) === tid ||
           childOf.get(String(x.matchupId)) === tid));
        if (totOwn.length) cornersOu = ouGoals(totOwn).filter(o => cornerLine(o.line) && !o.range);
      }
      // Sportarten ohne Specials (z.B. Cricket-Test-Matches) haben auf PIN nur
      // das Moneyline. Ohne Pool-Eintrag wuerde findH() das Spiel nie auf einen
      // BF-Match-Odds-Lay (mo3) treffen -> "Pinnacle <lid>: 0 Spiele" und der
      // Back-vs-Lay-Vergleich (processMatchOdds) laeuft nie. Also fuer solche
      // Spiele das Moneyline laden und den besten 1X2-Back als best uebernehmen.
      // Soccer wird nie betroffen (jedes Spiel hat CS-Specials), Cricket nur
      // wenige Spiele -> wenige zusaetzliche Fetches.
      if (!(best > 0 || yn.length || ous.length || hfs.length || w2ns.length ||
        btsws.length || resous.length || oes.length || dcs.length || pts.length || euhs.length ||
        Object.keys(csBacks).length || cs00Backs.length || cs11Backs.length || htKeys.length ||
        htNeither > 0 || (cornersOu && cornersOu.length))) {
        const mpr = await pinGet('/matchups/' + m.id + '/markets/straight')
          .catch(() => null);
        const ml = (Array.isArray(mpr) ? mpr : []).find(mkt =>
          /^moneyline$/i.test(String(mkt.type || '')) && (mkt.period || 0) === 0);
        if (ml) {
          const px = pinPrices(ml);
          const mlBack = Math.max(toDecU(px['home']), toDecU(px['draw']),
            toDecU(px['away']), toDecU(px['tie']));
          if (mlBack > 1.01) { best = mlBack; src = 'PIN Moneyline'; }
        }
      }
      if (best > 0 || yn.length || ous.length || hfs.length || w2ns.length || btsws.length || resous.length || oes.length || dcs.length || pts.length || euhs.length || Object.keys(csBacks).length || cs00Backs.length || cs11Backs.length || htKeys.length || htNeither > 0 || (cornersOu && cornersOu.length))
        out[m.id] = { id: m.id, teams: (m.participants || []).map(x => x.name),
          back: best, src, yn, ous, hfs, w2ns, btsws, resous, oes, dcs, pts, euhs, csBacks, cs00Backs, cs11Backs,
          htCsBacks, htNeither, htExact0, exactMax, exactMin, cornersOu, st: m.startTime, score: scoreOf(m),
          live: !!m.isLive };
      if (exactMax)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' exactMax=' + exactMax.line +
          ' @' + exactMax.back.toFixed(2));
      if (exactMin)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' exactMin=' + exactMin.line +
          ' @' + exactMin.back.toFixed(2));
      if (htExact0 > 0)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' htExact0=' + htExact0.toFixed(2));
      if (cornersOu && cornersOu.length)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' cornersOu=' +
          cornersOu.map(o => o.line + '=' + o.over.toFixed(2)).join(' '));
      if (w2ns.length)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' w2ns=' + w2ns.length +
          ' | ' + w2ns.map(w => w.team + '=' + w.yes.toFixed(2)).join(' '));
      if (pts.length)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' pts=' + pts.length +
          ' | ' + pts.map(p => p.player + '=' + p.yes.toFixed(2)).join(' '));
      if (btsws.length)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' btsws=' + btsws.length +
          ' | ' + btsws.map(bs => bs.outs.map(o => o.yn + '&' + o.team + '=' + o.back.toFixed(2)).join(' ')).join(' ;; '));
      if (resous.length)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' resous=' + resous.length +
          ' | ' + resous.map(bs => bs.outs.map(o => o.team + '&' + o.side + ' ' + o.line +
            '=' + o.back.toFixed(2)).join(' ')).join(' ;; '));
      if (hfs.length)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' hfs=' + hfs.length +
          ' outs=' + (hfs[0].outs || []).length + ' Beispiel: ' +
          (hfs[0].outs || []).slice(0, 3).map(o => o.name + '=' + o.back).join(' '));
      if (oes.length)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' oes=' + oes.length +
          ' | ' + oes.map(o => o.desc + ' (sid ' + o.sid + ', odd ' + o.oddId +
            ', even ' + o.evenId + ')').join(' | '));
      if (dcs.length)
        log('  DEBUG pinGames[' + lid + '] ' + m.id + ' dcs=' + dcs.length +
          ' | ' + dcs.map(d => d.desc + ' (sid ' + d.sid + '): 1X=' +
            ((d.dc && d.dc['1x']) || 0).toFixed(2) + ' X2=' +
            ((d.dc && d.dc['x2']) || 0).toFixed(2) + ' 12=' +
            ((d.dc && d.dc['12']) || 0).toFixed(2)).join(' | '));
      if (euhs.length) {
      }
    }
    if (DBG) log('  Pinnacle ' + lid + ': ' + Object.keys(out).length + ' Spiele');
    if (Object.values(out).some(p => p.cornersOu && p.cornersOu.length))
      log('  DEBUG pinGames[' + lid + '] cornersOu: ' +
        Object.values(out).filter(p => p.cornersOu && p.cornersOu.length)
          .map(p => p.teams.join(' v ') + ' ' + p.cornersOu.map(o => o.line + '=' + o.over.toFixed(2)).join(' ')).join(' | '));
    if (htDbg.n || Object.keys(htDbg.games).length)
      log('  DEBUG pinGames[' + lid + '] HT-CS-Bilanz: ' + htDbg.n + ' HT-Specials (' +
        htDbg.p1 + ' mit period=1, ' + htDbg.noBack + ' ohne Back-Preis), ' +
        Object.keys(htDbg.games).length + ' Spiel(e) mit htCsBacks');
    if (st) st.pinOut = Object.keys(out).length;
    return out;
  }

  // ---------- H2H (2-Wege-Maerkte, alle Sportarten) ----------
  let debugH2HShape = false;
  async function pinH2H(lid, log) {
    // Retry auf leere /matchups-Antwort: ein transienter Netzwerkfehler darf
    // NICHT als "Turnier vorbei" fehlgedeutet werden (scanH2HLeague wuerde
    // sonst autoTourLid-Remap ausloesen). 3 Versuche mit Backoff, analog Discovery.
    let mus = await pinGet('/leagues/' + lid + '/matchups').catch(() => []);
    for (let i = 0; i < 2 && !(mus || []).length; i++) {
      await sleep(backoff(600, i));
      mus = await pinGet('/leagues/' + lid + '/matchups').catch(() => []);
    }
    const now = Date.now(), soon = now + daysAhead * MS_PER_DAY;
    const out = {};
    let nZeit = 0, nPart = 0, nPx = 0, nFail = 0, nOdds = 0, dStraight = false;
    if (!(mus || []).length) {
      log('  DEBUG pinH2H[' + lid + '] RAW leer');
    } else if (!debugH2HShape) {
      debugH2HShape = true;
      const f0 = mus[0];
      log('  DEBUG pinH2H[' + lid + '] RAW=' + mus.length);
      log('  DEBUG pinH2H[' + lid + '] Keys=' + Object.keys(f0).join(','));
      log('  DEBUG pinH2H[' + lid + '] F0: type=' + JSON.stringify(f0.type) +
        ' parentId=' + JSON.stringify(f0.parentId) +
        ' startTime=' + JSON.stringify(f0.startTime) +
        ' isLive=' + f0.isLive + ' state=' + JSON.stringify(f0.state) +
        ' home=' + JSON.stringify(f0.home) + ' away=' + JSON.stringify(f0.away) +
        ' name=' + JSON.stringify(f0.name) +
        ' Teilnehmer=' + JSON.stringify((f0.participants || []).map(p => p.name)) +
        ' moneyline=' + JSON.stringify(f0.moneyline && f0.moneyline.prices || null) +
        ' marketPicks=' + JSON.stringify((f0.marketPicks || []).map(p => p.price)));
    }
    const ups = (mus || []).filter(m => m.type === 'matchup' && !m.parentId);
    // MMA/UFC: "Fight Goes To Decision" ist ein PIN-Special (type=special,
    // desc="Fight Goes To Decision", Teilnehmer Yes/No). Preise kommen aus dem
    // straight-Fetch des Specials (wie BTTS/OE im CS-Pfad).
    const specs = (mus || []).filter(s => s.type === 'special' && s.parentId);
    const fdSpec = s => {
      const desc = String((s.special && s.special.description) || s.name || '');
      return /fight goes to decision|go(es)? (to )?(the )?distance/i.test(desc);
    };
    const fdSpecs = specs.filter(fdSpec);
    if (fdSpecs.length)
      log('  DEBUG pinH2H[' + lid + '] FD-Specials: ' + fdSpecs.length + ' (' +
        fdSpecs.slice(0, 4).map(s => s.id).join(',') + ')');
    const fdById = {};
    if (fdSpecs.length) {
      await pool(fdSpecs, async s => {
        const pr = await fetchStraight(s.id, log, 'fd');
        if (!pr) return null;
        const ps = s.participants || [];
        const yesP = ps.find(p => String(p.name).toLowerCase() === 'yes');
        const noP = ps.find(p => String(p.name).toLowerCase() === 'no');
        const yesId = yesP ? (yesP.id ?? yesP.participantId) : null;
        const noId = noP ? (noP.id ?? noP.participantId) : null;
        if (yesId == null || noId == null) return null;
        const px = {};
        for (const mkt of (pr || [])) for (const p of (mkt.prices || []))
          if (typeof p.price === 'number') px[p.participantId ?? p.id] = p.price;
        const yes = toDecU(px[yesId]), no = toDecU(px[noId]);
        if (yes > 1.01 && no > 1.01) fdById[s.parentId] = { yes, no };
        return null;
      }, POOL_CONCURRENCY);
    }
    // Tennis: Die Games-Totals (s;0;ou;21.5 …) sind isAlternate-Maerkte und liegen
    // NICHT zuverlaessig in /matchups/{id}/markets/straight (dort oft nur die 5
    // Kern-Maerkte inkl. Set-Total 2.5). Die komplette Marktliste inkl. Games
    // liefert /leagues/{lid}/markets/straight (pro Liga ein Call, gefiltert je
    // Matchup). Fuer alle anderen Sportarten bleibt es beim bisherigen Pfad.
    const tennis = sportVonLiga(lid) === 'Tennis';
    const soccer = sportVonLiga(lid) === 'Soccer';
    let lgStraight = null;
    let tennisChildOf = null;
    if ((tennis || soccer) && ups.length) {
      lgStraight = await pinGet('/leagues/' + lid + '/markets/straight').catch(() => null);
      tennisChildOf = new Map();
      for (const c of (mus || []))
        if (c.type === 'matchup' && c.parentId)
          tennisChildOf.set(String(c.id), String(c.parentId));
    }
    if (soccer) {
      const allTot = (Array.isArray(lgStraight) ? lgStraight : []).filter(x =>
        x && x.type === 'total' && Number(x.period) === 0);
      const corners = allTot.filter(x =>
        (x.prices || []).some(p => cornerLine(p.points)));
      log('  DEBUG pinH2H[' + lid + '] lg-straight(soccer): ' +
        (Array.isArray(lgStraight) ? lgStraight.length : 'typ=' + typeof lgStraight) +
        ' | total-p0=' + allTot.length + ' | corners(6.5-13.5)=' + corners.length +
        (corners[0] ? ' | Bsp ' + corners[0].key + ' mu=' + corners[0].matchupId +
          ' line=' + corners[0].line + ' pts=' +
          JSON.stringify((corners[0].prices || []).map(p =>
            ({ d: p.designation, pts: p.points, pr: p.price }))) : ''));
    }
    if (tennis) {
      const allTot = (Array.isArray(lgStraight) ? lgStraight : []).filter(x =>
        x && x.type === 'total' && Number(x.period) === 0);
      const games = allTot.filter(x =>
        (x.prices || []).some(p => Math.abs(Number(p.points)) > 5));
      const muCount = {};
      for (const g of allTot) muCount[g.matchupId] = (muCount[g.matchupId] || 0) + 1;
      const g0 = games[0];
      const g0Parent = g0 && tennisChildOf ? tennisChildOf.get(String(g0.matchupId)) : undefined;
      const mu0 = ups[0] || {};
      log('  DEBUG pinH2H[' + lid + '] lg-straight: ' +
        (Array.isArray(lgStraight) ? lgStraight.length : 'typ=' + typeof lgStraight) +
        ' | total-p0=' + allTot.length + ' | games(pts>5)=' + games.length +
        ' | Kinder=' + (tennisChildOf ? tennisChildOf.size : 0) +
        ' | bestOfX(m0)=' + JSON.stringify(mu0.bestOfX) +
        ' | m0.keys=' + Object.keys(mu0).join(',') +
        ' | total-p0 je muId=' + JSON.stringify(muCount) +
        (g0 ? ' | Bsp ' + g0.key + ' mu=' + g0.matchupId +
          ' (parent=' + (g0Parent || '?') + ') px=' +
          JSON.stringify((g0.prices || []).map(p =>
            ({ d: p.designation, pts: p.points, pr: p.price }))) : ''));
    }
    const straights = await adaptivePool(ups, async m => {
      const t = new Date(m.startTime || 0).getTime();
      const inWin = !(t < now - HOURS_BACK * MS_PER_HOUR || t > soon);
      // Nur Spiele im Fenster fetchen — out-of-window/closed-Matchups werden im
      // Loop eh uebersprungen (spart die Straight-Calls bei kurzem Horizont).
      if (!inWin || matchSkipReason(m)) return { m, inWin: false, pr: null };
      const pr = await fetchStraight(m.id, log, 'h2h',
        e => (dStraight = false, { err: e.message }));
      return { m, inWin, pr };
    }, POOL_CONCURRENCY);
    for (const { m, inWin, pr } of straights) {
      if (!inWin) continue;
      // Status-Filter: "pending" ist normal fuer zukuenftige Spiele.
      const skipReason = matchSkipReason(m);
      if (skipReason) {
        log('  DEBUG pinH2H SKIP ' + skipReason + ': ' +
          (m.participants || []).map(p => p.name).join(' v '));
        continue;
      }
      nZeit++;
      const ps = m.participants || [];
      if (ps.length !== 2) continue;
      nPart++;
      if (pr && pr.err) {
        log('  DEBUG pinH2H straight[' + m.id + '] FEHLER: ' + pr.err);
        continue;
      }
      if (!pr) continue;
      const moneylineMs = (pr || []).filter(mkt => {
        const both = [mkt.type, mkt.marketName, mkt.name, mkt.period]
          .map(x => String(x || '').toLowerCase()).join(' ')
          .replace(/[^a-z0-9]+/g, ' ');
        return /moneyline/.test(both) &&
          !/(^| )(1st|2nd|3rd|4th|1|2|3|4)\.? (set|quarter|half|period|frame|inning)( |$)|(^| )(set|sets ahead|first half|second half)( |$)/i
            .test(both);
      });
      if (!dStraight) {
        dStraight = true;
        log('  DEBUG pinH2H straight[' + m.id + ']: ' + pr.length + ' Markets, Moneyline=' +
          JSON.stringify(moneylineMs.map(mkt => ({
            t: mkt.type, name: mkt.marketName || mkt.name || '', per: mkt.period,
            px: (mkt.prices || []).map(p =>
              ({ d: p.designation || p.participantId || p.id || '?', pr: p.price }))
          }))) +
          ' m0Keys=' + JSON.stringify(moneylineMs[0] ? Object.keys(moneylineMs[0]) : []));
      }
      const toDec = toDecU;
      const mlPair = mkt => {
        const pxD = {};
        for (const p of (mkt && mkt.prices) || []) {
          if (!p || typeof p.price !== 'number') continue;
          if (p.designation) pxD[String(p.designation).toLowerCase()] = p.price;
          else {
            const pid = p.participantId ?? p.id;
            if (pid !== undefined && pid !== null) pxD['p' + pid] = p.price;
            else if (p.participant && p.participant.name)
              pxD[String(p.participant.name).toLowerCase()] = p.price;
          }
        }
        const q = (x, d) => {
          if (!x) return 0;
          const id = x.id ?? x.participantId;
          const k = (id !== undefined && id !== null) ? 'p' + id : String(x.name).toLowerCase();
          return toDec(pxD[k] ?? pxD[d]);
        };
        return [q(ps[0], 'home'), q(ps[1], 'away')];
      };
      const matchMoneyline = moneylineMs.find(m => Number(m.period) === 0) || moneylineMs[0];
      const [a, b] = mlPair(matchMoneyline);
      if (!(a > 1.01 && b > 1.01)) {
        nFail++;
        if (nFail <= 3)
          log('  DEBUG pinH2H KEINE 2 Preise (a=' + a + ' b=' + b + '): ' +
            ps.map(x => x.name).join(' | '));
        continue;
      }
      nPx++;
      // Satz-Handicap (Tennis Best-of-3): 2:0-Back je Spieler aus dem
      // Spread-Markt (pt -1.5). Gate: bestOfX aus der PIN-Matchstruktur
      // (3 = 2 Gewinnsaetze). Fallback, wenn bestOfX fehlt: Spread-Guard
      // spMax <= 1.5 (Grand Slams bieten +/-2.5 an -> -1.5 ist dann kein 2:0).
      const spMks = (pr || []).filter(mkt => mkt.type === 'spread' && Number(mkt.period) === 0);
      const spMax = Math.max(0, ...spMks.flatMap(mkt => (mkt.prices || [])
        .map(p => Math.abs(Number(p.points) || 0))));
      const bestOf = Number(m.bestOfX);
      // bo3 = Best-of-3 (2 Gewinnsaetze): Satz-Handicap ±1.5, Satz-Total 2.5.
      // bo5 = Grand Slam / Best-of-5 (3 Gewinnsaetze): Satz-Handicap ±2.5,
      // Satz-Total 3.5. Grand Slams bieten ±2.5 an -> -1.5 ist dort kein 2:0.
      const bo3 = bestOf === 3 ||
        (m.bestOfX == null && spMks.length && spMax <= 1.5);
      const bo5 = bestOf === 5 ||
        (m.bestOfX == null && spMks.length && spMax > 1.5);
      let b2 = null, b15 = null;
      // Best-of-5: ±2.5 (b25 = "gewinnt 3:0", b25plus = "verliert nicht 0:3").
      // b15neg = -1.5-Seite in bo5 ("gewinnt 3:0 oder 3:1", v8.60.21).
      let b25 = null, b25plus = null, b15neg = null;
      if (bo3) {
        // Set-Handicap ±1.5: Ein Spieler ist Favorit (-1.5 = 2:0), der andere
        // Underdog (+1.5 = "nicht 0:2 verlieren"). Beide Seiten separat lesen.
        const spNeg = {}, spPos = {};
        for (const mkt of spMks) for (const p of (mkt.prices || [])) {
          if (typeof p.price !== 'number') continue;
          const pt = Number(p.points);
          const d = desig(p);
          if (!d) continue;
          if (pt === -1.5) spNeg[d] = p.price;
          else if (pt === 1.5) spPos[d] = p.price;
        }
        const a2 = toDec(spNeg['home']), b2v = toDec(spNeg['away']);
        if (a2 > 1.01 || b2v > 1.01) b2 = [a2, b2v];
        const a15 = toDec(spPos['home']), b15v = toDec(spPos['away']);
        if (a15 > 1.01 || b15v > 1.01) b15 = [a15, b15v];
      } else if (bo5) {
        // Set-Handicap ±2.5 (Best-of-5): -2.5 gewinnt nur bei exakt 3:0,
        // +2.5 deckt "nicht 0:3 verlieren" ab (analog +1.5 in bo3).
        const spNeg = {}, spPos = {};
        for (const mkt of spMks) for (const p of (mkt.prices || [])) {
          if (typeof p.price !== 'number') continue;
          const pt = Number(p.points);
          const d = desig(p);
          if (!d) continue;
          if (pt === -2.5) spNeg[d] = p.price;
          else if (pt === 2.5) spPos[d] = p.price;
        }
        const a25 = toDec(spNeg['home']), b25v = toDec(spNeg['away']);
        if (a25 > 1.01 || b25v > 1.01) b25 = [a25, b25v];
        const a25p = toDec(spPos['home']), b25p = toDec(spPos['away']);
        if (a25p > 1.01 || b25p > 1.01) b25plus = [a25p, b25p];
        // ±1.5 zusätzlich lesen (v8.60.21): Grand Slams bieten beide Linien
        // an. -1.5 = "gewinnt 3:0 oder 3:1", +1.5 = "verliert nicht mit 2
        // Sätzen Differenz" (Gegner holt 2 Sätze oder gewinnt) — b15 ist die
        // +1.5-Seite (wie in bo3), b15neg die -1.5-Seite. Die 3:1-Gegenwette
        // (Boost „X gewinnt 3:1") braucht beides: b15neg als Informations-
        // Wert zum BF-Lay X 3-1, b15 als Back Gegner +1,5.
        const spNeg15 = {}, spPos15 = {};
        for (const mkt of spMks) for (const p of (mkt.prices || [])) {
          if (typeof p.price !== 'number') continue;
          const pt = Number(p.points);
          const d = desig(p);
          if (!d) continue;
          if (pt === -1.5) spNeg15[d] = p.price;
          else if (pt === 1.5) spPos15[d] = p.price;
        }
        const a15m = toDec(spNeg15['home']), b15m = toDec(spNeg15['away']);
        if (a15m > 1.01 || b15m > 1.01) b15neg = [a15m, b15m];
        const a15p = toDec(spPos15['home']), b15pv = toDec(spPos15['away']);
        if (a15p > 1.01 || b15pv > 1.01) b15 = [a15p, b15pv];
      }
      // Satz-Total (Tennis): bo3 -> "total 2.5" = Anzahl Saetze (2 oder 3),
      // bo5 -> "total 3.5" = Saetze 3/4/5. Nur beim jeweiligen Gate, sonst
      // ist das Total z.B. Basketball-Punkte oder Games.
      let sou = null;
      if (bo3 || bo5) {
        const line = bo5 ? 3.5 : 2.5;
        const totMk = (pr || []).find(mkt => mkt.type === 'total' && Number(mkt.period) === 0 &&
          (mkt.prices || []).some(p => Math.abs(Number(p.points) - line) < 0.01));
        if (totMk) {
          const tp = {};
          for (const p of (totMk.prices || [])) {
            const d = desig(p);
            if ((d === 'over' || d === 'under') && typeof p.price === 'number') tp[d] = p.price;
          }
          const ov = toDec(tp['over']), un = toDec(tp['under']);
          if (ov > 1.01 && un > 1.01) sou = { over: ov, under: un };
        }
      }
      // O/U Goals (Soccer): Alle Total-Maerkte mit Over/Under aus Straight Markets.
      // Tennis: Zusaetzlich die eigenen Total-p0-Maerkte aus dem Liga-Straight
      // (lg-straight) mergen, damit die isAlternate-Games-Totals (21.5+) ankommen.
      // Soccer: Corners-Totals (8.5/9.0/…/11.0) sind ebenfalls isAlternate und
      // liegen NUR im lg-straight/related-straight, nicht im Kern-straight. Sie
      // werden als eigener Kanal (cornersOu) gefuehrt, damit sie nie gegen
      // BF-Tore-Totals (z.B. "Over/Under 8.5 Goals") matchen koennen.
      let goalsOu = ouGoals(pr);
      let cornersOu = null;
      if ((tennis || soccer) && Array.isArray(lgStraight)) {
        const tid = String(m.id);
        const totOwn = lgStraight.filter(x =>
          x && x.type === 'total' && Number(x.period) === 0 &&
          (String(x.matchupId) === tid ||
           String(tennisChildOf && tennisChildOf.get(String(x.matchupId))) === tid));
        if (totOwn.length) {
          const known = new Set((pr || []).map(x => x && x.key));
          const fresh = totOwn.filter(x => !known.has(x.key));
          if (fresh.length) {
            if (tennis) goalsOu = ouGoals((pr || []).concat(fresh));
            else cornersOu = ouGoals(fresh).filter(o => cornerLine(o.line) && !o.range);
          }
        }
      }
      const oddEvenPin = pinOdd(pr);
      const w = {};
      for (const per of [1, 2]) {
        const [pa, pb] = mlPair(moneylineMs.find(m => Number(m.period) === per) || null);
        if (pa > 1.01 && pb > 1.01) w[per] = [pa, pb];
      }
      // MMA/UFC: "Fight Goes To Decision" (2-Wege Yes/No) == BF "Go The Distance".
      // Der Markt ist ein PIN-Special; Preise wurden oben in fdById abgelegt.
      const fd = fdById[m.id] || null;
      // Zeitbasierte Heuristik: Wenn ein Spiel laenger als 4 Stunden live ist,
      // wird es wahrscheinlich abgebrochen/walkover sein -> Quoten verwaist.
      if (m.isLive && m.startTime) {
        const startMs = new Date(m.startTime).getTime();
        const nowMs = Date.now();
        const hoursSinceStart = (nowMs - startMs) / (1000 * 60 * 60);
        if (hoursSinceStart > 4) {
          log('  DEBUG pinH2H SKIP stale live: ' + ps.map(x => x.name).join(' v ') +
            ' (seit ' + hoursSinceStart.toFixed(1) + 'h live)');
          continue;
        }
      }
      out[m.id] = { id: m.id, teams: [ps[0].name, ps[1].name], back: [a, b], back2: b2, back15: b15,
        back25: b25, back25plus: b25plus, back15neg: b15neg, w, sou, goalsOu,
        cornersOu,
        oe: oddEvenPin, fd,
        live: !!m.isLive, st: m.startTime, score: scoreOf(m) };
      nOdds++;
    }
    log('  DEBUG pinH2H[' + lid + '] Typ=' + ups.length + ' Zeit=' + nZeit + ' Teiln=' + nPart +
      ' Px=' + nPx + ' Fail=' + nFail + ' Odds=' + nOdds);
    if (Object.values(out).some(p => p.goalsOu && p.goalsOu.length))
      log('  DEBUG pinH2H[' + lid + '] goalsOu: ' +
        Object.values(out).filter(p => p.goalsOu && p.goalsOu.length)
          .map(p => p.teams.join(' v ') + ' ' + p.goalsOu.map(o => o.line + '=' + o.over.toFixed(2)).join(' ')).join(' | '));
    if (Object.values(out).some(p => p.cornersOu && p.cornersOu.length))
      log('  DEBUG pinH2H[' + lid + '] cornersOu: ' +
        Object.values(out).filter(p => p.cornersOu && p.cornersOu.length)
          .map(p => p.teams.join(' v ') + ' ' + p.cornersOu.map(o => o.line + '=' + o.over.toFixed(2)).join(' ')).join(' | '));
    if (DBG) log('  PIN-H2H ' + lid + ': ' + Object.keys(out).length + ' Spiele');
    return out;
  }
// ---------- Betfair: API-Transport ----------
  const bfQ = p => new URLSearchParams(Object.assign({ _ak: AK, alt: 'json' }, p));

  async function bfJson(url, tries) {
    const attempts = tries || 0;
    // url ist entweder ein String oder eine Builder-Funktion (frischer _ak je Versuch).
    const render = () => typeof url === 'function' ? url() : url;
    reqStats.bf++;
    let r;
    try {
      await bfSem(async () => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
        try {
          r = await fetch(render(), { signal: ac.signal, __bf: true });
        } finally { clearTimeout(timer); }
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        reqStats.bfTimeout++;
        if (attempts < 3) { await sleep(backoff(600, attempts)); return bfJson(url, attempts + 1); }
        throw new Error('Betfair Timeout ' + render().slice(0, 120));
      }
      if (attempts < 3) { await sleep(backoff(600, attempts)); return bfJson(url, attempts + 1); }
      throw e;
    }
    if (r.status === 429 || r.status >= 500) {
      if (r.status === 429) reqStats.bf429++;
      else reqStats.bf5xx++;
      if (attempts < 3) {
        await sleep(backoff(1000, attempts));
        return bfJson(url, attempts + 1);
      }
    }
    // 400/403 = _ak rotiert/unbekannt: kurz warten, damit der Proxy den frischen
    // Token aus den Betfair-eigenen Requests uebernimmt, dann neu bauen (bfQ
    // liest AK erst beim Retry) — Selbstheilung nach Token-Rotation.
    if ((r.status === 400 || r.status === 403) && attempts < 3) {
      if (r.status === 403) reqStats.bf403++;
      await sleep(backoff(1200, attempts));
      return bfJson(url, attempts + 1);
    }
    if (!r.ok) throw new Error('Betfair ' + r.status + ' ' + render().slice(0, 120));
    return r.json();
  }

  async function bfBynode(nodeIds, attachments, dist, maxResults, maxIn) {
    const build = () => 'https://www.betfair.com/www/sports/navigation/v2/graph/bynode?' +
      bfQ({ nodeIds, attachments, maxOutDistance: dist, maxInDistance: maxIn || 0, maxResults });
    return bfJson(build, 0);
  }
  // Auto-skalierender bfBynode: startet mit 500, bei Trunkation bis maxCap
  async function bfBynodeAuto(nodeIds, attachments, dist, maxCap, maxIn) {
    const steps = [500, 1500, maxCap || 5000];
    for (const mr of steps) {
      const j = await bfBynode(nodeIds, attachments, dist, mr, maxIn).catch(() => null);
      if (!j || !j.nodes) return j;
      // Trunkation vermuten wenn fast so viele nodes wie maxResults
      if (j.nodes.length < mr - 10 || mr === steps[steps.length - 1]) return j;
    }
    return null;
  }

  async function bfByMarket(marketIds) {
    const build = () => 'https://www.betfair.com/www/sports/exchange/readonly/v1/bymarket?' +
      bfQ({ currencyCode: 'EUR', locale: 'en_GB', marketIds,
        types: 'MARKET_STATE,RUNNER_STATE,RUNNER_EXCHANGE_PRICES_BEST,RUNNER_DESCRIPTION,EVENT,MARKET_DESCRIPTION' });
    return bfJson(build, 0);
  }

  // ---------- _ak-Selbstheilung ----------
  // Betfair rotiert den Access-Key (_ak). Der fetch-/XHR-Proxy uebernimmt den
  // aktuellen Token aus den Requests der Betfair-Seite selbst (nie aus unseren
  // eigenen Calls, die mit __bf markiert sind) — so uebersteht der Scanner
  // Token-Rotationen ohne manuelles Update.
  const __akSniff = url => {
    const m = String(url).match(/[?&]_ak=([A-Za-z0-9_-]+)/);
    if (m && m[1] !== AK) { AK = m[1]; }
  };

  // ---------- Betfair: Lays je COMP (bfLays) ----------
  // Optionaler 4. Parameter opts.onlyEvent (Array von PIN-Teamnamen): Bei
  // gezielten Einzel-Checks (WHY/Boost-Arb) werden NUR die Maerkte des
  // passenden Events geladen statt der ganzen COMP (~12 Spiele x 60 Maerkte
  // = ~35 bymarket-Chunks -> 3 Chunks fuer ein Spiel, ~10x schneller). Die
  // EVENT-Namen liefert die bynode-Struktur kostenlos mit; der Filter
  // laeuft VOR den teuren bymarket-Calls (v8.60.28). Ohne opts identisch
  // zum bisherigen Verhalten (Scan braucht die ganze COMP).
  async function bfLays(comp, log, st, opts) {
    const o = opts || {};
    const evFilter = (o.onlyEvent && o.onlyEvent.length >= 2)
      ? o.onlyEvent.map(x => String(x).trim()).filter(Boolean) : null;
    // Cache-Key filterbewusst: gefilterte Rows duerfen nie in ungefilterte
    // Aufrufe leaken (und umgekehrt).
    const cacheKey = evFilter ? comp + '|ev:' + evFilter.join('|') : comp;
    const c = bfLaysCache.get(cacheKey);
    if (c && (Date.now() - c.ts) < BF_CACHE_TTL_MS) {
      if (st) { st.bfRaw = c.raw; st.bfOut = c.rows.length; }
      if (DBG) log('  Betfair ' + comp + ': cached (' + c.rows.length + ' Lays' +
        (evFilter ? ', ev-Filter)' : ')'));
      return c.rows;
    }
    const j = await bfLeagueMarkets(comp);
    if (!j || !j.nodes || !j.nodes.length) {
      if (st) st.bfRaw = 0;
      bfLaysCache.set(cacheKey, { rows: [], raw: 0, ts: Date.now() });
      if (DBG) log('  Betfair ' + comp + ': leer'); return [];
    }
    if (st) {
      st.bfRaw = new Set(j.nodes.filter(n => n.nodeType === 'EVENT')
        .map(n => n.name)).size;
      // Alle EVENT-Namen dieser COMP (fuer die WHY-Diagnose "kein BF-Event
      // (Teamnamen-Diff)" — die GUI zeigt dann, welche Events es gibt).
      st.bfEventNames = [...new Set(j.nodes.filter(n => n.nodeType === 'EVENT')
        .map(n => n.name).filter(Boolean))];
    }
    const mname = bfMktName;
    let markets = j.nodes.filter(n => n.nodeType === 'MARKET' &&
      classifyMarket(mname(n)).size > 0);
    if (!markets.length) { if (DBG) log('  Betfair ' + comp + ': kein CS/BTTS-Markt'); return []; }
    const htNames = j.nodes.filter(n => n.nodeType === 'MARKET' &&
      /half|1st|2nd|period/i.test(mname(n))).map(n => mname(n))
      .filter((v, i, a) => a.indexOf(v) === i);
    if (htNames.length)
      if (DBG) log('  DEBUG BF HT-Marktnamen: ' + htNames.join(' | '));
    const evName = bfEventNames(j, markets);
    // Event-Filter (v8.60.28): nur die Maerkte des gematchten Events behalten
    // — erspart ~90 % der bymarket-Calls bei gezielten Checks (Championship
    // 12 Spiele -> 1). Nicht matchbare MarketIds (ohne EVENT-Ancestor) fallen
    // raus — im alten Pfad haetten solche Rows im WHY eh keinen evMatch-Treffer
    // gehabt (name fiel auf eventId zurueck).
    if (evFilter) {
      const before = markets.length;
      markets = markets.filter(m => evMatch(evFilter, evName[m.nodeId.split(':')[1]] || ''));
      if (st) { st.bfFilterBefore = before; st.bfFilterAfter = markets.length; }
      if (DBG) log('  Betfair ' + comp + ': Event-Filter ' + evFilter.join(' v ') +
        ' -> ' + markets.length + ' von ' + before + ' Maerkten');
      if (!markets.length) {
        bfLaysCache.set(cacheKey, { rows: [], raw: st ? st.bfRaw : 0, ts: Date.now() });
        return [];
      }
    }
    const mktName = {};
    markets.forEach(m => { mktName[m.nodeId.split(':')[1]] = mname(m); });
    // bymarket akzeptiert nur begrenzte ID-Mengen pro Request -> 20er-Chunks
    const bms = await bfFetchChunks(bfChunkIds(markets));
    if (!bms.length) {
      bfLaysCache.set(cacheKey, { rows: [], raw: st ? st.bfRaw : 0, ts: Date.now() });
      if (DBG) log('  Betfair ' + comp + ': leer'); return [];
    }
    const rows = [];
    let ahDbg = false, hfDbg = false, hfTotDbg = false;
    const ouDbgEvents = new Set();
    const oeDbg = {};
    bfEachMarket(bms, (mk, e) => {
      // Marktdaten nur verarbeiten, wenn der Markt offen ist (kein SUSPENDED/CLOSED)
      if (!bfOpen(mk)) return;
      const evn = evName[mk.marketId] || e.eventId || String(mk.marketId);
      const tags = classifyMarket(mktName[mk.marketId] || '');
      const isBtts = tags.has('btts');
      const isEitherTTS = tags.has('eitherTTS');
      const isExactGoals = tags.has('exactGoals');
      const isTot = tags.has('tot');
      const isCorners = tags.has('corners');
      if (isTot && !ouDbgEvents.has(evn)) {
        ouDbgEvents.add(evn);
        log('  DEBUG BF O/U[' + comp + '] Markt="' + mktName[mk.marketId] + '" Runner: ' +
          (mk.runners || []).map(r => ((r.description && r.description.runnerName) || '') +
            ' lay=' + (r.exchange && r.exchange.availableToLay && r.exchange.availableToLay[0] ?
              r.exchange.availableToLay[0].price : '-') +
            ' back=' + (r.exchange && r.exchange.availableToBack && r.exchange.availableToBack[0] ?
              r.exchange.availableToBack[0].price : '-')).join(' | '));
      }
      if (isCorners && !ouDbgEvents.has(evn)) {
        ouDbgEvents.add(evn);
        log('  DEBUG BF CORNERS[' + comp + '] Markt="' + mktName[mk.marketId] + '" Runner: ' +
          (mk.runners || []).map(r => ((r.description && r.description.runnerName) || '') +
            ' lay=' + (r.exchange && r.exchange.availableToLay && r.exchange.availableToLay[0] ?
              r.exchange.availableToLay[0].price : '-') +
            ' back=' + (r.exchange && r.exchange.availableToBack && r.exchange.availableToBack[0] ?
              r.exchange.availableToBack[0].price : '-')).join(' | '));
      }
      // Gezielter Debug: kompletter bymarket-Runner-Exchange fuer "Over/Under 6.5 Goals".
      // Diagnose Raufoss v Asane: Over-6.5-Lay (16.50 lt. UI) wird nie erfasst (over=null).
      if (isTot && /^over\/under 6\.5 goals$/i.test(mktName[mk.marketId] || '')) {
        log('  DEBUG BF O/U6.5 RAW[' + comp + '] mkt=' + mk.marketId + ' "' + evn + '" ' +
          JSON.stringify((mk.runners || []).map(r => ({
            n: (r.description && r.description.runnerName) || '',
            sel: (r.description && r.description.selectionId) || r.selectionId || '?',
            back: (r.exchange && r.exchange.availableToBack || []).slice(0, 10)
              .map(x => x.price + 'x' + x.size).join(','),
            lay: (r.exchange && r.exchange.availableToLay || []).slice(0, 10)
              .map(x => x.price + 'x' + x.size).join(','),
            status: (r.state || {}).status
          }))));
      }
      const isHfTot = tags.has('hfTot');
      const isMo3 = tags.has('mo3');
      const isMo3H = tags.has('mo3h');
      const isAh = tags.has('ah');
      const isHf = tags.has('hf');
      const isW2n = tags.has('w2n');
      const isDnb = tags.has('dnb');
      const isDc = tags.has('dc');
      const isBtsw = tags.has('btsw');
      const isResou = tags.has('resou');
      const isOe = tags.has('oe');
      const isHtCs = tags.has('htcs');
      const isPts = tags.has('pts');
      const isTtot = tags.has('ttot');
      const isEuh = tags.has('euh');
      const mklive = !!((mk.state || {}).inplay);
      if (isHf && !hfDbg) {
        hfDbg = true;
        log('  DEBUG BF HT/FT[' + comp + '] Markt="' + mktName[mk.marketId] + '" Runner: ' +
          (mk.runners || []).map(r => ((r.description && r.description.runnerName) || '') +
            ' lay=' + (r.exchange && r.exchange.availableToLay && r.exchange.availableToLay[0] ?
              r.exchange.availableToLay[0].price : '-')).join(' | '));
      }
      const ys = [], ns = [], totLines = {}, hfTotLines = {}, hfLays = [];
      let layH = null, layD = null, layA = null, layHn = '', layAn = '';
      let backH = null, backD = null, backA = null;
      let w2nYes = null, w2nNo = null;
      let w2nBackYes = 0, w2nBackYesVol = 0, w2nBackNo = 0, w2nBackNoVol = 0;
      let bttsBackYes = null, bttsBackNo = null, bttsBackYesVol = 0, bttsBackNoVol = 0;
      const oeSide = {};
      const ahLays = {};
      const dnbLays = {}, dcLays = {}, dcBacks = {};
      const btswLays = {};
      let btswDbg = false;
      const resouLays = {};
      let resouDbg = false;
      const ptsLays = {};
      let ptsDbg = false;
      const teamTotLines = {};
      let teamTotDbg = false;
      const euhRunners = [];
      if (tags.has('tq')) {
        // To Qualify: exakt 2 Runner (Teamnamen, kein Draw). Fuer Back-Back-
        // Crosslegs reicht ein Back-Preis je Runner; fehlt einer Seite der Lay,
        // entfaellt die tqA/tqB-Row (arbDir-Guard), bbTq-Crosslegs bleiben aktiv.
        const run = [];
        (mk.runners || []).forEach(rn => {
          const nm = (rn.description && rn.description.runnerName) || '';
          const bk = rn.exchange && rn.exchange.availableToBack && rn.exchange.availableToBack[0];
          const ly = rn.exchange && rn.exchange.availableToLay && rn.exchange.availableToLay[0];
          if (nm && (bk || ly))
            run.push({ nm, back: bk ? bk.price : 0, lay: ly ? ly.price : 0,
              volB: bk ? bk.size : 0, volL: ly ? ly.size : 0 });
        });
        if (run.length === 2)
          rows.push({ name: evn, kind: 'tq', r0: run[0], r1: run[1],
            marketId: mk.marketId, live: mklive });
        return;
      }
      if (isPts && !ptsDbg) {
        // Kompletter Runner-Dump des ersten Player-To-Score-Markts je Liga:
        // zeigt AUCH Runner ohne Lay (die sonst still uebersprungen wuerden).
        // Bewusst KEIN DEBUG-Praefix — das Debug-Gating (ui.js) wuerde die
        // Zeile sonst im Produktions-Scan ausfiltern.
        ptsDbg = true;
        log('  BF PTS-Runner[' + comp + '] Markt="' + mktName[mk.marketId] + '": ' +
          (mk.runners || []).map(r => ((r.description && r.description.runnerName) || '') +
            ' back=' + (r.exchange && r.exchange.availableToBack && r.exchange.availableToBack[0]
              ? r.exchange.availableToBack[0].price : '-') +
            ' lay=' + (r.exchange && r.exchange.availableToLay && r.exchange.availableToLay[0]
              ? r.exchange.availableToLay[0].price : '-')).join(' | '));
      }
      (mk.runners || []).forEach(rn => {
        const nm = (rn.description && rn.description.runnerName) || '';
        const l = rn.exchange && rn.exchange.availableToLay && rn.exchange.availableToLay[0];
        const bk = rn.exchange && rn.exchange.availableToBack && rn.exchange.availableToBack[0];
        if (!l || l.price >= 200) return;
        if (isPts) {
          // Torschuetze: Runner = Spielername (z.B. "Kai Havertz"). Lay ist die
          // Back-Lay-Seite gegen PIN "X To Score" Yes. "No Goalscorer" o.ae.
          // generische Runner sind hier nicht zu erwarten; falls doch, faengt
          // das spaetere Spieler-Matching sie nicht (kein PIN-Special).
          if (nm) ptsLays[nm.trim()] = { lay: l.price, vol: l.size,
            back: bk && bk.price < MAX_LAY_PRICE ? bk.price : 0,
            volB: bk && bk.price < MAX_LAY_PRICE ? bk.size : 0 };
          return;
        }
        if (isAh) {
          if (!ahDbg) {
            ahDbg = true;
            log('  DEBUG AH[' + comp + '] Markt="' + mktName[mk.marketId] + '" Runner: ' +
              (mk.runners || []).map(r => ((r.description && r.description.runnerName) || '') +
                '(h=' + r.handicap + ')').join(' | '));
          }
          let hand = (rn.handicap != null) ? Number(rn.handicap) : NaN;
          if (isNaN(hand)) hand = (rn.description && rn.description.handicap != null)
            ? Number(rn.description.handicap) : NaN;
          if (isNaN(hand)) {
            const am = /^(.*?)\s*\(?\s*([+-]?\d+(?:\.\d+)?|level|level ball)\s*\)?\s*$/i.exec(nm);
            if (am) hand = am[2].toLowerCase().startsWith('level') ? 0 : parseFloat(am[2]);
          }
          if (isNaN(hand)) return;
          const ahStep25 = Math.round(Math.abs(hand) * 4);
          if (Math.abs(hand) > MAX_AH_LINE ||
            Math.abs(Math.abs(hand) * 4 - ahStep25) > 1e-6) return;
          // Back-Preis zusaetzlich erfassen (v8.33.1): ermoeglicht den
          // EH↔AH-Back-Cross (PIN euh-Seite + BF AH Back auf den Gegner).
          ahLays[hand + ':' + nm.trim()] = { lay: l.price, vol: l.size,
            back: bk && bk.price < MAX_LAY_PRICE ? bk.price : 0,
            volB: bk && bk.price < MAX_LAY_PRICE ? bk.size : 0 };
          return;
        }
        if (isMo3 || isMo3H) {
          const teams = (evn || '').split(' v ');
          const bkPrice = bk && bk.price < MAX_LAY_PRICE ? bk : null;
          if (/^(the )?(draw|tie)$/i.test(nm)) {
            layD = l;
            if (bkPrice) backD = bkPrice;
          } else if (teams.length === 2 && teamMatch(nm, teams[0])) {
            layH = l; layHn = nm;
            if (bkPrice) backH = bkPrice;
          } else if (teams.length === 2 && teamMatch(nm, teams[1])) {
            layA = l; layAn = nm;
            if (bkPrice) backA = bkPrice;
          } else if (!layH) {
            layH = l; layHn = nm;
            if (bkPrice) backH = bkPrice;
          } else if (!layA) {
            layA = l; layAn = nm;
            if (bkPrice) backA = bkPrice;
          }
        } else if (new RegExp('^([0-' + MAX_CS_SCORE + '])\\s*-\\s*([0-' + MAX_CS_SCORE + '])$').test(nm)) {
          // Correct Score 0-0 bis MAX_CS_SCORE-MAX_CS_SCORE
          // (isHtCs -> Halbzeit-CS: eigener Kind-Praefix "hcs")
          const scoreKey = nm.replace(/\s/g, '');
          const kind = (isHtCs ? 'hcs' : 'cs') + scoreKey.replace('-', '');
          if (kind === 'cs00') {
            // CS 0-0: mit evtl. bereits vorhandenem Under 0.5 Lay vergleichen
            const u05row = rows.find(r => r.name === evn && r.kind === 'cs00' && r.u05);
            if (u05row) {
              // Minimum = besserer Lay-Preis
              if (l.price < u05row.lay) {
                u05row.lay = l.price;
                u05row.vol = l.size;
                u05row.marketId = mk.marketId;
              }
            } else {
              rows.push({ name: evn, kind, lay: l.price, vol: l.size,
                marketId: mk.marketId, live: mklive });
            }
          } else {
            rows.push({ name: evn, kind, lay: l.price, vol: l.size,
              marketId: mk.marketId, live: mklive });
          }
        } else if (isTot && /^under 0\.5/i.test(nm)) {
          // Under 0.5 Goals = kein Tor = 0:0 — mit CS 0-0 vergleichen
          mergeCs00(rows, evn, l.price, l.size, mk.marketId, mklive, true);
        } else if (isBtts && nm === 'Yes') {
          ys.push(l);
          if (bk && bk.price < MAX_LAY_PRICE) { bttsBackYes = bk.price; bttsBackYesVol = bk.size; }
        } else if (isBtts && nm === 'No') {
          ns.push(l);
          if (bk && bk.price < MAX_LAY_PRICE) { bttsBackNo = bk.price; bttsBackNoVol = bk.size; }
        } else if (isEitherTTS && nm === 'No') {
          // Either Team To Score = No = kein Tor = 0:0 — mit CS 0-0 vergleichen
          mergeCs00(rows, evn, l.price, l.size, mk.marketId, mklive, true);
        } else if (isExactGoals && /^0$/.test(nm)) {
          // Exact Total Goals = 0 = kein Tor = 0:0 — mit CS 0-0 vergleichen
          mergeCs00(rows, evn, l.price, l.size, mk.marketId, mklive, true);
        } else if (isW2n && (nm === 'Yes' || nm === 'No')) {
          const bkPrice = bk && bk.price < MAX_LAY_PRICE ? bk : null;
          if (nm === 'Yes') {
            w2nYes = l;
            w2nBackYes = bkPrice ? bkPrice.price : 0;
            w2nBackYesVol = bkPrice ? bkPrice.size : 0;
          } else {
            w2nNo = l;
            w2nBackNo = bkPrice ? bkPrice.price : 0;
            w2nBackNoVol = bkPrice ? bkPrice.size : 0;
          }
        } else if (isOe && (/^(odd|yes)$/i.test(nm) || /^(even|no)$/i.test(nm))) {
          const side = /^(odd|yes)$/i.test(nm) ? 'odd' : 'even';
          oeSide[side] = { lay: l.price, vol: l.size,
            back: bk && bk.price < MAX_LAY_PRICE ? bk.price : 0 };
        } else if (isDnb) {
          const teams = (evn || '').split(' v ');
          const bkPrice = bk && bk.price < MAX_LAY_PRICE ? bk : null;
          if (teams.length === 2 && teamMatch(nm, teams[0]))
            dnbLays['home'] = { lay: l.price, vol: l.size,
              back: bkPrice ? bkPrice.price : 0, volB: bkPrice ? bkPrice.size : 0 };
          else if (teams.length === 2 && teamMatch(nm, teams[1]))
            dnbLays['away'] = { lay: l.price, vol: l.size,
              back: bkPrice ? bkPrice.price : 0, volB: bkPrice ? bkPrice.size : 0 };
        } else if (isDc) {
          const bkPrice = bk && bk.price < MAX_LAY_PRICE ? bk : null;
          if (/^1\s*\/?\s*x|^home.*draw|1x/i.test(nm)) {
            dcLays['1x'] = { lay: l.price, vol: l.size };
            if (bkPrice) dcBacks['1x'] = { back: bkPrice.price, vol: bkPrice.size };
          } else if (/^x\s*\/?\s*2|^draw.*away|x2/i.test(nm)) {
            dcLays['x2'] = { lay: l.price, vol: l.size };
            if (bkPrice) dcBacks['x2'] = { back: bkPrice.price, vol: bkPrice.size };
          } else if (/^1\s*\/?\s*2|^home.*away|12/i.test(nm)) {
            dcLays['12'] = { lay: l.price, vol: l.size };
            if (bkPrice) dcBacks['12'] = { back: bkPrice.price, vol: bkPrice.size };
          }
        } else if (isBtsw) {
          const si = nm.lastIndexOf('/');
          const team = si >= 0 ? nm.slice(0, si).trim() : nm.trim();
          const yn = si >= 0 ? nm.slice(si + 1).trim().toLowerCase() : '';
          if (team && (yn === 'yes' || yn === 'no')) {
            btswLays[team + ':' + yn] = { lay: l.price, vol: l.size };
            if (!btswDbg) {
              btswDbg = true;
              log('  DEBUG BF BTSW[' + comp + '] Markt="' + mktName[mk.marketId] +
                '" Runner: ' + (mk.runners || []).map(r =>
                  ((r.description && r.description.runnerName) || '') +
                  ' lay=' + (r.exchange && r.exchange.availableToLay &&
                    r.exchange.availableToLay[0] ? r.exchange.availableToLay[0].price : '-'))
                  .join(' | '));
            }
          }
        } else if (isResou) {
          // Kombi "Result + O/U": Runner "FC Dordrecht/Under 2.5 Goals",
          // "Draw/Over 2.5 Goals" -> Key team:side:line
          const si = nm.lastIndexOf('/');
          const team = si >= 0 ? nm.slice(0, si).trim() : nm.trim();
          const side = si >= 0 ? nm.slice(si + 1).trim().toLowerCase() : '';
          const tm = /^(over|under) (\d+\.?\d*) goals?$/i.exec(side);
          if (team && tm) {
            const line = parseFloat(tm[2]);
            if (line >= 0.5 && line <= MAX_OU_LINE_BF) {
              resouLays[team + ':' + tm[1] + ':' + line] = { lay: l.price, vol: l.size };
              if (!resouDbg) {
                resouDbg = true;
                log('  DEBUG BF RESOU[' + comp + '] Markt="' + mktName[mk.marketId] +
                  '" Runner: ' + (mk.runners || []).map(r =>
                    ((r.description && r.description.runnerName) || '') +
                    ' lay=' + (r.exchange && r.exchange.availableToLay &&
                      r.exchange.availableToLay[0] ? r.exchange.availableToLay[0].price : '-'))
                    .join(' | '));
              }
            }
          }
        } else if (isTot || isCorners) {
          const tm = /^(over|under) (\d+\.?\d*)/i.exec(nm);
          if (tm) {
            const line = parseFloat(tm[2]);
            const maxLine = isCorners ? MAX_CORNERS_LINE_BF : MAX_OU_LINE_BF;
            if (line >= 0.5 && line <= maxLine) {
              const side = tm[1].toLowerCase();
              (totLines[line] = totLines[line] || {})[side] = l;
              const bkP = bk && bk.price < MAX_LAY_PRICE ? bk : null;
              (totLines[line][side + 'Bk'] = bkP || null);
            }
          } else {
            log('  DEBUG BF O/U Runner[' + comp + '] "' + nm + '" kein Over/Under Match, lay=' +
              l.price + ' back=' + (bk ? bk.price : '-'));
          }
        } else if (isHfTot) {
          const tm = /^(over|under) (\d+\.?\d*)/i.exec(nm);
          if (tm) {
            const line = parseFloat(tm[2]);
            if (line >= 0.5 && line <= 4.5) {
              const side = tm[1].toLowerCase();
              (hfTotLines[line] = hfTotLines[line] || {})[side] = l;
              const bkP = bk && bk.price < MAX_LAY_PRICE ? bk : null;
              (hfTotLines[line][side + 'Bk'] = bkP || null);
            }
          }
        } else if (isTtot) {
          // Team-Totals: Runner "Under 0.5 Goals"/"Over 0.5 Goals", der
          // Teamname steckt im Marktnamen ("Malaga Over/Under 0.5 Goals").
          const tm = /^(over|under) (\d+\.?\d*)/i.exec(nm);
          if (tm) {
            const line = parseFloat(tm[2]);
            if (line >= 0.5 && line <= 2.5) {
              const side = tm[1].toLowerCase();
              (teamTotLines[line] = teamTotLines[line] || {})[side] = l;
              const bkP = bk && bk.price < MAX_LAY_PRICE ? bk : null;
              (teamTotLines[line][side + 'Bk'] = bkP || null);
            }
          }
        } else if (isHf) {
          hfLays.push({ nm, lay: l.price, vol: l.size });
        } else if (isEuh) {
          // Europaeisches Handicap (3-Weg): Runner "Team ±N" / "Gegner ∓N" /
          // "Draw" — Back+ Lay je Runner sammeln; die Markt-Identitaet wird
          // nach dem Loop ueber Vorzeichen + Linie + Draw geprueft.
          const bkP = bk && bk.price < MAX_LAY_PRICE ? bk : null;
          euhRunners.push({ nm, lay: l.price, vol: l.size,
            back: bkP ? bkP.price : 0 });
        }
      });
      if ((isTot || isCorners) && !Object.keys(totLines).length) {
        log('  DEBUG BF O/U[' + comp + '] ' + evn + ' KEINE Over/Under Runner gefunden, Markt="' +
          (mktName[mk.marketId] || '') + '" Runner: ' +
          (mk.runners || []).map(r => ((r.description && r.description.runnerName) || '') +
            ' lay=' + (r.exchange && r.exchange.availableToLay && r.exchange.availableToLay[0] ?
              r.exchange.availableToLay[0].price : '-')).join(' | '));
      }
      if (isBtts && ys.length && ns.length) {
        rows.push({ name: evn, kind: 'btts', layYes: ys[0].price, volYes: ys[0].size,
          layNo: ns[0].price, volNo: ns[0].size,
          backYes: bttsBackYes || 0, volBYes: bttsBackYesVol,
          backNo: bttsBackNo || 0, volBNo: bttsBackNoVol,
          marketId: mk.marketId, live: mklive });
      }
      if (isOe && oeSide.odd && oeSide.even) {
        rows.push({ name: evn, kind: 'oe',
          odd: { lay: oeSide.odd.lay, vol: oeSide.odd.vol, back: oeSide.odd.back || 0,
            volB: oeSide.odd.vol },
          even: { lay: oeSide.even.lay, vol: oeSide.even.vol, back: oeSide.even.back || 0,
            volB: oeSide.even.vol },
          marketId: mk.marketId, live: mklive });
        oeDbg[comp] = true;
      }
      if (isW2n && (w2nYes || w2nNo)) {
        const team = (mktName[mk.marketId] || '').replace(/win ?to ?nil.*$/i, '').trim();
        rows.push({ name: evn, kind: 'w2n', team,
          layYes: w2nYes ? w2nYes.price : 0, volYes: w2nYes ? w2nYes.size : 0,
          backYes: w2nBackYes, volBYes: w2nBackYesVol,
          layNo: w2nNo ? w2nNo.price : 0, volNo: w2nNo ? w2nNo.size : 0,
          backNo: w2nBackNo, volBNo: w2nBackNoVol,
          marketId: mk.marketId, live: mklive });
      }
      if ((isMo3 || isMo3H) && (layH || layD || layA)) {
        rows.push({ name: evn, kind: isMo3H ? 'mo3h' : 'mo3',
          layH: layH && layH.price || 0, volH: layH ? layH.size : 0,
          layD: layD && layD.price || 0, volD: layD ? layD.size : 0,
          layA: layA && layA.price || 0, volA: layA ? layA.size : 0,
          backH: backH && backH.price || 0, backD: backD && backD.price || 0,
          backA: backA && backA.price || 0,
          layHn, layAn, marketId: mk.marketId, live: mklive });
      }
      if (isEuh && euhRunners.length === 3) {
        // Europaeisches Handicap: exakt 3 Runner (Team ±N, Gegner ∓N, Draw).
        // Ohne Draw (2-Wege-Spread) wird nichts erzeugt.
        const drawR = euhRunners.find(r => /^(the )?(draw|tie)$/i.test(r.nm));
        const lined = euhRunners.filter(r => !/^(the )?(draw|tie)$/i.test(r.nm));
        if (drawR && lined.length === 2) {
          const lm0 = /^(.+?)\s+([+-])(\d+)$/i.exec(lined[0].nm);
          const lm1 = /^(.+?)\s+([+-])(\d+)$/i.exec(lined[1].nm);
          if (lm0 && lm1 && lm0[2] !== lm1[2] && lm0[3] === lm1[3]) {
            const pos = lm0[2] === '+' ? lined[0] : lined[1];
            const neg = lm0[2] === '+' ? lined[1] : lined[0];
            rows.push({ name: evn, kind: 'euh', line: parseInt(lm0[3], 10),
              pos, neg, draw: drawR, marketId: mk.marketId, live: mklive });
          }
        }
      }
      if (isHf && hfLays.length) {
        rows.push({ name: evn, kind: 'hf', outs: hfLays, marketId: mk.marketId,
          live: mklive });
      }
      if (isAh && Object.keys(ahLays).length) {
        rows.push({ name: evn, kind: 'ah', ah: ahLays, marketId: mk.marketId,
          live: mklive });
      }
      if (isDnb && dnbLays.home && dnbLays.away) {
        rows.push({ name: evn, kind: 'dnb', dnb: dnbLays, marketId: mk.marketId,
          live: mklive });
      }
      if (isDc && Object.keys(dcLays).length) {
        rows.push({ name: evn, kind: 'dc', dc: dcLays, dcBack: dcBacks,
          marketId: mk.marketId, live: mklive });
      }
      if (isBtsw && Object.keys(btswLays).length) {
        rows.push({ name: evn, kind: 'btsw', btsw: btswLays, marketId: mk.marketId,
          live: mklive });
      }
      if (isResou && Object.keys(resouLays).length) {
        rows.push({ name: evn, kind: 'resou', resou: resouLays, marketId: mk.marketId,
          live: mklive });
      }
      if (isPts && Object.keys(ptsLays).length) {
        rows.push({ name: evn, kind: 'pts', pts: ptsLays, marketId: mk.marketId,
          live: mklive });
      }
      for (const line of Object.keys(totLines)) {
        const t = totLines[line];
        if (t.over && t.under)
          rows.push({ name: evn, kind: 'ou', line: +line, layO: t.over.price,
            volO: t.over.size, layU: t.under.price, volU: t.under.size,
            backO: t.overBk && t.overBk.price || 0, volBO: t.overBk && t.overBk.size || 0,
            backU: t.underBk && t.underBk.price || 0, volBU: t.underBk && t.underBk.size || 0,
            marketId: mk.marketId, live: mklive, corners: isCorners });
        else if (isTot || isCorners)
          log('  DEBUG BF O/U[' + comp + '] ' + evn + ' line=' + line +
            ' over=' + (t.over ? t.over.price : 'null') +
            ' under=' + (t.under ? t.under.price : 'null'));
      }
      const ttTeam = (mktName[mk.marketId] || '').replace(/ over\/under .*$/i, '').trim();
      for (const line of Object.keys(teamTotLines)) {
        const t = teamTotLines[line];
        if (t.over && t.under && ttTeam) {
          if (!teamTotDbg) {
            teamTotDbg = true;
            log('  DEBUG BF Team-Total[' + comp + '] ' + ttTeam + ' line=' + line +
              ' over=' + t.over.price + ' under=' + t.under.price);
          }
          rows.push({ name: evn, kind: 'ttot', team: ttTeam, line: +line,
            layO: t.over.price, volO: t.over.size, layU: t.under.price, volU: t.under.size,
            backO: t.overBk && t.overBk.price || 0, volBO: t.overBk && t.overBk.size || 0,
            backU: t.underBk && t.underBk.price || 0, volBU: t.underBk && t.underBk.size || 0,
            marketId: mk.marketId, live: mklive });
        }
      }
      for (const line of Object.keys(hfTotLines)) {
        const t = hfTotLines[line];
        if (t.over && t.under) {
          if (!hfTotDbg) {
            hfTotDbg = true;
            log('  DEBUG BF HT-O/U[' + comp + '] Markt="' + mktName[mk.marketId] +
              '" Runner: ' + (mk.runners || []).map(r =>
                ((r.description && r.description.runnerName) || '') +
                ' lay=' + (r.exchange && r.exchange.availableToLay &&
                  r.exchange.availableToLay[0] ? r.exchange.availableToLay[0].price : '-'))
                .join(' | '));
          }
          rows.push({ name: evn, kind: 'hfou', line: +line, layO: t.over.price,
            volO: t.over.size, layU: t.under.price, volU: t.under.size,
            backO: t.overBk && t.overBk.price || 0, volBO: t.overBk && t.overBk.size || 0,
            backU: t.underBk && t.underBk.price || 0, volBU: t.underBk && t.underBk.size || 0,
            marketId: mk.marketId, live: mklive });
        }
        // HT Under 0.5 = kein Tor im 1. Durchgang -> HT-CS 0:0 (analog cs00)
        if (Math.abs(+line - 0.5) < 0.01 && t.under) {
          const ht00row = rows.find(r => r.name === evn && r.kind === 'hcs00');
          if (ht00row) {
            if (t.under.price < ht00row.lay) {
              ht00row.lay = t.under.price;
              ht00row.vol = t.under.size;
              ht00row.marketId = mk.marketId;
            }
          } else {
            rows.push({ name: evn, kind: 'hcs00', lay: t.under.price,
              vol: t.under.size, marketId: mk.marketId, live: mklive });
          }
        }
      }
    });
    // Event-Startzeiten stempeln (v8.62.5): bymarket-EVENT-Knoten tragen keine
    // openDate, aber jeder bymarket-MARKT hat description.marketTime == Spielstart.
    // Die Unmatched-Sammlung (scan.js) filtert damit BF-Events ausserhalb des
    // PIN-Scan-Fensters (Folgerunden-/Turnier-Events derselben COMP) als
    // "kein Verlust" heraus — die matchen an ihrem eigenen Spieltag normal.
    const evStart = {};
    bfEachMarket(bms, mk => {
      const mt = mk && mk.description && mk.description.marketTime;
      if (!mt) return;
      const nm = evName[mk.marketId] || '';
      if (!nm || evStart[nm]) return;
      const ts = new Date(mt).getTime();
      if (Number.isFinite(ts)) evStart[nm] = ts;
    });
    if (Object.keys(evStart).length)
      for (const r of rows) if (r.st == null && evStart[r.name]) r.st = evStart[r.name];
    bfLaysCache.set(cacheKey, { rows, raw: st ? st.bfRaw : 0, ts: Date.now() });
    if (DBG) log('  Betfair ' + comp + ': ' + rows.length + ' Lays' +
      (rows.filter(r => r.kind === 'oe').length ?
        ' (oe ' + rows.filter(r => r.kind === 'oe').length + ')' : '') +
      (rows.filter(r => r.kind.startsWith('hcs')).length ?
        ' (hcs ' + rows.filter(r => r.kind.startsWith('hcs')).length + ')' : '') +
      (rows.filter(r => r.kind === 'euh').length ?
        ' (euh ' + rows.filter(r => r.kind === 'euh').length + ')' : ''));
    if (st) st.bfOut = rows.length;
    return rows;
  }

  // ---------- Betfair: H2H-Maerkte (bfH2H) ----------
  async function bfH2H(comp, log) {
    const cached = bfH2HCache.get(comp);
    if (cached && (Date.now() - cached.ts) < BF_CACHE_TTL_MS) { if (DBG) log('  BF-H2H ' + comp + ': cached (' + cached.mo.length + ' Maerkte)'); return cached; }
    const j = await bfLeagueMarkets(comp);
    if (!j || !j.nodes || !j.nodes.length) { if (DBG) log('  BF-H2H ' + comp + ': leer'); return { mo: [], sb: [], sw: [], ou: [], oe: [] }; }
    log('  DEBUG bfBynode ' + comp + ': ' + j.nodes.length + ' nodes, ' + (j.edges || []).length + ' edges');
    const mname = bfMktName;
    const mo = j.nodes.filter(n => n.nodeType === 'MARKET' &&
      /^(match odds|regular time match odds|head to head|moneyline|fight result)/i.test(mname(n)));
    const sbM = j.nodes.filter(n => n.nodeType === 'MARKET' &&
      /^(set betting|number of sets)$/i.test(mname(n)));
    const swM = j.nodes.filter(n => n.nodeType === 'MARKET' &&
      /^set [12] winner/i.test(mname(n)));
    const ouM = j.nodes.filter(n => n.nodeType === 'MARKET' &&
      ((/^over\/under \d/i.test(mname(n)) && !/half|period|handicap/i.test(mname(n))) ||
       (/^total goals$/i.test(mname(n)) && !/half|period/i.test(mname(n))) ||
       (/^total games$/i.test(mname(n)) && !/half|period/i.test(mname(n))) ||
       (/^corners over\/under \d/i.test(mname(n)) && !/half|period/i.test(mname(n)))));
    const oeM = j.nodes.filter(n => n.nodeType === 'MARKET' &&
      /^total goals odd\/even$/i.test(mname(n)) && !/half|period/i.test(mname(n)));
    // MMA/UFC: "Go The Distance" (2-Wege Yes/No) == PIN "Fight Goes To Decision".
    // BF-Marktname ist "Go The Distance?" (inkl. Fragezeichen).
    const gdM = j.nodes.filter(n => n.nodeType === 'MARKET' &&
      /^go(es)? (to )?(the )?distance\??$/i.test(mname(n)) && !/half|period|round/i.test(mname(n)));
    if (!mo.length && !sbM.length && !swM.length && !ouM.length && !oeM.length && !gdM.length) {
      const mn = [...new Set(j.nodes.filter(n => n.nodeType === 'MARKET')
        .map(m => mname(m)).filter(Boolean))].slice(0, 6);
      const allNodes = j.nodes.length;
      const mktNodes = j.nodes.filter(n => n.nodeType === 'MARKET').length;
      if (DBG) log('  BF-H2H ' + comp + ': kein Match-Odds (nodes:' + allNodes + ' mktNodes:' + mktNodes + ' Maerkte: ' + (mn.join(' | ') || 'keine') + ')');
      return { mo: [], sb: [], sw: [], ou: [], oe: [], gd: [] };
    }
    const evName = Object.assign(bfEventNames(j, [...mo, ...sbM, ...swM]),
      bfEventNames(j, ouM), bfEventNames(j, oeM), bfEventNames(j, gdM));
    const rows = [];
    const moBms = await bfFetchChunks(bfChunkIds(mo));
    bfEachMarket(moBms, (mk, e) => {
      // Marktdaten nur verarbeiten, wenn der Markt offen ist (kein SUSPENDED/CLOSED)
      if (!bfOpen(mk)) return;
      const run = [];
      (mk.runners || []).forEach(rn => {
        const nm = (rn.description && rn.description.runnerName) || '';
        const bk = rn.exchange && rn.exchange.availableToBack && rn.exchange.availableToBack[0];
        const ly = rn.exchange && rn.exchange.availableToLay && rn.exchange.availableToLay[0];
        if (bk && ly && nm) run.push({ nm, back: bk.price, lay: ly.price,
          volB: bk.size, volL: ly.size });
      });
      // 2-Wege-Sportarten (Rugby, Boxen, MMA, …): PIN liefert nur Heim/
      // Auswaerts (kein Draw), BF "Match Odds" fuehrt aber oft 3 Runner
      // inkl. Draw. Den Draw-Runner verwerfen und mit den 2 Team-Runnern
      // weiterarbeiten (frueher verwarf der 2-Runner-Check den ganzen
      // Markt — kein Rugby-Vergleich moeglich). hadDraw merkt sich, ob der
      // Markt urspruenglich einen Draw-Runner hatte: Dann preisen die BF-
      // Quoten den Draw ein, und der Back-Back (PIN-Back + BF-Back) ist
      // NICHT wasserdicht (bei einem Draw verlieren beide Wetten) — der
      // BF-Lay (bl) deckt den Draw dagegen mit ab und bleibt erlaubt.
      const hadDraw = (mk.runners || []).some(rn => {
        const nm = ((rn.description && rn.description.runnerName) ||
          rn.runnerName || '').trim();
        return /^(the )?(draw|tie)$/i.test(nm);
      });
      const teams2 = run.filter(r => !/^(the )?(draw|tie)$/i.test(r.nm));
      if (teams2.length !== 2) return;
      const bfLive = !!((mk.state || {}).inplay);
      // evId (v8.60.7): die EVENT-node-id des Matches mitgeben. Die marketId
      // (z.B. "1.261632327") ist ein MARKET-Knoten — als nodeIds fuer
      // bfBynodeAuto unbrauchbar (Market ist Blatt im Graphen, liefert keine
      // EVENT/MARKET-Kinder). Fuer den Match-COMP-Retry (bfH2H mit der
      // match-spezifischen COMP) brauchen wir die EVENT-node-id des Matches
      // (e.eventId aus der bymarket-Antwort), z.B. "EVENT:33016740".
      rows.push({ name: evName[mk.marketId] || e.eventId || String(mk.marketId),
        r0: teams2[0], r1: teams2[1], marketId: mk.marketId, live: bfLive,
        hadDraw, evId: e.eventId || '' });
    });
    // Event-Startzeiten stempeln (v8.62.5, analog bfLays): description.marketTime
    // der bymarket-Markt-Knoten == Spielstart. Fuer den Unmatched-Fensterfilter
    // (scan.js collectUnmatched): BF-Events ausserhalb des PIN-Scan-Fensters
    // (Turnier-Events anderer Spieltage) sind kein echter Verlust.
    const moStart = {};
    bfEachMarket(moBms, mk => {
      const mt = mk && mk.description && mk.description.marketTime;
      if (!mt) return;
      const nm = evName[mk.marketId] || '';
      if (!nm || moStart[nm]) return;
      const ts = new Date(mt).getTime();
      if (Number.isFinite(ts)) moStart[nm] = ts;
    });
    if (Object.keys(moStart).length)
      for (const r of rows) if (r.st == null && moStart[r.name]) r.st = moStart[r.name];
    const sbRows = [];
    const sbBms = await bfFetchChunks(bfChunkIds(sbM));
    // v8.60.11-Diagnose: Set-Betting-Maerkte, die bfH2H gefunden hat, und
    // deren Status — damit sichtbar ist, ob sb leer liegt, weil die Maerkte
    // SUSPENDED/CLOSED sind (bfOpen-Filter) oder weil die Runner nicht auf
    // das "2-0|3-0"-Regex matchen.
    let sbMktGesamt = 0, sbMktOffen = 0, sbRunnerBeispiel = '';
    for (const et of (sbBms || [])) for (const etn of (et.eventTypes || [])) {
      for (const e of (etn.eventNodes || [])) for (const mk of (e.marketNodes || [])) {
        sbMktGesamt++;
        if (bfOpen(mk)) sbMktOffen++;
        if (!sbRunnerBeispiel) {
          const rn = ((mk.runners || [])[0] || {}).description || {};
          sbRunnerBeispiel = String(rn.runnerName || (mk.runners || [])[0] || '');
        }
      }
    }
    if (DBG || sbM.length) {
      log('  DEBUG BF-SetBetting[' + comp + ']: Maerkte=' + sbM.length +
        ' geladen=' + sbMktGesamt + ' offen=' + sbMktOffen +
        (sbRunnerBeispiel ? ' RunnerBsp="' + sbRunnerBeispiel + '"' : ''));
    }
    bfEachMarket(sbBms, (mk, e) => {
      // Marktdaten nur verarbeiten, wenn der Markt offen ist (kein SUSPENDED/CLOSED)
      if (!bfOpen(mk)) return;
      const pl = {}, ns = {};
      (mk.runners || []).forEach(rn => {
        const nm = (rn.description && rn.description.runnerName) || '';
        const ly = rn.exchange && rn.exchange.availableToLay && rn.exchange.availableToLay[0];
        const bk = rn.exchange && rn.exchange.availableToBack && rn.exchange.availableToBack[0];
        if (!ly) return;
        // Set Betting: Runner "Team X-Y" -> je Spieler die Score-Lays sammeln.
        // 2:0/2:1 (bo3) => s20/s21, 3:0/3:1/3:2 (bo5/Grand Slam) => s30/s31/s32.
        const sb = /^(.+?) (2-0|2-1|3-0|3-1|3-2)$/.exec(nm);
        if (sb) {
          const runner = { lay: ly.price, vol: ly.size, back: bk ? bk.price : 0, volB: bk ? bk.size : 0 };
          const key = 's' + sb[2].replace('-', '');
          const cur = pl[sb[1]] || {};
          cur[key] = runner;
          pl[sb[1]] = cur;
          return;
        }
        const nsm = /^(two|three|four|five) sets$/i.exec(nm);
        if (nsm) {
          // v8.68.0: ns-Runner tragen seit dem Over-4.5-Boost (so45) auch
          // den BF-Back (Three/Four Sets = Cross-Legs) — vorher nur Lay.
          ns[nsm[1].toLowerCase()] = { lay: ly.price, vol: ly.size,
            back: bk && bk.price > 1.01 ? bk.price : 0,
            volB: bk && bk.price > 1.01 ? bk.size : 0 };
        }
      });
      const players = Object.keys(pl).filter(p => pl[p] && Object.keys(pl[p])
        .some(k => k.startsWith('s') && pl[p][k] && pl[p][k].lay));
      if (!players.length && !ns.two && !ns.three && !ns.four && !ns.five) return;
      const bfLive = !!((mk.state || {}).inplay);
      sbRows.push({ name: evName[mk.marketId] || e.eventId || String(mk.marketId),
        players: players.map(p => ({ name: p, s20: pl[p] && pl[p].s20, s21: pl[p] && pl[p].s21,
          s30: pl[p] && pl[p].s30, s31: pl[p] && pl[p].s31, s32: pl[p] && pl[p].s32 })),
        ns: (ns.two || ns.three || ns.four || ns.five) ? ns : null,
        marketId: mk.marketId, live: bfLive });
    });
    const swRows = [];
    const swBms = await bfFetchChunks(bfChunkIds(swM));
    bfEachMarket(swBms, (mk, e) => {
      // Marktdaten nur verarbeiten, wenn der Markt offen ist (kein SUSPENDED/CLOSED)
      if (!bfOpen(mk)) return;
      const run = [];
      (mk.runners || []).forEach(rn => {
        const nm = (rn.description && rn.description.runnerName) || '';
        const bk = rn.exchange && rn.exchange.availableToBack && rn.exchange.availableToBack[0];
        const ly = rn.exchange && rn.exchange.availableToLay && rn.exchange.availableToLay[0];
        if (bk && ly && nm) run.push({ nm, back: bk.price, lay: ly.price,
          volB: bk.size, volL: ly.size });
      });
      if (run.length !== 2) return;
      const per = /^set 1 winner/i.test(mname(mk)) ? 1 : 2;
      const bfLive = !!((mk.state || {}).inplay);
      swRows.push({ name: evName[mk.marketId] || e.eventId || String(mk.marketId),
        r0: run[0], r1: run[1], per, marketId: mk.marketId, live: bfLive });
    });
    const ouRows = [];
    const ouBms = await bfFetchChunks(bfChunkIds(ouM));
    if (ouM.length) {
      const ouNames = [...new Set(ouM.map(n => mname(n)).filter(Boolean))];
      const cornersNodes = ouM.filter(n => /^corners over\/under/i.test(mname(n)));
      log('  DEBUG ouM: ' + ouM.length + ' nodes, chunks: ' + bfChunkIds(ouM).length +
        (cornersNodes.length ? ' | corners=' + cornersNodes.length : '') +
        ' | Namen: ' + (ouNames.slice(0, 8).join(' | ') || 'keine'));
    }
    let mkRows = 0, skippedStatus = 0, skippedLine = 0, skippedRunners = 0;
    bfEachMarket(ouBms, (mk, e) => {
      mkRows++;
      const mktStatus = ((mk.state || {}).status || "").toUpperCase();
      if (mktStatus && mktStatus !== "OPEN") { skippedStatus++; if (mkRows <= 3) log('  DEBUG O/U skip status=' + mktStatus + ' mk=' + mk.marketId); return; }
      const mktNm = mname(mk);
      // Corners-Maerkte ("Corners Over/Under 8.5/10.5") muessen im Kanal strikt
      // von den Tore-Totals getrennt bleiben: BF-"Over/Under 8.5 Goals" (Tore)
      // und PIN-Corners-8.5 duerfen sich nicht fälschlich matchen. Das Flag
      // steuert spaeter die Partner-Wahl (h.cornersOu statt h.goalsOu).
      const isCorners = /^corners over\/under/i.test(mktNm);
      // Runner-Namen mit Doppel-Fallback (Betfair liefert sie teils als
      // rn.runnerName, teils nur unter rn.description.runnerName).
      // Runner-Namen mit Doppel-Fallback (Betfair liefert sie teils als
      // rn.runnerName, teils nur unter rn.description.runnerName). Bevorzugt wird
      // der Name, der die Linie traegt (mit Ziffer), sonst der bare "Under"/"Over".
      const rnNm = rn => {
        if (!rn) return '';
        const a = rn.runnerName || '';
        const b = (rn.description && rn.description.runnerName) || '';
        if (b && !/\d/.test(a) && /\d/.test(b)) return b;
        return a || b;
      };
      // Line-Kandidat aus dem Handicap-Feld (wie beim AH-Pfad): Betfair
      // labelt "Total Games"-Runners nur als "Under"/"Over" und haelt die
      // Linie im Handicap-Feld (+21.5 etc.) -- Namen liefern keine Ziffer.
      const bfHand = r => {
        if (!r) return NaN;
        let h = (r.handicap != null) ? Number(r.handicap) : NaN;
        if (isNaN(h)) h = (r.description && r.description.handicap != null) ? Number(r.description.handicap) : NaN;
        return h;
      };
      const bfSide = nm => /^under/i.test(nm) ? 'under' : (/^over/i.test(nm) ? 'over' : '');
      const rns = (mk.runners || []).map(rnNm);
      if (mkRows <= 3) log('  DEBUG O/U mk=' + mk.marketId + ' status=' + mktStatus + ' name="' + mktNm +
        '" runners=' + rns.length + ' names=' + JSON.stringify(rns.slice(0, 6)) +
        ' h=' + JSON.stringify((mk.runners || []).slice(0, 6).map(bfHand)));
      // Total-Games-Maerkte: Die Line steckt in den Runner-Namen ("Over 21.5")
      // ODER -- wenn der Runner-Name keine Ziffer traegt (Live-Scan: nur "Under"/
      // "Over") -- im Handicap-Feld; pro Linie ein O/U-Paar bauen (~110 Runner).
      const byLine = {};
      let named = 0;
      (mk.runners || []).forEach(rn => {
        const nm = rnNm(rn);
        const side = bfSide(nm);
        if (!side) return;
        const hand = bfHand(rn);
        const rm = /^(over|under)\s+(\d+(?:\.\d+)?)/i.exec(nm);
        const L = (rm && rm[2] != null) ? parseFloat(rm[2]) : (hand >= 0.5 ? hand : NaN);
        if (!(L >= 0.5)) return;
        named++;
        const ly = rn.exchange && rn.exchange.availableToLay && rn.exchange.availableToLay[0];
        const bk = rn.exchange && rn.exchange.availableToBack && rn.exchange.availableToBack[0];
        if (!ly) return;
        const key = String(L);
        const g = byLine[key] || (byLine[key] = { line: L, over: null, under: null });
        if (side === 'over') g.over = { lay: ly.price, vol: ly.size, back: bk ? bk.price : 0, volB: bk ? bk.size : 0 };
        else g.under = { lay: ly.price, vol: ly.size, back: bk ? bk.price : 0, volB: bk ? bk.size : 0 };
      });
      if (named > 0) {
        const keys = Object.keys(byLine);
        for (const k of keys) {
          const g = byLine[k];
          if (!g.over || !g.under) { skippedRunners++; continue; }
          const bfLive = !!((mk.state || {}).inplay);
          ouRows.push({ name: evName[mk.marketId] || e.eventId || String(mk.marketId),
            line: g.line, over: g.over, under: g.under, marketId: mk.marketId, live: bfLive,
            corners: isCorners });
        }
        if (mkRows <= 3) log('  DEBUG O/U namedPairs=' + keys.length + ' ok=' + ouRows.length);
        return;
      }
      const lineMatch = /^over\/under (\d+\.?\d*)/i.exec(mktNm) ||
        /^over (\d+\.?\d*)/i.exec(mktNm);
      let line = lineMatch ? parseFloat(lineMatch[1]) : NaN;
      if (isNaN(line)) {
        const rLine = rns.join('|');
        const rM = /^(over|under)\s+(\d+\.?\d*)/i.exec(rLine);
        if (rM) line = parseFloat(rM[2]);
      }
      if (isNaN(line)) { skippedLine++; return; }
      const ouLays = {};
      (mk.runners || []).forEach(rn => {
        const nm = rnNm(rn);
        const ly = rn.exchange && rn.exchange.availableToLay && rn.exchange.availableToLay[0];
        const bk = rn.exchange && rn.exchange.availableToBack && rn.exchange.availableToBack[0];
        if (!ly) return;
        const lowNm = nm.toLowerCase();
        if (/^over/.test(lowNm)) ouLays.over = { lay: ly.price, vol: ly.size, back: bk ? bk.price : 0 };
        else if (/^under/.test(lowNm)) ouLays.under = { lay: ly.price, vol: ly.size, back: bk ? bk.price : 0 };
      });
      if (!ouLays.over || !ouLays.under) { skippedRunners++; return; }
      const bfLive = !!((mk.state || {}).inplay);
      ouRows.push({ name: evName[mk.marketId] || e.eventId || String(mk.marketId),
        line, over: ouLays.over, under: ouLays.under, marketId: mk.marketId, live: bfLive,
        corners: isCorners });
    });
    log('  DEBUG bfByMarket O/U: mkRows=' + mkRows + ' ouRows=' + ouRows.length + ' skipStatus=' + skippedStatus + ' skipLine=' + skippedLine + ' skipRunners=' + skippedRunners);
    if (DBG) log('  BF-H2H ' + comp + ': ' + rows.length + ' Maerkte' +
      (sbRows.length ? ' (+' + sbRows.length + ' Set Betting)' : '') +
      (swRows.length ? ' (+' + swRows.length + ' Set Winner)' : '') +
      (ouRows.length ? ' (+' + ouRows.length + ' O/U)' : ''));
    const oeRows = [];
    const oeBms = await bfFetchChunks(bfChunkIds(oeM));
    if (oeM.length) log('  DEBUG oeM: ' + oeM.length + ' nodes, chunks: ' + bfChunkIds(oeM).length);
    bfEachMarket(oeBms, (mk, e) => {
      if (!bfOpen(mk)) return;
      const side = {};
      (mk.runners || []).forEach(rn => {
        const nm = (rn.description && rn.description.runnerName) || '';
        const ly = rn.exchange && rn.exchange.availableToLay && rn.exchange.availableToLay[0];
        const bk = rn.exchange && rn.exchange.availableToBack && rn.exchange.availableToBack[0];
        if (!ly) return;
        const lowNm = nm.toLowerCase();
        if (lowNm === 'odd' || lowNm === 'yes') side.odd = { lay: ly.price, vol: ly.size, back: bk ? bk.price : 0 };
        else if (lowNm === 'even' || lowNm === 'no') side.even = { lay: ly.price, vol: ly.size, back: bk ? bk.price : 0 };
      });
      if (!side.odd || !side.even) return;
      const bfLive = !!((mk.state || {}).inplay);
      oeRows.push({ name: evName[mk.marketId] || e.eventId || String(mk.marketId),
        odd: side.odd, even: side.even, marketId: mk.marketId, live: bfLive });
    });
    if (DBG) log('  BF-H2H ' + comp + ': ' + rows.length + ' Maerkte' +
      (sbRows.length ? ' (+' + sbRows.length + ' Set Betting)' : '') +
      (swRows.length ? ' (+' + swRows.length + ' Set Winner)' : '') +
      (ouRows.length ? ' (+' + ouRows.length + ' O/U)' : '') +
      (oeRows.length ? ' (+' + oeRows.length + ' Odd/Even)' : ''));
    // MMA/UFC: "Go The Distance" (2-Wege Yes/No). Back UND Lay je Seite, damit
    // sowohl Back-Lay- (fdY/fdN) als auch Back-Back-Crosslegs (fdBBY/fdBBN)
    // analog zu BTTS/W2N entstehen koennen.
    const gdRows = [];
    const gdBms = await bfFetchChunks(bfChunkIds(gdM));
    if (gdM.length) log('  DEBUG gdM: ' + gdM.length + ' nodes, chunks: ' + bfChunkIds(gdM).length);
    bfEachMarket(gdBms, (mk, e) => {
      if (!bfOpen(mk)) return;
      let yes = null, no = null;
      (mk.runners || []).forEach(rn => {
        const nm = (rn.description && rn.description.runnerName) || '';
        const ly = rn.exchange && rn.exchange.availableToLay && rn.exchange.availableToLay[0];
        const bk = rn.exchange && rn.exchange.availableToBack && rn.exchange.availableToBack[0];
        if (!ly) return;
        const lowNm = nm.toLowerCase();
        const side = lowNm === 'yes' ? 'yes' : (lowNm === 'no' ? 'no' : '');
        if (!side) return;
        const rec = { lay: ly.price, vol: ly.size, back: bk ? bk.price : 0, volB: bk ? bk.size : 0 };
        if (side === 'yes') yes = rec; else no = rec;
      });
      if (!yes || !no) return;
      const bfLive = !!((mk.state || {}).inplay);
      gdRows.push({ name: evName[mk.marketId] || e.eventId || String(mk.marketId),
        yes, no, marketId: mk.marketId, live: bfLive });
    });
    if (gdRows.length)
      if (DBG) log('  BF-H2H ' + comp + ': +' + gdRows.length + ' Go The Distance');
    const out = { mo: rows, sb: sbRows, sw: swRows, ou: ouRows, oe: oeRows, gd: gdRows, ts: Date.now() };
    bfH2HCache.set(comp, out);
    return out;
  }
  // ---------- Odds-Pipe: Snapshots an die VBSB-App (SQLite) ----------
  const DB_URL = PIPE + '/odds';

  function dbSend(snap) {
    if (typeof GM_xmlhttpRequest === 'undefined') return Promise.resolve(false);
    return new Promise(res => {
      GM_xmlhttpRequest({
        method: 'POST', url: DB_URL, data: JSON.stringify(snap),
        headers: { 'content-type': 'application/json' },
        timeout: 4000,
        onload: r => res(r.status >= 200 && r.status < 300),
        onerror: () => res(false),
        ontimeout: () => res(false)
      });
    });
  }

  // Fire-and-forget POST an die App (Monitoring/Metriken). Darf nie den Scan
  // stoeren oder verzögern — Fehler werden stumm geschluckt.
  const postPipe = (path, obj) => {
    if (typeof GM_xmlhttpRequest === 'undefined') return;
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: PIPE + path, data: JSON.stringify(obj),
        headers: { 'content-type': 'application/json' }, timeout: 4000,
        onload: () => {}, onerror: () => {}, ontimeout: () => {}
      });
    } catch (e) { /* monitoring ist unkritisch */ }
  };

  async function dbFlush(log) {
    let q = [];
    try { q = JSON.parse(localStorage.getItem('vbsb_csarb_queue') || '[]'); } catch (e) { q = []; }
    for (let i = q.length - 1; i >= 0; i--) {
      if (await dbSend(q[i])) q.splice(i, 1);
    }
    // try/catch: Quota-Fehler duerfen den Flush (und damit den Scan-Zyklus)
    // nie abbrechen — die Queue ist dann nur im RAM (analog ui.js-Queue).
    try { localStorage.setItem('vbsb_csarb_queue', JSON.stringify(q)); } catch (e) { /* Quota voll */ }
    if (q.length && log) log('DB-Queue: ' + q.length + ' Snapshots warten (App laeuft nicht?)');
  }

  // ---------- Scan-Log-Pipe: Log an die VBSB-App (data/scan_logs/) ----------
  // Panel-log + devlog werden gepuffert und in Batches per POST /log an die
  // 8765-Bridge geschickt (App schreibt data/scan_logs/scan_<datum>.log).
  // So landet das komplette Scan-Log ohne manuelles Konsole-Kopieren auf der
  // Platte. Bei ausgeschalteter App wird im localStorage (begrenzt, letzte
  // 6000 Zeilen) gepuffert und beim naechsten Scan-Flush nachgeholt. Der
  // Scanner-Versionsheader bleibt fuer die Zuordnung im Log-File erhalten.
  const LOG_KEY = 'vbsb_csarb_logbuf';
  const LOG_URL = PIPE + '/log';
  const logBuf = { q: [], busy: false, lastTry: 0 };
  const logBufLoad = () => {
    try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch (e) { return []; }
  };
  const logBufSave = q => {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(q.slice(-6000))); } catch (e) { /* vol */ }
  };
  logBuf.q = logBufLoad();
  function logPipe(line) {
    logBuf.q.push(String(line));
    logBufSave(logBuf.q);
    if (logBuf.q.length >= 200 && !logBuf.busy && Date.now() - logBuf.lastTry > 15000) logPipeFlush(false);
  }
  function logPipeFlush(force) {
    if (!logBuf.q.length || typeof GM_xmlhttpRequest === 'undefined' || logBuf.busy) return;
    if (!force && Date.now() - logBuf.lastTry < 15000) return;
    logBuf.lastTry = Date.now();
    const batch = logBuf.q;
    logBuf.q = [];
    logBufSave(logBuf.q);
    logBuf.busy = true;
    const requeue = () => {
      logBuf.busy = false;
      logBuf.q = batch.concat(logBuf.q);
      logBufSave(logBuf.q);
    };
    GM_xmlhttpRequest({
      method: 'POST', url: LOG_URL,
      data: JSON.stringify({
        text: batch.join('\n'), ts: new Date().toISOString(), version: VERSION
      }),
      headers: { 'content-type': 'application/json' }, timeout: 5000,
      onload: r => {
        logBuf.busy = false;
        if (!(r.status >= 200 && r.status < 300)) requeue();
      },
      onerror: requeue, ontimeout: requeue
    });
  }
  const LEAGUES = { 1728:'COMP:129', 2476:'COMP:12202373', 2333:'COMP:11068551',
    2331:'COMP:12209546', 1913:'COMP:23', 2024:'COMP:45', 2374:'COMP:97',
    6633:'COMP:403085', 1792:'COMP:10479956', 2517:'COMP:133', 2395:'COMP:4905',
    2434:'COMP:103', 2453:'COMP:12013300', 2457:'COMP:115', 9320:'COMP:15',
    1880:'COMP:17', 2095:'COMP:1842928', 2102:'COMP:12209556', 2421:'COMP:105',
     2663:'COMP:141', 2650:'COMP:139', 1857:'COMP:744098',
     5591:'COMP:844197' };

  const LIGA_NAMEN = { 1728:'Sweden - Allsvenskan', 2476:'Sweden - Superettan',
    2333:'Norway - Eliteserien', 2331:'Norway - 1st Division', 1913:'Denmark - Superliga',
    2024:'Finland - Veikkausliiga', 2374:'Poland - Ekstraklasa', 6633:'Poland - 1st Liga',
    1792:'Austria - Bundesliga', 2517:'Switzerland - Super League', 2395:'Romania - Liga 1',
    2434:'Serbia - Super Liga', 2453:'Slovakia - Super Liga', 2457:'Slovenia - Prva Liga',
    9320:'Bulgaria - First League', 1880:'Croatia - HNL', 2095:'Hungary - NB 1',
     2102:'Iceland - Premier League', 2421:'Scotland - Premiership', 2663:'USA - Major League Soccer',
     2650:'Ukraine - Premier League',
     1857:'Chile - Primera Division', 5591:'Colombia - Primera A' };

  // Ligen, deren BF-COMP aktuell bekanntlich leer ist (Saison-Pause/abgemeldet).
  // Unterdrueckt die laute [LigaCheck]-Warnung, bleibt aber als Sammelzeile am
  // Scan-Ende sichtbar. Loest sich automatisch auf, sobald das COMP wieder liefert.
  const SUPPRESSED_EMPTY = { 2332: 'COMP:12224917', 202026: 'COMP:12704680',
    // Pruefung 2026-08-08: Betfair fuehrt aktuell KEINE COMPs fuer diese Ligen
    // (BF-recherchiert via __bfevents/bf_snapshot --search + GUI). Sweden
    // Damallsvenskan + Mexico Liga MX Women sind dort saisonbedingt/derzeit
    // nicht gelistet -> keine laute Warnung, bis BF sie wieder anbietet.
    1903: 'COMP:12742058', 201165: 'COMP:5627174' };

  const H2H = {};          // Pinnacle-Liga-ID -> Betfair-COMP (2-Wege-Sportarten)
  const H2H_NAMEN = {};

  // Gemeinsame Mapping-Pruefung (CS-Ligen + H2H-Ligen).
  const isMapped = pid => !!LEAGUES[pid] || !!H2H[pid];


  // Bekannte Abkuerzungs-Aliase fuer Token-Matching im Discovery
  // (z.B. Betfair-COMP "US MLS" fuer Pinnacle "USA - Major League Soccer").
  // Achtung: usa->"us" wird NUR fuer Soccer-Ligen angewandt, sonst
  // mappt z.B. "MLS Next Pro" faelschlich auf die MLS-COMP.
  const TALIAS = { soccer: ['mls'], mls: ['soccer'] };

  // Generische Liga-Woerter: allein nicht unterscheidungskraeftig (Country-Guard)
  const GENERIC = new Set(['premier','league','liga','ligue','division','cup','super',
    'klasse','serie','championship','qualifier','national','u20','u21','u22','u23',
    'u19','u18','u17','u16','youth','junior','juniors','reserves','reserve',
    'women','womens','w','group','groupa','groupb','a','b','1','2','3','4',
    'primera','segunda','tercera','first','second','third','fourth',
    '1st','2nd','3rd','4th','deild','erste','divisie','nbl','europa','world']);
  // __SYNONYMS_COUNTRY_BEGIN__
  const COUNTRY = {
    sweden: "swed",
    norway: "norw",
    denmark: "danish",
    finland: "finn",
    poland: "pol",
    austria: "austria",
    switzerland: "swiss",
    romania: "roman",
    serbia: "serb",
    slovakia: "slovak",
    slovenia: "sloven",
    bulgaria: "bulgar",
    croatia: "croat",
    hungary: "hungar",
    iceland: "iceland",
    scotland: "scott",
    england: "eng",
    korea: "korean",
    japan: "japan",
    ukraine: "ukrain",
    chile: "chile",
    colombia: "colomb",
    czech: "czech",
    "czech republic": "czech",
    ireland: "irish",
    wales: "welsh",
    germany: "german",
    france: "french",
    spain: "span",
    italy: "ital",
    portugal: "portug",
    netherlands: "dutch",
    belgium: "belg",
    greece: "greek",
    turkey: "turki",
    brazil: "brazil",
    argentina: "argentin",
    mexico: "mexic",
    peru: "peru",
    ecuador: "ecuador",
    uruguay: "uruguay",
    paraguay: "paraguay",
    bolivia: "bolivian",
    venezuela: "venezuelan",
    "costa rica": "costa rican",
    panama: "panaman",
    guatemala: "guatemal",
    honduras: "honduran",
    "el salvador": "salvador",
    nicaragua: "nicaraguan",
    latvia: "latvia",
    lithuania: "lithuan",
    estonia: "eston",
    faroe: "faroe",
    usa: "american",
    "north macedonia": "macedonian",
    montenegro: "montenegrin",
    bosnia: "bosnian",
    albania: "albanian",
    luxembourg: "luxembourg",
    malta: "maltese",
    cyprus: "cypriot",
    australia: "austral",
    china: "chinese",
    india: "indian",
    indonesia: "indonesian",
    thailand: "thai",
    vietnam: "vietnam",
    israel: "israeli",
    saudi: "saudi",
    qatar: "qatar",
    uae: "emirates",
    egypt: "egypt",
    morocco: "moroccan",
    tunisia: "tunisian",
    nigeria: "nigerian",
    ghana: "ghana",
    "south africa": "south african",
    "new zealand": "new zealand",
    "south korea": "korean",
    dominican: "dominican",
    russia: "russ",
    kazakhstan: "kazakh",
    belarus: "belarus",
    armenia: "armenian",
    canada: "canadian",
    lebanon: "lebanese",
    kyrgyzstan: "kyrgyz",
    moldova: "moldovan",
    georgia: "georgian",
    uzbekistan: "uzbek",
    "northern ireland": "irish",
    "puerto rico": "puerto rican",
    cuba: "cuban",
    trinidad: "trinidadian",
    jamaica: "jamaican",
    "faroe islands": "faroe",
    "saudi arabia": "saudi",
    "hong kong": "hong kong",
    taiwan: "taiwanese",
    singapore: "singapore",
    philippines: "filipino",
    pakistan: "pakistani",
    bangladesh: "bangladesh",
    "sri lanka": "sri lanka",
    afghanistan: "afghan",
    "united states": "american",
    turkiye: "turki",
    "türkiye": "turki",
    "great britain": "british",
    uk: "british",
    holland: "dutch",
    myanmar: "myanmar",
    kuwait: "kuwaiti",
    uganda: "ugandan",
    kenya: "kenyan",
    rwanda: "rwandan",
    tanzania: "tanzanian",
    senegal: "senegalese",
    cameroon: "cameroonian",
    "ivory coast": "ivorian",
    iran: "iranian",
    iraq: "iraqi",
    jordan: "jordanian",
    oman: "omani",
    bahrain: "bahraini",
    azerbaijan: "azerbaijani",
    kosovo: "kosovan",
    "north korea": "korean",
    tajikistan: "tajik",
    turkmenistan: "turkmen",
    mongolia: "mongolian",
    nepal: "nepali",
    cambodia: "cambodian",
    laos: "laotian",
    malaysia: "malaysian",
    zambia: "zambian",
    zimbabwe: "zimbabwean",
    namibia: "namibian",
    "burkina faso": "burkinabe",
    mali: "malian",
    "cape verde": "cape verdean",
    "dr congo": "congolese",
    congo: "congolese",
    angola: "angolan",
    gabon: "gabonese",
    benin: "beninese",
    togo: "togolese",
    niger: "nigerien",
    chad: "chadian",
    libya: "libyan",
    algeria: "algerian",
    "bosnia herzegovina": "bosnian",
    "test match": "cricket",
    "test matches": "cricket",
    "one day": "cricket",
    "one day international": "cricket",
    twenty20: "cricket",
    t20: "cricket",
    t20i: "cricket",
    ipl: "cricket",
    "the hundred": "cricket",
    odi: "cricket",
    "first class": "cricket",
    "list a": "cricket"
  };
  // __SYNONYMS_COUNTRY_END__

  // COUNTRY-Lookup mit "and"-Variante: PIN "Bosnia and Herzegovina - Premier Liga"
  // hat parts[0]="bosnia and herzegovina", im Map fehlt aber der "and"-Key.
  // Fallback-Kette: exakter Key -> "and"-entfernt ("bosnia herzegovina") ->
  // erster Teil ("trinidad" bei "trinidad and tobago").
  const countryRoot = country => {
    const k = String(country || '').toLowerCase().trim();
    if (COUNTRY[k]) return COUNTRY[k];
    const woAnd = k.replace(/\s+(?:and|&)\s+/g, ' ');
    if (COUNTRY[woAnd]) return COUNTRY[woAnd];
    const first = woAnd.split(' ')[0];
    if (first && COUNTRY[first]) return COUNTRY[first];
    return '';
  };

  // rootHit(text, root): Wort-Praefix-Match statt Substring, damit kurze Roots
  // nicht in Fremd-Woertern landen ("austria" matcht "austrian", aber nicht
  // "australian"; "turki" matcht "turkish", aber nicht "turkmenistan").
  // Mehrwort-Roots ("south african") werden als Phrase verglichen.
  const rootHit = (text, root) => {
    if (!root || !text) return false;
    const t = norm(text);
    const r = String(root).trim();
    if (!r) return false;
    if (r.includes(' ')) return t.includes(r);
    return t.split(' ').some(w => w === r || w.startsWith(r));
  };

  // Alle COUNTRY-Roots (fuer den Land-Konflikt-Guard in scoreCands): einmal
  // vorberechnet, damit der Guard pro Kandidat nicht Object.values neu baut.
  const COUNTRY_ROOTS = Object.values(COUNTRY).filter(Boolean);

  // Land-Konflikt-Guard (v7.92.3): liefert den Root eines ANDEREN Landes, das
  // im BF-Namen steht ("Iraq - Stars League" -> "qatari stars league" liefert
  // 'qatar'). scoreCands lehnt solche Kandidaten ab, auch wenn ein generisches
  // Token den Namen scheinbar passend macht.
  const foreignCountryRoot = (cn, root) => {
    if (!root || !cn) return null;
    const cnorm = norm(cn);
    const words = cnorm.split(' ');
    return COUNTRY_ROOTS.find(r => r !== root &&
      (r.includes(' ') ? cnorm.includes(r) : words.some(w => w === r || w.startsWith(r)))) || null;
  };

  // Qualifier-Ebene (v8.20.0): true, wenn PIN-Liga und BF-COMP beide (oder
  // beide nicht) eine Quali-Stufe bezeichnen. Ohne diesen Abgleich wuerde z.B.
  // "ATP US Open - Qualifiers" auf die Haupt-COMP "us open" mappen (gleiche
  // Tokens, kuerzerer BF-Name gewinnt den Tiebreak) statt auf die Quali-COMP
  // "us open qualifying" — und umgekehrt eine Haupt-Liga auf die Quali-COMP.
  const qualLevel = (pinName, bfName) => {
    const ltQual = /\bqualifiers?\b/i.test(String(pinName || ''));
    const cnQual = /\bqualif\w*\b/i.test(String(bfName || ''));
    return ltQual === cnQual;
  };

  // ---------- Discovery (Ligen-Vorschlaege fuer mehrere Sportarten) ----------
  async function findSports() {
    let sps = await pinGet('/sports').catch(() => []);
    for (let i = 0; i < 3 && !(sps || []).length; i++) {
      await sleep(backoff(800, i));
      sps = await pinGet('/sports').catch(() => []);
    }
    const filtered = (sps || []).filter(s =>
      /tennis|basketball|esport|baseball|ice hockey|volleyball|handball|american football|cricket|aussie rules|australian rules|rugby|mixed martial arts|\bmma\b|boxing/i
        .test(s.name || '')).map(s => ({ sid: s.id, name: s.name }));
    // Esports (sid 12) wird von /sports nicht geliefert wenn keine aktiven Ligen
    if (!filtered.some(s => s.sid === 12))
      filtered.push({ sid: 12, name: 'Esports' });
    return filtered;
  }

  const pinLeagueCache = new Map();   // sid -> {ts, list} (TTL 6h)
  async function getLeaguesCached(sid, tries) {
    const c = pinLeagueCache.get(sid);
    if (c && Date.now() - c.ts < 6 * MS_PER_HOUR) return c.list;
    const r = await pinGet('/sports/' + sid + '/leagues').catch(() => []);
    if (!(r || []).length && tries < 3) {
      await sleep(backoff(600, tries));
      return getLeaguesCached(sid, tries + 1);
    }
    pinLeagueCache.set(sid, { ts: Date.now(), list: r || [] });
    return r || [];
  }

  const bfNodeCache = new Map();       // cid -> {cn, effSid} (Session)
  // Sport-ID aus bynode-Knoten: SPORT-Knoten gibt's nie (attachments verbietet
  // SPORT -> HTTP 400); die Elternkette liefert stattdessen EVENT_TYPE:N,
  // wobei N die Betfair-Sport-ID ist (EVENT_TYPE:1 = Soccer, :5 = Basketball).
  function sportFromNodes(nodes) {
    const sportNode = nodes.find(n => String(n.nodeType) === 'SPORT') ||
      nodes.find(n => String(n.nodeType) === 'EVENT_TYPE') ||
      nodes.find(n => n.sportId !== undefined);
    if (!sportNode) return undefined;
    if (sportNode.sportId !== undefined) return Number(sportNode.sportId);
    const nid = Number(String(sportNode.nodeId || '').split(':')[1]);
    return Number.isFinite(nid) ? nid : undefined;
  }
  async function nodeInfo(cid, log) {
    let c = bfNodeCache.get(cid);
    if (c) return c;
    const n = await bfNode(cid).catch(() => null);
    const nodes = (n && n.nodes) || [];
    const compNode = nodes.find(x => String(x.nodeId || x.id) === 'COMP:' + cid);
    const named = nodes.filter(x => x.name && x !== compNode);
    // Generische Platzhalter-Namen (Betfair: "Fixtures 11 Aug") und Event-Namen
    // ("Team A v Team B") sind KEINE Wettbewerbsnamen und duerfen den echten
    // COMP-Namen nicht ueberschreiben (Vorfall Australia Cup: COMP:12011007 heisst
    // korrekt "Australia Cup", wurde aber von MENU "Fixtures 11 Aug" verdraengt
    // -> Discovery-Miss trotz korrekter Such-CID). Fallback auf die alten
    // Kandidaten, falls nichts "echtes" uebrig bleibt.
    const PH = /^(fixtures?|all games|all matches|today|tomorrow|upcoming)\b| v /;
    const isReal = x => x && x.name && !PH.test(norm(x.name));
    const real = [compNode, ...named].filter(isReal);
    const pool = real.length ? real : [compNode, ...named].filter(x => x && x.name);
    let cn = '';
    // laengster Name gewinnt (z.B. COMP "US MLS" + MENU "US Major League Soccer")
    for (const a of pool) {
      const an = norm(a.name);
      if (an.length > cn.length) cn = an;
    }
    const effSid = sportFromNodes(nodes);
    c = { cn, effSid };
    bfNodeCache.set(cid, c);
    return c;
  }

  // Einzel-Vorschlag fuer eine Liga (gemeinsamer Pfad: Discovery + Auto-Discovery)
  // Stufen-Erkennung (Liga-Tier): verhindert Vorschlaege auf falscher Ebene,
  // z.B. "Paulista Serie B" -> COMP "Brazilian Serie A" oder "Liga 2" -> "Liga 1".
  // Wichtig: Vergleich ist symmetrisch — Pinnacle- und BF-Name folgen meist
  // denselben Benennungs-Konventionen, daher greift die Penalty nur bei echten
  // Abweichungen (beide Seiten liefern eine Stufe).
  function tierOf(name) {
    const n = norm(name);
    if (!n) return null;
    const R = [
      [/meistriliiga/, 1], [/esiliiga/, 2],
      [/allsvenskan/, 1], [/superettan/, 2],
      [/eliteserien/, 1], [/veikkausliiga/, 1], [/ekstraklasa/, 1],
      [/2nd bundesliga|2\s*bundesliga/, 2], [/3rd bundesliga|3\s*bundesliga/, 3],
      [/bundesliga/, 1], [/regionalliga/, 3], [/oberliga/, 4],
      [/premier/, 1],
      [/primera division/, 1], [/primera a\b/, 1], [/primera b\b/, 2],
      [/segunda/, 2], [/tercera/, 3],
      [/superliga|super liga/, 1],
      [/serie a\b/, 1], [/serie b\b/, 2], [/serie c\b/, 3],
      [/liga\s+(1|i)\b/, 1], [/liga\s+(2|ii)\b/, 2], [/liga\s+(3|iii)\b/, 3],
      [/ligue\s+(1|i)\b/, 1], [/ligue\s+(2|ii)\b/, 2],
      [/division\s+1\b/, 1], [/division\s+2\b/, 2], [/division\s+3\b/, 3],
      [/1st division|first division/, 1], [/2nd division|second division/, 2],
      [/3rd division|third division/, 3],
      [/championship/, 2]
    ];
    for (const [re, lvl] of R) if (re.test(n)) return lvl;
    return null;
  }

  // Liga-Typ-Synonyme -> kanonisch "lig". Erlaubt es, PIN "… 1st League" gegen
  // BF "… 1. Lig"/"… 1 liga"/"… 1st Division" zu matchen (Vorfall 2026-08-13:
  // "Turkey - 1st League" -> "turkish 1 lig", Discovery-Name-Miss).
  // Wettbewerbs-Synonyme: BF benennt Pokalwettbewerbe oft in Landessprache
  // ("Coppa Italia", "Copa del Rey", "DFB-Pokal", "Coupe de France"), PIN
  // dagegen englisch ("Italy - Cup"). Ohne diese Map matcht "cup" (generisch)
  // weder auf "coppa" noch "copa" -> Discovery-Name-Miss, wie bei "Italy -
  // Cup" (pid 2147 -> COMP:12214429, Coppa Italia) beobachtet.
  // Freundschaftsspiele: BF nennt "International Matches"/"Club Matches",
  // PIN "International Friendlies"/"Club Friendlies". Ohne diese Map matcht
  // "friendlies" nicht auf "matches" (beides unterscheidbare Tokens) ->
  // Discovery-Name-Miss fuer Club/International Friendlies aller Sportarten.
  // Alle drei Maps werden aus synonyms.json generiert (scripts/sync_synonyms.py).
  // __SYNONYMS_DISCOVERY_BEGIN__
  const LIG_SYN = {
    league: "lig",
    liga: "lig",
    lig: "lig",
    division: "lig",
    divisao: "lig",
    deild: "lig",
    ligaen: "lig"
  };
  const COMP_SYN = {
    coppa: "cup",
    copa: "cup",
    pokal: "cup",
    coupe: "cup",
    shield: "cup",
    supercup: "cup",
    supercoppa: "cup",
    taca: "cup",
    "taça": "cup",
    beker: "cup",
    kopp: "cup",
    kupa: "cup"
  };
  const MATCH_SYN = {
    friendlies: "matches",
    friendly: "matches"
  };
  // __SYNONYMS_DISCOVERY_END__
  // Ordinal-/Numerik-Aequivalenz: "1st"/"1."/"1"/"first"/"i" -> "1".
  const ordNum = t => {
    const m = /^(\d{1,2})(st|nd|rd|th)?\.?$/.exec(t);
    if (m) return m[1];
    const o = { first: '1', second: '2', third: '3', fourth: '4', fifth: '5',
      i: '1', ii: '2', iii: '3' };
    return o[t] || null;
  };

  // Bewertet eine beliebige Kandidaten-Liste (Suche ODER Nav-Baum) fuer die
  // Liga L und liefert den besten Match. Gemeinsamer Scoring-Pfad von
  // proposeComp (Textsuche) und dem Nav-Baum-Zweipass (Landes-COMPs).
  async function scoreCands(cands, L, sp, bfSid, ctx) {
    const lt = ctx.lt, kt = ctx.kt, ltDist = ctx.ltDist, acro = ctx.acro,
      root = ctx.root, country = ctx.country, log = ctx.log;
    const lblScore = o => {
      const lc = rawLbl(o);
      if (!lc) return -1;
      let s = 0;
      for (const t of lt) {
        if (lc.split(' ').includes(t)) s += 2;
        else if (t.length >= 4 && lc.includes(t)) s += 1;
        else {
          const cc = COMP_SYN[t] || t;
          if (lc.split(' ').some(w => w === cc || COMP_SYN[w] === cc)) s += 2;
          else if (MATCH_SYN[t] && lc.split(' ').some(w => w === MATCH_SYN[t] ||
            MATCH_SYN[w] === MATCH_SYN[t])) s += 2;
        }
      }
      for (const t of kt) if (lc.split(' ').includes(t)) s += 2;
      if (root && (rootHit(lc, root) || rootHit(lc, norm(country)))) s += 3;
      return s;
    };
    cands = cands.slice().sort((x, y) => lblScore(y) - lblScore(x));
    let best = null, bestScore = 0, bestLen = 1e9, bestName = '', firstName = '', bestEff, firstEff;
    const cands2 = cands.filter(o => {
      // C9: Sport-Vorfilter rein ueber die von der Suche gelieferte sportId
      // (spart nodeInfo-Calls fuer offensichtliche Fremd-Sport-Treffer).
      // Nav-Baum-Kandidaten tragen sportId=bfSid und bleiben unberuehrt.
      if (o.sportId === undefined) return true;
      if (bfSid !== undefined) return o.sportId === bfSid;
      return !BF_SIDS.has(o.sportId);
    }).slice(0, 14);
    const resolved = await pool(cands2, async o => {
      const info = await nodeInfo(o.cid, log);
      const effSid = info.effSid !== undefined ? info.effSid : o.sportId;
      // Sport-Guard: Pinnacle-Sport != BF-Sport ablehnen (z.B. Padel-Liga
      // darf nicht auf Soccer-COMP mappen).
      if (bfSid !== undefined && effSid !== undefined && effSid !== bfSid) return null;
      // Kein bekannter BF-Sport fuer die Pinnacle-Sportart (z.B. Padel):
      // nur COMPs akzeptieren, deren BF-Sport ebenfalls unbekannt ist
      // (sonst landet z.B. eine Padel-Liga auf der falschen Soccer-COMP).
      if (bfSid === undefined && effSid !== undefined && BF_SIDS.has(effSid)) return null;
      if (/\b(politics|election|elections|novelty|novelties|music|tv|film|cinema|award|awards|special|specials)\b/.test(info.cn)) return null;
      return { o, cn: info.cn, effSid };
    }, 6);
    for (const r of resolved) {
      if (!r) continue;
      let cn = r.cn;
      const o = r.o;
      if (!cn) {
        const lcn = rawLbl(o);
        if (lcn) {
          let w = 0;
          for (const t of lt) if (lcn.split(' ').includes(t)) w++;
          if (w >= 2) cn = lcn;
        }
      }
      if (!firstName && cn) { firstName = cn; firstEff = r.effSid; }
      const words = cn.split(' ');
      const ltSoc = lt.has('soccer') || lt.has('football');
      const matchTok = t => {
        if (words.includes(t) || words.includes(t + 's') || words.includes(t + 'es')) return true;
        if (TALIAS[t] ? TALIAS[t].some(w => words.includes(w)) : false) return true;
        if (t === 'usa' && ltSoc && words.includes('us')) return true;
        const c = LIG_SYN[t] || ordNum(t);
        if (c) {
          for (const w of words) {
            if (w === c || LIG_SYN[w] === c || ordNum(w) === c) return true;
          }
        }
        // Wettbewerbs-Synonyme: "cup" (PIN) matcht auf "coppa"/"copa"/"pokal"/
        // "coupe"/"shield" im BF-Namen und umgekehrt.
        const cc = COMP_SYN[t] || t;
        for (const w of words) {
          if (w === cc || COMP_SYN[w] === cc) return true;
        }
        // Freundschaftsspiele: "friendlies" (PIN) matcht auf "matches" (BF).
        const mm = MATCH_SYN[t];
        if (mm) {
          for (const w of words) if (w === mm || MATCH_SYN[w] === mm) return true;
        }
        return false;
      };
      let sc = 0;
      for (const t of lt) {
        if (matchTok(t)) sc += acro.includes(t) ? 4 : 2;
        else if (t.length >= 4 && cn.includes(t)) sc += 1;
      }
      if (!(lt.has('women') || lt.has('womens') || lt.has('ladies')) &&
        /\b(women|womens|ladies)\b/.test(cn)) sc -= 4;   // Herren-Liga != Damen-Comp
      if ((lt.has('women') || lt.has('womens') || lt.has('ladies')) &&
        !/\b(women|womens|ladies|femenina|feminina)\b/.test(cn)) sc -= 4;   // Damen-Liga != Herren-Comp
      // Jugend-/Altersklassen-Guard (analog Damen): U16-U23, Youth, Junior,
      // Reserve darf nicht auf eine Senior-COMP mappen und umgekehrt.
      // (Fix 7.78.4: "Poland - U19 League" -> "polish 2 liga" war vorher Proposal.)
      const youthTok = /(^|\s)(u1[6-9]|u2[0-3]|youth|junior|juniors|reserves?)(\s|$)/;
      const ltYouth = youthTok.test([...lt].join(' '));
      const cnYouth = /\b(u1[6-9]|u2[0-3]|youth|junior|juniors|reserves?)\b/.test(cn);
      if (ltYouth !== cnYouth) sc -= 4;
      // Qualifier-Ebene (v8.20.0): Quali-Liga nur auf Quali-COMP, Haupt-Liga
      // nur auf Haupt-COMP (analog Jugend-/Altersklassen-Guard).
      if (!qualLevel([...lt].join(' '), cn)) sc -= 4;
      const countryHit = !!root &&
        (rootHit(cn, root) || rootHit(cn, norm(country)) ||
        (country === 'usa' && ltSoc && (words.includes('us') || words.includes('mls'))));
      // Land-Konflikt-Guard (v7.92.3): enthaelt der BF-Name einen ANDEREN
      // bekannten Country-Root, ist es eine Fremd-Liga — kein Vorschlag, auch
      // wenn ein generisches Token ("stars") den Namen scheinbar passend macht
      // ("Iraq - Stars League" -> "qatari stars league" war vorher Proposal).
      // Greift nur, wenn der EIGENE Land-Root fehlt (countryHit false).
      if (root && !countryHit && foreignCountryRoot(cn, root)) {
        continue;
      }
      if (!countryHit && !ltDist.some(matchTok)) {
        // Weder Land noch unterscheidbares Token im BF-Namen: zu generisch
        // (z.B. "SEA V.League - Women" darf nicht auf eine beliebige
        // "... women ... league"-COMP mappen)
        continue;
      }
      if (countryHit) sc += 3;
      for (const t of lt) if (GENERIC.has(t) && !matchTok(t)) sc -= 2;
      // Stufen-Abgleich: gleiche Stufe belohnen, falsche Stufe hart bestrafen
      // (z.B. "Paulista Serie B" darf nicht auf "Brazilian Serie A" mappen).
      const tP = tierOf(L.name), tC = tierOf(cn);
      if (tP !== null && tC !== null) {
        if (tP === tC) sc += 1;
        else sc -= 4;
      }
      // Numerik-Abgleich: PIN-Stufe ("1st"/"2nd"/"1.") und BF-Stufe ("1"/"2")
      // stimmen ueberein -> Bonus (hebt z.B. "Turkey - 1st League" gegen
      // "turkish 1 lig" ueber den Auto-Apply-Schwellwert, ohne dass tierOf
      // die laenderspezifische Nomenklatur kennen muss).
      const nP = [...lt].map(ordNum).filter(Boolean);
      const nC = words.map(ordNum).filter(Boolean);
      if (nP.length && nC.length && nP.some(n => nC.includes(n))) sc += 2;
      if (sc < 4) continue;
      if (sc > bestScore || (sc === bestScore && cn.length < bestLen)) {
        bestScore = sc; best = o.cid; bestLen = cn.length; bestName = cn; bestEff = r.effSid;
      }
    }
    if (best && bestScore > 0) return { ok: true, cid: best, score: bestScore, cn: bestName,
      effSid: bestEff };
    return { ok: false, reason: 'name',
      sample: firstName + (firstEff !== undefined ? ' (sid ' + firstEff + ')' : '') };
  }

  async function proposeComp(L, sp, log) {
    const parts = String(L.name).split(' - ');
    // Seit v8.20.0 werden Quali-Ligen wie normale Ligen vorgeschlagen (der
    // User will z.B. Grand-Slam-Qualis erkennen). Die Quali-COMPs sind zwar
    // transient (verschwinden nach der Quali-Runde), aber die Zuordnung wird
    // je Lauf neu vorgeschlagen und per GUI bestaetigt. Der qualLevel-Guard
    // in scoreCands haelt sie auf der Quali-Ebene (nie auf der Haupt-COMP).
    const country = (parts[0] || '').toLowerCase().trim();
    const kw = parts[1] || parts[0];
    const isSoccer = sp.sid === 29;
    const root = (isSoccer || country !== 'usa') ? countryRoot(country) : '';
    const full = String(L.name).replace(/\s*-\s*/g, ' ');
    const bfSid = BF_SID[sp.sid];
    let comps = [];
    try { comps = await searchComps(parts, full, bfSid); } catch (e) { comps = []; }
    await sleep(100);
    if (!comps.length) return { ok: false, reason: 'search' };
    const lt = toks(L.name);
    const kt = toks(kw);
    // Unterscheidbare Tokens: >= 4 Zeichen (nicht generisch) ODER
    // Grossbuchstaben-Akronyme aus dem Originalnamen (UFC, NRL, AFL, NPC ...)
    const ltDistRaw = [...lt].filter(t => t.length >= 4 && !GENERIC.has(t));
    const acro = [...new Set(String(L.name).split(/[^A-Za-z0-9]+/)
      .filter(t => /^[A-Z]{2,5}$/.test(t)).map(t => t.toLowerCase())
      .filter(t => t !== 'usa' && !ltDistRaw.includes(t)))];
    const ltDist = ltDistRaw.concat(acro);
    const ctx = { lt, kt, ltDist, acro, root, country, log };
    let res;
    try {
      res = await scoreCands(comps, L, sp, bfSid, ctx);
    } catch (e) {
      devlog('scoreCands-Fehler (' + L.id + ' ' + L.name + '): ' +
        (e && e.stack ? String(e.stack).split('\n').slice(0, 3).join(' | ') : e));
      res = { ok: false, reason: 'error', sample: (e && e.message || e) };
    }
    // Nav-Baum-Zweipass: Textsuche liefert fuer generische Namen ("France -
    // Super Cup") oft nur Fremd-Treffer (uefa super cup) statt des Landes-COMPs
    // ("French Super Cup"). Dann die COMPs des Landes aus dem Nav-Baum sammeln
    // und mit demselben Scoring bewerten. Gemeinsamer Sammel-Pfad mit dem
    // searchComps-Fallback: navCompsFor().
    // Auch bei LEERER Textsuche (reason 'search') pruefen: Der BF-Suchindex
    // rankt z.B. "Test Match" (Singular) nicht, obwohl der Nav-Baum die
    // Cricket-Gruppe "test matches" fuehrt (Vorfall 2026-08-13, COMP:11365612).
    if (!res.ok && (res.reason === 'name' || res.reason === 'search') &&
      root && bfSid !== undefined) {
      let nav = await navCompsFor(bfSid, country, root);
      if (nav.length) {
        const seen = new Set(comps.map(o => o.cid));
        nav = nav.filter(o => !seen.has(o.cid));
        if (nav.length) {
          try {
            const res2 = await scoreCands(nav, L, sp, bfSid, ctx);
            if (res2.ok) res = res2;
          } catch (e) {
            devlog('scoreCands-nav-Fehler (' + L.id + ' ' + L.name + '): ' +
              (e && e.message ? e.message : e));
          }
        }
      }
    }
    return res;
  }

  // ---------- Discovery-Deny-Liste ----------
  // Blockt nur das EXAKTE (pid -> COMP)-Paar, nie eine Liga komplett: Neue
  // COMP-Kandidaten fuer dieselbe Liga kommen ungehindert durch. TTL 7 Tage:
  // Nach Ablauf wird das Paar aus der Liste entfernt und wieder als
  // Vorschlag gemeldet (mit "[Deny abgelaufen]"-Marker) — nichts wird
  // dauerhaft verloren.
  const DENY_TTL_MS = 7 * 864e5;
  // Permanente, dokumentierte Fehl-Zuordnungen (Doku SCANNER_UEBERSICHT §5.5,
  // CHANGELOG v7.87.9/v7.90.1/v7.92.1): Diese Eintraege kehrten nach Ablauf der
  // 7-Tage-Deny-TTL jedes Mal als Proposal wieder (z.B. Australia NPL -> A-League).
  // Seit v8.44.3 kommen sie NICHT mehr aus hartkodierten Seed-Aufrufen, sondern
  // live von der Odds-Pipe: Single Source of Truth ist deny_mapping.json
  // (GET /league-map -> denies), in pipeDenies gemergt (gesetzt von ui.js
  // loadLeagueMap). KEINE TTL — der Block gilt dauerhaft fuer das exakte
  // pid|COMP-Paar; kommt die Liga spaeter mit einer RICHTIGEN COMP, laeuft der
  // Vorschlag trotzdem (der Key matcht nicht).
  // Hinweis: pipeDenies ist `let`, da es von ui.js (gleicher IIFE-Scope, kommt
  // nach discovery.js im Build) beim Mapping-Load gefuellt wird — nicht const,
  // sonst ReferenceError schon beim Deklarieren wegen der spaeten Zuweisung.
  let pipeDenies = {};
  let denyList = [];
  try { denyList = JSON.parse(localStorage.getItem('vbsb_csarb_deny') || '[]'); } catch (e) { denyList = []; }
  const denySave = () => {
    try { localStorage.setItem('vbsb_csarb_deny', JSON.stringify(denyList)); } catch (e) { /* voll */ }
  };
  // Persistenter Promotions-Zaehler fuer Auto-Deny-Promotion: Merkt sich, welche
  // pid|COMP-Konflikte bereits auto-gedenist wurden, UEBERLEBT die TTL-Loesung
  // des temporaeren Deny-Eintrags. Zweiter Erreichen der 3x-Schwelle -> Promotion
  // auf dauerhaft (perm=true). Bewusst ein Set, kein Zeit-Feld: Es geht um die
  // FAKTISCHE Wiederholung, nicht um den Zeitpunkt.
  const PROMOTE_KEY = 'vbsb_csarb_denypromote';
  let promoteSet = new Set();
  try { promoteSet = new Set(JSON.parse(localStorage.getItem(PROMOTE_KEY) || '[]')); } catch (e) { /* leer */ }
  const promoteSave = () => {
    try { localStorage.setItem(PROMOTE_KEY, JSON.stringify([...promoteSet])); } catch (e) { /* voll */ }
  };
  const promoteCount = key => promoteSet.has(key) ? 1 : 0;
  const promoteHit = key => { promoteSet.add(key); promoteSave(); };
  // Promotions-Set per Userscript-Update zuruecksetzen? Nein — Promotion gilt
  // dauerhaft und soll Bugfixes nicht unterlaufen (nur temporaere auto-Denys
  // werden per DENY_VER_KEY zurueckgesetzt, siehe unten).
  unsafeWindow.__promotes = () => promoteSet.size ? [...promoteSet].join('\n') : 'Keine Auto-Deny-Promotions.';
  const denyUpsert = (pid, comp, reason, perm = false, kind = perm ? 'wrong-comp' : 'auto') => {
    const key = String(pid) + '|' + comp;
    denyList = denyList.filter(d => d.key !== key);
    denyList.push({ key, pid: String(pid), comp, reason, ts: Date.now(), perm, kind });
    denySave();
  };
  // Ergebnis: 'active' (blockt), 'expired' (abgelaufen, aus Liste entfernt) oder null.
  // perm=true (manuell/Seed, "Auto-STATIC_DENY" v7.92.5): blockt DAUERHAFT, kein TTL.
  // kind: 'never' (Liga hat auf Betfair keinen Wettbewerb -> Pre-Skip vor der
  // Suche), 'wrong-comp' (Liga existiert, nur das falsche COMP-Paar blockt),
  // 'auto' (temporaer, 3x-Konflikt).
  const denyStatus = (pid, comp) => {
    const stKey = String(pid) + '|' + comp;
    const now = Date.now();
    for (const d of denyList) {
      if (d.pid === String(pid) && d.comp === comp) {
        if (d.perm) return 'active';
        if (now - (d.ts || 0) > DENY_TTL_MS) {
          denyList = denyList.filter(x => x !== d);
          denySave();
          return 'expired';
        }
        return 'active';
      }
    }
    if (pipeDenies[stKey]) return 'active';
    return null;
  };
  // Nur lesend: liefert das Block-kind eines konkreten (pid, comp)-Paars fuer
  // Log/Doku (pipeDenies -> wrong-comp Default/Datei-kind, denyList -> gespeichertes kind).
  const denyKind = (pid, comp) => {
    const stKey = String(pid) + '|' + comp;
    const d = denyList.find(x => x.pid === String(pid) && x.comp === comp);
    if (d) return d.kind || (d.perm ? 'wrong-comp' : 'auto');
    if (pipeDenies[stKey]) return pipeDenies[stKey].kind || 'wrong-comp';
    return null;
  };
  const denyReason = (pid, comp) => {
    const stKey = String(pid) + '|' + comp;
    const d = denyList.find(x => x.pid === String(pid) && x.comp === comp);
    if (d) return d.reason;
    if (pipeDenies[stKey]) return pipeDenies[stKey].reason || null;
    return null;
  };
  // Liefert das 'never'-kind einer Liga UNABHAENGIG vom COMP-Kandidaten:
  // true wenn Betfair fuer die Liga keinen Wettbewerb fuehrt (Pre-Skip-Kandidat).
  const isNeverPid = pid => NEVER_PIDS.has(String(pid));
  // Pids, die auf Betfair KEINEN Wettbewerb fuehren (State-/Regionalligen -
  // COMP existiert nachweislich nicht). Diese werden VOR der Suche uebersprungen
  // (kein Search-/nodeInfo-Aufwand). NEVER_RECHECK_INTERVAL erlaubt ein
  // regelmaessiges Re-Check, falls Betfair die Liga irgendwann doch aufnimmt.
  // In league_mapping.json bewusst NICHT eingetragen (kein PF-COMP vorhanden).
  const NEVER_RECHECK_MS = 30 * 864e5; // 30 Tage
  const NEVER_PIDS = new Set(['1769','8588','8586','1753','219117','194796',
    '212331','209510','194630','11693']);
  const neverRecheck = new Map(); // pid -> ts
  const isNeverSkip = pid => {
    const p = String(pid);
    if (!NEVER_PIDS.has(p)) return null;
    const last = neverRecheck.get(p);
    if (last && Date.now() - last < NEVER_RECHECK_MS) return 'skip';
    return 'check';  // Intervall abgelaufen -> einmalig wieder pruefen
  };
  const neverMarkChecked = pid => neverRecheck.set(String(pid), Date.now());
  // Seed beim ersten Start ist seit v8.44.3 NICHT mehr noetig: Die dauerhaften
  // Fehl-Zuordnungen (ehemals STATIC_DENY + Seed-Aufrufe) liegen als Single
  // Source of Truth in deny_mapping.json und werden live von der Odds-Pipe
  // geladen (ui.js loadLeagueMap -> pipeDenies). Bereits abgelegte perm-Eintraege
  // aelterer Builds in localStorage bleiben unveraendert aktiv. Die never-Ligen
  // (NEVER_PIDS, ohne BF-Wettbewerb) bleiben per Pre-Skip im Code (kompakte
  // Sammelzeile "[never] ... Ligen uebersprungen").

  // Deny-Versions-Reset (analog missList): Nach einem Userscript-Update werden
  // TEMPORAERE (kind==='auto') Denys zurueckgesetzt, damit Bugfixes an genau
  // diesen Ursachen wirklich wirken. Permanente (never/wrong-comp) bleiben.
  const DENY_VER_KEY = 'vbsb_csarb_deny_ver';
  try {
    const oldDenyVer = localStorage.getItem(DENY_VER_KEY);
    if (oldDenyVer !== VERSION) {
      const before = denyList.length;
      // Nur permanente (perm) Denys behalten; temporaere 'auto'-Denys raus,
      // damit Bugfixes an genau deren Ursache wieder greifen.
      denyList = denyList.filter(d => d.perm === true);
      if (denyList.length !== before) denySave();
      localStorage.setItem(DENY_VER_KEY, VERSION);
    }
  } catch (e) { /* localStorage evtl. gesperrt */ }

  // __denys(): Vollstaendiger Einblick in alle Block-Ebenen (pipeDenies-Code +
  // denyList). Spiegelt __props/__misses. Gibt je Block pid|COMP, kind, reason,
  // perm/TTL und Ablaufzeit aus.
  unsafeWindow.__denys = () => {
    const rows = [];
    for (const key of Object.keys(pipeDenies || {})) {
      const [pid, comp] = key.split('|');
      const d = pipeDenies[key];
      rows.push('[static] ' + pid + ' -> ' + comp + ' [' + (d.kind || 'wrong-comp') + ', dauerhaft] ' + (d.reason || ''));
    }
    for (const d of denyList) {
      const ttl = d.perm ? 'dauerhaft' : 'bis ' + new Date((d.ts || 0) + DENY_TTL_MS).toLocaleString('de-DE');
      rows.push('[' + (d.kind || 'auto') + (d.perm ? ', perm' : ', auto') + '] ' + d.pid +
        ' -> ' + d.comp + ' (' + d.reason + ') ' + ttl);
    }
    return rows.length ? rows.join('\n') : 'Keine aktiven Deny-Blöcke.';
  };

  // ---------- Miss-Feedback-Loop (name/search-Misses) ----------
  // Discovery-Misses sind bisher "verbrannte Luft": "LCK CL", "LRN", "CBLOL"
  // (Esports) o.ae. scheitern JEDEN Lauf an name/search und rauschen jedes Mal
  // durch die Suche. Neu wird pro Liga mitgezaehlt, wie oft proposeComp ohne
  // Zuordnung endet; ab MISS_SEEN Treffern innerhalb der TTL wird die Liga
  // wie ein Deny uebersprungen (kein Suchaufwand mehr), TTL gleiche 7 Tage
  // wie die Deny-Liste. Funktioniert identisch zum Auto-Deny fuer Conflicts:
  // Konzept-Lernen aus wiederholter Erfahrung, ohne Ligen dauerhaft zu verlieren.
  const MISS_KEY = 'vbsb_csarb_misses';
  const MISS_VER_KEY = 'vbsb_csarb_misses_ver';
  let missList = [];
  try { missList = JSON.parse(localStorage.getItem(MISS_KEY) || '[]'); } catch (e) { missList = []; }
  const missSave = () => {
    try { localStorage.setItem(MISS_KEY, JSON.stringify(missList)); } catch (e) { /* voll */ }
  };
  // Versions-Reset: Nach einem Userscript-Update die Miss-Zaehlung zuruecksetzen.
  // Bugfixes beheben genau die Ursachen, die als Miss x3 blockierten (z.B.
  // COMP_SYN: "Italy - Cup" -> "Coppa Italia"); ohne Reset wuerde die alte
  // Zaehlung bis zum TTL-Ablauf (7 Tage) weiter blocken.
  try {
    const oldVer = localStorage.getItem(MISS_VER_KEY);
    if (oldVer !== VERSION) {
      missList = [];
      missSave();
      localStorage.setItem(MISS_VER_KEY, VERSION);
    }
  } catch (e) { /* localStorage evtl. gesperrt — Miss-Reset dann nicht moeglich */ }
  const MISS_SEEN = 3;
  const missTrack = (pid, name, reason) => {
    const key = String(pid);
    const now = Date.now();
    const ex = missList.find(m => m.pid === key);
    if (ex) {
      if (now - (ex.lastSeen || 0) > DENY_TTL_MS) {
        // TTL abgelaufen: Trefferzaehlung startet frisch — dieselbe Liga braucht
        // wieder MISS_SEEN neue Misses, statt mit den alten weiterzuzaehlen.
        ex.firstSeen = now; ex.lastSeen = now; ex.seen = 1; ex.reason = reason;
      } else {
        ex.lastSeen = now; ex.seen++; ex.reason = reason;
        if (ex.seen >= MISS_SEEN) {
          devlog('Miss-Feedback: ' + ex.pid + ' (' + ex.name + ') ' + ex.seen +
            'x als ' + reason + '-Miss — Uebersprung bis TTL-Ablauf.');
        }
      }
    } else {
      missList.push({ pid: key, name: String(name).slice(0, 80), reason,
        firstSeen: now, lastSeen: now, seen: 1 });
    }
    missList = missList.slice(-300);
    missSave();
  };
  // Nur lesender Status: 'active' (nach MISS_SEEN Treffern, blockt),
  // 'expired' (TTL weg) oder null (noch unter Schwelle). Kein Seiteneffekt
  // (kein Entfernen/Speichern) — das Aufraeumen macht missPrune() einmalig.
  const missStatus = pid => {
    const now = Date.now();
    for (const m of missList) {
      if (m.pid === String(pid)) {
        if (now - (m.lastSeen || 0) > DENY_TTL_MS) return 'expired';
        return m.seen >= MISS_SEEN ? 'active' : null;
      }
    }
    return null;
  };
  // Entfernt abgelaufene Miss-Eintraege (TTL) — einmal je Discovery-Lauf und
  // beim Laden, damit __misses() und die Status-Logik nicht durch veraltete
  // Eintraege unuebersichtlich wachsen.
  const missPrune = () => {
    const now = Date.now();
    const kept = missList.filter(m => now - (m.lastSeen || 0) <= DENY_TTL_MS);
    if (kept.length !== missList.length) { missList = kept; missSave(); }
  };
  missPrune();
  unsafeWindow.__misses = () => {
    if (!missList.length) return 'Keine Discovery-Misses persistiert.';
    return missList.map(m => m.pid + ' (' + m.name + ') ' + m.reason + ' ' + m.seen + 'x | letzter ' +
      new Date(m.lastSeen).toLocaleString('de-DE')).join('\n');
  };

  // ---------- Discovery-Vorschlaege: Persistierung (Review-Flow) ----------
  // Jede Discovery-Runde wird nachvollziehbar gehalten: Proposal-Treffer und
  // COMP-Konflikte landen mit Zeitstempel in localStorage. Ueber den GUI-
  // Button "Vorschlaege" oder __props() ist der Verlauf ueber Tage abrufbar.
  const PROPS_KEY = 'vbsb_csarb_props';
  let propList = [];
  try { propList = JSON.parse(localStorage.getItem(PROPS_KEY) || '[]'); } catch (e) { propList = []; }
  const propsSave = () => {
    try { localStorage.setItem(PROPS_KEY, JSON.stringify(propList)); } catch (e) { /* voll */ }
  };
  // kind: 'proposal' (neue Zuordnung) | 'conflict' (COMP bereits woanders gemappt)
  // Auto-Deny: Ein wiederkehrender Conflict (3x in verschiedenen Laeufen) wird
  // automatisch in die Deny-Liste uebernommen und aus der Vorschlagsliste
  // entfernt — derselbe Konflikt rauscht damit nicht mehr jede Discovery warnend
  // durch (Konzept-Lernen aus Erfahrung). TTL der Deny-Liste gilt unveraendert.
  const AUTODENY_SEEN = 3;
  const propsUpsert = (pid, comp, cn, name, sid, kind) => {
    const key = String(pid) + '|' + comp;
    const now = Date.now();
    const ex = propList.find(p => p.key === key);
    if (ex) {
      ex.lastSeen = now; ex.seen++;
      if (kind === 'conflict' && ex.seen >= AUTODENY_SEEN) {
        // Auto-Deny (3x Konflikt). Promotion: Erreicht derselbe Konflikt die
        // Schwelle zum ZWEITEN Mal (nach TTL-Ablauf wieder aufgetaucht), wird er
        // dauerhaft (perm=true) statt wieder temporär — kein erneutes Wiederkäuen.
        // Der Promotions-Zähler ist PERSISTENT (ueberlebt die TTL-Löschung des
        // temp-Eintrags), sonst wäre ein wiederkehrender Konflikt nicht erkennbar.
        const promote = promoteCount(key) > 0;
        denyUpsert(ex.pid, ex.comp,
          'Auto-Denied: Conflict ' + ex.seen + 'x in ' + AUTODENY_SEEN + ' Discovery-Laeufen' +
          (promote ? ' (Promoted: wiederkehrend => dauerhaft)' : ''),
          promote, 'auto');
        propList = propList.filter(p => p.key !== key);
        devlog('⚠ Auto-Deny' + (promote ? ' (Promoted)' : '') + ': ' + ex.pid + ' -> ' +
          ex.comp + ' (' + ex.name + ') ' + ex.seen + 'x als Conflict gemeldet — ' +
          (promote ? 'dauerhaft gesetzt.' : 'in Deny-Liste uebernommen.'));
        promoteHit(key);
      }
    }
    else { propList.push({ key, pid: String(pid), comp, cn: cn || '', name, sid, kind, firstSeen: now, lastSeen: now, seen: 1 }); }
    propList = propList.slice(-200);
    propsSave();
  };
  unsafeWindow.__props = (kind) => {
    const rows = kind ? propList.filter(p => p.kind === kind) : propList;
    if (!rows.length) return 'Keine persistierten Discovery-Vorschlaege.';
    return rows.map(p => '[' + p.kind + '] ' + p.pid + ' -> ' + p.comp +
      (p.cn ? ' [' + p.cn + ']' : '') + ' ' + p.name +
      ' | erst ' + new Date(p.firstSeen).toLocaleString('de-DE') +
      ' | letzter ' + new Date(p.lastSeen).toLocaleString('de-DE') +
      ' | ' + p.seen + 'x').join('\n');
  };
  // Aufraemung der Vorschlagsliste: Eintraege, deren pid inzwischen gemappt ist
  // (egal auf welche COMP), gelten als erledigt und fallen raus. Konflikte und
  // noch ungemappte Proposals bleiben fuer die Auto-Deny-Zaehlung stehen.
  // Wird nach loadLeagueMap() und nach jeder Discovery aufgerufen, damit frisch
  // gemappte Ligen nicht in der "Vorschlaege"-Liste haengen bleiben.
  const pruneProps = (andSave) => {
    const before = propList.length;
    propList = propList.filter(p => {
      const pid = String(p.pid);
      if (LEAGUES[pid] || H2H[pid]) return false;   // pid inzwischen gemappt
      return true;
    });
    if (andSave !== false && propList.length !== before) propsSave();
  };
  // Synchronisiert propList mit dem Pipe-Status: Eintraege, die im Pipe
  // (discovery_proposals-Tabelle) bereits als 'accepted' oder 'rejected'
  // markiert sind, werden aus propList entfernt. Loest das Problem, dass
  // der User einen Vorschlag im Pipe-GUI (Settings -> Discovery) akzeptiert,
  // aber der Userscript-seitige propList-Eintrag bleibt (kein status-Feld).
  // Wird nach jedem Discovery-Lauf aufgerufen (async, fire-and-forget).
  const syncPropListFromPipe = () => {
    if (typeof GM_xmlhttpRequest === 'undefined') return;
    try {
      GM_xmlhttpRequest({
        method: 'GET', url: PIPE + '/discovery-proposals',
        timeout: 4000,
        onload: (resp) => {
          try {
            const data = JSON.parse(resp.responseText);
            const decided = (data.proposals || []).filter(
              p => p.status === 'accepted' || p.status === 'rejected');
            if (!decided.length) return;
            const decidedKeys = new Set(decided.map(p => p.pid + '|' + p.comp));
            const before = propList.length;
            propList = propList.filter(p => !decidedKeys.has(p.key));
            if (propList.length < before) {
              propsSave();
              devlog('pruneProps (Pipe-Sync): ' + (before - propList.length) +
                ' entschiedene Eintraege aus propList entfernt.');
            }
          } catch (e) { /* parse-Fehler ignorieren */ }
        },
        onerror: () => {}, ontimeout: () => {}
      });
    } catch (e) { /* GM_xmlhttpRequest nicht verfuegbar */ }
  };

  // Gemeinsame aktive-Ligen-Erkennung (Discovery + Auto-Discovery): filtert
  // Ligen auf Haupt-Matchups im Zeitfenster (now-HOURS_BACK .. soon).
  // maxChecked begrenzt die Zahl der geprueften Ligen (0 = unbegrenzt),
  // checkedAccum akkumuliert ueber Aufrufe (Auto-Discovery teilt das Limit
  // ueber alle Sportarten). Rueckgabe: { act, checked }.
  // Aktivitaet wird kurzzeitig gecacht (TTL 10 min): Wiederholte Discovery-
  // Laeufe im Scan-Zyklus sparen sich den /leagues/{id}/matchups-Call je Liga
  // (vorher ~117 PIN-Calls pro Soccer-Lauf), nur frische Eintraege kosten
  // Netz. checked zaehlt nur ECHTE Calls (Cache-Hits sind gratis und begrenzen
  // das maxChecked-Budget nicht).
  const ACT_TTL_MS = 10 * 60e3;
  const actCache = new Map();   // pid -> {cnt, ts}
  async function activeLeagues(leagues, now, soon, maxChecked, checkedAccum) {
    const act = [];
    let checked = checkedAccum || 0;
    const chunk = maxChecked ? 8 : 10;
    for (let i = 0; i < leagues.length && (!maxChecked || checked < maxChecked); i += chunk) {
      await Promise.all(leagues.slice(i, i + chunk).map(async L => {
        if (maxChecked && checked >= maxChecked) return;
        const key = String(L.id);
        const c = actCache.get(key);
        let cnt;
        if (c && now - c.ts < ACT_TTL_MS) {
          cnt = c.cnt;
        } else {
          if (maxChecked && checked >= maxChecked) return;
          checked++;
          const mus = await pinGet('/leagues/' + L.id + '/matchups').catch(() => []);
          cnt = (mus || []).filter(m => m.type === 'matchup' && !m.parentId &&
            new Date(m.startTime || 0).getTime() > now - HOURS_BACK * MS_PER_HOUR &&
            new Date(m.startTime || 0).getTime() < soon).length;
          actCache.set(key, { cnt, ts: now });
        }
        if (cnt) act.push({ id: L.id, name: L.name });
      }));
    }
    return { act, checked };
  }

  // Discovery-Ergebnis je Lauf: {sid, name, leagues:[{id,name}]} fuer
  // "Manuell mappen" — wird von discovery() gefuellt und von ui.js
  // restauriert/gelesen (Deklaration hier, damit auch autoTourLid und
  // h2hRoundSiblings ohne ui.js-Zugriff darauf arbeiten koennen).
  let lastActive = [];

  // ---------- H2H-Turnier-Remap (Runden-Wechsel selbst heilen) ----------
  // Pinnacle vergibt fuer Turnier-Sportarten je Runde ein NEUES lid (z.B.
  // Tennis "ATP Montreal - R1" (221308) -> "ATP Montreal - R16" (221310)),
  // die Betfair-COMP bleibt ueber das ganze Turnier aber gleich. Liefert der
  // gemappte PIN-lid ploetzlich 0 Spiele (alte Runde vorbei/abgeschlossen),
  // sucht der Scanner in den aktuellen Ligen desselben Turniers den Folge-lid
  // und schreibt das Mapping automatisch um (COMP unveraendert). Falls kein
  // aktiver Nachfolger existiert (Turnier beendet), bleibt alles wie bisher.
  // Guard: Nur Namen mit Runden-Suffix (" - R16", " - Final", ...) ziehen
  // diesen Pfad — generische Ligen ("Atlanta - NBL") koennen so NICHT
  // versehentlich auf einen anderen lid umgemappt werden (ohne Runden-Endung
  // liefert tourKey2() null und autoTourLid() bricht ab).
  const H2H_ROUND_RE = /^(.*?)\s*-\s*(R\d+|R\w*|QF\d*|SF\d*|Final\w*|Semifinal\w*|Quarterfinal\w*|Doubles\w*|Qualifiers?|Q\d*)\s*$/i;
  // v8.62.17: nummerierte Serien-/Tour-Runden (CCT-Fall: "CS2 - CCT European
  // Series 8" bzw. "CCT European Series 7") — das Suffix "Series N"/"Tour N"
  // am Namensende wird abgetrennt, Basis = Rest. Dadurch bleibt die Region in
  // der Basis (Europe Series 7/8 teilen sie, South America nicht), und ein
  // Dash-Split ist nicht noetig. Bewusst NUR mit Ziffer: "Italy - Serie A"
  // ist eine eigene Liga, keine Runde (ohne Zahlen-Zwang waere ein Remap
  // Serie A -> Serie B moeglich).
  const SERIES_SUFFIX_RE = /\s*(?:Series|Tour)\s*\d+\s*$/i;
  const tourKey2 = name => {
    const s = String(name).trim();
    const m = H2H_ROUND_RE.exec(s);
    if (m) {
      const base = norm(m[1]);
      return base ? { base, round: norm(m[2]) } : null;
    }
    const ms = SERIES_SUFFIX_RE.exec(s);
    if (ms) {
      const base = norm(s.slice(0, ms.index));
      return base ? { base, round: norm(ms[0]) } : null;
    }
    return null;
  };
async function autoTourLid(lid, comp, log) {
    const name = H2H_NAMEN[lid] || '';
    const tk = tourKey2(name);
    if (!tk) return null;
    // Sport-sic jedes H2H-Sports aus lastActive ableiten (Discovery kennt ihn)
    let sid = null;
    for (const sa of lastActive) {
      if ((sa.leagues || []).some(x => String(x.id) === String(lid))) { sid = sa.sid; break; }
    }
    if (sid === null) {
      // Fallback ohne lastActive (kein Discovery-Lauf): bekannte PIN-Sportarten
      // durchprobieren, bis der lid in der Ligen-Liste auftaucht.
      for (const trySid of Object.keys(BF_SID).map(Number)) {
        if (trySid === 29) continue;
        const ll = await pinGet('/sports/' + trySid + '/leagues').catch(() => []);
        if ((ll || []).some(x => String(x.id) === String(lid))) { sid = trySid; break; }
      }
    }
    if (sid === null) {
      devlog('TourRemap: kein Sport fuer lid ' + lid + ' in lastActive');
      return null;
    }
    // FRISCH fetchen (nicht den 6h-Cache): der neue Runden-lid muss gerade
    // in der aktuellen Ligen-Liste von PIN stehen, sonst finden wir ihn nicht.
    const leagues = await pinGet('/sports/' + sid + '/leagues').catch(() => []);
    // Kandidaten: gleiches Turnier (nicht nur Basis per norm), anderes lid,
    // noch nicht gemappt — und Runden-Suffix des neuen Namens bitte auch
    // (nur Turnier-Namen, nie generische Ligen umbuchen)
    const cands = [];
    for (const L of leagues) {
      if (String(L.id) === String(lid)) continue;
      if (isMapped(L.id)) continue;
      const ct = tourKey2(L.name);
      if (!ct || ct.base !== tk.base) continue;
      // Typ erhalten: Doubles-Runde darf nicht auf Einzel-Runde umgebucht
      // werden und umgekehrt (gleiche Turnier-Basis, andere Wettbewerbsart).
      if (/doubles/.test(tk.round) !== /doubles/.test(ct.round)) continue;
      cands.push(L);
    }
    if (!cands.length) return null;
    const now = Date.now(), soon = now + daysAhead * MS_PER_DAY;
    for (const L of cands) {
      const mus = await pinGet('/leagues/' + L.id + '/matchups').catch(() => []);
      const cnt = (mus || []).filter(m => m.type === 'matchup' && !m.parentId &&
        new Date(m.startTime || 0).getTime() > now - HOURS_BACK * MS_PER_HOUR &&
        new Date(m.startTime || 0).getTime() < soon).length;
      if (cnt) return { lid: String(L.id), name: L.name, cnt };
    }
    return null;
  }

  // ---------- H2H-Turnier: Runden-Siblings fuer den Fenster-Merge (v8.62.6) ----------
  // Pinnacle splittet Turnier-Spieltage (vor allem Tennis) teils auf ZWEI Lids
  // auf: Live-Fall US Open 2026 — "ATP US Open - R1" (3451) fuehrte nur die
  // fruehesten Matches des Tages (7), der Rest inkl. Topspielen (Duckworth v
  // Y Wu, Alcaraz, Medvedev ...) lag im Nachbar-lid "ATP US Open - R2" (3453).
  // Solange das gemappte lid nicht LEER ist, remappt autoTourLid nicht — die
  // Matches des Nachbar-lids blieben daher ungescannt und landeten dauerhaft
  // als "unmatched". h2hRoundSiblings findet die aktiven Nachbar-Runden-lids
  // desselben Turniers (gleicher Basisname via tourKey2, Runden-Suffix, kein
  // Doubles-Wechsel) mit Fenster-Matchups fuer den Merge im H2H-Scan.
  // Cache (TTL 10 min, wie actCache): die /sports/{sid}/leagues- und
  // /leagues/{lid}/matchups-Calls laufen nicht bei jedem Scan-Zyklus neu.
  const SIB_TTL_MS = 10 * 60e3;
  const sibCache = new Map(); // lid -> { ts, siblings: [{ lid, name, cnt }] }
  async function h2hRoundSiblings(lid, log) {
    const name = H2H_NAMEN[lid] || '';
    const tk = tourKey2(name);
    if (!tk) return [];
    const c = sibCache.get(String(lid));
    if (c && Date.now() - c.ts < SIB_TTL_MS) return c.siblings;
    // Sport des Primär-lids ermitteln (wie autoTourLid): lastActive, sonst
    // bekannte PIN-Sportarten durchprobieren.
    let sid = null;
    for (const sa of lastActive) {
      if ((sa.leagues || []).some(x => String(x.id) === String(lid))) { sid = sa.sid; break; }
    }
    if (sid === null) {
      for (const trySid of Object.keys(BF_SID).map(Number)) {
        if (trySid === 29) continue;
        const ll = await pinGet('/sports/' + trySid + '/leagues').catch(() => []);
        if ((ll || []).some(x => String(x.id) === String(lid))) { sid = trySid; break; }
      }
    }
    if (sid === null) return [];
    const leagues = await pinGet('/sports/' + sid + '/leagues').catch(() => []);
    const cands = [];
    for (const L of leagues) {
      if (String(L.id) === String(lid)) continue;
      const ct = tourKey2(L.name);
      if (!ct || ct.base !== tk.base) continue;
      // Typ erhalten: Doubles-Runde nicht mit Einzel-Runde mischen
      if (/doubles/.test(tk.round) !== /doubles/.test(ct.round)) continue;
      cands.push(L);
    }
    const now = Date.now(), soon = now + daysAhead * MS_PER_DAY;
    const siblings = [];
    for (const L of cands) {
      const mus = await pinGet('/leagues/' + L.id + '/matchups').catch(() => []);
      const cnt = (mus || []).filter(m => m.type === 'matchup' && !m.parentId &&
        new Date(m.startTime || 0).getTime() > now - HOURS_BACK * MS_PER_HOUR &&
        new Date(m.startTime || 0).getTime() < soon).length;
      if (cnt) siblings.push({ lid: String(L.id), name: L.name, cnt });
    }
    sibCache.set(String(lid), { ts: now, siblings });
    return siblings;
  }

  async function discovery(log, sports) {
    const now = Date.now(), soon = now + daysAhead * MS_PER_DAY;
    const props = [];
    // lastActive pro Lauf NEU aufbauen (kein Akkumulieren ueber Laeufe hinweg):
    // vorher wurde jede Sportart bei jedem Lauf angehaengt, wodurch die
    // Zusammenfassung ("Bereits gemappt") laengst veraltete Ligen mehrfach
    // zaehlte und das "Manuell mappen"-Dropdown alte PIDs zeigte.
    lastActive = [];
    for (const sp of sports) {
      const leagues = await getLeaguesCached(sp.sid, 0);
      if (!leagues || !leagues.length) { log('  ' + sp.name + ': keine Ligen'); continue; }
      const { act } = await activeLeagues(leagues, now, soon);
      log('  ' + sp.name + ' (sid ' + sp.sid + '): ' + act.length + ' aktive Ligen: ' +
        act.map(x => x.name + ' (pid ' + x.id + ')').join(' | '));
      lastActive.push({ sid: sp.sid, name: sp.name, leagues: act });
      try { localStorage.setItem('vbsb_csarb_lastactive', JSON.stringify(lastActive)); } catch (e) {}
      const todo = act.filter(L => !isMapped(L.id));
      if (todo.length < act.length)
        log('  davon bereits gemappt: ' + (act.length - todo.length) + ' (uebersprungen)');
      // Miss-Feedback: Ligen, die seit MISS_SEEN Laeufen nicht zuordenbar waren,
      // ueberspringen (kein Suchaufwand) bis die TTL abgelaufen ist. Der Status
      // wird EINMAL je Liga gelesen (missPrune raeumt abgelaufene Eintraege vorher
      // weg); im Worker wird nur noch das Set geprueft — kein doppelter
      // missStatus-Aufruf mehr.
      missPrune();
      const missSkip = todo.filter(L => missStatus(L.id) === 'active');
      const missIds = new Set(missSkip.map(L => L.id));
      if (missSkip.length) {
        log('  ⏭ [Miss x' + MISS_SEEN + '] ' + missSkip.length + ' Ligen uebersprungen (' +
          missSkip.map(L => L.name + ' (pid ' + L.id + ')').join(', ') + ')');
      }
      // never-PreSkip: Ligen ohne Betfair-Wettbewerb (kind 'never') muessen NICHT
      // durch die Suche laufen (wuerden nur den geblockten/fehlenden COMP-Kandidat
      // wiederfinden). Nach NEVER_RECHECK_MS einmalig neu geprueft (isNeverSkip).
      const neverTodo = todo.filter(L => !missIds.has(L.id) && isNeverPid(L.id));
      const neverCheckIds = new Set(neverTodo.filter(L => isNeverSkip(L.id) === 'check').map(L => L.id));
      const neverSkipIds = new Set(neverTodo.filter(L => !neverCheckIds.has(L.id)).map(L => L.id));
      if (neverSkipIds.size) {
        log('  ⏭ [never] ' + neverSkipIds.size + ' Ligen ohne BF-Wettbewerb uebersprungen (' +
          neverTodo.filter(L => neverSkipIds.has(L.id)).map(L => L.name + ' (pid ' + L.id + ')').join(', ') + ')');
      }
      let hits = 0, matches = 0;
      const missed = [];
      // Dauerhafte/statische Denies (v8.44.3): kommen aus deny_mapping.json
      // (pipeDenies) bzw. perm-Seeds in localStorage — sie werden nicht je
      // Runde einzeln geloggt, sondern hier als Sammelzeile am Sportart-Ende.
      const aktiveDauerhaft = [];
      // Kandidaten parallel bewerten (pool 3): Discovery lag bei 26 ungemappten
      // Soccer-Ligen ~30s wegen sequenzieller proposeComp-Calls (2-4 Searches +
      // bis 14 nodeInfo je Liga). props/hits/matches/missed werden in den
      // Worker-Callbacks synchron mutiert (JS single-threaded -> sicher).
      await pool(todo, async L => {
        if (missIds.has(L.id) || neverSkipIds.has(L.id)) return;
        let pr;
        try {
          pr = await proposeComp(L, sp, log);
        } catch (e) {
          // Kein Worker-Fehler darf spurlos verschwinden: als error-Miss in die
          // Misses-Zeile + Meldung ins Panel (vorher nur in der Konsole).
          log('  ⚠ Fehler ' + L.name + ' (pid ' + L.id + '): ' + (e && e.message || e));
          missed.push({ kw: L.name.split(' - ')[1] || L.name, reason: 'error',
            sample: (e && e.message) });
          return;
        }
        if (pr.ok) {
          const kind = denyKind(L.id, 'COMP:' + pr.cid);
          const den = denyStatus(L.id, 'COMP:' + pr.cid);
          // never-PreSkip-Recheck: Wenn eine eigentlich 'never' gesperrte Liga
          // nach dem Intervall wieder geprueft wird und die COMP inzwischen
          // liefert, hier als normaler Deny (dauerhaft, wrong-comp) ausgeben.
          if (neverCheckIds.has(L.id)) neverMarkChecked(L.id);
          if (den === 'active') {
            const stKey = String(L.id) + '|COMP:' + pr.cid;
            const stDeny = pipeDenies[stKey];
            const statisch = stDeny ? stDeny.reason : null;
            const ent = denyList.find(d => d.pid === String(L.id) && d.comp === 'COMP:' + pr.cid);
            const perm = !!stDeny || !!ent?.perm || isNeverPid(L.id);
            const reason = statisch || (ent && ent.reason) || '';
            // Dauerhafte/statische Denies (pipeDenies oder perm-Seed in
            // localStorage) sind bekannt -> kein Einzel-Log je Runde (Rauschen,
            // v8.44.3). Sie werden als Sammelzeile am Sportart-Ende gezaehlt.
            if (perm) { aktiveDauerhaft.push({ L, pr, reason }); return; }
            // Nur temporaere Auto-Denies einzeln melden (sind relevant/neu).
            log('  ⏭ [Deny' + (kind ? '/' + kind : '') + '] ' + L.name + ' (pid ' + L.id +
              ') -> COMP:' + pr.cid + ' [' + pr.cn + '] (' + reason +
              ', abgelaufen nach ' + Math.round(DENY_TTL_MS / 864e5) + ' T)');
            return;
          }
          hits++;
          props.push({ sid: sp.sid, pid: L.id, comp: 'COMP:' + pr.cid, cn: pr.cn, name: L.name });
          matches++;
          log('  VORSCHLAG ' + L.name + ' -> ' + 'COMP:' + pr.cid +
            (pr.cn ? ' [' + pr.cn + ']' : '') +
            (den === 'expired' ? ' [Deny abgelaufen, neu geprueft]' : '') +
            (pr.effSid !== undefined ? ' (BF-sid ' + pr.effSid + ')' : ''));
          return;
        }
        if (pr.reason === 'name' || pr.reason === 'search') missTrack(L.id, L.name, pr.reason);
        if (pr.reason === 'name') hits++;
        missed.push({ kw: L.name.split(' - ')[1] || L.name, reason: pr.reason, sample: pr.sample });
      }, 3);
      // Sammelzeile der dauerhaften/statischen Denies (v8.44.3) statt je
      // aktiver Deny eine Einzelzeile pro Runde. Kompakt: Zaehler + die ersten
      // 4 Paare, der Rest als "+N weitere". Analog den never-/Miss-Sammelzeilen.
      if (aktiveDauerhaft.length) {
        const kopie = aktiveDauerhaft.slice(0, 4).map(x =>
          x.L.name + ' -> COMP:' + x.pr.cid + ' [' + x.pr.cn + ']').join(' | ');
        const rest = aktiveDauerhaft.length > 4 ? ' | ... +' + (aktiveDauerhaft.length - 4) + ' weitere' : '';
        log('  ⏭ [Deny dauerhaft] ' + aktiveDauerhaft.length + ' Ligen gesperrt (' + kopie + rest + ')');
      }
      log('  ' + sp.name + ': ' + matches + ' Treffer (' + hits + '/' + todo.length +
        ' mit Suchtreffer)' + (missed.length ? ' | Misses: ' +
        missed.slice(0, 5).map(m => '"' + m.kw + '" ' + m.reason +
          (m.sample ? ' -> ' + m.sample : '')).join(', ') : ''));
    }
    log('Discovery: ' + props.length + ' Vorschlaege');
    return { props, lastActive };
  }
  // ---------- Konsole-Helper: BF-Marktnamen auflisten (ohne vollen Scan) ----------
  // Zentrales Tool-Log: alle Dev-/Probe-Helper loggen hierueber statt je
  // eigener console.log-Closure. Der Dev-Tools-Dialog kann devSink setzen,
  // um die Ausgabe zusaetzlich ins Panel-Log umzuleiten.
  let devSink = null;
  const devlog = msg => {
    logPipe(msg);
    if (devSink) devSink(msg);
    console.log(msg);
  };
  // PIN-Sniff-Proxy an das Panel-Log andocken (Proxy ist vor devlog installiert).
  try { window.__pinSink = devlog; } catch (e) { /* ok */ }
  // Gemeinsamer Probe-Pfad (__hfprobe/__w2nprobe): COMP laden, Marktnamen
  // auflisten, Maerkte per Name-Regex filtern und Runner-Detail-Lay-Dump.
  async function bfProbeDump(comp, nameRe, label, out) {
    const j = await bfLeagueMarkets(comp);
    if (!j || !j.nodes || !j.nodes.length) return null;
    const mname = bfMktName;
    const names = [...new Set(j.nodes.filter(n => n.nodeType === 'MARKET')
      .map(mname))].filter(Boolean);
    out('BF Marktnamen ' + comp + ':\n' + names.join('\n'));
    const mkts = j.nodes.filter(n => n.nodeType === 'MARKET' && nameRe.test(mname(n)));
    out(label + ': ' + mkts.length);
    if (mkts.length) {
      const bms = await bfFetchChunks(bfChunkIds(mkts));
      bfEachMarket(bms, (mk, e) =>
        out('Markt ' + mk.marketId + ' | ' + (e.eventName || '?') + ' | Runner: ' +
          (mk.runners || []).map(r =>
            (r.description && r.description.runnerName) +
            ' lay=' + (r.exchange && r.exchange.availableToLay &&
              r.exchange.availableToLay[0] ? r.exchange.availableToLay[0].price : '-'))
            .join(' | ')));
    }
    return j;
  }

  unsafeWindow.__bfht = async (comp, kw) => {
    if (/^\d+$/.test(String(comp)) && LEAGUES[comp]) comp = LEAGUES[comp];
    const j = await bfLeagueMarkets(comp);
    if (!j || !j.nodes || !j.nodes.length) return devlog('__bfht: keine Daten');
    const mname = bfMktName;
    const names = [...new Set((j.nodes || []).filter(n => n.nodeType === 'MARKET')
      .map(mname))].filter(Boolean);
    devlog('BF Marktnamen ' + comp + ' (' + names.length + '):\n' + names.join('\n'));
    if (kw) {
      const hit = names.filter(n => n.toLowerCase().includes(kw.toLowerCase()));
      devlog('Filter "' + kw + '": ' + (hit.length ? hit.join(' | ') : 'KEINE'));
      const mkt = (j.nodes || []).filter(n => n.nodeType === 'MARKET' &&
        mname(n).toLowerCase().includes(kw.toLowerCase()));
      if (mkt.length) {
        const bms = await bfFetchChunks(bfChunkIds(mkt));
        bfEachMarket(bms, (mk, e) =>
          devlog('Markt ' + mk.marketId + ' ' + e.eventName + ' [' +
            (((mk.state || {}).status) || '?') + ']: ' +
            (mk.runners || []).map(r =>
              (r.description && r.description.runnerName) + '(h=' + r.handicap + ')' +
              ' back=' + (r.exchange && r.exchange.availableToBack && r.exchange.availableToBack[0] ?
                r.exchange.availableToBack[0].price : '-') +
              ' lay=' + (r.exchange && r.exchange.availableToLay && r.exchange.availableToLay[0] ?
                r.exchange.availableToLay[0].price : '-')
            ).join(' | ')));
      }
    }
  };

  // ---------- Konsole-Helper: AH-Parsing ohne Scan testen ----------
  const ahProbeOut = [];
  window.__ahProbe = async (comp, pinLid) => {
    const P = msg => { ahProbeOut.push(msg); };
    const mname = bfMktName;
    const j = await bfLeagueMarkets(comp);
    if (!j || !j.nodes || !j.nodes.length) return P('keine Daten');
    const markets = j.nodes.filter(n => n.nodeType === 'MARKET' &&
      /^asian handicap$/i.test(mname(n)));
    P('AH-Maerkte: ' + markets.length);
    const mktName = {};
    markets.forEach(m => { mktName[m.nodeId.split(':')[1]] = mname(m); });
    const bms = await bfFetchChunks(bfChunkIds(markets));
    let dumped = false;
    bfEachMarket(bms, mk => {
        const out = [];
        const rel = {};
        (mk.runners || []).forEach((rn, idx) => {
          const desc = rn.description || {};
          if (!dumped) {
            dumped = true;
            P('MARKT: ' + JSON.stringify(mk.marketDescription || null));
            P('RUNNER[0]: ' + JSON.stringify(rn));
          }
          out.push(desc.runnerName + ' h=' + rn.handicap +
            ' lay=' + (rn.exchange && rn.exchange.availableToLay ?
              rn.exchange.availableToLay[0].price : '-'));
          if (rn.handicap === 0 || rn.handicap === 0.5 || rn.handicap === -0.5) {
            const l = rn.exchange && rn.exchange.availableToLay &&
              rn.exchange.availableToLay[0].price;
            rel[rn.handicap + ':' + (desc.runnerName || '')] = l;
          }
        });
        P(mktName[mk.marketId] + ' | ' + out.join(' | '));
        const relLine = Object.keys(rel).sort().map(k =>
          k + '=' + rel[k]).join(' | ');
        if (relLine) P('  AH Kernlines: ' + relLine);
    });
    if (pinLid) {
      const mus = await pinGet('/leagues/' + pinLid + '/matchups').catch(() => null);
      if (!mus || !mus.length) return P('PIN: keine Matchups');
      P('PIN ' + pinLid + ': ' + mus.length + ' Matchups');
      const mm2 = m => /^moneyline$/i.test(String(m.type || '')) && (m.period || 0) === 0;
      for (const mu of mus) {
        const pr = await pinGet('/matchups/' + mu.id + '/markets/straight').catch(() => null);
        if (!pr) continue;
        const mm = pr.find(mm2);
        if (!mm) continue;
        const px = {};
        for (const p of (mm.prices || [])) {
          if (typeof p.price !== 'number') continue;
          px[desig(p)] = dec(p.price);
        }
        const q = { h: px.home || 0, d: px.draw || 0, a: px.away || 0 };
        const dnbH = q.h * (q.d - 1) / q.d, dnbA = q.a * (q.d - 1) / q.d;
        const dc1x = q.h * q.d / (q.h + q.d), dcx2 = q.a * q.d / (q.a + q.d),
          dc12 = q.h * q.a / (q.h + q.a);
        const nm = (mu.participants || []).map(p => p.name).join(' v ') ||
          ('id=' + mu.id);
        P('PIN ' + nm + ' ML=' + [q.h, q.d, q.a].map(v =>
          (v && v.toFixed ? v.toFixed(2) : '-')).join('/') +
          ' dnbH=' + dnbH.toFixed(2) + ' dnbA=' + dnbA.toFixed(2) +
          ' dc1x=' + dc1x.toFixed(2) + ' dcx2=' + dcx2.toFixed(2) +
          ' dc12=' + dc12.toFixed(2));
      }
    }
  };

  // ---------- Konsole-Helper: HT/FT-Marktstruktur (PIN + BF) zeigen ----------
  unsafeWindow.__hfprobe = async (comp, pinLid) => {
    const log = devlog;
    if (/^\d+$/.test(String(comp)) && LEAGUES[comp]) comp = LEAGUES[comp];
    const j = await bfProbeDump(comp,
      /half ?time\/? ?full ?time|half ?\/ ?full|ht\/ft/i, 'BF HT/FT-Maerkte', log);
    if (!j) log('BF: keine Daten fuer ' + comp);
    if (pinLid) {
      if (/^\d{10,}$/.test(String(pinLid))) {
        const mu = await pinGet('/matchups/' + pinLid).catch(() => null);
        const nm = mu && (mu.participants || []).map(p => p.name).join(' v ') ||
          ('id=' + pinLid);
        const pr = await pinGet('/matchups/' + pinLid + '/markets/straight').catch(() => null);
        const rel = await pinGet('/matchups/' + pinLid + '/markets/related').catch(() => null);
        if (Array.isArray(pr)) {
          const st = pr.map(m => String(m.type || ''))
            .filter((v, i, a) => a.indexOf(v) === i).join(',');
          log('PIN ' + nm + ' | straightTypes=' + st);
        }
        if (!Array.isArray(rel)) log('PIN ' + nm + ': related-Aufruf fehlgeschlagen');
        const hf = (Array.isArray(pr) ? pr : []).concat(Array.isArray(rel) ? rel : [])
          .filter(m => !m || String(m.matchupId) === String(pinLid))
          .filter(m => /half|full/i.test(String(m.type || '')));
        hf.forEach(m => log('PIN ' + nm + ' | type=' + m.type + ' period=' + (m.period || 0) +
          ' | ' + (m.prices || []).map(p => String(p.designation ||
            'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
        if (!hf.length) log('PIN ' + nm + ': kein half/full-Markt (straight+related)');
        return;
      }
      const mus = await pinGet('/leagues/' + pinLid + '/matchups').catch(() => null);
      if (!mus || !mus.length) return log('PIN: keine Matchups fuer ' + pinLid);
      const mains = (mus || []).filter(x => x.type === 'matchup' && !x.parentId);
      log('PIN ' + pinLid + ': ' + mains.length + ' Haupt-Matchups');
      const rel = await pinGet('/leagues/' + pinLid + '/markets/related').catch(() => null);
      if (Array.isArray(rel) && rel.length) {
        const rt = rel.map(m => String(m.type || ''))
          .filter((v, i, a) => a.indexOf(v) === i).join(',');
        log('PIN ' + pinLid + ' relatedTypes=' + rt);
      } else {
        log('PIN ' + pinLid + ': leagues/related = ' +
          (Array.isArray(rel) ? 'leer' : 'FEHLER (400?)'));
      }
      for (const mu of mains.slice(0, 6)) {
        const nm = (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + mu.id);
        const pr = await pinGet('/matchups/' + mu.id + '/markets/straight').catch(() => null);
        if (Array.isArray(pr)) {
          const st = pr.map(m => String(m.type || ''))
            .filter((v, i, a) => a.indexOf(v) === i).join(',');
          log('PIN ' + nm + ' | id=' + mu.id + ' | straightTypes=' + st);
        }
        const specs = (mus || []).filter(x => x.type === 'special' && x.parentId === mu.id);
        const odd = specs.filter(s => (s.participants || []).length === 9 ||
          (s.participants || []).some(p => /[\/]/.test(p.name || '')));
        if (odd.length) {
          for (const s of odd.slice(0, 3)) {
            log('PIN spec ' + s.id + ' | Teilnehmer: ' +
              (s.participants || []).map(p => p.id + '=' + p.name).join(' | '));
          const spr = await pinT('/matchups/' + s.id + '/markets/straight');
            if (spr && spr.length) {
              spr.forEach(m => log('PIN spec ' + s.id + ' | type=' + m.type +
                ' | ' + (m.prices || []).map(p => String(p.designation ||
                  'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' ')));
            } else {
              log('PIN spec ' + s.id + ': keine straight-Maerkte');
            }
          }
        }
        const hf = (Array.isArray(pr) ? pr : []).concat(Array.isArray(rel) ? rel : [])
          .filter(m => !m || String(m.matchupId) === String(mu.id))
          .filter(m => /half|full/i.test(String(m.type || '')));
        hf.forEach(m => log('PIN ' + nm + ' | type=' + m.type + ' period=' + (m.period || 0) +
          ' | ' + (m.prices || []).map(p => String(p.designation ||
            'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
        if (!hf.length) log('PIN ' + nm + ': kein half/full-Markt (straight+related)');
      }
    }
  };

  // ---------- Konsole-Helper: Win-to-Nil-Marktstruktur (PIN + BF) zeigen ----------
  const bfCompId = async comp => {
    if (/^COMP:\d+$/i.test(String(comp))) return String(comp);
    if (/^\d+$/.test(String(comp)) && LEAGUES[comp]) return LEAGUES[comp];
    const parts = String(comp).split(' - ').map(clean).filter(Boolean);
    const queries = parts.length > 1
      ? [parts[0] + ' ' + parts[1], parts[1], parts[0]]
      : [parts[0] || String(comp)];
    for (const q of queries) {
      if (String(q).length < 3) continue;
      const hits = await bfSearch(q).catch(() => []);
      if (hits.length) return 'COMP:' + hits[0].cid;
    }
    return null;
  };
  unsafeWindow.__w2nprobe = async (comp, pinLid) => {
    const log = devlog;
    const pinT = (path, ms) => Promise.race(
      [pinGet(path).catch(() => null), sleep(ms || 5000).then(() => null)]);
    const node = await bfCompId(comp);
    if (!node) return log('BF: keine COMP-Id gefunden fuer "' + comp + '"');
    const j = await bfProbeDump(node,
      /win ?to ?nil|clean ?sheet/i, 'BF Win-to-Nil/Clean-Sheet-Maerkte', log);
    if (!j) log('BF: keine Daten fuer ' + node);
    if (pinLid) {
      const mus = await pinT('/leagues/' + pinLid + '/matchups');
      if (!mus || !mus.length) return log('PIN: keine Matchups fuer ' + pinLid);
      const mains = (mus || []).filter(x => x.type === 'matchup' && !x.parentId);
      log('PIN ' + pinLid + ': ' + mains.length + ' Haupt-Matchups');
      for (const mu of mains.slice(0, 6)) {
        const nm = (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + mu.id);
        log('  straight-FETCH ' + mu.id + ' ...');
        const pr = await pinT('/matchups/' + mu.id + '/markets/straight');
        if (!Array.isArray(pr)) continue;
        const st = pr.map(m => String(m.type || ''))
          .filter((v, i, a) => a.indexOf(v) === i).join(',');
        log('PIN ' + nm + ' | id=' + mu.id + ' | straightTypes=' + st);
        pr.filter(m => /nil|clean ?sheet|shutout/i.test(String(m.type || '')))
          .forEach(m => log('  NIL type=' + m.type + ' period=' + (m.period || 0) +
            ' | ' + (m.prices || []).map(p => String(p.designation ||
              'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' ')));
      }
      let shown = 0;
      const allNames = {};
      for (const mu of mains) {
        const specs = (mus || []).filter(x => x.type === 'special' && x.parentId === mu.id);
        for (const s of specs) allNames[String(s.name || '')] = (allNames[String(s.name || '')] || 0) + 1;
        const w2n = specs.filter(s => /win ?to ?nil|clean ?sheet|\bnil\b/i.test(String(s.name || '')) ||
          (s.participants || []).some(p => /win ?to ?nil|clean ?sheet|\bnil\b/i.test(p.name || '')));
        if (!w2n.length) continue;
        const nm = (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + mu.id);
        for (const s of w2n) {
          log('PIN ' + nm + ' | spec ' + s.id + ' | name="' + s.name + '" | Teilnehmer: ' +
            (s.participants || []).map(p => p.id + '=' + p.name).join(' | '));
          const spr = await pinGet('/matchups/' + s.id + '/markets/straight').catch(() => null);
          if (spr && spr.length) {
            spr.forEach(m => log('  type=' + m.type + ' period=' + (m.period || 0) +
              ' | ' + (m.prices || []).map(p => String(p.designation ||
                'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' ')));
          } else {
            log('  keine straight-Maerkte');
          }
          if (++shown >= 8) break;
        }
        if (shown >= 8) break;
      }
      const uniq = Object.keys(allNames).filter(Boolean).sort();
      log('PIN ' + pinLid + ' alle Special-Namen (' + uniq.length + '): ' +
        uniq.slice(0, 40).join(' | ') + (uniq.length > 40 ? ' | ...' : ''));
      const typeCount = {};
      for (const x of mus) typeCount[x.type || '?'] = (typeCount[x.type || '?'] || 0) + 1;
      const specRows = mus.filter(x => x.type === 'special');
      log('PIN diag: mus=' + mus.length + ' types=' + JSON.stringify(typeCount) +
        ' specials=' + specRows.length);
      if (specRows.length) {
        const s0 = specRows[0];
        log('  RAW spec[0] keys: ' + Object.keys(s0).join(','));
        const cats = {};
        const descs = {};
        for (const s of specRows) {
          cats[String((s.special && s.special.category) || '?')] = 1;
          const d = String((s.special && s.special.description) || '');
          descs[d] = (descs[d] || 0) + 1;
        }
        log('  PIN Special-Kategorien: ' + Object.keys(cats).join(', '));
        const duniq = Object.keys(descs).filter(Boolean).sort();
        log('  PIN Special-Beschreibungen (' + duniq.length + '): ' +
          duniq.slice(0, 60).join(' | ') + (duniq.length > 60 ? ' | ...' : ''));
        let hits = 0, fetched = 0;
        for (const mu of mains.slice(0, 6)) {
          const nm = (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + mu.id);
          const specs = specRows.filter(s => s.parentId === mu.id);
          for (const s of specs.slice(0, 6)) {
            const spr = await pinT('/matchups/' + s.id + '/markets/straight');
            fetched++;
            if (!Array.isArray(spr) || !spr.length) continue;
            const line = (spr || []).map(m => String(m.name || m.type || '?') + ':p' +
              (m.period || 0) + '[' + (m.prices || []).map(p =>
                String(p.designation || 'p' + (p.participantId ?? p.id)) + '=' + p.price)
                .join(' ') + ']').join(' ;; ');
            const isW2n = /win ?to ?nil|clean ?sheet/i.test(
              String((s.special && s.special.description) || '') + ' ' + line);
            if (isW2n) hits++;
            log((isW2n ? 'W2N! ' : '     ') + nm + ' | spec ' + s.id + ' | ' +
              (s.special ? (s.special.category || '?') + ' | ' + (s.special.description || '?')
                : '?') + ' | Teiln: ' +
              (s.participants || []).map(p => p.name).join('/') + ' | ' +
              line.slice(0, 300));
          }
        }
        log('SPECIALS straight geprueft: ' + fetched + ' | W2N-Treffer: ' + hits);
      }
      if (!shown)
        log('PIN ' + pinLid + ': keine Win-to-Nil-Specials (' + mains.length +
          ' Spiele geprueft)');
    }
    log('PROBE FERTIG');
  };

  // ---------- Konsole-Helper: UFC "Fight Goes To Decision" <-> "Go The Distance" ----------
  // Zeigt beide Seiten fuer den FD-Kanal:
  //   BF-Seite:  alle Marktnamen der COMP + Runner des "Go The Distance"-Markts
  //              (back UND lay je Runner).
  //   PIN-Seite: alle Moneyline-Maerkte mit period!=0 (Typ/Name/Period/Preise),
  //              damit man sieht, wie "Fight Goes To Decision" ausgeliefert wird.
  // Aufruf: __fdprobe(comp)  oder  __fdprobe(comp, pinLid)
  unsafeWindow.__fdprobe = async (comp, pinLid) => {
    const log = devlog;
    const pinT = (path, ms) => Promise.race(
      [pinGet(path).catch(() => null), sleep(ms || 5000).then(() => null)]);
    const node = await bfCompId(comp);
    if (!node) return log('BF: keine COMP-Id gefunden fuer "' + comp + '"');
    const j = await bfProbeDump(node, /go(es)? (to )?(the )?distance/i,
      'BF Go-The-Distance-Maerkte', log);
    if (!j) log('BF: keine Daten fuer ' + node);
    if (pinLid) {
      const mus = await pinT('/leagues/' + pinLid + '/matchups');
      if (!mus || !mus.length) return log('PIN: keine Matchups fuer ' + pinLid);
      const mains = (mus || []).filter(x => x.type === 'matchup' && !x.parentId);
      const specs = (mus || []).filter(s => s.type === 'special' && s.parentId);
      log('PIN ' + pinLid + ': ' + mains.length + ' Haupt-Matchups, ' +
        specs.length + ' Specials');
      const fdSpecs = specs.filter(s => /fight goes to decision|go(es)? (to )?(the )?distance/i
        .test(String((s.special && s.special.description) || s.name || '')));
      log('FD-Specials: ' + fdSpecs.length);
      for (const s of fdSpecs.slice(0, 8)) {
        const nm = ((mains.find(m => m.id === s.parentId) || {}).participants || [])
          .map(p => p.name).join(' v ') || ('parent=' + s.parentId);
        const spr = await pinT('/matchups/' + s.id + '/markets/straight');
        const px = {};
        for (const mkt of (Array.isArray(spr) ? spr : []))
          for (const p of (mkt.prices || []))
            if (typeof p.price === 'number') px[p.participantId ?? p.id] = p.price;
        log('  FD spec ' + s.id + ' | ' + nm + ' | desc="' +
          String((s.special && s.special.description) || s.name || '') + '"');
        (s.participants || []).forEach(p => log('    Teiln ' + p.name +
          ' (id=' + p.id + ') -> Preis ' + (px[p.id] != null ? px[p.id] : '-')));
      }
    }
    log('PROBE FERTIG');
  };

  // ---------- Konsole-Helper: Torschuetzen-Marktstruktur (PIN + BF) ----------
  // Analog __w2nprobe: zeigt, OB und WIE der Torschuetzenmarkt aktuell auf beiden
  // Seiten existiert, bevor ein Arb-Scan ihn anbindet.
  //   BF-Seite:  alle Marktnamen der COMP + Runner der Goalscorer-Maerkte.
  //   PIN-Seite: Specials/Matchups, deren Name/Straight-Typ auf Torschuetzen
  //              hindeutet ("goalscorer", "to score", ...).
  // Aufruf: __gsprobe(comp)  oder  __gsprobe(comp, pinLid)
  unsafeWindow.__gsprobe = async (comp, pinLid) => {
    const log = devlog;
    const pinT = (path, ms) => Promise.race(
      [pinGet(path).catch(() => null), sleep(ms || 5000).then(() => null)]);
    const GS_RE = /scorer|to ?score|hat.?trick|goal scorer/i;
    const node = await bfCompId(comp);
    if (!node) return log('BF: keine COMP-Id gefunden fuer "' + comp + '"');
    const j = await bfProbeDump(node, GS_RE, 'BF Torschuetzen-Maerkte', log);
    if (!j) log('BF: keine Daten fuer ' + node);
    if (pinLid) {
      const mus = await pinT('/leagues/' + pinLid + '/matchups');
      if (!mus || !mus.length) return log('PIN: keine Matchups fuer ' + pinLid);
      const mains = (mus || []).filter(x => x.type === 'matchup' && !x.parentId);
      log('PIN ' + pinLid + ': ' + mains.length + ' Haupt-Matchups');
      const uniq = {};
      const descs = {};
      const specRows = mus.filter(x => x.type === 'special');
      for (const s of specRows) {
        uniq[String(s.name || '')] = 1;
        descs[String((s.special && s.special.description) || '')] = 1;
      }
      const uNames = Object.keys(uniq).filter(Boolean).sort();
      const uDescs = Object.keys(descs).filter(Boolean).sort();
      log('PIN alle Special-Namen (' + uNames.length + '): ' +
        uNames.slice(0, 50).join(' | ') + (uNames.length > 50 ? ' | ...' : ''));
      log('PIN alle Special-Beschreibungen (' + uDescs.length + '): ' +
        uDescs.slice(0, 40).join(' | ') + (uDescs.length > 40 ? ' | ...' : ''));
      let shown = 0, fetched = 0;
      for (const mu of mains) {
        const nm = (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + mu.id);
        const pr = await pinT('/matchups/' + mu.id + '/markets/straight');
        if (Array.isArray(pr) && pr.length) {
          const st = [...new Set(pr.map(m => String(m.type || '')))];
          const gs = pr.filter(m => GS_RE.test(String(m.type || '') + ' ' +
            String(m.name || '') + ' ' + String((m.special && (m.special.name || m.special.description)) || '')));
          if (gs.length) {
            log('PIN ' + nm + ' | id=' + mu.id + ' | straightTypes=' + st.join(','));
            gs.forEach(m => log('  GS type=' + m.type + ' period=' + (m.period || 0) +
              ' | ' + (m.prices || []).slice(0, 12).map(p => String(p.designation ||
                'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
            if (++shown >= 8) break;
          }
        }
        const specs = specRows.filter(s => s.parentId === mu.id);
        for (const s of specs) {
          const desc = String((s.special && s.special.description) || '') + ' ' + String(s.name || '');
          if (!GS_RE.test(desc)) continue;
          const spr = await pinT('/matchups/' + s.id + '/markets/straight');
          fetched++;
          log('PIN GS-Special ' + nm + ' | spec ' + s.id + ' | "' + desc.trim() + '" | Teiln: ' +
            (s.participants || []).map(p => p.name).join(' / '));
          if (Array.isArray(spr) && spr.length)
            spr.slice(0, 6).forEach(m => log('  type=' + m.type + ' period=' + (m.period || 0) +
              ' | ' + (m.prices || []).slice(0, 12).map(p => String(p.designation ||
                'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
          else log('  keine straight-Maerkte');
          if (++shown >= 8) break;
        }
        if (shown >= 8) break;
      }
      log('PIN GS: Specials geprueft=' + fetched + ' Treffer/Output=' + shown);
      if (!shown) log('PIN ' + pinLid + ': keine Torschuetzen-Specials in den ersten Maerken');
    }
    log('PROBE FERTIG');
  };

  // ---------- Konsole-Helper: Penalty-taken-Marktstruktur (PIN + BF) ----------
  // Analog __gsprobe: zeigt, OB und WIE der "Penalty taken"-Markt aktuell auf
  // beiden Seiten existiert, bevor ein Arb-Scan ihn anbindet.
  //   BF-Seite:  alle Marktnamen der COMP + Runner der Penalty-Maerkte.
  //   PIN-Seite: Specials/Matchups, deren Name/Straight-Typ auf Penalty
  //              hindeutet ("penalty", "spot kick", ...).
  // Aufruf: __pprobe(comp)  oder  __pprobe(comp, pinLid)
  unsafeWindow.__pprobe = async (comp, pinLid) => {
    const log = devlog;
    const pinT = (path, ms) => Promise.race(
      [pinGet(path).catch(() => null), sleep(ms || 5000).then(() => null)]);
    const PP_RE = /penalt|spot ?kick/i;
    const node = await bfCompId(comp);
    if (!node) return log('BF: keine COMP-Id gefunden fuer "' + comp + '"');
    const j = await bfProbeDump(node, PP_RE, 'BF Penalty-Maerkte', log);
    if (!j) log('BF: keine Daten fuer ' + node);
    if (pinLid) {
      const mus = await pinT('/leagues/' + pinLid + '/matchups');
      if (!mus || !mus.length) return log('PIN: keine Matchups fuer ' + pinLid);
      const mains = (mus || []).filter(x => x.type === 'matchup' && !x.parentId);
      log('PIN ' + pinLid + ': ' + mains.length + ' Haupt-Matchups');
      const uniq = {};
      const descs = {};
      const specRows = mus.filter(x => x.type === 'special');
      for (const s of specRows) {
        uniq[String(s.name || '')] = 1;
        descs[String((s.special && s.special.description) || '')] = 1;
      }
      const uNames = Object.keys(uniq).filter(Boolean).sort();
      const uDescs = Object.keys(descs).filter(Boolean).sort();
      log('PIN alle Special-Namen (' + uNames.length + '): ' +
        uNames.slice(0, 50).join(' | ') + (uNames.length > 50 ? ' | ...' : ''));
      log('PIN alle Special-Beschreibungen (' + uDescs.length + '): ' +
        uDescs.slice(0, 40).join(' | ') + (uDescs.length > 40 ? ' | ...' : ''));
      let shown = 0, fetched = 0;
      for (const mu of mains) {
        const nm = (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + mu.id);
        const pr = await pinT('/matchups/' + mu.id + '/markets/straight');
        if (Array.isArray(pr) && pr.length) {
          const st = [...new Set(pr.map(m => String(m.type || '')))];
          const pp = pr.filter(m => PP_RE.test(String(m.type || '') + ' ' +
            String(m.name || '') + ' ' + String((m.special && (m.special.name || m.special.description)) || '')));
          if (pp.length) {
            log('PIN ' + nm + ' | id=' + mu.id + ' | straightTypes=' + st.join(','));
            pp.forEach(m => log('  PP type=' + m.type + ' period=' + (m.period || 0) +
              ' | ' + (m.prices || []).slice(0, 12).map(p => String(p.designation ||
                'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
            if (++shown >= 8) break;
          }
        }
        const specs = specRows.filter(s => s.parentId === mu.id);
        for (const s of specs) {
          const desc = String((s.special && s.special.description) || '') + ' ' + String(s.name || '');
          if (!PP_RE.test(desc)) continue;
          const spr = await pinT('/matchups/' + s.id + '/markets/straight');
          fetched++;
          log('PIN PP-Special ' + nm + ' | spec ' + s.id + ' | "' + desc.trim() + '" | Teiln: ' +
            (s.participants || []).map(p => p.name).join(' / '));
          if (Array.isArray(spr) && spr.length)
            spr.slice(0, 6).forEach(m => log('  type=' + m.type + ' period=' + (m.period || 0) +
              ' | ' + (m.prices || []).slice(0, 12).map(p => String(p.designation ||
                'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
          else log('  keine straight-Maerkte');
          if (++shown >= 8) break;
        }
        if (shown >= 8) break;
      }
      log('PIN PP: Specials geprueft=' + fetched + ' Treffer/Output=' + shown);
      if (!shown) log('PIN ' + pinLid + ': keine Penalty-Specials in den ersten Maerken');
    }
    log('PROBE FERTIG');
  };

  // ---------- Konsole-Helper: Result + O/U 2.5 Kombi-Marktstruktur (PIN + BF) ----------
  // Analog __w2nprobe/__hfprobe: fuer die neue Wettart "Team/Draw + Over/Under X" wird die
  // echte Struktur von PIN-Special und BF-Markt ausgegeben, bevor der Arb-Scan sie nutzt.
  // BF-Seite: alle Marktnamen + Runner der getroffenen Kombi-Maerkte ("... & Over/Under ...").
  // PIN-Seite: Specials, deren Teilnehmer Over/Under-Kombinationen mit Team/Draw sind.
  unsafeWindow.__oucombo = async (comp, pinLid) => {
    const log = devlog;
    const pinT = (path, ms) => Promise.race(
      [pinGet(path).catch(() => null), sleep(ms || 5000).then(() => null)]);
    if (comp) {
      const node = await bfCompId(comp);
      if (!node) return log('BF: keine COMP-Id gefunden fuer "' + comp + '"');
      // BF-Seite: Marktnamen auflisten + Kombi-Maerkte mit Runner-Dump
      const namesRe = /over\/under|total goals/i;
      const j = await bfLeagueMarkets(node);
      if (j && j.nodes && j.nodes.length) {
        const mname = bfMktName;
        const names = [...new Set(j.nodes.filter(n => n.nodeType === 'MARKET')
          .map(mname))].filter(Boolean);
        log('BF Marktnamen ' + node + ':\n' + names.join('\n'));
        const mkts = j.nodes.filter(n => n.nodeType === 'MARKET' &&
          namesRe.test(mname(n)));
        const comb = mkts.filter(m => /over\/under.*(1x2|result|match|odds|&|0-0|winner)|(result|match|1x2|win|draw|and|&).*(over\/under)/i.test(mname(m)));
        log('BF Kombi-Maerkte (Result+O/U): ' + comb.length +
          (comb.length ? ' | ' + [...new Set(comb.map(m => mname(m)))].join(' | ') : ''));
        if (comb.length) {
          const bms = await bfFetchChunks(bfChunkIds(comb));
          bfEachMarket(bms, (mk, e) =>
            log('Markt ' + mk.marketId + ' | ' + (e.eventName || '?') + ' | Runner: ' +
              (mk.runners || []).map(r =>
                (r.description && r.description.runnerName) +
                ' lay=' + (r.exchange && r.exchange.availableToLay &&
                  r.exchange.availableToLay[0] ? r.exchange.availableToLay[0].price : '-'))
                .join(' | ')));
        }
      } else {
        log('BF: keine Daten fuer ' + node);
      }
    } else {
      log('BF: COMP leer — nur PIN-Seite wird geprueft.');
    }
    if (pinLid) {
      if (/^\d{10,}$/.test(String(pinLid))) {
        const mu = await pinT('/matchups/' + pinLid);
        const nm = mu && (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + pinLid);
        const isM = m => m && String(m.matchupId) === String(pinLid);
        const pr = await pinT('/matchups/' + pinLid + '/markets/straight');
        const rel = await pinT('/matchups/' + pinLid + '/markets/related');
        const all = (Array.isArray(pr) ? pr : []).concat(Array.isArray(rel) ? rel : []);
        const own = all.filter(isM);
        const types = own.map(m => String(m.type || '?'))
          .filter((v, i, a) => a.indexOf(v) === i).join(',');
        log('PIN ' + nm + ' | matchupKey=' + (mu ? Object.keys(mu).join(',') : '-'));
        log('PIN ' + nm + ' | ALLE straight+related Typen: ' + (types || 'keine'));
        // Kandidaten: alle Maerkte deren Preise mehrere Teilnehmer / Kombi-Charakter haben
        own.filter(m => /^[a-z_0-9]*result[a-z_0-9]*$/i.test(String(m.type || '')) ||
          /over|under|total|&/i.test(String(m.type || '') + ' ' +
            (m.prices || []).map(p => String(p.designation || 'p' + (p.participantId ?? p.id))).join(' ')))
          .forEach(m => log('PIN ' + nm + ' | type=' + m.type + ' period=' + (m.period || 0) +
            (m.line != null ? ' line=' + m.line : '') +
            ' | ' + (m.prices || []).map(p => String(p.designation ||
              'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
        // Specials des Spiels aus der Liga suchen (Parameter-Herkunft)
        const league = mu && mu.league;
        if (league || mu) {
          const lid = league ? league.id : null;
          if (lid) {
            const mus = await pinT('/leagues/' + lid + '/matchups');
            const specRows = Array.isArray(mus) ? mus.filter(x => x.type === 'special' &&
              String(x.parentId) === String(pinLid)) : [];
            log('PIN Specials fuer ' + nm + ': ' + specRows.length);
            // Nur Kombi-Specials (Teilnehmer "X & Over/Under Y") anzeigen + Preise
            const isOuComboSpec = s => (s.participants || []).some(p =>
              /&\s*(over|under)\s*\d/i.test(p.name || ''));
            const combSpecs = specRows.filter(isOuComboSpec);
            log('  davon O/U-Kombi-Specials: ' + combSpecs.length);
            for (const s of combSpecs.slice(0, 10)) {
              log('  spec ' + s.id + ' | name="' + s.name + '" | Kategorie: ' +
                (s.special && s.special.category || '?') + ' | Teilnehmer: ' +
                (s.participants || []).map(p => p.id + '=' + p.name).join(' | '));
              const spr = await pinT('/matchups/' + s.id + '/markets/straight');
              if (Array.isArray(spr) && spr.length) {
                spr.forEach(m => log('    type=' + m.type + ' period=' + (m.period || 0) +
                  ' | ' + (m.prices || []).map(p => String(p.designation ||
                    'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
              } else {
                log('    keine straight-Maerkte');
              }
            }
            if (!combSpecs.length)
              log('  (keine O/U-Kombi-Specials — pruefe alle 45: ' +
                specRows.map(s => (s.participants || []).map(p => p.name).join(' / ').slice(0, 60))
                  .join(' ;; ') + ')');
          }
        }
      } else {
        const mus = await pinT('/leagues/' + pinLid + '/matchups');
        if (!mus || !mus.length) return log('PIN: keine Matchups fuer ' + pinLid);
        const mains = (mus || []).filter(x => x.type === 'matchup' && !x.parentId);
        log('PIN ' + pinLid + ': ' + mains.length + ' Haupt-Matchups');
        const specRows = (mus || []).filter(x => x.type === 'special');
        const cats = {};
        for (const s of specRows) cats[String((s.special && s.special.category) || '?')] = 1;
        log('PIN Special-Kategorien: ' + Object.keys(cats).join(', '));
        let shown = 0;
        for (const mu of mains.slice(0, 8)) {
          const nm = (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + mu.id);
          const specs = specRows.filter(s => s.parentId === mu.id);
          for (const s of specs) {
            const ps = s.participants || [];
            const hasTp = ps.some(p => /^(over|under)\s\d/.test(p.name || '')) &&
              ps.some(p => /^(home|away|draw|tie)$/i.test(p.name || '') ||
                (mu.participants || []).some(t => teamMatch(t.name, p.name || '')));
            if (!hasTp) continue;
            log('PIN ' + nm + ' | spec ' + s.id + ' | name="' + s.name + '" | Kategorie: ' +
              (s.special && s.special.category || '?') + ' | Teilnehmer: ' +
              ps.map(p => p.id + '=' + p.name).join(' | '));
            const spr = await pinGet('/matchups/' + s.id + '/markets/straight').catch(() => null);
            if (spr && spr.length) {
              spr.forEach(m => log('  type=' + m.type + ' period=' + (m.period || 0) +
                ' | ' + (m.prices || []).map(p => String(p.designation ||
                  'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
            } else {
              log('  keine straight-Maerkte');
            }
            if (++shown >= 10) break;
          }
          if (shown >= 10) break;
        }
        if (!shown)
          log('PIN ' + pinLid + ': keine O/U-Kombi-Specials im Mix geprueft');
      }
    }
    log('PROBE FERTIG');
  };

  // ---------- Konsole-Helper: Odd/Even-Marktstruktur (Total Goals Odd/Even, PIN + BF) ----------
  // Debug-Tool fuer die Odd/Even-Wettart: BF-Marktnamen + Runner (Odd/Even) und PIN-
  // Straight-Maerkte mit odd/even-Designations werden angezeigt, bevor der Scan sie nutzt.
  unsafeWindow.__oeprobe = async (comp, pinLid) => {
    const log = devlog;
    const pinT = (path, ms) => Promise.race(
      [pinGet(path).catch(() => null), sleep(ms || 5000).then(() => null)]);
    if (comp) {
      const node = await bfCompId(comp);
      if (!node) return log('BF: keine COMP-Id gefunden fuer "' + comp + '"');
      const j = await bfLeagueMarkets(node);
      if (j && j.nodes && j.nodes.length) {
        const mname = bfMktName;
        const names = [...new Set(j.nodes.filter(n => n.nodeType === 'MARKET')
          .map(mname))].filter(Boolean);
        log('BF Marktnamen ' + node + ':\n' + names.join('\n'));
        const mkts = j.nodes.filter(n => n.nodeType === 'MARKET' &&
          /odd|even/i.test(mname(n)));
        const oeMkts = mkts.filter(m => /^total goals odd\/even$/i.test(mname(m)));
        log('BF Odd/Even-Maerkte: ' + oeMkts.length +
          (oeMkts.length ? ' | ' + [...new Set(oeMkts.map(m => mname(m)))].join(' | ') : ''));
        if (oeMkts.length) {
          const bms = await bfFetchChunks(bfChunkIds(oeMkts));
          bfEachMarket(bms, (mk, e) =>
            log('Markt ' + mk.marketId + ' | ' + (e.eventName || '?') + ' | Runner: ' +
              (mk.runners || []).map(r =>
                (r.description && r.description.runnerName) +
                ' lay=' + (r.exchange && r.exchange.availableToLay &&
                  r.exchange.availableToLay[0] ? r.exchange.availableToLay[0].price : '-') +
                ' back=' + (r.exchange && r.exchange.availableToBack &&
                  r.exchange.availableToBack[0] ? r.exchange.availableToBack[0].price : '-'))
                .join(' | ')));
        }
      } else {
        log('BF: keine Daten fuer ' + node);
      }
    } else {
      log('BF: COMP leer — nur PIN-Seite wird geprueft.');
    }
    if (pinLid) {
      if (/^\d{10,}$/.test(String(pinLid))) {
        const mu = await pinT('/matchups/' + pinLid);
        const nm = mu && (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + pinLid);
        const pr = await pinT('/matchups/' + pinLid + '/markets/straight');
        const rel = await pinT('/matchups/' + pinLid + '/markets/related');
        const own = (Array.isArray(pr) ? pr : []).filter(m => m &&
          String(m.matchupId) === String(pinLid));
        const ownRel = (Array.isArray(rel) ? rel : []).filter(m => m &&
          String(m.matchupId) === String(pinLid));
        log('PIN ' + nm + ' | straight=' + own.length + ' related=' + ownRel.length + ' Maerkte');
        const types = own.map(m => String(m.type || '?'))
          .filter((v, i, a) => a.indexOf(v) === i).join(',');
        log('PIN ' + nm + ' | ALLE straight Typen: ' + (types || 'keine'));
        own.concat(ownRel).forEach(m => log('PIN ' + nm + ' | type=' + m.type +
          ' period=' + (m.period || 0) + ' desc="' + (m.marketName || m.name || '') + '" | ' +
          (m.prices || []).map(p => String(p.designation ||
            'p' + (p.participantId ?? p.id)) + '=' + p.price).join(' | ')));
        const oe = pinOdd(own.concat(ownRel));
        log('PIN ' + nm + ' | pinOdd => ' +
          (oe ? 'Odd ' + oe.odd.toFixed(2) + ' / Even ' + oe.even.toFixed(2) : 'kein Odd/Even-Markt'));
        const league = mu && mu.league;
        if (league && (league.id || league.leagueId)) {
          const lidNum = league.id || league.leagueId;
          const musL = await pinT('/leagues/' + lidNum + '/matchups');
          const specRows = (Array.isArray(musL) ? musL : [])
            .filter(x => x.type === 'special' && String(x.parentId) === String(pinLid))
            .filter(s => /odd|even|yes|no/i.test(String(s.name || '') + ' ' +
              ((s.special && s.special.description) || '')));
          log('PIN ' + nm + ' | Specs (odd/even/yes/no): ' + specRows.length);
          for (const s of specRows.slice(0, 12)) {
            const ps = s.participants || [];
            log('  spec ' + s.id + ' | "' + (s.name || '') + '" | desc="' +
              ((s.special && s.special.description) || '') + '" | ' +
              ps.map(p => p.id + '=' + p.name).join(' | '));
            if (ps.length === 2 && ps.some(p => p.name === 'Yes') && ps.some(p => p.name === 'No')) {
              const spr = await pinT('/matchups/' + s.id + '/markets/straight');
              if (spr) {
                const priceById = {};
                for (const mkt of spr) for (const p of (mkt.prices || [])) {
                  if (typeof p.price === 'number') priceById[p.participantId ?? p.id] = p.price;
                }
                const yesId = ps.find(p => p.name === 'Yes').id;
                const noId = ps.find(p => p.name === 'No').id;
                log('    -> Yes=' + (priceById[yesId] ?? '-') + ' No=' + (priceById[noId] ?? '-'));
              } else {
                log('    -> keine straight-Preise');
              }
            }
            if (ps.length === 2 && ps.some(p => p.name === 'Odd') && ps.some(p => p.name === 'Even')) {
              const spr = await pinT('/matchups/' + s.id + '/markets/straight');
              if (spr) {
                const priceById = {};
                for (const mkt of spr) for (const p of (mkt.prices || [])) {
                  if (typeof p.price === 'number') priceById[p.participantId ?? p.id] = p.price;
                }
                const oddId = ps.find(p => p.name === 'Odd').id;
                const evenId = ps.find(p => p.name === 'Even').id;
                log('    -> Odd=' + (priceById[oddId] ?? '-') + ' Even=' + (priceById[evenId] ?? '-'));
              } else {
                log('    -> keine straight-Preise');
              }
            }
          }
        } else {
          log('PIN ' + nm + ' | Spec-Scan uebersprungen (keine Liga-Info im matchup)');
        }
      } else {
        log('PIN: bitte eine Matchup-ID (10-stellig) angeben.');
      }
    }
    log('PROBE FERTIG');
  };

  // ---------- Konsole-Helper: Spiele per Teamname suchen + half/full pruefen ----------
  unsafeWindow.__hffind = async (kw) => {
    const log = devlog;
    const toks = String(kw || '').split(/\s+/).filter(Boolean);
    if (!toks.length) return log('__hffind: Suchbegriff(e) angeben, z.B. __hffind("Oslo Kristiansund")');
    const rx = toks.map(t => new RegExp(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    const leagues = await pinGet('/sports/29/leagues').catch(() => null);
    if (!leagues || !leagues.length) return log('keine Ligen geladen');
    log('Pruefe ' + leagues.length + ' Ligen ...');
    const results = await pool(leagues, async L => {
      const mus = await pinGet('/leagues/' + L.id + '/matchups').catch(() => null);
      if (!mus || !mus.length) return null;
      const mains = mus.filter(x => x.type === 'matchup' && !x.parentId);
      const hit = mains.filter(m => {
        const names = (m.participants || []).map(p => p.name || '');
        return rx.every(r => names.some(n => r.test(n)));
      });
      if (!hit.length) return null;
      return { L, hit };
    }, 10);
    let n = 0;
    for (const r of results) {
      if (!r) continue;
      const rel = await pinGet('/leagues/' + r.L.id + '/markets/related').catch(() => null);
      for (const m of r.hit) {
        n++;
        const nm = (m.participants || []).map(p => p.name).join(' v ');
        const pr = await pinGet('/matchups/' + m.id + '/markets/straight').catch(() => null);
        const st = (pr || []).map(x => String(x.type || ''))
          .filter((v, i, a) => a.indexOf(v) === i).join(',');
        const hf = (pr || []).concat(Array.isArray(rel) ? rel : [])
          .filter(x => !x || String(x.matchupId) === String(m.id))
          .filter(x => /half|full/i.test(String(x.type || '')));
        log('FUND: Liga ' + r.L.id + ' (' + r.L.name + ') | ' + nm + ' | id=' + m.id +
          ' | straight=' + st +
          (hf.length ? ' | half/full: ' + hf.map(x => x.type + ' p' + (x.period || 0) + ' [' +
            (x.prices || []).map(p => String(p.designation || '?') + '=' + p.price)
              .join(' ')).join(' ; ')
            : ' | KEIN half/full'));
      }
    }
    log('Fertig: ' + n + ' Treffer');
  };

  // ---------- Konsole-Helper: BF-Navigationsbaum inspizieren ----------
  unsafeWindow.__bfnav = async (bfSid, like) => {
    const log = devlog;
    const sid = Number(bfSid || 1);
    const groups = await bfNavGroups(sid).catch(() => []);
    log('Sport-Nav ' + sid + ': ' + groups.length + ' Gruppen');
    for (const g of groups.slice(0, 60)) log('  GRUPPE ' + g.id + ' | ' + g.name);
    if (groups.length > 60) log('  ... (' + (groups.length - 60) + ' weitere)');
    const likeWords = String(like || 'south africa').toLowerCase().split(/\s+/)
      .filter(w => w.length >= 3);
    const comps = await bfNavComps(sid, likeWords).catch(() => []);
    log('COMPs fuer [' + likeWords.join(' ') + ']: ' + comps.length);
    for (const c of comps.slice(0, 25)) log('  COMP:' + c.cid + ' | ' +
      (c.raw && c.raw.label));
    // Roh-Antworten der Wurzel (Diagnose, wenn 0 Gruppen)
    for (const [id, att, dist, mr] of [['EVENT_TYPE:' + sid, 'MENU', 1, 500],
      ['EVENT_TYPE:' + sid, 'MENU,SPORT', 1, 500], ['SPORT:' + sid, 'MENU', 1, 500]]) {
      let body = 'n/a';
      try {
        const r = await fetch('https://www.betfair.com/www/sports/navigation/v2/graph/bynode?' +
          bfQ({ nodeIds: id, attachments: att, maxOutDistance: dist, maxResults: mr }));
        const t = await r.text();
        body = t.slice(0, 200).replace(/\s+/g, ' ');
        log('RAW ' + id + ' + ' + att + ': HTTP ' + r.status + ' | ' + body);
      } catch (e) { log('RAW ' + id + ' + ' + att + ': EX ' + e.message); }
      await sleep(120);
    }
    const sub = await bfBynode('EVENT_TYPE:' + sid, 'MENU', 2, 2000).catch(() => null);
    if (sub && (sub.nodes || []).length) {
      log('RAW dist2: ' + sub.nodes.length + ' Knoten, erste 10: ' +
        sub.nodes.slice(0, 10).map(n => n.nodeType + ' ' + (n.nodeId || n.id) +
          ' "' + (n.name || '') + '"').join(' | '));
    }
  };

  // ---------- Konsole-Helper: Live/InPlay-Erkennung pruefen ----------
  // __pinlive([lid]) -> zeigt fuer alle Matchups der Pinnacle-Liga die live-
  // relevanten Felder (isLive, state, score, startTime, evtl. live/period-keys)
  unsafeWindow.__pinlive = async (lid, limit) => {
    const log = devlog;
    const mus = await pinGet('/leagues/' + (lid || 30) + '/matchups').catch(() => null);
    if (!mus || !mus.length) return log('keine Matchups fuer Liga ' + lid);
    const mains = mus.filter(m => m.type === 'matchup' && !m.parentId);
    log('PIN live-Liga ' + lid + ': ' + mus.length + ' Eintraege, ' + mains.length +
      ' Spiele | keys[0]: ' + Object.keys(mains[0] || {}).join(','));
    for (const m of mains.slice(0, limit || 12)) {
      const st = m.state || {};
      const liveKeys = Object.keys(m).filter(k => /live|play|status|period|time/i.test(k));
      log('  "' + (m.participants || []).map(p => p.name).join(' v ') + '"' +
        ' | liveKeys=' + (liveKeys.join(',') || '-') +
        ' | isLive=' + JSON.stringify(m.isLive) +
        ' | state=' + JSON.stringify(st) +
        ' | score=' + (scoreOf(m) || '-') +
        ' | start=' + (m.startTime || '-'));
      await sleep(60);
    }
    log('Fertig: ' + mains.length + ' Spiele geprueft');
  };

  // __bflive(comp) -> prueft live-Signale auf Betfair-Seite via bymarket
  // (event-/market-Keys, Status, marketName) fuer die ersten Maerkte der COMP
  unsafeWindow.__bflive = async (comp, limit) => {
    const log = devlog;
    const j = await bfLeagueMarkets(comp);
    if (!j || !j.nodes || !j.nodes.length) return log('Bynode leer fuer ' + comp);
    const mkt = j.nodes.filter(n => n.nodeType === 'MARKET');
    log('BF live ' + comp + ': ' + mkt.length + ' Maerkte');
    const ids = mkt.slice(0, limit || 4).map(n => n.nodeId.split(':')[1]);
    for (const mid of ids) {
      const bm = await bfByMarket(mid).catch(() => null);
      await sleep(120);
      if (!bm) { log('  market ' + mid + ': bymarket leer'); continue; }
      for (const et of (bm.eventTypes || [])) for (const ev of (et.eventNodes || [])) {
        const evKeys = Object.keys(ev);
        const liveish = evKeys.filter(k => /live|play|status|open|time/i.test(k));
        const evInfo = ev.description || ev.eventInfo || {};
        log('EVENT ' + ev.eventId + ' | keys=' + evKeys.join(','));
        log('  ' + 'keys(live)=' + (liveish.join(',') || '-') +
          ' | openDate=' + JSON.stringify(ev.openDate || ev.EventInfo || '') +
          ' | desc=' + String(JSON.stringify(evInfo) || '').slice(0, 200));
        for (const mk of (ev.marketNodes || []).slice(0, 2)) {
          const mklive = Object.keys(mk).filter(k => /live|play|status|open|inplay/i.test(k));
          log('  MARK ' + mk.marketId + ' keys=' + Object.keys(mk).join(','));
          log('    keys(live)=' + (mklive.join(',') || '-') +
            ' | state=' + String(JSON.stringify(mk.state) || '') +
            ' | description=' + String(JSON.stringify(mk.description) || '').slice(0, 300));
        }
      }
    }
    log('Fertig.');
  };

  // ---------- Konsole-Helper: Matchup-Details eines konkreten Spiels ----------
  // __pinmatch("Frech") -> sucht in ALLEN Ligen nach dem Spiel und zeigt
  // alle live-/statusrelevanten Felder (isLive, status, liveMode, periods, state)
  unsafeWindow.__pinmatch = async (kw) => {
    const log = devlog;
    if (!kw) return log('__pinmatch("Frech") -> Suchbegriff angeben');
    const rx = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const sports = await pinGet('/sports').catch(() => []);
    log('Durchsuche ' + (sports || []).length + ' Sportarten ...');
    let found = 0;
    for (const sp of (sports || [])) {
      const leagues = await pinGet('/sports/' + sp.id + '/leagues').catch(() => null);
      if (!leagues || !leagues.length) continue;
      for (const L of leagues) {
        const mus = await pinGet('/leagues/' + L.id + '/matchups').catch(() => null);
        if (!mus || !mus.length) continue;
        const hits = mus.filter(m => m.type === 'matchup' && !m.parentId &&
          (m.participants || []).some(p => rx.test(p.name || '')));
        for (const m of hits) {
          found++;
          const nm = (m.participants || []).map(p => p.name).join(' v ');
          log('=== ' + nm + ' (Liga ' + L.id + ': ' + L.name + ', Sport ' + sp.id + ') ===');
          log('  isLive=' + m.isLive + '  hasLive=' + m.hasLive +
            '  liveMode=' + JSON.stringify(m.liveMode) +
            '  status=' + JSON.stringify(m.status));
          log('  state=' + JSON.stringify(m.state));
          log('  periods=' + JSON.stringify(m.periods));
          log('  startTime=' + m.startTime);
          log('  allKeys=' + Object.keys(m).join(', '));
        }
        await sleep(50);
      }
    }
    log('Fertig: ' + found + ' Treffer fuer "' + kw + '"');
  };
// __htcsprobe(1633236740, 1843) -> zeigt alle Specials + straight-Maerkte eines
  // konkreten PIN-Matches und markiert HT-CS-relevante Strukturen (period=1,
  // "1st half/half time" in Description). Dient als Scans am Hit-Test fuer die
  // HT-CS-Erkennung ohne vollen Liga-Scan: "Correct Score 1st Half" (PIN) muss
  // als htCsBacks erkannt werden. lid optional (fallback /sports/29/matchups).
  unsafeWindow.__htcsprobe = async (mid, lid) => {
    const log = devlog;
    if (!mid) return log('__htcsprobe(<Matchup-ID>[, <Liga-ID>]) -> z.B. 16332467');
    const mu = await pinGet('/matchups/' + mid).catch(() => null);
    if (!mu) return log('Matchup ' + mid + ' nicht gefunden');
    const nm = (mu.participants || []).map(p => p.name).join(' v ') || ('id=' + mid);
    let lg = mu.leagueId || (mu.league && mu.league.id) || (mu.parentId && '') || lid;
    if (!lg) {
      const all = await pinGet('/sports/29/matchups?status=1').catch(() => []);
      const hit = (all || []).find(x => String(x.id) === String(mid));
      lg = hit && (hit.leagueId || (hit.league && hit.league.id)) || '';
    }
    log('=== ' + nm + ' (Liga ' + (lg || 'UNBEKANNT') + ', allKeys=' + Object.keys(mu).join(',') + ') ===');
    if (!lg) return log('Liga-ID nicht ermittelbar - bitte zweites Argument (Liga-ID) angeben');
    log('  status=' + JSON.stringify(mu.status) + ' isLive=' + mu.isLive +
      ' liveMode=' + JSON.stringify(mu.liveMode) +
      ' startTime=' + mu.startTime + ' hasMarkets=' + mu.hasMarkets +
      ' totalMarketCount=' + mu.totalMarketCount);
    const mus = await pinGet('/leagues/' + lg + '/matchups').catch(() => null);
    if (!mus || !mus.length) return log('Liga ' + lg + ': keine Matchups (evtl. ist das Spiel live, Liga leer)');
    const sMid = String(mid);
    const specs = (mus || []).filter(s => s.type === 'special' && String(s.parentId) === sMid);
    const allSpecs = (mus || []).filter(s => s.type === 'special');
    const hCS_RE = new RegExp('^([0-' + MAX_CS_SCORE + ']),([0-' + MAX_CS_SCORE + '])$');
    const hCS2_RE = new RegExp('^(.+) ([0-' + MAX_CS_SCORE + ']), (.+) ([0-' + MAX_CS_SCORE + '])$');
    const hCsKey = nm => {
      const m1 = hCS_RE.exec(nm);
      if (m1) return m1[1] + ',' + m1[2];
      const m2 = hCS2_RE.exec(nm);
      if (m2) return m2[2] + ',' + m2[4];
      return null;
    };
    const hIsCs = ps => ps.some(p => hCsKey(p.name) || /Yes & Under|No & Over/.test(p.name));
    log('Liga ' + lg + ': ' + (mus || []).length + ' Elemente, davon ' + allSpecs.length +
      ' Specials gesamt, ' + specs.length + ' fuer dieses Match');
    if (specs.length === 0 && allSpecs.length) {
      log('  -> Alle Specials der Liga (id, parentId, name, desc, Tehlnr):');
      for (const s of allSpecs.slice(0, 30))
        log('    spec ' + s.id + ' parent=' + s.parentId + ' name=' + JSON.stringify(s.name) +
          ' desc=' + JSON.stringify((s.special && s.special.description) || '') +
          ' n=' + (s.participants || []).length +
          ' | ' + (s.participants || []).slice(0, 8).map(p => p.name).join(' | '));
    }
    const pr = await pinGet('/matchups/' + mid + '/markets/straight').catch(() => null);
    if (pr && pr.length) {
      log('  straight-Maerkte des MATCHUP direkt: ' + pr.map(m => 'type=' + m.type + ' p' + (m.period || 0)).join(' ;; '));
      for (const m of pr)
        log('    RAW: ' + JSON.stringify({
          id: m.id, key: m.key, type: m.type, period: m.period, line: m.line,
          points: m.points, name: m.name, description: m.description,
          special: (m.special && { id: m.special.id, name: m.special.name, description: m.special.description }) || null,
          prices: (m.prices || []).slice(0, 6).map(p => p.designation + '=' + p.price + ' pts=' + p.points)
        }));
      const ht = pr.filter(m => /half|1st|2nd|ht|correct/i.test(String(m.type || '')) ||
        Number(m.period || 0) === 1);
      if (ht.length) ht.forEach(m => log('    HT-relevant: type=' + m.type + ' period=' + (m.period || 0) +
        ' line=' + JSON.stringify(m.line) + ' points=' + JSON.stringify(m.points) +
        ' | keys=' + Object.keys(m).join(',') + ' | ' +
        (m.prices || []).slice(0, 8).map(p => JSON.stringify(p.designation || p.participantId) +
          '=' + p.price + ' pts=' + JSON.stringify(p.points !== undefined ? p.points : p.point)).join(' | ')));
      const htTot = pr.filter(m => /^total/i.test(String(m.type || '')) && Number(m.period || 0) === 1);
      for (const m of htTot) {
        const l1 = parseFloat(m.line ?? m.points ?? NaN);
        const p0 = (m.prices || [])[0] || {};
        const l3 = parseFloat(p0.points ?? p0.point ?? NaN);
        log('    HT-TOTAL Roh: line=' + JSON.stringify(m.line) + ' points=' + JSON.stringify(m.points) +
          ' -> parse=' + l1 + (isNaN(l1) ? ' (Fallback price.points=' + l3 + ')' : '') +
          ' | prices=[' + (m.prices || []).map(p => JSON.stringify(p)).join(' ;; ').slice(0, 400) + ']');
      }
      const cs = pr.filter(m => /correct/i.test(String(m.type || '')));
      if (cs.length) log('  !! CORRECT-SCORE-TYP direkt im straight: ' +
        cs.map(m => m.type + ' p' + (m.period || 0)).join(' ;; '));
    }
    const rel = await pinGet('/matchups/' + mid + '/markets/related').catch(() => null);
    if (rel && rel.length) {
      log('  related-Maerkte: ' + rel.map(m => 'type=' + m.type + ' p' + (m.period || 0) +
        ' matchup=' + m.matchupId).join(' ;; '));
      const ht = rel.filter(m => String(m.matchupId) === String(mid) &&
        (/half|1st|2nd|ht/i.test(String(m.type || '')) || Number(m.period || 0) === 1));
      if (ht.length) ht.forEach(m => log('    HT-relevant: type=' + m.type + ' period=' + (m.period || 0) +
        ' | ' + (m.prices || []).slice(0, 8).map(p => JSON.stringify(p.designation || p.participantId) +
          '=' + p.price).join(' | ')));
    }
    const qRe = /qualif|advance|proceed|next round|to win the/i;
    const lgStraight = await pinGet('/leagues/' + lg + '/markets/straight').catch(() => null);
    if (lgStraight && lgStraight.length) {
      const mine = lgStraight.filter(m => String(m.matchupId) === sMid);
      log('Liga-straight: ' + lgStraight.length + ' Maerkte gesamt, ' + mine.length + ' fuer dieses Match');
      const q = mine.filter(m => qRe.test(String((m.special && (m.special.description || m.special.name)) || '') +
        ' ' + String(m.type || '') + ' ' + String(m.key || '')));
      if (q.length) log('  !! To-Qualify-relevant in Liga-straight (' + q.length + '):');
      for (const m of q) log('    RAW: ' + JSON.stringify({
        id: m.id, key: m.key, type: m.type, period: m.period, matchupId: m.matchupId,
        special: (m.special && { id: m.special.id, name: m.special.name, description: m.special.description }) || null,
        prices: (m.prices || []).slice(0, 6).map(p => (p.designation || p.participantId) + '=' + p.price)
      }));
      const relStraight = await pinGet('/matchups/' + mid + '/markets/related/straight').catch(() => null);
      if (relStraight && relStraight.length) {
        const q2 = relStraight.filter(m => qRe.test(String((m.special && (m.special.description || m.special.name)) || '') +
          ' ' + String(m.type || '') + ' ' + String(m.key || '')));
        if (q2.length) {
          log('  !! To-Qualify-relevant in related/straight (' + q2.length + '):');
          for (const m of q2) log('    RAW: ' + JSON.stringify({
            id: m.id, key: m.key, type: m.type, period: m.period, matchupId: m.matchupId,
            special: (m.special && { id: m.special.id, name: m.special.name, description: m.special.description }) || null,
            prices: (m.prices || []).slice(0, 6).map(p => (p.designation || p.participantId) + '=' + p.price)
          }));
        } else {
          log('  related/straight: ' + relStraight.length + ' Maerkte, davon fuer Match ' +
            relStraight.filter(m => String(m.matchupId) === sMid).length + ' (keine Qualify-Keys)');
        }
      }
    }
    const descOf = s => String((s.special && s.special.description) || s.name || '');
    const qSpecs = specs.filter(s => /qualif|advance|proceed|next round|to win the/i.test(descOf(s)));
    if (qSpecs.length)
      log('  !! Qualify-/Advance-Specials (' + qSpecs.length + '):');
    const specList = qSpecs.length ? qSpecs : specs;
    for (const s of specList) {
      const ps = s.participants || [];
      const desc = descOf(s);
      log('--- Special ' + s.id + ' name=' + JSON.stringify(s.name) +
        ' desc=' + JSON.stringify(desc) + ' n=' + ps.length);
      log('    Teilnehmer: ' + ps.slice(0, 14).map(p => p.id + '=' + p.name).join(' | ') +
        (ps.length > 14 ? ' (+' + (ps.length - 14) + ')' : ''));
      const pr = await pinGet('/matchups/' + s.id + '/markets/straight').catch(() => null);
      if (!pr) { log('    straight: FEHLER'); continue; }
      if (!pr.length) { log('    straight: 0 Maerkte'); continue; }
      log('    Markets=' + pr.length + ' periodVerteilung: ' + pr.map(m => 'p' + (m.period || 0)).join(','));
      for (const m of pr) log('      type=' + m.type + ' period=' + (m.period || 0) +
        ' line=' + JSON.stringify(m.line) + ' | ' +
        (m.prices || []).slice(0, 6).map(p => JSON.stringify(p.designation || p.participantId) +
          '=' + p.price).join(' | '));
      if (pr.some(m => Number(m.period || 0) === 1))
        log('    => period=1-JA! ' + pr.filter(m => Number(m.period || 0) === 1).length + ' Market(s)');
      const checkCk = ps.slice(0, 3).map(p => hCsKey(p.name));
      log('    => csKeyOf-Beispiel: ' + checkCk.join(' | ') + ' -> isCS=' + hIsCs(ps) +
        ' | desc-Half=' + /1st half|first half|half time/i.test(desc));
    }
  };
  // __bfunmap(293225)  -> entfernt "Premier Padel Pretoria" aus H2H/LEAGUES
  unsafeWindow.__bfunmap = pid => {
    const id = String(pid);
    let out = '';
    const maps = [
      ['LEAGUES', LEAGUES, LIGA_NAMEN, 'cs'],
      ['H2H', H2H, H2H_NAMEN, 'h2h']];
    for (const [name, map, names, section] of maps) {
      if (map[id]) {
        const old = map[id];
        delete map[id];
        if (names[id]) delete names[id];
        out += ' ' + name + ' Eintrag entfernt (' + id + ' -> ' + old + ');';
      }
    }
    // Aus JSON-Datei entfernen (via App-API)
    try {
      GM_xmlhttpRequest({
        method: 'POST',
        url: PIPE + '/league-map',
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify({ remove: true, pid: id }),
      });
    } catch (e) { /* App nicht erreichbar */ }
    devlog('__bfunmap(' + pid + '):' + (out || ' kein Mapping vorhanden.'));
    return out || null;
  };

  // ---------- Konsole-Helper: UEFA CL + EL Qualifiers abfragen ----------
  // __uefaq() -> zeigt alle Matches beider Ligen von Pinnacle
  unsafeWindow.__uefaq = async () => {
    const log = devlog;
    const pids = [
      { pid: 205451, name: 'CL Qualifiers' },
      { pid: 2632, name: 'EL Qualifiers' }
    ];
    for (const { pid, name } of pids) {
      log('=== ' + name + ' (pid ' + pid + ') ===');
      const leag = await pinGet('/leagues/' + pid + '/matchups').catch(e => { log('  FEHLER: ' + e); return null; });
      if (!leag || !leag.length) { log('  keine Matches'); continue; }
      for (const m of leag) {
        if (m.type !== 'matchup' || m.parentId) continue;
        const teams = (m.participants || []).map(p => p.name).join(' v ');
        const pr = await pinGet('/matchups/' + m.id + '/markets/straight').catch(() => null);
        const types = [...new Set((pr || []).map(x => String(x.type || '')))];
        log('  ' + m.id + ' | ' + teams + ' | ' + m.status + ' | markets: ' + types.join(', '));
      }
    }
  };

  // ---------- Konsole-Helper: BF-Snapshot (alle COMPs fuer Matcher) ----------
  // __bfsnapshot('soccer') -> sammelt alle COMPs, laesst JSON downloaden
  unsafeWindow.__bfsnapshot = async (sport) => {
    const log = devlog;
    const SIDS = { soccer:1, tennis:2, basketball:7522, baseball:3, handball:18,
      volleyball:34, cricket:4, rugby_league:1477, rugby_union:5, boxing:6,
      mma:22, table_tennis:32 };
    const sid = SIDS[(sport||'').toLowerCase()] || 1;
    log('BF-Snapshot: sport=' + (sport||'soccer') + ' (sid=' + sid + ')');

    // Step 1: Top-level groups
    let root = null;
    for (const id of ['EVENT_TYPE:' + sid, 'SPORT:' + sid]) {
      root = await bfBynode(id, 'MENU', 1, 500).catch(() => null);
      if (root && root.nodes && root.nodes.length) break;
    }
    if (!root || !root.nodes) { log('Keine Gruppen gefunden'); return; }
    const groups = root.nodes.filter(n => n.name && (
      String(n.nodeType) === 'MENU' || String(n.nodeType) === 'GROUP' ||
      String(n.nodeType) === 'COMPETITION' ||
      /^(MENU|GROUP|COMP):/.test(String(n.nodeId || n.id))
    )).map(n => ({ id: String(n.nodeId || n.id), name: n.name }));
    log(groups.length + ' Gruppen');

    // Step 2: COMPs aus jeder Gruppe
    const allComps = [];
    const seen = new Set();
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      log('  [' + (i+1) + '/' + groups.length + '] ' + g.name + '...');
      const sub = await bfBynode(g.id, 'MENU,EVENT', 2, 800).catch(() => null);
      let n = 0;
      for (const nd of ((sub && sub.nodes) || [])) {
        const cid = String(nd.nodeId || nd.id || '');
        if (/^COMP:/.test(cid) && nd.name) {
          const cidNum = Number(cid.slice(5));
          if (Number.isFinite(cidNum) && !seen.has(cidNum)) {
            seen.add(cidNum);
            allComps.push({
              cid: cidNum,
              name: nd.name,
              group: g.name,
              group_id: g.id,
              nodeType: nd.nodeType,
              sportId: nd.sportId,
              raw: { label: nd.name },
            });
            n++;
          }
        }
      }
      log(' ' + n + ' COMPs');
      await sleep(80);
    }
    log('Gesamt: ' + allComps.length + ' COMPs');

    // Step 3: JSON downloaden
    const blob = new Blob([JSON.stringify(allComps, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'bf_snapshot_' + (sport||'soccer') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log('Download gestartet: bf_snapshot_' + (sport||'soccer') + '.json');
  };

  // ---------- Konsole-Helper: PIN-Snapshot (alle Ligen fuer Matcher) ----------
  // __pinsnapshot('soccer') -> sammelt alle PIN-Ligen + ALLE Felder, laesst JSON downloaden
  unsafeWindow.__pinsnapshot = async (sport) => {
    const log = devlog;
    const SIDS = { soccer:29, tennis:33, basketball:4, baseball:3, handball:18,
      volleyball:34, cricket:8, rugby_league:26, rugby_union:27, boxing:6,
      mma:22, table_tennis:32 };
    const sid = SIDS[(sport||'').toLowerCase()] || 29;
    log('PIN-Snapshot: sport=' + (sport||'soccer') + ' (sid=' + sid + ')');

    const leagues = await pinGet('/sports/' + sid + '/leagues').catch(e => { log('FEHLER: ' + e); return []; });
    if (!leagues || !leagues.length) { log('Keine Ligen'); return; }
    log(leagues.length + ' Ligen');
    log('Verfuegbare Felder: ' + [...new Set(leagues.flatMap(l => Object.keys(l)))].join(', '));

    // Alle Felder mitnehmen
    const result = leagues.map(l => ({ ...l, sport: sport || 'soccer' }));

    const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pin_snapshot_' + (sport||'soccer') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log('Download gestartet: pin_snapshot_' + (sport||'soccer') + '.json');
  };

  // ---------- Konsole-Helper: PIN-Events (Upcoming Fixtures) ----------
  // __pinevents('soccer') -> sammelt alle kommenden Spiele von Pinnacle
  unsafeWindow.__pinevents = async (sport) => {
    const log = devlog;
    const SIDS = { soccer:29, tennis:33, basketball:4, baseball:3, handball:18,
      volleyball:34, cricket:8, rugby_league:26, rugby_union:27, boxing:6,
      mma:22, table_tennis:32 };
    const sid = SIDS[(sport||'').toLowerCase()] || 29;
    log('PIN-Events: sport=' + (sport||'soccer') + ' (sid=' + sid + ')');

    // Fixtures/Matchups laden
    const matchups = await pinGet('/sports/' + sid + '/matchups?status=1').catch(e => { log('FEHLER: ' + e); return []; });
    if (!matchups || !matchups.length) { log('Keine Events'); return; }
    log(matchups.length + ' Events geladen (raw)');

    // Erstes Event vollstaendig loggen fuer Feld-Analyse
    log('RAW Beispiel: ' + JSON.stringify(matchups[0]));

    // Nur echte Spiele filtern (keine Yes/No-Specials, Correct Score, Handicap etc.)
    const SPECIAL_PATTERNS = /^(yes|no|draw|over|under|even|odd|none|all|field|other|any|or |by \d|total|exact|both)/i;
    const HANDICAP_PATTERN = /[\(\[][+\-]?\d|Handicap|Asian|Draw No Bet|Double Chance|To Qualify|Winner/i;
    const REAL_EVENTS = matchups.filter(m => {
      const parts = m.participants || [];
      if (parts.length < 2) return false;
      for (const p of parts) {
        const n = (p.name || '').trim();
        if (SPECIAL_PATTERNS.test(n)) return false;
        if (HANDICAP_PATTERN.test(n)) return false;
        if (n.length < 2) return false;
      }
      return true;
    });
    log(REAL_EVENTS.length + ' echte Spiele (gefiltert)');

    // Nur relevante Felder extrahieren
    const events = REAL_EVENTS.map(m => {
      const parts = m.participants || [];
      // Team-Namen: Handicap-Suffixe entfernen wie "(+3)", "(-1.5)"
      const clean = n => (n || '').replace(/\s*[\(\[][+\-]?\d+\.?\d*[\)\]]/g, '').trim();
      return {
        id: m.id,
        leagueId: m.league?.id || m.leagueId,
        leagueName: m.league?.name || '',
        home: clean(parts[0]?.name || ''),
        away: clean(parts[1]?.name || ''),
        startDate: m.starts || m.startDate || '',
        cid: m.id,  // PIN Competition ID (Matchup-ID = Event-ID)
        sport: sport || 'soccer',
      };
    });

    log('Feldbeispiel: ' + JSON.stringify(events[0]));

    const blob = new Blob([JSON.stringify(events, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'pin_events_' + (sport||'soccer') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log('Download gestartet: pin_events_' + (sport||'soccer') + '.json');
  };

  // ---------- Konsole-Helper: BF-Baum-Walk (geteilt) ----------
  // Ein gemeinsamer BF-Baum-Traverser fuer alle Discovery-Helper. Budget +
  // Node-/COMP-Filter steuern Umfang; Fortschritt wird geloggt.
  const BF_SPORTS = { soccer:1, tennis:2, basketball:7522, baseball:3, handball:18,
    volleyball:34, cricket:4, rugby_league:1477, rugby_union:5, boxing:6,
    mma:22, table_tennis:32 };
  const bfSportId = sport => BF_SPORTS[(sport||'').toLowerCase()] || 1;

  // Auto-Heal: Wenn EVENT_TYPE:<known> leer ist (Betfair hat die Sport-ID
  // umgezogen, z.B. Tennis 33 -> 2), die wirklich aktive Event-Type-Node
  // per Knoten-Name suchen. Bekannte Kandidaten zuerst, dann Bruchteil (1..40).
  const BF_EV_TYPE_CANDIDATES = [1, 2, 33, 29, 3, 4, 5, 1477, 6, 18, 22, 26, 27, 32, 34, 39];
  const bfAutoHealSport = async (nameHint, bfid, onLog) => {
    const log = onLog || (m => devlog(m));
    const need = ((nameHint||'') + '').toLowerCase().trim();
    if (!need) return bfid;
    for (const sid of [...BF_EV_TYPE_CANDIDATES]) {
      if (sid === bfid) continue;
      const j = await bfBynode('EVENT_TYPE:' + sid, 'MENU', 1, 300).catch(() => null);
      const n = (j && j.nodes || []);
      const hit = n.some(x => (x.name||'').toLowerCase().indexOf(need) !== -1);
      if (hit) {
        log('Auto-Heal: EVENT_TYPE:' + bfid + ' leer, stattdessen EVENT_TYPE:' +
            sid + ' (Name: "' + (n.find(x => (x.name||'').toLowerCase().indexOf(need) !== -1) || {}).name + '") mit "' + need + '" erkannt');
        return sid;
      }
    }
    return bfid;
  };

  // opts: { sport, budget, wantGroup(name)->bool, wantComp(name)->bool, onLog(msg) }
  // Liefert { events: [...], found: [{id,name,count}], calls, budgetHit }
  async function bfWalk(opts) {
    const log = opts.onLog || (m => devlog(m));
    const budget = opts.budget || 600;
    const maxDepth = opts.maxDepth || 8;
    let bfid = bfSportId(opts.sport);
    const wantGroup = opts.wantGroup || (() => true);
    const wantComp = opts.wantComp || (() => true);
    log('[BF-Walk] sport=' + (opts.sport||'soccer') + ' (bfSid=' + bfid +
        ') Budget=' + budget + ' Tiefe=' + maxDepth);

    const events = [], found = [], seenEv = new Set(), seenComp = new Set();
    let compFetched = 0, calls = 0;
    const cap = () => calls >= budget;

    async function fetchComp(compId, compName) {
      if (seenComp.has(compId) || compFetched >= 300 || cap()) return 0;
      seenComp.add(compId);
      await sleep(60);
      compFetched++;
      if (opts.wantComp && !wantComp(compName)) return 0;
      calls++;
      if (calls % 50 === 0) log('BF-Walk ... ' + calls + '/' + budget + ' Calls');
      const evSub = await bfBynode(compId, 'MENU,EVENT', 6, 500).catch(() => null);
      if (!evSub) return 0;
      let count = 0;
      for (const ev of (evSub.nodes || [])) {
        const eid = String(ev.nodeId || ev.id);
        const evName = ev.name || '';
        if ((evName.includes(' v ') || evName.includes(' vs ')) && !seenEv.has(eid)) {
          seenEv.add(eid);
          events.push({ id: eid, compId, compName, name: evName,
            startDate: ev.eventDate || ev.date || '' });
          count++;
        }
      }
      if (count > 0) log('  ' + compName + ': ' + count + ' Events');
      found.push({ id: compId, name: compName, count });
      return count;
    }

    // Page-First: Erfasste COMPs (Interceptor) zuerst nutzen
    const captured = Array.from(window.__bfCaptureIds || []).filter(c => !/Sport|Specials|ANTEPOST|sports/i.test(c));
    if (captured.length) {
      log('Page-First: ' + captured.length + ' erfasste COMPs');
      for (const cid of captured) await fetchComp(cid, cid);
      if (events.length > 0) {
        log(events.length + ' Events aus ' + compFetched + ' COMP-Abfragen (Page-First)');
        return { events, found, compFetched, calls, budgetHit: cap() };
      }
    }

    // Baum-Traverse (BFS): gleichmaessig ueber alle Aeste, Budget-deterministisch
    log('Fallback: Baum-Traverse von EVENT_TYPE:' + bfid);
    let root = await bfBynode('EVENT_TYPE:' + bfid, 'MENU', 1, 500).catch(() => null);
    let level1 = ((root && root.nodes) || []).filter(n => n.name);
    if (level1.length === 0) {
      const healed = await bfAutoHealSport(opts.sport, bfid, log);
      if (healed !== bfid) {
        bfid = healed;
        root = await bfBynode('EVENT_TYPE:' + bfid, 'MENU', 1, 500).catch(() => null);
        level1 = ((root && root.nodes) || []).filter(n => n.name);
      }
    }
    if (!root) { log('Kein BF-Root gefunden'); return { events, found, compFetched, calls, budgetHit: true }; }
    log(level1.length + ' Knoten auf Ebene 1');

    let frontier = [];
    const seenNode = new Set();
    for (const n of level1) {
      const nid = String(n.nodeId || n.id);
      if (nid.startsWith('COMP:')) {
        await fetchComp(nid, n.name);
      } else if (nid.match(/^(GROUP|MENU):/) && wantGroup(n.name) &&
                 n.name !== 'Specials' && n.name !== 'ANTEPOST') {
        seenNode.add(nid);
        frontier.push(nid);
      }
    }

    let bfsLevel = 0;
    while (frontier.length && !cap() && bfsLevel < maxDepth) {
      const next = [];
      for (const nid of frontier) {
        if (cap()) break;
        await sleep(30);
        calls++;
        if (calls % 50 === 0) log('BF-Walk ... ' + calls + '/' + budget + ' Calls');
        const sub = await bfBynode(nid, 'MENU,EVENT', 4, 500).catch(() => null);
        if (!sub) continue;
        for (const s of (sub.nodes || [])) {
          const sid = String(s.nodeId || s.id);
          if (sid.startsWith('COMP:') && !seenComp.has(sid)) {
            await fetchComp(sid, s.name || sid);
          } else if (sid.match(/^(GROUP|MENU):/) && !seenNode.has(sid) &&
                     wantGroup(s.name) && s.name !== 'Specials' && s.name !== 'ANTEPOST') {
            seenNode.add(sid);
            next.push(sid);
          }
        }
      }
      bfsLevel++;
      frontier = next;
    }

    log(events.length + ' Events aus ' + compFetched + ' COMP-Abfragen' +
      (cap() ? ' (Budget ' + budget + ' erreicht, ggf. unvollstaendig)' : ' (Calls=' + calls + ')'));
    return { events, found, compFetched, calls, budgetHit: cap() };
  }

  // ---------- Konsole-Helper: BF-Events (alle COMPs, Events holen) ----------
  // __bfevents('soccer')                -> alle COMPs, JSON-Download
  // __bfevents('soccer', 'COMP:123')    -> zusaetzlich diese COMP explizit laden
  unsafeWindow.__bfevents = async (sport, extraComps) => {
    const log = devlog;
    const out = await bfWalk({ sport, budget: 600 });

    const extraArr = [];
    if (extraComps) {
      const arr = Array.isArray(extraComps) ? extraComps : [extraComps];
      for (const c of arr) {
        const cid = c.startsWith('COMP:') ? c : 'COMP:' + c;
        if (!out.found.some(f => f.id === cid)) extraArr.push(cid);
      }
    }
    if (extraArr.length) {
      log('Extra COMPs: ' + extraArr.join(', '));
      for (const cid of extraArr) {
        await new Promise(res => { devlog('Extra: ' + cid);
          bfBynode(cid, 'MENU,EVENT', 6, 500).then(j => {
            (j && (j.nodes || [])).forEach(ev => {
              const evName = ev.name || '';
              if ((evName.includes(' v ') || evName.includes(' vs ')) &&
                  !out.events.some(e => e.id === String(ev.nodeId || ev.id))) {
                out.events.push({ id: String(ev.nodeId || ev.id), compId: cid,
                  compName: cid, name: evName,
                  startDate: ev.eventDate || ev.date || '' });
              }
            });
            res();
          }).catch(res);
        });
      }
    }
    const allEvents = out.events;

    log(allEvents.length + ' Events aus ' + out.compFetched + ' COMP-Abfragen' +
      (out.budgetHit ? ' (Budget erreicht, ggf. unvollstaendig)' : ''));
    if (allEvents.length) log('Beispiel: ' + JSON.stringify(allEvents[0]));

    const blob = new Blob([JSON.stringify(allEvents, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'bf_events_' + (sport||'soccer') + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log('Download gestartet: bf_events_' + (sport||'soccer') + '.json');
  };

  // ---------- Konsole-Helper: PIN-Netz-Schnueffler (Live-Capture) ----------
  // Der Proxy ist bereits bei @run-at document-start installiert (vor Pinnacle
  // main.js), damit er die Requests der Seite sieht (Seite friert fetch/XHR beim
  // Laden ein). __pinsniff(true) schaltet nur scharf, false wieder ab.
  // Ausgabe: Log je Treffer mit Request-URL, gefundenen Keys und alt-Flags.
  unsafeWindow.__pinsniff = (on) => {
    const log = devlog;
    if (!window.__pinSniffOn) { log('PIN-Sniff-Proxy nicht installiert (Seite vor v1.63 geladen — neu laden).'); return 'na'; }
    window.__pinSniffOn.v = !!on;
    if (on) { __pinSniffHits.length = 0; __pinShuffleReport.clear(); }
    if (!on && __pinSniffLog.length) {
      log('PIN-Sniff aus. (Letzte ' + Math.min(8, __pinSniffLog.length) + ' Stream-Linien:)');
      __pinSniffLog.slice(-8).forEach(m => log('  ' + m));
    } else {
      log(on ?
        'PIN-Sniff an: Proxy laeuft (alle arcadia-Responses via fetch/XHR/WS, "s;...ou;..."-Keys extra) — Games-Tabelle oeffnen. __pinsniff(false) stoppt.' :
        'PIN-Sniff aus.');
    }
    return on ? 'on' : 'off';
  };

  // ---------- Konsole-Helper: PIN-Komplett-Crawler (Baum-Walker) ----------
  // __pinwalk('tennis')  -> startet bei /sports/{sid}/leagues und laeuft durch ALLE
  //   Kind-Ebenen: Ligen -> matchups -> matchup-Detail -> markets/straight.
  //   Aus jeder JSON-Antwort werden generisch IDs gelesen und als Kindern fortge­
  //   setzt (keine Endpunkt-Liste mehr raten). Werte je Knoten: keys (s;.;ou;VARIANT),
  //   market-Typen, Preis-Anzahl, isAlternate. Ausgabe: JSON 'pin_walk_<sport>.json'
  //   + Log mit jeder erreichten URL + gefundenen "s;...ou;..."-Keys.
  // __pinwalk('tennis', '{"leagues":12,"budget":600,"kw":"Griekspoor"}')
  //   -> begrenzte Liga-/Call-Zahl, opt. Keyword als Zielverortung im Baum.
  unsafeWindow.__pinwalk = async (sport, optsJson) => {
    const log = devlog;
    let o = {};
    try {
      const r = optsJson == null ? '' : String(optsJson).trim();
      if (r) o = r.startsWith('{') ? JSON.parse(r) : { kw: r };
    } catch (e) { o = {}; }
    const sname = (sport || 'soccer').toLowerCase();
    const PIN_SIDS = { soccer:29, tennis:33, basketball:4, baseball:3, handball:18,
      volleyball:34, cricket:8, rugby_league:26, rugby_union:27, boxing:6,
      mma:22, table_tennis:32 };
    const sid = PIN_SIDS[sname] || 29;
    const budget = Math.min((o.budget || 600) | 0, 1500);   // Call-Limit (Sicherheitsgrenze)
    const ligaMax = ((o.liga ?? o.leagues ?? 0) | 0);       // 0 => alle Ligen
    const known = new Set();                                 // besuchte URLs (Dedup)
    const leafStats = {};                                    // URL -> keys/alt/Bytes
    const keyByUrl = {};
    const errors = [];
    let calls = 0;
    const queue = [];
    const sleep2 = ms => new Promise(r => setTimeout(r, ms));
    const enq = u => { if (!known.has(u)) { known.add(u); queue.push(u); } };
    // generiche Kind-Ableitung: aus jedem JSON-Knoten IDs extrahieren & weiterfolgen
    const collectKids = (obj, parentUrl, out) => {
      if (!obj || typeof obj !== 'object') return;
      if (Array.isArray(obj)) { obj.forEach(x => collectKids(x, parentUrl, out)); return; }
      const add = u => { if (u && !out.includes(u)) out.push(u); };
      if (obj.leagueId) add('/leagues/' + obj.leagueId);
      if (obj.matchupId) add('/matchups/' + obj.matchupId);
      if (obj.id && typeof obj.id === 'number') {
        if (/^\/leagues\//.test(parentUrl)) add('/leagues/' + obj.id);
        else if (/^\/matchups\//.test(parentUrl)) add('/matchups/' + obj.id);
      }
      for (const f of ['children', 'leagues', 'matchups', 'markets', 'nodes', 'subMarkets']) {
        if (Array.isArray(obj[f])) obj[f].forEach(x => collectKids(x, parentUrl, out));
      }
    };
    const phaseOf = url => {
      if (/^\/sports\/\d+\/leagues$/.test(url)) return 'league-list';
      if (/^\/leagues\/\d+\/matchups$/.test(url)) return 'matchups';
      if (/^\/leagues\/\d+$/.test(url)) return 'league';
      if (/^\/matchups\/\d+\/markets\/straight$/.test(url)) return 'market';
      if (/^\/matchups\/\d+$/.test(url)) return 'matchup';
      return 'other';
    };
    enq('/sports/' + sid + '/leagues');
    while (queue.length && calls < budget) {
      const url = queue.shift();
      if (calls >= budget) break;
      let g = null;
      try { g = await pinGet(url); } catch (e) { errors.push(url + ' :: ' + e); }
      calls++;
      if (calls % 40 === 0) log('PIN-Walk ... ' + calls + '\/' + budget + ' Calls, ' + queue.length + ' offen');
      if (g == null) { leafStats[url] = { err: true }; continue; }
      const gStr = JSON.stringify(g);
      const gKeys = [...new Set((gStr.match(/"key":"s;[0-9;]*(ou|tt|s);[^"]*"/g) || []).map(x => x.slice(7, -1)))];
      const gAlt = (gStr.match(/"isAlternate":true/g) || []).length;
      const phase1 = phaseOf(url);
      leafStats[url] = { phase: phase1, keys: gKeys.length, alt: gAlt, bytes: gStr.length, n: gKeys.length ? gKeys.join(' | ') : '' };
      if (gKeys.length) keyByUrl[url] = gKeys;
      if (gKeys.length) log('  keys in ' + url + ' -> ' + gKeys.join(' | '));
      // Kinds generisch + gezielte Abzweige
      const kids = [];
      collectKids(g, url, kids);
      if (phase1 === 'league' && /^\/leagues\/\d+$/.test(url)) {
        // Liga-Detail: nur Matchups (s;...-Keys inkl. Games liegen in
        // /matchups/{id}/markets/straight, NICHT in /leagues/{id}/coupons = 404)
        enq(url + '/matchups');
      }
      if (phase1 === 'league-list' && Array.isArray(g)) {
        let nL = 0;
        for (const l of g) {
          if (l && (l.id || l.leagueId)) {
            const lid = l.id || l.leagueId;
            if (!ligaMax || nL < ligaMax) {
              const lu = '/leagues/' + lid;
              if (!known.has(lu)) { known.add(lu); queue.push(lu); }
              nL++;
            }
          }
        }
      }
      if (phase1 === 'matchups' && Array.isArray(g)) {
        for (const m of g) {
          const mu = '/matchups/' + (m.id || m.matchupId);
          if (!known.has(mu)) { known.add(mu); queue.push(mu); }
        }
      }
      if (phase1 === 'matchup') {
        if (!known.has(url + '/markets/straight')) { known.add(url + '/markets/straight'); queue.push(url + '/markets/straight'); }
        if (o.kw && gStr.toLowerCase().indexOf(String(o.kw).toLowerCase()) !== -1)
          log('  * KW-Kontext "' + o.kw + '" in ' + url);
      }
      kids.forEach(u => { if (!known.has(u)) { known.add(u); queue.push(u); } });
      await sleep2(20);
    }
    log('=== PIN-WALK (' + sname + ', sid ' + sid + ') ===');
    log('Abrufpfade gesamt: ' + calls + (calls >= budget ? ' (Budget!)' : '') + ' | wartend: ' + queue.length + ' | Fehler: ' + errors.length);
    Object.keys(leafStats).sort().forEach(u => {
      const st = leafStats[u];
      if (st.err) { log('  ' + u + ' -> FEHLER'); return; }
      log('  ' + u + ' -> ' + st.keys + ' keys' + (st.alt ? ' (alt=' + st.alt + ')' : '') +
        (st.keys ? ' | ' + st.keys : ''));
    });
    const blob = new Blob([JSON.stringify(
      { sport: sname, sid, visited: Object.keys(leafStats), leafStats,
        keysByUrl: keyByUrl }, null, 2)],
      { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'pin_walk_' + sname + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    log('Download gestartet: pin_walk_' + sname + '.json');
    return keyByUrl;
  };

  // ---------- Konsole-Helper: Kompletter Markt-Baum einer Sportart ----------
  // __tree('tennis')                                  -> kompletten Marktbaum der
  //   Sportart einmal auslesen: PIN-Ligen/Matchups/straight-Typen + BF-COMPs/Marktnamen.
  // __tree('tennis', '{"kw":"Griekspoor"}')            -> zusaetzlich das zum Keyword
  //   passende Match auf PIN- und BF-Seite vollstaendig verorten (alle straight-M-
  //   rkte bzw. Event-Marktnamen des Spiels).
  // __tree('soccer', '{"pinLigen":20,"compLimit":60}') -> Begrenzungen per JSON-Opts.
  // Ausgabe: JSON-Download 'sport_tree_<sport>.json' + Log-Zusammenfassung.
  // Wiederverwendbar fuer neue Markttypen (z.B. Tennis "Total Games" 21.5) und
  // bestehende Features; Sets-2.5-Pfad (sou) bleibt davon getrennt bestehen.
  unsafeWindow.__tree = async (sport, optsJson) => {
    const log = devlog;
    let o = {};
    // opts akzeptiert JSON {"kw":"X",...} ODER ein reines Keyword (z.B. "Griekspoor").
    try {
      const raw = optsJson == null ? '' : String(optsJson).trim();
      if (raw) {
        if (raw.startsWith('{')) o = JSON.parse(raw);
        else o = { kw: raw };
      }
    } catch (e) { o = {}; }
    const PIN_SIDS = { soccer:29, tennis:33, basketball:4, baseball:3, handball:18,
      volleyball:34, cricket:8, rugby_league:26, rugby_union:27, boxing:6,
      mma:22, table_tennis:32 };
    const sname = (sport || 'soccer').toLowerCase();
    const pinSid = PIN_SIDS[sname] || 29;
    const bfSid = bfSportId(sname);
    const pinLigenLimit = Math.min(o.pinLigen || 10, 50);
    const sampleLimit = o.sampleLimit || 3;
    const compLimit = Math.min(o.compLimit || 40, 60);
    const compBudget = o.bfBudget || 400;
    const kw = String(o.kw || '').toLowerCase();
    if (o.kw) log('Opts: kw="' + o.kw + '" (JSON oder Reinnamen)');

    const compactMkt = m => ({
      type: m.type, period: m.period || 0,
      line: (m.line ?? m.points ?? null),
      prices: (m.prices || []).slice(0, 6).map(p => ({
        desig: p.designation || 'p' + (p.participantId ?? p.id ?? '?'),
        points: p.points ?? p.line ?? null,
        price: p.price
      }))
    });

    const out = {
      sport: sname,
      meta: { pinSid, bfSid, ts: new Date().toISOString() },
      pin: { leagues: [], types: {} },
      bf: { comps: [], marketCatalog: [] },
      match: null
    };
    const typeCount = {};

    // ----- PIN: Ligen -> Matchups (inkl. Specials) -> straight-Typen (Sample) -----
    log('PIN: Sport=' + sname + ' (sid ' + pinSid + ')');
    const leagues = (await pinGet('/sports/' + pinSid + '/leagues').catch(e => {
      log('  PIN-Ligen FEHLER: ' + e); return [];
    })) || [];
    log('  Ligen: ' + leagues.length);
    for (const L of leagues.slice(0, pinLigenLimit)) {
      const mus = (await pinGet('/leagues/' + L.id + '/matchups').catch(() => null)) || [];
      const real = mus.filter(m => m.type === 'matchup' && !m.parentId);
      const specials = mus.filter(m => m.type === 'special');
      const types = {};
      let fetched = 0;
      for (const mu of real.slice(0, sampleLimit)) {
        const pr = (await pinGet('/matchups/' + mu.id + '/markets/straight').catch(() => null)) || [];
        // Related-Maerkte (z.B. Double Chance, HT/FT-Varianten, Corners-O/U) sind
        // fuer neue Markttypen relevant und gehoeren in die Typen-Statistik.
        const rl = (await pinGet('/matchups/' + mu.id + '/markets/related').catch(() => null)) || [];
        const allM = pr.concat(Array.isArray(rl) ? rl : []);
        if (!allM.length) continue;
        fetched++;
        for (const m of allM) {
          if (m && String(m.matchupId) !== String(mu.id)) continue;
          const t = String(m.type || '(ohne Typ)') + '|p' + (m.period || 0);
          types[t] = types[t] || { n: 0, lines: {} };
          types[t].n++;
          // PIN legt die Linie in prices[].points (z.B. 2.5=Sets, 21.5=Games)
          const ln = m.line ?? m.points ??
            ((m.prices || []).find(p => p.points != null) || {}).points ?? null;
          // Linien als Schluessel sammeln (z.B. 2.5=Set-Total, 21.5/22.5=Games-Total)
          if (ln !== null && ln !== undefined) {
            const lk = String(ln);
            types[t].lines[lk] = (types[t].lines[lk] || 0) + 1;
          }
        }
      }
      // Special-Namen dieser Liga (fuer neue Markttypen wie z.B. Corners-Winner)
      const specNames = {};
      specials.forEach(s => {
        const nm = String(s.name || '');
        if (nm) specNames[nm] = (specNames[nm] || 0) + 1;
      });
      Object.keys(types).forEach(k => {
        typeCount[k] = typeCount[k] || { n: 0, lines: {} };
        typeCount[k].n += types[k].n;
        Object.keys(types[k].lines || {}).forEach(lk => {
          typeCount[k].lines[lk] = (typeCount[k].lines[lk] || 0) + types[k].lines[lk];
        });
      });
      out.pin.leagues.push({
        id: L.id, name: L.name, matchups: real.length, specials: specials.length,
        sampled: fetched, types,
        firstSpecials: specials.slice(0, 6).map(s => ({
          id: s.id, parentId: s.parentId,
          n: (s.participants || []).length, name: s.name
        }))
      });
      await sleep(30);
    }
    out.pin.types = typeCount;

    // ----- BF: COMPs + samtliche Marktnamen je COMP (Katalog der Sport) -----
    log('BF: Sport=' + sname + ' (sid ' + bfSid + ') Budget=' + compBudget);
    const walk = await bfWalk({ sport: sname, budget: compBudget, onLog: log });
    const mktNames = {};
    const comps = [];
    for (const c of (walk.found || []).slice(0, compLimit)) {
      if (!String(c.id).startsWith('COMP:')) continue;
      const j = await bfLeagueMarkets(c.id).catch(() => null);
      if (!j || !j.nodes) continue;
      const nm = [...new Set(j.nodes.filter(n => n.nodeType === 'MARKET').map(bfMktName).filter(Boolean))];
      nm.forEach(n => mktNames[n] = (mktNames[n] || 0) + 1);
      comps.push({ id: c.id, name: c.name, events: c.count || 0, markets: nm });
      await sleep(30);
    }
    out.bf.comps = comps;
    out.bf.marketCatalog = Object.keys(mktNames).sort().map(n => ({ name: n, comps: mktNames[n] }));
    log('  COMPs: ' + comps.length + ', BF-Marktnamen: ' + out.bf.marketCatalog.length);

    // ----- Match-Verortung (kw) auf PIN- und BF-Seite -----
    if (kw) {
      log('  KW-Suche nach: ' + kw);
      for (const L of leagues) {
        const mus = (await pinGet('/leagues/' + L.id + '/matchups').catch(() => null)) || [];
        const hit = mus.find(m => m.type === 'matchup' && !m.parentId &&
          (m.participants || []).some(p => (p.name || '').toLowerCase().includes(kw)));
if (!hit) continue;
        // Probe: mehr Endpunkt-Varianten durchprobieren und jeden Markt-Knoten
        // erfassen (key, period, type, isAlternate, status, Preise). key ist KEIN
        // Endpunkt, sondern das KLASSEN-Kennzeichen "s;0;ou;22.5" (s=straight?
        // Sport-Marktklasse, 0=ganzes Spiel/period, ou=over-under, 22.5=Linie).
        const probeDefs = [
          // Pfade, die die PIN-Web-Oberflaeche selbst aufruft (aus CSP-Reports der
          // Pinnacle-Seite sichtbar): straight, related/related-straight, lg-markets.
          ['straight', '/matchups/' + hit.id + '/markets/straight'],
          ['straight+alts', '/matchups/' + hit.id + '/markets/straight?includeAlts=true'],
          ['related', '/matchups/' + hit.id + '/markets/related'],
          ['related/straight', '/matchups/' + hit.id + '/markets/related/straight'],
          ['related-ohneMarkets', '/matchups/' + hit.id + '/related'],
          ['related+alts', '/matchups/' + hit.id + '/markets/related?includeAlts=true'],
          ['list', '/matchups/' + hit.id + '/markets'],
          ['special', '/matchups/' + hit.id + '/markets/special'],
          ['lg-related', '/leagues/' + L.id + '/markets/related'],
          ['lg-straight', '/leagues/' + L.id + '/markets/straight'],
          ['lg-matchups', '/leagues/' + L.id + '/matchups'],
        ];
        const keysFound = new Map();   // key -> { alt, prices, types{}, period, status, srcs }
        const bestOfs = new Set();     // "3"-Hinweise je Quelle
        const teasers = new Set();     // Quellen mit altTeaser
        const probeLog = [];
        const walkKey = (needle, isArr, src) => {
          if (Array.isArray(needle)) { needle.forEach(x => walkKey(x, true, src)); return; }
          if (!needle || typeof needle !== 'object') return;
          if (needle.key && isArr && String(needle.key).startsWith('s;')) {
            const k = String(needle.key);
            const parts = k.split(';');
            const rec = keysFound.get(k) || {
              alt: false, period: parts[1] || '', types: {}, statuses: '', prices: 0, srcs: new Set()
            };
            if (needle.isAlternate) rec.alt = true;
            rec.prices = Math.max(rec.prices, Array.isArray(needle.prices) ? needle.prices.length : 0);
            if (needle.type) rec.types[needle.type] = (rec.types[needle.type] || 0) + 1;
            if (needle.status) rec.statuses += (rec.statuses && ';') + needle.status;
            rec.srcs.add(src);
            keysFound.set(k, rec);
          }
          if (needle.bestOfX != null) bestOfs.add('Bo' + needle.bestOfX + ' via ' + src);
          if (needle.altTeaser === true) teasers.add(src);
          Object.values(needle).forEach(v => walkKey(v, false, src));
        };
        for (const [d, p] of probeDefs) {
          const raw = await pinGet(p).catch(() => null);
          if (raw == null) { probeLog.push(d + ': leer/404'); continue; }
          probeLog.push(d + ': ' + (Array.isArray(raw) ? raw.length + ' Eintraege' : 'Objekt'));
          walkKey(raw, true, d);
        }
        log('  PIN-Probe-Pfade: ' + probeLog.join(' | '));
        if (bestOfs.size) log('  PIN bestOfX (echte Matchstruktur): ' + [...bestOfs].join(' | '));
        if (teasers.size) log('  PIN altTeaser aktiv: ' + [...teasers].join(' | '));
        if (keysFound.size) {
          log('  PIN key-Knoten (' + keysFound.size + '):');
          [...keysFound.entries()].sort().forEach(([k, r]) => log(
            '    ' + k + ' | p=' + (r.period || '?') + ' | alt=' + (r.alt ? 'ja' : 'nein') +
            ' | ' + r.prices + ' Preise | type=' + (Object.keys(r.types).join(',') || '-') +
            (r.statuses ? ' | status=' + r.statuses : '') + ' | via ' + [...r.srcs].join('/')));
        } else {
          log('  PIN key-Knoten: keine (kein s;...-Knoten unter: ' +
            probeDefs.map(d => d[0]).join(' | ') + ')');
        }
        // Klassische Ausgabe: straight + related je Quelle
        const pr = (await pinGet('/matchups/' + hit.id + '/markets/straight').catch(() => null)) || [];
        const relM = (await pinGet('/matchups/' + hit.id + '/markets/related').catch(() => null)) || [];
        const relL = (await pinGet('/leagues/' + L.id + '/markets/related').catch(() => null)) || [];
        const isOwn = a => (Array.isArray(a) ? a : [])
          .filter(m => !m || String(m.matchupId) === String(hit.id));
        const rl = (isOwn(relL).length ? isOwn(relL) : isOwn(relL).concat(relM));
        log('  PIN-Match: ' + (hit.participants || []).map(p => p.name).join(' v ') +
          ' -> ' + pr.length + ' straight + ' + rl.length + ' related (League-Source: ' +
          (isOwn(relL).length ? 'ja' : 'nein') + ')');
        const showM = (m, src) => {
          const ln = m.line ?? m.points ??
            ((m.prices || []).find(p => p.points != null) || {}).points;
          const desigN = (m.prices || []).map(p =>
            (p.designation || 'p' + (p.participantId ?? p.id ?? '?')) +
            (p.points != null ? '/' + p.points : '') + '=' + p.price).join(' ');
          log('    PIN[' + src + '] ' + (m.type || '?') + '|p' + (m.period || 0) +
            (m.name ? ' name=' + m.name : '') +
            (ln !== null && ln !== undefined ? ' line=' + ln : '') +
            (desigN ? ' [' + desigN + ']' : ''));
        };
        pr.forEach(m => showM(m, 'straight'));
        isOwn(relL).forEach(m => showM(m, 'relatedL'));
        (isOwn(relL).length ? [] : relM).forEach(m => showM(m, 'relatedM'));
        out.match = {
          pin: {
            id: hit.id, leagueId: L.id,
            name: (hit.participants || []).map(p => p.name).join(' v '),
            straight: pr.map(compactMkt),
            relatedLeague: isOwn(relL).map(compactMkt),
            relatedMatchup: (isOwn(relL).length ? [] : relM).map(compactMkt)
          },
          bf: null
        };
        break;
      }
      const bfEv = (walk.events || []).find(e => e.name.toLowerCase().includes(kw));
      if (bfEv) {
        const j = await bfLeagueMarkets(bfEv.compId).catch(() => null);
        const markets = (j && j.nodes) ? j.nodes.filter(n => n.nodeType === 'MARKET') : [];
        const evName = bfEventNames(j || { nodes: [], edges: [] }, markets);
        const mine = markets.filter(m =>
          (evName[m.nodeId.split(':')[1]] || '').toLowerCase().includes(kw));
        out.match = out.match || {};
        const bfMktNames = [...new Set(mine.map(bfMktName))].filter(Boolean);
        out.match.bf = { event: bfEv.name, compId: bfEv.compId, markets: bfMktNames };
        log('  BF-Event: ' + bfEv.name + ' -> ' + bfMktNames.length + ' Maerkte');
        // Alle Märkte des Events mit Runners (Linien/Handicap + Preise) anzeigen.
        bfEachMarket(await bfFetchChunks(bfChunkIds(mine)), (mk, e) => {
          const nm = bfMktName(mk) || '';
          const tmp = (mk.runners || []).map(r => {
            const hc = r.handicap ?? (r.description && r.description.handicap) ?? '';
            const b = r.exchange && r.exchange.availableToBack;
            const l = r.exchange && r.exchange.availableToLay;
            return (r.runnerName || (r.description && r.description.runnerName) || '?') +
              (hc !== '' && hc != null ? '(' + hc + ')' : '') +
              ': back=' + (b && b[0] ? b[0].price : '-') +
              ' lay=' + (l && l[0] ? l[0].price : '-');
          });
          if (tmp.length) log('    BF-Runner [' + nm + ']: ' + tmp.join(' | '));
        });
      } else {
        log('  BF: kein Event mit "' + kw + '" im Baum');
      }
    }

    // ----- Log-Zusammenfassung -----
    log('=== BAUM (' + sname + ') | PIN-Ligen: ' + out.pin.leagues.length +
      ' | PIN-Typen: ' + Object.keys(out.pin.types).length +
      ' | BF-COMPs: ' + out.bf.comps.length + ' | BF-Marktnamen: ' + out.bf.marketCatalog.length);
    Object.keys(out.pin.types).sort().forEach(k => {
      const lines = Object.keys(out.pin.types[k].lines || {});
      log('  PIN ' + k + ': x' + out.pin.types[k].n +
        (lines.length ? ' | Linien: ' + lines.slice(0, 30).join(', ') : ''));
    });
    if (out.bf.marketCatalog.length) log('  BF: ' + out.bf.marketCatalog.map(c => c.name).join(' | '));

    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'sport_tree_' + sname + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log('Download gestartet: sport_tree_' + sname + '.json');
    return out;
  };

  // ---------- Konsole-Helper: Voll-Dump eines konkreten Matches ----------
  // __probeMatch(<PIN-Matchup-ID>, <COMP oder Name>, [opts]) -> komplette
  // Markt-Struktur EINES Spiels auf beiden Seiten in einem Rutsch (statt je
  // Wettart einzeln zu proben): PIN alle Endpunkte (straight + includeAlts,
  // related + related/straight, special, Liga-straight/-related) inkl. key/
  // isAlternate/status, und BF das passende Event mit allen Marktnamen +
  // Runner-Dump (handicap/back/lay). Ausgabe: Log-Zusammenfassung + JSON-Download
  // match_dump_<mid>.json. opts: {"alts":true,"specials":12,"download":true}.
  unsafeWindow.__probeMatch = async (mid, comp, optsJson) => {
    const log = devlog;
    const pinT = (path, ms) => Promise.race(
      [pinGet(path).catch(() => null), sleep(ms || 5000).then(() => null)]);
    let o = {};
    try {
      const raw = optsJson == null ? '' : String(optsJson).trim();
      if (raw) o = raw.startsWith('{') ? JSON.parse(raw) : {};
    } catch (e) { o = {}; }
    if (!mid) return log('__probeMatch(<PIN-Matchup-ID>, <COMP oder Name>[, {opts}]) — z.B. __probeMatch(1633236740, "COMP:129")');
    const wantAlts = o.alts !== false;
    const specMax = o.specials || 12;

    const out = {
      sport: null, meta: { ts: new Date().toISOString() },
      pin: { id: mid, name: '', leagueId: '', status: null, keys: {}, markets: [], specials: [] },
      bf: { comp: comp || '', event: null, catalog: [], markets: [] },
      match: null
    };

    // ----- PIN-Seite: Matchup + Liga + alle Markt-Endpunkte -----
    const mu = await pinT('/matchups/' + mid);
    if (!mu) return log('PIN: Matchup ' + mid + ' nicht gefunden');
    const pinTeams = (mu.participants || []).map(p => p.name).filter(Boolean);
    out.pin.name = pinTeams.join(' v ') || ('id=' + mid);
    out.pin.leagueId = mu.leagueId || (mu.league && mu.league.id) || '';
    out.pin.status = mu.status;
    const SID = (mu.sportId) || '';
    const PIN_SPORT_SIDS = { 29: 'soccer', 33: 'tennis', 4: 'basketball', 3: 'baseball',
      18: 'handball', 34: 'volleyball', 8: 'cricket', 26: 'rugby_league',
      27: 'rugby_union', 6: 'boxing', 22: 'mma', 32: 'table_tennis' };
    out.sport = PIN_SPORT_SIDS[SID] || String(SID);
    log('=== ' + out.pin.name + ' (Liga ' + (out.pin.leagueId || '?') +
      ', status=' + JSON.stringify(mu.status) + ' isLive=' + mu.isLive +
      ' totalMarketCount=' + mu.totalMarketCount + ') ===');
    if (!out.pin.leagueId) log('  (keine Liga-ID — Special-/Liga-Scans uebersprungen)');

    const probeDefs = [
      ['straight', '/matchups/' + mid + '/markets/straight'],
      ['related', '/matchups/' + mid + '/markets/related'],
      ['related/straight', '/matchups/' + mid + '/markets/related/straight'],
      ['special', '/matchups/' + mid + '/markets/special'],
      ['related-ohneMarkets', '/matchups/' + mid + '/related'],
    ];
    if (wantAlts) probeDefs.splice(1, 0,
      ['straight+alts', '/matchups/' + mid + '/markets/straight?includeAlts=true'],
      ['related+alts', '/matchups/' + mid + '/markets/related?includeAlts=true']);
    const keysFound = new Map();
    const bestOfs = new Set();
    const teasers = new Set();
    const probeLog = [];
    const walkKey = (needle, isArr, src) => {
      if (Array.isArray(needle)) { needle.forEach(x => walkKey(x, true, src)); return; }
      if (!needle || typeof needle !== 'object') return;
      if (needle.key && isArr && String(needle.key).startsWith('s;')) {
        const k = String(needle.key);
        const parts = k.split(';');
        const rec = keysFound.get(k) || {
          alt: false, period: parts[1] || '', types: {}, statuses: '', prices: 0, srcs: new Set()
        };
        if (needle.isAlternate) rec.alt = true;
        rec.prices = Math.max(rec.prices, Array.isArray(needle.prices) ? needle.prices.length : 0);
        if (needle.type) rec.types[needle.type] = (rec.types[needle.type] || 0) + 1;
        if (needle.status) rec.statuses += (rec.statuses && ';') + needle.status;
        rec.srcs.add(src);
        keysFound.set(k, rec);
      }
      if (needle.bestOfX != null) bestOfs.add('Bo' + needle.bestOfX + ' via ' + src);
      if (needle.altTeaser === true) teasers.add(src);
      Object.values(needle).forEach(v => walkKey(v, false, src));
    };
    for (const [d, p] of probeDefs) {
      const raw = await pinT(p);
      if (raw == null) { probeLog.push(d + ': leer/404'); continue; }
      probeLog.push(d + ': ' + (Array.isArray(raw) ? raw.length + ' Eintraege' : 'Objekt'));
      walkKey(raw, true, d);
    }
    log('  PIN-Probe-Pfade: ' + probeLog.join(' | '));
    if (bestOfs.size) log('  PIN bestOfX: ' + [...bestOfs].join(' | '));
    if (teasers.size) log('  PIN altTeaser aktiv: ' + [...teasers].join(' | '));
    // Related-Liste: welche Matchups (IDs+Teams) haengen an diesem Spiel?
    const relList = await pinT('/matchups/' + mid + '/related');
    if (Array.isArray(relList) && relList.length) {
      log('  PIN Related-Liste (' + relList.length + '):');
      relList.slice(0, 25).forEach(x => log('    id=' + x.id + ' type=' + (x.type || '?') +
        ' parent=' + x.parentId + ' | ' + (x.participants || []).map(p => p.name).join(' v ')));
      const relMids = new Set(relList.map(x => String(x.id)));
      if (relMids.has(String(mid))) log('  Related enthaelt mid=' + mid + ' selbst');
      [...relMids].forEach(rid => log('  Related-ID: ' + rid));
    } else {
      log('  PIN Related-Liste: leer/nicht vorhanden');
    }
    if (keysFound.size) {
      out.pin.keys = Object.fromEntries([...keysFound.entries()].sort().map(([k, r]) => [k, {
        period: r.period || '', alt: r.alt, types: Object.keys(r.types), status: r.statuses || '',
        prices: r.prices, srcs: [...r.srcs]
      }]));
      log('  PIN key-Knoten (' + keysFound.size + '):');
      [...keysFound.entries()].sort().forEach(([k, r]) => log(
        '    ' + k + ' | p=' + (r.period || '?') + ' | alt=' + (r.alt ? 'ja' : 'nein') +
        ' | ' + r.prices + ' Preise | type=' + (Object.keys(r.types).join(',') || '-') +
        (r.statuses ? ' | status=' + r.statuses : '') + ' | via ' + [...r.srcs].join('/')));
    } else {
      log('  PIN key-Knoten: keine (kein s;...-Knoten in: ' + probeDefs.map(d => d[0]).join(' | ') + ')');
    }

    // Voll-Maerkte sammeln (straight + related + Liga-Sources), nur eigener matchupId
    const collect = (raw, src) => {
      const isOwn = m => m && String(m.matchupId) === String(mid);
      (Array.isArray(raw) ? raw : []).filter(isOwn).forEach(m => {
        out.pin.markets.push({
          src,
          type: m.type || '?', period: m.period || 0,
          name: m.name || '', description: m.marketName || '',
          key: m.key || '', alt: m.isAlternate === true, status: m.status || '',
          line: m.line ?? m.points ?? null,
          special: (m.special && { id: m.special.id, name: m.special.name, description: m.special.description }) || null,
          prices: (m.prices || []).slice(0, 12).map(p => ({
            desig: p.designation || 'p' + (p.participantId ?? p.id ?? '?'),
            points: p.points ?? p.line ?? null, price: p.price
          }))
        });
      });
    };
    const pr = await pinT('/matchups/' + mid + '/markets/straight');
    const relM = await pinT('/matchups/' + mid + '/markets/related');
    collect(pr, 'straight');
    collect(relM, 'related');
    if (out.pin.leagueId) {
      const lgS = await pinT('/leagues/' + out.pin.leagueId + '/markets/straight');
      collect(lgS, 'lg-straight');
      const relL = await pinT('/leagues/' + out.pin.leagueId + '/markets/related');
      collect(relL, 'relatedL');
      // Corner-Inventur: ALLE Corners-Maerkte (6.5-13.5) aus jeder Quelle inkl.
      // matchupId, damit man sofort sieht, wo die GUI-Corners liegen.
      const cornerInv = [];
      const addCor = (raw, src) => {
        (Array.isArray(raw) ? raw : []).forEach(m => {
          if (m && m.type === 'total' && Number(m.period) === 0 &&
            (m.prices || []).some(p => cornerLine(p.points)))
            cornerInv.push(src + ' mu=' + m.matchupId + ' key=' + m.key +
              ' pts=' + JSON.stringify((m.prices || []).map(p => p.points)));
        });
      };
      addCor(pr, 'straight'); addCor(relM, 'related');
      addCor(lgS, 'lg-straight'); addCor(relL, 'relatedL');
      const relS = await pinT('/matchups/' + mid + '/markets/related/straight');
      addCor(relS, 'related/straight');
      if (cornerInv.length) {
        log('  PIN Corner-Inventur (' + cornerInv.length + '):');
        cornerInv.forEach(c => log('    ' + c));
      } else {
        log('  PIN Corner-Inventur: keine (6.5-13.5) in straight/related/lg-straight/relatedL');
      }
      if (!relL || !(Array.isArray(relL) ? relL : []).some(m => String(m.matchupId) === String(mid))) {
        collect(relM, 'relatedM');
      }
      const mus = await pinT('/leagues/' + out.pin.leagueId + '/matchups');
      const specs = (Array.isArray(mus) ? mus : [])
        .filter(s => s.type === 'special' && String(s.parentId) === String(mid));
      out.pin.specials = specs.slice(0, specMax).map(s => ({
        id: s.id, name: s.name,
        desc: (s.special && s.special.description) || '',
        n: (s.participants || []).length,
        participants: (s.participants || []).slice(0, 12).map(p => p.name)
      }));
      log('  PIN-Specials dieses Matches: ' + out.pin.specials.length);
      for (const s of out.pin.specials) log('    spec ' + s.id + ' | "' + s.name + '" | desc="' +
        s.desc + '" | Teiln(' + s.n + '): ' + s.participants.join(' | '));
      if (!out.pin.specials.length) log('    (keine Specials zugeordnet)');
    }
    const uniqTypes = [...new Set(out.pin.markets.map(m => m.type + '|p' + m.period))];
    log('  PIN Markt-Typen gesamt (' + out.pin.markets.length + ' Maerkte): ' +
      (uniqTypes.join(' ;; ') || 'keine'));
    const typeLine = {};
    for (const m of out.pin.markets) {
      const k = m.type + '|p' + m.period;
      if (m.line !== null && m.line !== undefined)
        typeLine[k] = (typeLine[k] || new Set());
      if (m.line !== null && m.line !== undefined) typeLine[k].add(String(m.line));
    }
    Object.keys(typeLine).forEach(k => log('    ' + k + ' | Linien: ' +
      [...typeLine[k]].join(', ')));

    // ----- BF-Seite: COMP -> Event (Teams) -> Marktnamen + Runner -----
    if (comp) {
      const node = await bfCompId(comp);
      if (!node) {
        log('BF: keine COMP-Id gefunden fuer "' + comp + '"');
      } else {
        out.bf.comp = node;
        const j = await bfLeagueMarkets(node);
        if (!j || !j.nodes || !j.nodes.length) {
          log('BF: keine Daten fuer ' + node);
        } else {
          const mname = bfMktName;
          const names = [...new Set(j.nodes.filter(n => n.nodeType === 'MARKET')
            .map(mname))].filter(Boolean);
          out.bf.catalog = names;
          log('BF Marktnamen ' + node + ' (' + names.length + '):\n' + names.join('\n'));
          const markets = j.nodes.filter(n => n.nodeType === 'MARKET');
          const evName = bfEventNames(j, markets);
          const byEv = {};
          markets.forEach(m => {
            const en = evName[m.nodeId.split(':')[1]] || '';
            (byEv[en] = byEv[en] || []).push(m);
          });
          // Event per Team-Match finden (evMatch ist strikt; Teil-Fallback ueber norm)
          let evHit = null;
          if (pinTeams.length === 2) {
            const cands = Object.keys(byEv).filter(en => en.includes(' v ') || en.includes(' vs '));
            const normT = pinTeams.map(norm);
            evHit = cands.find(en => evMatch(pinTeams, en)) ||
              cands.find(en => {
                const halves = norm(en).split(' v ').filter(Boolean);
                return halves.length === 2 &&
                  halves.every(h => normT.some(t => t === h || t.includes(h) || h.includes(t)));
              }) || null;
          }
          if (!evHit && pinTeams.length) {
            evHit = Object.keys(byEv).find(en => pinTeams.some(t =>
              norm(en).includes(norm(t).slice(0, Math.max(4, Math.floor(norm(t).length / 2)))))) || null;
          }
          if (!evHit) {
            log('BF: kein Event zu "' + out.pin.name + '" gefunden (COMP hat ' +
              Object.keys(byEv).length + ' Events)');
          } else {
            out.bf.event = evHit;
            log('BF-Event: ' + evHit + ' (' + byEv[evHit].length + ' Maerkte)');
            const evMarkets = byEv[evHit];
            const bms = await bfFetchChunks(bfChunkIds(evMarkets));
            bfEachMarket(bms, mk => {
              const nm = mname(mk) || '';
              const runners = (mk.runners || []).map(r => {
                const b = r.exchange && r.exchange.availableToBack;
                const l = r.exchange && r.exchange.availableToLay;
                return {
                  name: (r.runnerName || (r.description && r.description.runnerName) || '?'),
                  handicap: r.handicap ?? (r.description && r.description.handicap) ?? null,
                  back: b && b[0] ? b[0].price : null,
                  lay: l && l[0] ? l[0].price : null
                };
              });
              out.bf.markets.push({ marketId: mk.marketId, name: nm, status: mk.state && mk.state.status,
                runners });
              if (runners.length) log('    BF-Runner [' + nm + ']: ' + runners.map(r =>
                r.name + (r.handicap !== null && r.handicap !== undefined ? '(' + r.handicap + ')' : '') +
                ' back=' + (r.back ?? '-') + ' lay=' + (r.lay ?? '-')).join(' | '));
            });
            if (!out.bf.markets.length) log('    (keine Runner-Preise abrufbar)');
          }
        }
      }
    } else {
      log('BF: COMP leer — nur PIN-Seite wird geprueft.');
    }

    out.match = {
      pin: { id: mid, name: out.pin.name, leagueId: out.pin.leagueId, markets: out.pin.markets },
      bf: out.bf.event ? { event: out.bf.event, comp: out.bf.comp, markets: out.bf.markets } : null
    };
    const dl = o.download !== false;
    if (dl) {
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'match_dump_' + mid + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }
    log('PROBE FERTIG' + (dl ? ' — Download match_dump_' + mid + '.json' : ''));
    return out;
  };

  // ---------- Konsole-Helper: Gezielte COMP-Suche ----------
  // __bfsearch('damallsvenskan', 'sport') -> nur COMPs, deren Name das
  // Keyword enthaelt; kompakt geloggt (kein Events-Dump). Mehrere Keywords
  // per Komma: __bfsearch('mx women, liga fementen, mexico', 'sport')
  unsafeWindow.__bfsearch = async (kw, sport, budgetIn) => {
    const log = devlog;
    const needles = String(kw||'').split(',').map(k => k.trim().toLowerCase()).filter(Boolean);
    if (!needles.length) { log('__bfsearch(<keyword>, <sport>, <budget>) — z.B. __bfsearch("damall", "sport", 1500)'); return; }
    const out = await bfWalk({
      sport,
      budget: budgetIn || 1500,
      maxDepth: 12,
      wantGroup: n => true,
      wantComp: n => {
        const l = (n||'').toLowerCase();
        return needles.some(k => l.includes(k));
      },
    });
    const hits = out.found;
    log('Treffer (' + hits.length + '):');
    hits.forEach(h => log('  ' + h.id + ' | ' + h.name + ' | ' + h.count + ' Events'));
    if (!hits.length) log('Kein COMP mit "' + kw + '" gefunden' +
      (out.budgetHit ? ' (Budget ' + out.calls + ' erreicht, ggf. unvollstaendig)' : ''));
  };

  // ---------- Konsole-Helper: Page-First COMP-Discovery ----------
  // __bfcapture('stop') -> beendet Interception
  // __bfcapture('dump') -> zeigt gesammelte COMPs
  // __bfcapture()       -> startet Interception (dann auf BF-Seite navigieren)
  unsafeWindow.__bfcapture = (cmd) => {
    const log = devlog;
    if (window.__bfCaptureHook) {
      if (cmd === 'stop') {
        window.__bfCaptureIds = null;
        window.fetch = window.__bfCaptureOrigFetch;
        window.__bfCaptureHook = null;
        log('Interceptor gestoppt.');
        return;
      }
      if (cmd === 'dump') {
        const comps = Array.from(window.__bfCaptureIds || []);
        log('Erfasste COMPs: ' + comps.length);
        comps.forEach(c => log('  ' + c));
        return comps;
      }
    }
    if (cmd === 'stop') { log('Kein Interceptor aktiv.'); return; }

    const ids = new Set();
    window.__bfCaptureIds = ids;
    window.__bfCaptureOrigFetch = window.fetch;

    // COMPs aus bynode-URL extrahieren
    const extract = url => {
      try {
        const u = new URL(url);
        if (!u.pathname.includes('bynode')) return;
        const nodeIds = u.searchParams.get('nodeIds') || '';
        const parts = nodeIds.split(',');
        for (const p of parts) {
          const m = p.match(/^(COMP):(\d+)/);
          if (m) ids.add(m[1] + ':' + m[2]);
        }
      } catch (e) {}
    };

    // fetch-Interceptor
    window.fetch = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
      extract(url);
      return window.__bfCaptureOrigFetch.apply(window, args);
    };

    // XHR-Interceptor (BF nutzt teils XHR)
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      extract(url);
      return origOpen.apply(this, [method, url, ...rest]);
    };

    window.__bfCaptureHook = true;
    log('Interceptor aktiv — jetzt auf BF-Seite navigieren (Sport-Seiten klicken).\n' +
        'Fertig: __bfcapture("dump") um COMPs zu sehen, __bfevents("sport") nutzt sie automatisch.');
  };

  // ---------- Konsole-Helper: BF-Debug (Knoten-Struktur analysieren) ----------
  unsafeWindow.__bfdebug = async (nodeId, dist) => {
    const log = devlog;
    log('Debug: ' + nodeId + ' (dist=' + (dist||6) + ')');
    const r = await bfBynode(nodeId, 'MENU,EVENT', dist||6, 500).catch(e => { log('ERROR: ' + e); return null; });
    if (!r) return;
    const nodes = r.nodes || [];
    log('Gesamt: ' + nodes.length + ' Knoten');
    const byType = {};
    for (const n of nodes) {
      const t = String(n.nodeId||n.id).split(':')[0];
      if (!byType[t]) byType[t] = [];
      byType[t].push(n);
    }
    for (const [t, arr] of Object.entries(byType)) {
      log(t + ': ' + arr.length + ' Knoten');
      arr.slice(0, 15).forEach(n => log('  ' + (n.nodeId||n.id) + ' | ' + (n.name||'')));
    }
    // Alle EVENTs anzeigen (auch ohne " v ")
    const events = byType['EVENT'] || [];
    if (events.length > 0) {
      log('--- Alle EVENT-Namen (erste 30):');
      events.slice(0, 30).forEach(e => log('  ' + e.name));
    }
  };

  // ---------- Konsole-Helper: Live-Markt-Odds (byMarket, volle Leiter) ----------
  // __bfmkt("260961195") -> liest den Markt live von der bymarket-API und loggt
  // die volle Back/Lay-Leiter jedes Runners (reale Einstiegspreise ohne Rollup).
  unsafeWindow.__bfmkt = async (marketId, optsJson) => {
    const log = devlog;
    const id = String(marketId).includes('.') ? String(marketId) : '1.' + marketId;
    let o = {};
    try { const raw = String(optsJson || '').trim(); if (raw) o = JSON.parse(raw); } catch (e) { o = {}; }
    log('Live-Markt: ' + id + (o.rollupLimit ? ' (rollup ' + o.rollupModel + ':' + o.rollupLimit + ')' : ' (kein Rollup)'));
    const q = { currencyCode: 'EUR', locale: 'en_GB', marketIds: [id],
      types: 'MARKET_STATE,RUNNER_STATE,RUNNER_EXCHANGE_PRICES_BEST,RUNNER_DESCRIPTION,EVENT,MARKET_DESCRIPTION' };
    if (o.rollupLimit) { q.rollupLimit = String(o.rollupLimit); q.rollupModel = o.rollupModel || 'STAKE'; }
    const r = await bfJson(() => 'https://www.betfair.com/www/sports/exchange/readonly/v1/bymarket?' +
      bfQ(q), 0).catch(e => { log('ERROR: ' + e); return null; });
    if (!r) { log('Keine Antwort.'); return; }
    const mkts = [];
    ((r.eventTypes || []) || []).forEach(et => ((et.eventNodes || []) || []).forEach(e =>
      ((e.marketNodes || []) || []).forEach(mk => mkts.push(mk))));
    if (!mkts.length) { log('Keine Markt-Knoten.'); return; }
    const mk = mkts[0];
    log('Markt: ' + bfMktName(mk) + ' | status=' +
      JSON.stringify((mk.state || {}).status) + ' inplay=' + !!(mk.state || {}).inplay);
    const fmtL = arr => (arr && arr.length ? arr.map(p => p.price + 'x' + p.size).join(', ') : '(leer)');
    for (const ru of (mk.runners || [])) {
      log('  ' + ((ru.description && ru.description.runnerName) || ru.runnerName || ru.selectionId) +
        '\n    back: ' + fmtL((ru.exchange && ru.exchange.availableToBack) || []) +
        '\n    lay : ' + fmtL((ru.exchange && ru.exchange.availableToLay) || []));
    }
  };

  // ---------- Konsole-Helper: Warum kein Arb? (echte Scan-Pipeline, alle Kanaele) ----------
  // __why(mid, comp) laedt fuer die Liga des PIN-Spiels die ECHTE Pipeline-Daten
  // (pinGames + bfLays — exakt die Funktionen, die auch scanLeague nutzt) und zeigt
  // fuer dieses eine Spiel je Kanal: welche PIN-Legs existieren, welche BF-Lays
  // existieren und wo die Rechnung abgebrochen ist (kein PIN-Eintrag, kein BF-Event,
  // fehlende PIN-Seite, kein Lay, Preis-Filter, kein Arb-Verhaeltnis). Eingabe:
  // mid = PIN-Matchup-ID (10-stellig), comp = BF-COMP (COMP:129 oder Name).
  unsafeWindow.__why = async (mid, comp, optsJson) => {
    const log = devlog;
    const pinT = (path, ms) => Promise.race(
      [pinGet(path).catch(() => null), sleep(ms || 6000).then(() => null)]);
    const o = {};
    try { const raw = String(optsJson || '').trim(); if (raw) Object.assign(o, JSON.parse(raw)); } catch (e) {}
    if (!mid) return log('__why(<PIN-Matchup-ID>, <COMP oder BF-Name>[, {opts}]) — z.B. __why(1633668843, "COMP:61")');
    // Pruefung soll IMMER Live-Daten zeigen, nicht den Stand des letzten Scans:
    // die Session-Caches (bfLays/fetchStraight/pinGames) werden geleert, damit
    // alle Abrufe in diesem Check frisch von PIN/Betfair kommen.
    straightCache.clear();
    bfLaysCache.clear();
    bfH2HCache.clear();
    log('WHY: Session-Caches geleert — Live-Daten statt Scan-Stand.');
    const out = { meta: { ts: new Date().toISOString(), mid, comp: String(comp || '') },
      pin: null, bf: null, channels: [], reasons: [] };
    // Tatsaechlich im Browser laufende Build-Version melden, damit der
    // Boost-Arb-Checker sofort erkennt, welcher Scan-Stand zugrunde liegt
    // (veraltetes Build im Tampermonkey = fehlende BF-Lay-Fixes).
    out.meta.version = String(VERSION || '?');
    log('WHY: Scanner-Build v' + out.meta.version +
      (typeof GM_info !== 'undefined' && GM_info && GM_info.script ?
        ' | Tampermonkey-Script v' + GM_info.script.version : ''));

    // ----- Schritt 1: PIN-Matchup -> Liga + Teams -----
    const mu = await pinT('/matchups/' + mid);
    if (!mu) { log('=== SCHRITT 1 FEHLT: PIN-Matchup ' + mid + ' nicht abrufbar (API?).'); return out; }
    const pinTeams = (mu.participants || []).map(p => p.name).filter(Boolean);
    const lid = mu.leagueId || (mu.league && mu.league.id) || '';
    // Vertrauenslevel-Daten: Liga-Name + Sportart (sportVonLiga) + live-Flag,
    // damit die GUI die Kombination (Spiel × Markt × Liga × Sportart) speichern kann.
    const lidName = LIGA_NAMEN[lid] || H2H_NAMEN[lid] || String(lid);
    // Sport-Routing: Die App kennt den Sport bereits aus der DB (Spielauswahl)
    // und sendet ihn als Override `o.sport`. Das ist zuverlaessiger als das
    // Yes-Namen-Raten via sportVonLiga — eine real 2-weite Liga (Boxen/MMA,
    // Rugby), deren Name den Regex nicht trifft oder die nicht exakt in
    // LIGA_NAMEN/H2H_NAMEN steht, lieferte sonst 'Soccer' und kippte damit
    // faelschlich in den 3-Wege-Pfad (PIN 2-Wege vs BF 3-Wege). Ohne Override
    // bleibt es beim bisherigen Namen-basierten Fallback.
    const lidSport = (typeof o.sport === 'string' && o.sport.trim())
      ? o.sport.trim() : sportVonLiga(lid);
    out.meta.league = lid; out.meta.leagueName = lidName; out.meta.sport = lidSport;
    out.meta.live = !!((mu.isLive) || (mu.status && String(mu.status).indexOf('live') !== -1) ||
      (mu.startTime && mu.isLive === undefined && Date.now() > new Date(mu.startTime).getTime()));
    log('=== WHY ' + mid + ' | ' + pinTeams.join(' v ') + ' | Liga ' + lid + ' (' + lidName +
      ', ' + lidSport + ')' + (out.meta.live ? ' LIVE' : '') + ' | status=' +
      JSON.stringify(mu.status) + ' ===');

    // Gemeinsamer Kanal-Builder (PIN-Back + BF-Lay + Begruendung).
    // quietNote (7. Param): Log-Zeile unterdruecken und stattdessen in die
    // Sammel-Liste `skipped` aufnehmen — der Kanal wird trotzdem gepusht
    // (Boost-Arb braucht die BF-Lays z.B. fuer Lay-Both), nur die Anzeige
    // wird nicht mit statischen Linien-Gap-Zeilen zugemuellt (v8.44.0).
    const skipped = [];
    const TEN_LOCK_KINDS = ['s51A', 's51B', 'sd15PlusA', 'sd15PlusB',
      's21A', 's21B', 's32A', 's32B', 'so45'];
    const add = (kind, pinBack, bfLay, pinTxt, bfTxt, extra, quietNote, xBack) => {
      const lockNote = TEN_LOCK_KINDS.indexOf(kind) >= 0 ?
        'Lock-Instrumente (Boost, kein Paarvergleich!)' : '';
      const reason = [];
      if (!pinBack) reason.push('KEIN PIN-Back' + (pinTxt ? ' (' + pinTxt + ')' : ''));
      if (bfLay == null) reason.push('KEIN BF-Lay' + (bfTxt ? ' [' + bfTxt + ']' : ''));
      if (pinBack && bfLay != null) {
        if (!isValidPrice(pinBack)) reason.push('PIN-Back ungueltig (' + pinBack + ')');
        else if (!isValidPrice(bfLay)) reason.push('BF-Lay ungueltig (' + bfLay + ')');
        else if (lockNote) reason.push(lockNote);
        else if (!arbDir(pinBack, bfLay)) reason.push('kein Arb: PIN ' + pinBack.toFixed(2) +
          ' > BF-Lay ' + bfLay.toFixed(2));
        else reason.push('ARB!');
      }
      const line = '  [' + kind + '] PIN=' + (pinBack != null ? pinBack.toFixed(2) : '-') +
        ' BF-Lay=' + (bfLay != null ? bfLay.toFixed(2) : '-') +
        (pinTxt ? ' (' + pinTxt + ')' : '') + (bfTxt ? ' [' + bfTxt + ']' : '') +
        (extra ? ' | ' + extra : '') + ' ==> ' + reason.join(' | ');
      if (quietNote) skipped.push(quietNote); else log(line);
      out.channels.push({ kind, pinBack: pinBack || null, bfLay: bfLay || null,
        pinSrc: pinTxt || '', bfSrc: bfTxt || '', reason,
        xBack: xBack || 0 });
    };

    // ----- Schritt 1b: H2H-Ligen (Boxen, Rugby, …) — 2-Wege-Pfad -----
    // PIN liefert hier nur Heim/Auswaerts (h.back = [a, b]), BF "Match Odds"
    // fuehrt oft 3 Runner inkl. Draw (bfH2H filtert den Draw raus -> r0/r1).
    // Der CS-Pfad (pinGames/bfLays) waere hier falsch: er emittiert 3-Wege-
    // Kinds (mo3 H/D/A), die der h2h-Scan (scanH2HLeague -> blA/blB) nie
    // erzeugt — der Boost-Check findet dann keine Legs.
    // 2-Wege-Sportarten (Boxen/MMA, Rugby, Tennis, …): PIN liefert nur Heim/
    // Auswaerts, BF "Match Odds" fuehrt aber oft einen Draw-Runner. Fallback:
    // Auch wenn die Liga noch NICHT in der H2H-Map steht (z.B. nicht gemappte
    // Boxing-Liga), darf sie nie in den 3-Wege-CS-Pfad (mo3 H/D/A inkl.
    // Unentschieden) rutschen — dort wuerde ein 2-Wege-Kampf faelschlich
    // gegen 3-Wege verglichen. sportVonLiga erkennt 2-Wege-Sportarten erklaert.
    const ZWEI_WEG_SPORT = new Set(['MMA', 'Rugby', 'Aussie Rules', 'Tennis',
      'Basketball', 'Baseball', 'Cricket', 'Ice Hockey', 'Volleyball',
      'Handball', 'Esports', 'American Football']);
    const isH2H = !!H2H[String(lid)] || ZWEI_WEG_SPORT.has(lidSport);
    if (isH2H) {
      const pinH = await pinH2H(lid, log, {}).catch(() => ({}));
      const h2 = pinH[mid];
      out.pin = { lid, games: Object.keys(pinH).length, present: !!h2, h2h: true };
      if (!h2) {
        log('=== KEIN PIN-Eintrag (h2h) fuer ' + mid + ' in Liga ' + lid +
          ' (pinH2H hielt ' + Object.keys(pinH).length + ' Spiele)');
        out.reasons.push('kein PIN-Eintrag in pinH2H (2-Wege-Pfad)');
        return out;
      }
      out.pin.h = { teams: h2.teams, back: h2.back, live: h2.live, st: h2.st };
      log('  PIN-Eintrag OK (h2h): back=' + h2.back.join('/') +
        ' live=' + !!h2.live + ' start=' + (h2.st || ''));
      const bfH = await bfH2H(comp, log).catch(() => ({ mo: [], sb: [], sw: [], ou: [], oe: [] }));
      // Tolerantes Event-Matching analog zum H2H-Scanner (findH/halfHit):
      // BF liefert bei Turnier-COMPs (Grand Slam, z.B. US Open „52 Events")
      // Event-Namen mit leichten Abweichungen zu PIN (Kurz-/Initial-Namen,
      // fehlende maskottchen). Das strikte evMatch wuerde hier zu leerem moH
      // fuehren und die Tennis-Satz-Score-Kanaele (s2/s5/sdPlus/sd5Plus) nie
      // erreichen. matched: erst exakt (teamMatch), dann Token-Subset je Halb-
      // seite, dann Nachname im Event-Halbnamen (wie der Scanner).
      const surnameH = t => {
        const ws = norm(t).split(' ').filter(w => w && !STOPW.has(w));
        return ws.length ? ws[ws.length - 1] : '';
      };
      const evTol = evName => {
        const halves = String(evName || '').split(/\s+v\s+/i).filter(Boolean);
        if (halves.length !== 2 || pinTeams.length < 2) return false;
        const halfHit = (team, half) => {
          if (teamMatch(team, half)) return true;
          const tt = toks(team);
          const ht = toks(half);
          let sub = true;
          for (const t of ht) if (!tt.has(t)) { sub = false; break; }
          if (sub) return true;
          const sn = surnameH(team);
          return !!sn && ht.has(sn);
        };
        return (halfHit(pinTeams[0], halves[0]) && halfHit(pinTeams[1], halves[1])) ||
               (halfHit(pinTeams[0], halves[1]) && halfHit(pinTeams[1], halves[0]));
      };
      const moH = (bfH.mo || []).filter(b => evTol(b.name));
      out.bf = { comp: String(comp), h2h: true, mo: (bfH.mo || []).length, forEvent: moH.length };
      if (!moH.length) {
        // Diagnose (v8.60.4): die ECHTEN BF-Event-Namen mit in die reasons,
        // damit die GUI zeigt, wie die Events in dieser COMP heissen und
        // warum evTol sie nicht matcht (Turnier-COMPs koennen andere
        // Namensformate haben, z.B. "R2: Zverev v Sonego" o.ae.).
        const evNames = (bfH.mo || []).slice(0, 12)
          .map(b => b.name).filter(Boolean);
        log('=== KEIN BF-Match-Odds-Event (h2h) zu "' + pinTeams.join(' v ') + '" in ' + comp +
          ' (BF-Events: ' + (evNames.slice(0, 5).join(' | ') || 'keine') + ')');
        const hint = evNames.length
          ? 'BF-Events dieser COMP (erste ' + evNames.length + '): ' +
            evNames.join(' | ')
          : 'BF-Match-Odds-Events: KEINE in dieser COMP';;
        out.reasons.push('kein BF-Match-Odds-Event (Teamnamen-Diff) — ' + hint);
        return out;
      }
      // Robustheits-Baustein (v8.60.3): Bei einer Turnier-COMP (Grand Slam,
      // z.B. US Open mit 50+ Events) ist `comp` die Kompetition, nicht das
      // Match. Das konkrete Match-Odds-Event traegt in `marketId` die
      // match-spezifische COMP. Die melden wir im meta (und die App legt sie
      // ggf. ab), damit kuenftige Checks / der naechste Scan die richtige
      // Match-Ebene-COMP nutzen statt die ganze Kompetition (52 Events
      // vermischt zu laden). moH ist nach evTol nicht leer.
      // v8.60.7: die match-spezifische COMP ist die EVENT-node-id des
      // Matches (moH[].evId aus bfH2H, z.B. "33016740"), NICHT die marketId
      // des Match-Odds-Markts ("1.261632327") — ein MARKET-Knoten hat als
      // nodeIds fuer bfBynodeAuto keine EVENT/MARKET-Kinder (Blatt im
      // Graphen), der Retry lieferte daher immer leer (Live-Befund: nur
      // blA/blB trotz erkanntem "Match-COMP 1.261632327"). EVENT-node-id
      // als "EVENT:<evId>" formatieren (bfBynode erwartet node-ids mit
      // Typ-Praefix, vgl. "COMP:12758999").
      const evId = (moH[0] || {}).evId;
      const matchComp = (evId ? 'EVENT:' + evId : '') ||
        (moH[0] || {}).marketId || String(comp || '');
      log('  BF-Match-Event gefunden (evTol): "' + moH[0].name +
        '" -> Match-COMP ' + matchComp);
      // Match-COMP-Retry (v8.60.5): Bei einer Turnier-COMP (Grand Slam, 50+
      // Events) liefert bfH2H(comp) die Maerkte ALLER Matches vermischt —
      // das Set Betting des gesuchten Spiels geht dabei oft unter (sb leer,
      // Live-Befund Zverev v Sonego: nur blA/blB). Die gefundene Match-COMP
      // (EVENT-node-id des Match-Odds-Events) isoliert EIN Spiel: bfH2H
      // nochmal damit laden und dessen sb-Rows fuer den tenscore-Block
      // verwenden.
      // v8.60.11: Mehrformatiger Match-COMP-Retry. bynode akzeptiert je nach
      // Knotentyp unterschiedliche nodeIds-Formate ("COMP:…", "EVENT:…",
      // rohe id) — die Soccer-Match-COMPs in der DB sind z.B. "COMP:…"
      // und funktionieren. Wir probieren alle Varianten der Event-node-id
      // durch und nehmen die erste, die Set-Betting-Rows liefert.
      const evRaw = evId ? String(evId) : '';
      const retryCands = [];
      if (evRaw) {
        retryCands.push('EVENT:' + evRaw);
        retryCands.push('COMP:' + evRaw);
        retryCands.push(evRaw);
      }
      let bfHMatch = null;
      // Die Event-node bleibt die gemeldete Match-COMP, auch wenn kein
      // Retry-Kandidat Set-Betting lieferte — die App soll sie als BF-COMP
      // uebernehmen (statt der Turnier-COMP), damit der naechste Check die
      // Match-Ebene nutzt.
      let matchCompUsed = (retryCands.length ? retryCands[0] :
        String(matchComp || comp || ''));
      const retryErgebnisse = {};  // Format -> {mo,sb,sw} (Diagnose v8.60.11)
      for (const cand of retryCands) {
        if (!cand || String(cand) === String(comp)) continue;
        const h = await bfH2H(String(cand), log).catch(() => null);
        if (h) {
          retryErgebnisse[cand] = { mo: (h.mo || []).length,
            sb: (h.sb || []).length, sw: (h.sw || []).length };
        }
        if (h && (h.sb || []).length) {
          bfHMatch = h;
          matchCompUsed = String(cand);
          log('  Match-COMP ' + cand + ' geladen: ' +
            (h.sb || []).length + ' Set-Betting-Rows (statt Turnier-COMP)');
          break;
        }
        if (!bfHMatch && h) bfHMatch = h;
      }
      if (!bfHMatch && !retryCands.length) bfHMatch = null;
      if (out.meta) out.meta.matchComp = String(matchCompUsed);
      // v8.60.15: Diagnose-Nachricht des Match-COMP-Retrys. Bei Tennis-
      // Grand-Slams traegt die Match-COMP (EVENT-node) haeufig KEIN Set
      // Betting — die Turnier-COMP schon (Live-Befund Zverev v Sonego:
      // EVENT:35991551=0/0/0, Turnier-COMP sb=1). sbRows faellt unten auf
      // die Turnier-COMP-Rows zurueck, die tenscore-Kanaele entstehen dann
      // trotzdem. Die Meldung ist daher diagnostisch, KEIN Fehler — der
      // Reason wird nur gepusht, wenn am Ende wirklich keine Set-Score-
      // Kanaele entstanden sind (unten via retryMsg).
      let retryMsg = '';
      if (!bfHMatch || !(bfHMatch.sb || []).length) {
        const bilanz = retryCands.map(c =>
          c + '=' + (retryErgebnisse[c] ?
            retryErgebnisse[c].mo + '/' + retryErgebnisse[c].sb + '/' +
            retryErgebnisse[c].sw : 'n/a')).join(' ');
        const turnierSb = (bfH.sb || []).length;
        retryMsg = 'Match-COMP-Retry ohne Set-Betting (' +
          (bilanz || 'keine Kandidaten') + '; Turnier-COMP sb=' + turnierSb + ')' +
          (turnierSb ? ' — tenscore nutzt Turnier-COMP-Rows (Fallback)' :
            ' — keine Set-Betting-Rows verfuegbar');
        log('  ' + retryMsg);
      }
      const sbRows = (bfHMatch && (bfHMatch.sb || []).length)
        ? (bfHMatch.sb || []) : (bfH.sb || []);
      const surname = surnameH;
      const mScore = (team, rn) => {
        if (teamMatch(team, rn.nm)) return 3;
        const sn = surname(team);
        return sn && norm(rn.nm).split(' ').includes(sn) ? 1 : 0;
      };
      for (const b of moH) {
        const s1 = mScore(h2.teams[0], b.r0) + mScore(h2.teams[1], b.r1);
        const s2 = mScore(h2.teams[0], b.r1) + mScore(h2.teams[1], b.r0);
        let x, y;
        if (s1 > s2) { x = b.r0; y = b.r1; }
        else if (s2 > s1) { x = b.r1; y = b.r0; }
        else continue;
        const a = h2.back[0], bb = h2.back[1];
        add('bl A', a > 1.01 ? a : null, x.lay || null,
          'PIN A (' + h2.teams[0] + ')', 'BF ' + x.nm, '');
        add('bl B', bb > 1.01 ? bb : null, y.lay || null,
          'PIN B (' + h2.teams[1] + ')', 'BF ' + y.nm, '');
      }
      // Tennis-Satz-Score-Kanaele (v8.60.1): der Boost-Arb-Check (tenscore
      // „X gewinnt 2:0/3:0") braucht die Set-Betting-Backs/Lays auch im
      // why-Pull, sonst findet er das Leg nur, wenn der Scan-Cross zufaellig
      // ein Arb war (DB-Rows werden nur dann gepusht). Kinds identisch mit
      // den DB-Rows (s2A/s2B/s5A/s5B/sdPlusA/B/sd5PlusA/B) —
      // normalisiere_why_kind laesst sie unveraendert durch.
      //   s2A/s2B    : PIN Back -1.5 (2:0) + BF Lay „Team 2-0"
      //   s5A/s5B    : PIN Back -2.5 (3:0) + BF Lay „Team 3-0"
      //   sdPlusA/B  : PIN Back +1.5 (Gegner „nicht 0:2") + BF 2-0 Back
      //   sd5PlusA/B : PIN Back +2.5 (Gegner „nicht 0:3") + BF 3-0 Back
      // Datengetrieben statt nur Sport-Label (v8.60.3): Set-Betting-Maerkte
      // existieren NUR im Tennis — wenn sbRows Zeilen hat, ist es Tennis, egal
      // ob sportVonLiga fuer die Liga exakt 'Tennis' liefert (US Open etc.
      // koennen im Namen-Raten scheitern). Der h2h-Zweig laeuft trotzdem
      // (bl A/bl B kamen im Live-Test), aber der tenscore-Block waere ohne
      // diese Bedingung uebersprungen worden.
      const tennisSb = sbRows.length > 0;
      if (lidSport === 'Tennis' || tennisSb) {
        if (lidSport !== 'Tennis') {
          log('  DEBUG WHY-Tennis: lidSport=' + lidSport +
            ' aber ' + sbRows.length + ' Set-Betting-Rows -> tenscore-Block aktiv');
        }
        for (const sb of sbRows) {
          if (!evTol(sb.name) && !evMatch(pinTeams, sb.name)) continue;
          // v8.60.13: Spieler-Zuordnung tolerant wie evTol — die BF-Spieler-
          // namen in sb.players koennen Kurzformen haben ("A Zverev" vs.
          // PIN "Alexander Zverev", US-Open-Live-Befund). Das strikte
          // teamMatch liess byTeam leer -> trotz sb-Row + PIN-Handicaps
          // keine Set-Score-Kanaele. Erst exakt, dann Nachname-Fallback
          // (analog mScore unten).
          const byTeam = {};
          const sbPlayerHit = (team, pname) => {
            if (teamMatch(team, pname)) return true;
            const sn = surname(team);
            return !!sn && norm(String(pname || '')).split(' ').includes(sn);
          };
          for (const p of (sb.players || [])) {
            let i = -1;
            if (sbPlayerHit(h2.teams[0], p.name)) i = 0;
            else if (sbPlayerHit(h2.teams[1], p.name)) i = 1;
            if (i >= 0 && byTeam[i] === undefined) byTeam[i] = p;
          }
          for (const i of [0, 1]) {
            const j = 1 - i;
            const p = byTeam[i], opp = byTeam[j];
            // Bo3 (PIN -1.5/+1.5, BF 2-0-Runner)
            const pinMinus15 = (h2.back2 || [])[i];
            if (p && p.s20 && isValidPrice(pinMinus15) &&
                p.s20.lay != null) {
              add('s2' + (i === 0 ? 'A' : 'B'), pinMinus15, p.s20.lay,
                'PIN ' + h2.teams[i] + ' -1.5',
                'BF ' + h2.teams[i] + ' 2-0 (Lay)', '');
            }
            const pinPlus15 = (h2.back15 || [])[i];
            if (opp && opp.s20 && isValidPrice(pinPlus15) &&
                opp.s20.back != null) {
              add('sdPlus' + (i === 0 ? 'A' : 'B'), pinPlus15, opp.s20.back,
                'PIN ' + h2.teams[i] + ' +1.5',
                'BF ' + h2.teams[j] + ' 2-0 (BB)', '');
            }
            // Bo5 / Grand Slam (PIN -2.5/+2.5, BF 3-0-Runner)
            const pinMinus25 = (h2.back25 || [])[i];
            if (p && p.s30 && isValidPrice(pinMinus25) &&
                p.s30.lay != null) {
              add('s5' + (i === 0 ? 'A' : 'B'), pinMinus25, p.s30.lay,
                'PIN ' + h2.teams[i] + ' -2.5',
                'BF ' + h2.teams[i] + ' 3-0 (Lay)', '');
            }
            const pinPlus25 = (h2.back25plus || [])[i];
            if (opp && opp.s30 && isValidPrice(pinPlus25) &&
                opp.s30.back != null) {
              add('sd5Plus' + (i === 0 ? 'A' : 'B'), pinPlus25, opp.s30.back,
                'PIN ' + h2.teams[i] + ' +2.5',
                'BF ' + h2.teams[j] + ' 3-0 (BB)', '');
            }
            // 3:1 (v8.60.21): BF-Lay „Team 3-1" (s31-Runner) + PIN ±1.5
            // (bo5). Gegner +1,5 ist KEIN exaktes Komplement zu „X 3:1"
            // (der Sweep X 3:0 bleibt offen) — der Boost-Check baut daraus
            // den Kombi-Lock (Lay X 3-1 + Back Gegner +1,5).
            const pinMinus15b5 = (h2.back15neg || [])[i];
            if (p && p.s31 && p.s31.lay != null) {
              add('s51' + (i === 0 ? 'A' : 'B'),
                isValidPrice(pinMinus15b5) ? pinMinus15b5 : null,
                p.s31.lay, 'PIN ' + h2.teams[i] + ' -1.5',
                'BF ' + h2.teams[i] + ' 3-1 (Lay)', '');
            }
            const pinPlus15b5 = (h2.back15 || [])[i];
            if (p && p.s31 && isValidPrice(pinPlus15b5)) {
              add('sd15Plus' + (i === 0 ? 'A' : 'B'), pinPlus15b5,
                p.s31.lay, 'PIN ' + h2.teams[i] + ' +1.5',
                'BF ' + h2.teams[i] + ' 3-1 (Lay)', '');
            }
            // 2:1 (bo3) / 3:2 (bo5) v8.60.24: BF-Lay „X 2-1"/„X 3-2" (Runner
            // s21/s32) + PIN-Gegner-Moneyline als Lock-Back (Y +0,5 Sätze
            // gibt es als Markt nicht; „nicht X 2:1" = {X 2:0, Y-Sieg},
            // „nicht X 3:2" = {X 3:0, X 3:1, Y-Sieg}).
            for (const key of ['21', '32']) {
              const pf = 's' + key;
              const scoreTxt = key === '21' ? '2-1' : '3-2';
              const t = p && p[pf];
              if (!t || t.lay == null) continue;
              const pinY = (h2.back || [])[1 - i];
              add('s' + key + (i === 0 ? 'A' : 'B'),
                isValidPrice(pinY) ? pinY : null, t.lay,
                'PIN ' + h2.teams[1 - i] + ' (Moneyline)',
                'BF ' + h2.teams[i] + ' ' + scoreTxt + ' (Lay)', '');
            }
          }
          // „Mehr als 4,5 Sätze“ (so45, v8.68.0): Boost-M = 5 Sätze (bo5),
          // Gegenwetten nur vom BF „Number of Sets“-Markt (PIN hat keine
          // 4,5-Linie): BF-Lay „Five Sets“ (verliert exakt bei M) als lay-,
          // BF-Back „Three Sets“ + „Four Sets“ zusammen als xBack (gewinnen
          // exakt bei ¬M = 3/4 Sätze). Ungegatet — der Boost-Solver braucht
          // die Quoten im why-Pull (analog s2/s51/sw-Rows).
          if (sb.ns && sb.ns.five && ((sb.ns.five.lay != null &&
              isValidPrice(sb.ns.five.lay)) || (sb.ns.three &&
              isValidPrice(sb.ns.three.back) && sb.ns.four &&
              isValidPrice(sb.ns.four.back)))) {
            let so45xb = 0;
            if (sb.ns.three && sb.ns.four &&
                isValidPrice(sb.ns.three.back) &&
                isValidPrice(sb.ns.four.back)) {
              const q3 = sb.ns.three.back, q4 = sb.ns.four.back;
              so45xb = 1 / (1 / q3 + 1 / q4);
            }
            add('so45', null,
              (sb.ns.five.lay != null && isValidPrice(sb.ns.five.lay))
                ? sb.ns.five.lay : null,
              '', 'BF Five Sets (Lay) / 3+4 Sets (Back, ¬M)', '', '', so45xb);
          }
        }
        // Satz-Winner (sw1A/B, sw2A/B, v8.60.26): Boost „X gewinnt Satz 1/2"
        // braucht die Set-Winner-Backs/Lays auch im why-Pull, sonst findet
        // der Boost-Check das Leg nur, wenn der Scan-Cross zufaellig ein Arb
        // war. PIN-Seite: period-Moneyline (h2.w[per] = [A, B]), BF-Seite:
        // „Set N Winner"-Runner (bfH2H.sw, x.lay). Kinds identisch mit den
        // DB-Rows (sw1A/sw1B/sw2A/sw2B) — normalisiere_why_kind laesst sie
        // unveraendert durch.
        const swRowsW = (bfHMatch && (bfHMatch.sw || []).length)
          ? (bfHMatch.sw || []) : (bfH.sw || []);
        for (const sw of swRowsW) {
          if (!evTol(sw.name) && !evMatch(pinTeams, sw.name)) continue;
          const wk = h2.w && h2.w[sw.per];
          if (!wk) {
            add('sw' + sw.per + 'A', null, (sw.r0 && sw.r0.lay) || null,
              'PIN Satz ' + sw.per + ' ' + (h2.teams[0] || ''),
              'BF Set ' + sw.per + ' Winner', '');
            add('sw' + sw.per + 'B', null, (sw.r1 && sw.r1.lay) || null,
              'PIN Satz ' + sw.per + ' ' + (h2.teams[1] || ''),
              'BF Set ' + sw.per + ' Winner', '');
            continue;
          }
          const s1 = mScore(h2.teams[0], sw.r0) + mScore(h2.teams[1], sw.r1);
          const s2 = mScore(h2.teams[0], sw.r1) + mScore(h2.teams[1], sw.r0);
          let x = null, y = null;
          if (s1 > s2) { x = sw.r0; y = sw.r1; }
          else if (s2 > s1) { x = sw.r1; y = sw.r0; }
          else continue;
          add('sw' + sw.per + 'A',
            isValidPrice(wk[0]) ? wk[0] : null, (x && x.lay) || null,
            'PIN Satz ' + sw.per + ' ' + h2.teams[0],
            'BF Set ' + sw.per + ' Winner', '');
          add('sw' + sw.per + 'B',
            isValidPrice(wk[1]) ? wk[1] : null, (y && y.lay) || null,
            'PIN Satz ' + sw.per + ' ' + h2.teams[1],
            'BF Set ' + sw.per + ' Winner', '');
        }
      }
      // Diagnose-Bilanz fuer den tenscore-Live-Test (v8.60.3): zeigt, welche
      // Daten je Spiel vorhanden waren — bfH2H.sb (Set Betting), PIN-Satz-
      // Handicaps (back2/back15/back25/back25plus) — damit klar wird, warum
      // ein Kanal fehlt, falls der User wieder nur blA/blB sieht.
      if (tennisSb || lidSport === 'Tennis') {
        const sbHit = sbRows.filter(s => evTol(s.name) ||
          evMatch(pinTeams, s.name));
        log('  DEBUG WHY-Tennis-Bilanz: sb-rows=' + sbRows.length +
          ' (match-COMP: ' + String(matchComp) + ')' +
          ' sb-match=' + sbHit.length +
          ' back2=' + JSON.stringify(h2.back2 || null) +
          ' back15=' + JSON.stringify(h2.back15 || null) +
          ' back25=' + JSON.stringify(h2.back25 || null) +
          ' back25plus=' + JSON.stringify(h2.back25plus || null));
        // v8.60.9: tenscore-Bilanz in die reasons schreiben, damit die GUI
        // sie zeigt, wenn Sport=Tennis geliefert wurde aber der tenscore-Block
        // KEINE Kanäle erzeugte (nur blA/blB). Die reasons sind im Dialog
        // sichtbar (anders als die letzte log-Zeile, die der User oft nur
        // gekuerzt postet). Gibt an, warum die Set-Score-Kanaele fehlen:
        // keine sb-Rows, kein sb-Match, oder fehlende PIN-Satz-Handicaps
        // (back2/back15/back25/back25plus).
        const hasScoreChannel = ch => ch.some(c => {
          return c && ['s2A', 's2B', 's5A', 's5B', 'sdPlusA', 'sdPlusB',
            'sd5PlusA', 'sd5PlusB', 's51A', 's51B',
            'sd15PlusA', 'sd15PlusB', 's21A', 's21B',
            's32A', 's32B', 'so45'].indexOf(String(c.kind)) >= 0;
        });
        if (!hasScoreChannel(out.channels)) {
          const retryInfo = retryMsg ? retryMsg + ' — ' : '';
          const pinMissing = ['back2', 'back15', 'back15neg', 'back25',
            'back25plus']
            .map(k => k + '=' + JSON.stringify(h2[k] || null)).join(' ');
          if (!sbRows.length) {
            out.reasons.push('Tennis tenscore: ' + retryInfo +
              'KEINE Set-Betting-Rows (sb-rows=0, ' +
              'Match-COMP ' + matchComp + ') — BF Set Betting in dieser COMP ' +
              'nicht geliefert; PIN-Satz-Handicaps: ' + pinMissing);
          } else if (!sbHit.length) {
            out.reasons.push('Tennis tenscore: Set-Betting-Rows vorhanden (' +
              sbRows.length + ') aber keine matcht das Spiel (sb-match=0); ' +
              'PIN-Satz-Handicaps: ' + pinMissing);
          } else {
            out.reasons.push('Tennis tenscore: ' + sbRows.length +
              ' sb-Rows (match=' + sbHit.length + ') aber keine Set-Score-Kanaele ' +
              'erzeugt — PIN-Satz-Handicaps fehlen? ' + pinMissing);
          }
        }
      }
      log('WHY: ' + out.channels.length + ' Kanaele (h2h 2-Wege).');
      return out;
    }

    // ----- Schritt 2: ECHTE PIN-Pipeline (pinGames) -----
    const pin = await pinGames(lid, log, {}).catch(() => ({}));
    const h = pin[mid];
    out.pin = { lid, games: Object.keys(pin).length, present: !!h };
    if (!h) {
      const skip = matchSkipReason(mu);
      const t = new Date(mu.startTime || 0).getTime();
      const now = Date.now();
      const inWindow = t >= now - HOURS_BACK * MS_PER_HOUR && t <= now + daysAhead * MS_PER_DAY;
      let stale = '';
      if (mu.isLive && mu.startTime) {
        const hrs = (now - new Date(mu.startTime).getTime()) / MS_PER_HOUR;
        if (hrs > 4) stale = ' | stale live: seit ' + hrs.toFixed(1) + 'h (>4h -> SKIP)';
      }
      log('=== KEIN PIN-Eintrag fuer ' + mid + ' in Liga ' + lid + ' (pinGames hielt ' +
        Object.keys(pin).length + ' Spiele)');
      log('  status=' + JSON.stringify(mu.status) + ' | skipReason=' + (skip || 'keiner') +
        ' | startTime=' + (mu.startTime || '') + ' | im Zeitfenster? ' + inWindow + stale);
      out.reasons.push('kein PIN-Eintrag in pinGames (Status/Zeitfenster/keine handelbaren Maerkte)');
      return out;
    }
    out.pin.h = { teams: h.teams, back: h.back, src: h.src, live: h.live, st: h.st };
    log('  PIN-Eintrag OK: back=' + h.back.toFixed(2) + ' (' + h.src + ')' +
      ' live=' + !!h.live + ' start=' + (h.st || ''));
    log('  PIN-Kanaele: csBacks=' + Object.keys(h.csBacks).join(',') +
      ' | cs00Backs=' + (h.cs00Backs || []).length +
      ' | htCsBacks=' + Object.keys(h.htCsBacks).join(',') +
      ' | yn(BTTS)=' + (h.yn || []).length + ' | ous=' + (h.ous || []).length +
      ' | hfs=' + (h.hfs || []).length + ' | w2ns=' + (h.w2ns || []).length +
      ' | btsws=' + (h.btsws || []).length + ' | resous=' + (h.resous || []).length +
      ' | oes=' + (h.oes || []).length + ' | dcs=' + (h.dcs || []).length +
      ' | exactMax=' + (h.exactMax ? h.exactMax.line + '@' + h.exactMax.back.toFixed(2) : '-') +
      ' | exactMin=' + (h.exactMin ? h.exactMin.line + '@' + h.exactMin.back.toFixed(2) : '-') +
      ' | htExact0=' + h.htExact0.toFixed(2) + ' | htNeither=' + h.htNeither.toFixed(2) +
      ' | cornersOu=' + (h.cornersOu || []).length);

    // ----- Schritt 3: ECHTE BF-Pipeline (bfLays) -----
    // v8.60.28: Event-beschraenkter BF-Fetch — bfLays laedt mit
    // opts.onlyEvent NUR die Maerkte des passenden Events statt der ganzen
    // COMP (~10x schneller, Championship: 35 statt 3 bymarket-Chunks). Die
    // EVENT-Namen der COMP liefert bfLays in st.bfEventNames fuer die
    // Diagnose, falls kein Event matcht (Teamnamen-Diff).
    const stBf = {};
    const lays = await bfLays(comp, log, stBf, { onlyEvent: pinTeams }).catch(() => []);
    if (!lays.length) {
      const evNames = stBf.bfEventNames || [];
      if (evNames.length && stBf.bfFilterBefore !== undefined) {
        // COMP hat Events, aber keins matcht die PIN-Teams (Teamnamen-Diff) —
        // die erste Event-Liste in die reasons, damit die GUI zeigt, wie die
        // Events in dieser COMP heissen (analog h2h-Zweig v8.60.4).
        log('=== KEIN BF-Event zu "' + pinTeams.join(' v ') + '" in ' + comp +
          ' (Teamnamen-Diff). BF-Events: ' + evNames.slice(0, 10).join(' | '));
        const hint = 'BF-Events dieser COMP (erste ' + evNames.length + '): ' +
          evNames.join(' | ');
        out.reasons.push('kein BF-Event (Teamnamen-Diff) — ' + hint);
        return out;
      }
      log('=== BF-Lays leer fuer ' + comp);
      log('  Hinweis: bfLays braucht die Betfair-Seite im Browser (fetch gegen betfair.com).');
      log('  Oeffne eine Betfair-Seite (z.B. ' + comp + ') in einem Tab, damit der BF-Abruf klappt.');
      out.reasons.push('BF leer (Betfair-Seite im Browser offen? bfLays braucht betfair.com-Zugriff)');
      return out;
    }
    const bs = lays;  // bfLays hat bereits auf das Event gefiltert
    out.bf = { comp: String(comp), lays: lays.length, forEvent: bs.length,
      evFiltered: true };
    out.bf.event = bs[0].name;
    log('BF-Event: ' + bs[0].name + ' (' + bs.length + ' Lays) in ' + comp);
    log('  BF-Kanaele: ' + [...new Set(bs.map(b => b.kind))].join(' | '));

    // ----- Schritt 4: je Kanal PIN-Leg vs BF-Lay + Abbruch-Grund -----
    // Straight-Fetch fuer ML/DNB/DC/AH/TQ (h.back deckt nur den besten Wert ab)
    const straight = await fetchStraight(h.id, log, 'why', () => {}, null).catch(() => null) || [];

    for (const b of bs) {
      const k = b.kind || '';
      if (/^h?cs\d\d$/.test(k)) {
        // CS / HT-CS: PIN csBacks/htCsBacks vs BF-Lay
        const isHt = /^hcs/.test(k);
        const key = k.replace(/^h?cs/, '').replace(/(\d)(\d)/, '$1,$2');
        const src = isHt ? (h.htCsBacks || {}) : h.csBacks;
        let back = (src[key] || 0);
        let srcTxt = (isHt ? 'HT ' : '') + 'CS ' + key;
        // cs00 MAX (analog scan.js): bester Back-Preis ueber CS 0:0, Under 0.5,
        // Either TTS=No, Exact Goals=0, First TTS=Neither (v8.15.0)
        if (key === '0,0' && !isHt && h.cs00Backs && h.cs00Backs.length) {
          const all = [{ back, src: 'CS 0:0' }, ...h.cs00Backs].filter(s => s.back > 0);
          if (all.length) {
            const best = all.reduce((a, x) => x.back > a.back ? x : a);
            back = best.back; srcTxt = best.src;
          }
        }
        // cs11 MAX: bester Back-Preis ueber CS 1:1 und "Yes & Under 2.5"
        // (= BTTS Yes + Under 2.5 = exakt 1:1). Analog cs00.
        if (key === '1,1' && !isHt && h.cs11Backs && h.cs11Backs.length) {
          const all = [{ back, src: srcTxt }, ...h.cs11Backs].filter(s => s.back > 0);
          if (all.length) {
            const best = all.reduce((a, x) => x.back > a.back ? x : a);
            back = best.back; srcTxt = best.src;
          }
        }
        const bfTxt = b.lay >= 200 ? 'lay>=200 Platzhalter' : ('BF ' + key);
        if (b.lay >= 200) add(k, 0, null, srcTxt, bfTxt, '');
        else add(k, back || null, b.lay, srcTxt, bfTxt, '');
      } else if (k === 'btts') {
        // BTTS: PIN h.yn-Spec -> Back-Preise via pinBtts, BF layYes/layNo — wie
        // der Scanner je Seite BOTH Back-Lay-Varianten (Yes/No) UND die
        // Back-Back-Crosslegs (bttsBBY: PIN-Yes + BF-No-Back, bttsBBN:
        // PIN-No + BF-Yes-Back).
        const yn = h.yn || [];
        if (!yn.length) {
          // Kein PIN-yn-Special (z.B. Pokal-Spiele): trotzdem beide BF-Lays
          // als btts Yes/No emittieren (statt Basis-Kanal `btts`), damit die
          // Boost-Arb-Legs bttsY/bttsN die BF-Lay-Quoten finden (v8.60.32).
          add(k + ' Yes', null, b.layYes, 'kein yn-Special', 'BF layYes', '', '',
            isValidPrice(b.backNo) ? b.backNo : 0);
          add(k + ' No', null, b.layNo, 'kein yn-Special', 'BF layNo', '', '',
            isValidPrice(b.backYes) ? b.backYes : 0);
        } else {
          const r = await pinBtts(yn, b, log).catch(() => null);
          const pre = r && r.pre, bb = r && r.bb;
          const srcPre = pre ? 'PIN BTTS-Spec ' + pre.sid : 'kein Preismatch';
          add(k + ' Yes', pre ? pre.yes : null, b.layYes, srcPre,
            'BF layYes', pre ? 'Score ' + pre.score.toFixed(3) : (bb ? 'BB ' + bb.sid : ''), '',
            isValidPrice(b.backNo) ? b.backNo : 0);
          add(k + ' No', pre ? pre.no : null, b.layNo, srcPre,
            'BF layNo', pre ? 'Score ' + pre.score.toFixed(3) : (bb ? 'BB ' + bb.sid : ''), '',
            isValidPrice(b.backYes) ? b.backYes : 0);
          // Back-Back-Crosslegs (Gegenwette): PIN-Back der einen Seite + BF-Back
          // der anderen. Hier ist kein Lay im Spiel, daher eigener Edge-Check.
          if (bb && isValidPrice(bb.yes) && isValidPrice(b.backNo)) {
            const eBb = computeBBEdge(bb.yes, b.backNo);
            const r = eBb > 0 ? 'BB-Edge ' + (eBb * 100).toFixed(1) + '%' : 'kein BB-Edge: ' + (eBb * 100).toFixed(1) + '%';
            const line = '  [bttsBBY] PIN-Yes=' + bb.yes.toFixed(2) + ' BF-No-Back=' + b.backNo.toFixed(2) +
              ' (PIN Yes + BF No-Back) ==> ' + r;
            log(line);
            out.channels.push({ kind: 'bttsBBY', pinBack: bb.yes, bfLay: b.backNo,
              pinSrc: srcPre + ' Yes + BF No-Back', bfSrc: 'BF No-Back', reason: [r] });
          }
          if (bb && isValidPrice(bb.no) && isValidPrice(b.backYes)) {
            const eBb = computeBBEdge(bb.no, b.backYes);
            const r = eBb > 0 ? 'BB-Edge ' + (eBb * 100).toFixed(1) + '%' : 'kein BB-Edge: ' + (eBb * 100).toFixed(1) + '%';
            const line = '  [bttsBBN] PIN-No=' + bb.no.toFixed(2) + ' BF-Yes-Back=' + b.backYes.toFixed(2) +
              ' (PIN No + BF Yes-Back) ==> ' + r;
            log(line);
            out.channels.push({ kind: 'bttsBBN', pinBack: bb.no, bfLay: b.backYes,
              pinSrc: srcPre + ' No + BF Yes-Back', bfSrc: 'BF Yes-Back', reason: [r] });
          }
          if (!pre && !bb) add(k + ' (Pre) ', null, null, 'kein pre/bb', '', '');
        }
      } else if (k === 'ou') {
        // O/U: PIN goalsOu (Kern-straight) bzw. cornersOu (lg-straight) vs BF line/layO/layU
        const srcName = b.corners ? 'cornersOu' : 'goalsOu';
        const pinSrc = b.corners ? (h.cornersOu || []) : ouGoals(straight);
        const cover = pinSrc.find(x => Math.abs(x.line - b.line) < 0.01);
        const pinLinesTxt = 'keine PIN-Linie (' + srcName + '=' +
          pinSrc.map(x => x.line).join(',') + ')';
        if (!cover) {
          // Keine PIN-Linie: BF-Lay trotzdem liefern (pinBack=null), damit der
          // Boost-Arb die Lay-Both-Strategie ueber die BF-Lays rechnen kann
          // (vgl. "Lay bei Betfair, beste Version finden"). Statische Gaps
          // (corners 8.5, goals 6.5/8.5, ...) werden nur kompakt gemeldet.
          const fam = (b.corners ? 'corners ' : 'goals ') + b.line + ' (nur BF)'; 
          if (b.layO > 0) add(k + ' O' + b.line, null, b.layO, pinLinesTxt, 'BF over', '', fam);
          if (b.layU > 0) add(k + ' U' + b.line, null, b.layU, pinLinesTxt, 'BF under', '', fam);
          if (!(b.layO > 0) && !(b.layU > 0)) add(k + ' ' + b.line, null, null,
            pinLinesTxt, 'BF ' + b.name + ' line=' + b.line, '', fam);
        } else {
          if (b.layO > 0) add(k + ' O' + b.line, cover.over || null, b.layO,
            srcName + (cover.range ? (cover.under ? ' (Range → Under ' + cover.line + ')' :
              ' (Range → Over ' + cover.line + ')') :
              (cover.crossOnly ? ' (Exact Goals=0 → Under 0.5)' : '')),
            'BF over', cover.range ? 'Range' : (cover.crossOnly ? 'crossOnly' : ''), '',
            b.backU > 1.01 && b.backU !== 0 ? b.backU : 0);
          if (b.layU > 0) add(k + ' U' + b.line, (cover.under > 1.01 ? cover.under : null) || null,
            b.layU, srcName + (cover.range ? (cover.under ? ' (Range → Under ' + cover.line + ')' :
              ' (Range → Over ' + cover.line + ')') :
              (cover.crossOnly ? ' (Exact Goals=0 → Under 0.5)' : '')),
            'BF under', cover.range ? 'Range' : (cover.crossOnly ? 'crossOnly' : ''), '',
            b.backO > 1.01 && b.backO !== 0 ? b.backO : 0);
        }
      } else if (k === 'oe') {
        // Odd/Even: PIN h.oes-Spec -> Back-Preise via pinOeSpecs, BF odd/even-lay
        const oes = h.oes || [];
        if (!oes.length) add(k, null, null, 'kein oe-Special', 'BF ' + b.name, '');
        else {
          const r = await pinOeSpecs(oes, b, log).catch(() => null);
          const pre = r && r.pre;
          const srcOe = pre ? 'PIN OE-Spec ' + pre.sid : 'kein Preismatch';
          add(k + ' Odd', pre ? pre.odd : null, b.odd ? b.odd.lay : null,
            srcOe, 'BF odd lay', '', '',
            b.even && isValidPrice(b.even.back) ? b.even.back : 0);
          add(k + ' Even', pre ? pre.even : null, b.even ? b.even.lay : null,
            srcOe, 'BF even lay', '', '',
            b.odd && isValidPrice(b.odd.back) ? b.odd.back : 0);
        }
      } else if (k === 'dnb') {
        // DNB: PIN straight-DNB-Markt vs BF dnb.home/away
        const dm = straight.find(m => /^(draw ?no ?bet|draw_no_bet|drawnobet)$/i.test(String(m.type || '')) &&
          Number(m.period) === 0);
        if (!dm) add(k, null, null, 'kein PIN-DNB-Markt', 'BF ' + b.name, '');
        else {
          const px = pinPrices(dm);
          add(k + ' H', dec(px['home'] || px['1'] || px['home win'] || 0) || null,
            b.dnb && b.dnb.home ? b.dnb.home.lay : null, 'PIN DNB H', 'BF DNB H', '');
          add(k + ' A', dec(px['away'] || px['2'] || px['away win'] || 0) || null,
            b.dnb && b.dnb.away ? b.dnb.away.lay : null, 'PIN DNB A', 'BF DNB A', '');
        }
      } else if (k === 'dc') {
        // DC: PIN h.dcs-Special bzw. straight-DC vs BF dc 1x/x2/12
        let p1x = 0, pX2 = 0, p12 = 0;
        const dcs = h.dcs || [];
        let dcSrc = 'PIN DC (kein Special)';
        if (dcs.length && dcs[0].dc) {
          p1x = dcs[0].dc['1x'] || 0; pX2 = dcs[0].dc['x2'] || 0; p12 = dcs[0].dc['12'] || 0;
          dcSrc = 'PIN DC-Spec ' + dcs[0].sid;
        }
        if (!(p1x || pX2 || p12)) {
          const cm = straight.find(m => /^(double ?chance|double_chance|doublechance)$/i.test(String(m.type || '')) &&
            Number(m.period) === 0);
          if (cm) {
            const px = pinPrices(cm);
            p1x = dec(px['1x'] || px['home/draw'] || 0);
            pX2 = dec(px['x2'] || px['draw/away'] || 0);
            p12 = dec(px['12'] || px['home/away'] || 0);
            dcSrc = 'PIN DC (straight)';
          }
        }
        add(k + ' 1X', p1x > 1.01 ? p1x : null, b.dc && b.dc['1x'] ? b.dc['1x'].lay : null,
          dcSrc, 'BF DC', '');
        add(k + ' X2', pX2 > 1.01 ? pX2 : null, b.dc && b.dc['x2'] ? b.dc['x2'].lay : null,
          dcSrc, 'BF DC', '');
        add(k + ' 12', p12 > 1.01 ? p12 : null, b.dc && b.dc['12'] ? b.dc['12'].lay : null,
          dcSrc, 'BF DC', '');
        // Back-Back-Crosslegs (3-Wege) — spiegelt scan.js „3-Wege-Back-Cross-
        // Matching“: PIN DC Back + BF Einzel-Back bzw. PIN Einzel-Back + BF DC
        // Back, die alle 3 Ergebnisse abdecken. Der WHY-Diagnose-Block fuhr
        // bisher NUR die Back-Lay-Richtung, dadurch fehlten diese Arbs im Pull.
        // BF-Kommission: 3 % auf Nettogewinn => bfEffQ.
        const mo3R = bs.find(r => r.kind === 'mo3' && r.name === b.name);
        if (mo3R) {
          const bfHomeBack = mo3R.layHn && teamMatch(pinTeams[0], mo3R.layHn) ? mo3R.backH :
            (mo3R.layAn && teamMatch(pinTeams[0], mo3R.layAn) ? mo3R.backA : 0);
          const bfAwayBack = mo3R.layAn && teamMatch(pinTeams[1], mo3R.layAn) ? mo3R.backA :
            (mo3R.layHn && teamMatch(pinTeams[1], mo3R.layHn) ? mo3R.backH : 0);
          const bfDBack = mo3R.backD || 0;
          for (const cp of [
            { kind: 'dc1xB', p: p1x, bf: bfAwayBack, d: 'PIN DC 1X + BF B' },
            { kind: 'dcX2A', p: pX2, bf: bfHomeBack, d: 'PIN DC X2 + BF A' },
            { kind: 'dc12D', p: p12, bf: bfDBack, d: 'PIN DC 12 + BF D' },
          ]) {
            if (cp.p > 1.01 && cp.bf > 1.01) {
              const e = crossBackEdge(cp.p, bfEffQ(cp.bf));
              const r = e > 0 ? 'BB-Edge ' + e.toFixed(2) + '%' :
                'kein BB-Edge: ' + e.toFixed(2) + '%';
              log('  [' + cp.kind + '] PIN=' + cp.p.toFixed(2) + ' BF-Back=' + cp.bf.toFixed(2) +
                ' (eff ' + bfEffQ(cp.bf).toFixed(2) + ') (' + cp.d + ') ==> ' + r);
              out.channels.push({ kind: cp.kind, pinBack: cp.p, bfLay: cp.bf,
                pinSrc: cp.d, bfSrc: 'BF mo3 Back', reason: [r] });
            } else {
              log('  [' + cp.kind + '] PIN=' + (cp.p > 1.01 ? cp.p.toFixed(2) : '-') +
                ' BF-Back=' + (cp.bf > 1.01 ? cp.bf.toFixed(2) : '-') + ' (' + cp.d + ') ==> ' +
                (!(cp.p > 1.01) ? 'KEIN PIN-Back' : '') + ' | ' +
                (!(cp.bf > 1.01) ? 'KEIN BF-Back' : ''));
            }
          }
        }
        // Richtung 2: PIN Einzel-Back + BF DC Back (PIN ML vs b.dcBack)
        const mlMk2 = straight.find(m => /^moneyline$/i.test(String(m.type || '')) &&
          Number(m.period) === 0);
        const mpx2 = mlMk2 ? pinPrices(mlMk2) : {};
        const pinH2 = dec(mpx2['home'] || 0), pinD2 = dec(mpx2['draw'] || 0),
          pinA2 = dec(mpx2['away'] || 0);
        const dcBf1x = b.dcBack && b.dcBack['1x'] ? b.dcBack['1x'].back : 0;
        const dcBfX2 = b.dcBack && b.dcBack['x2'] ? b.dcBack['x2'].back : 0;
        const dcBf12 = b.dcBack && b.dcBack['12'] ? b.dcBack['12'].back : 0;
        for (const cp of [
          { kind: 'A dcX2', p: pinH2, bf: dcBfX2, d: 'PIN H + BF DC X2' },
          { kind: 'B dc1x', p: pinA2, bf: dcBf1x, d: 'PIN A + BF DC 1X' },
          { kind: 'D dc12', p: pinD2, bf: dcBf12, d: 'PIN D + BF DC 12' },
        ]) {
          if (cp.p > 1.01 && cp.bf > 1.01) {
            const e = crossBackEdge(cp.p, bfEffQ(cp.bf));
            const r = e > 0 ? 'BB-Edge ' + e.toFixed(2) + '%' :
              'kein BB-Edge: ' + e.toFixed(2) + '%';
            log('  [' + cp.kind + '] PIN=' + cp.p.toFixed(2) + ' BF-DC-Back=' + cp.bf.toFixed(2) +
              ' (eff ' + bfEffQ(cp.bf).toFixed(2) + ') (' + cp.d + ') ==> ' + r);
            out.channels.push({ kind: cp.kind, pinBack: cp.p, bfLay: cp.bf,
              pinSrc: cp.d, bfSrc: 'BF DC Back', reason: [r] });
          } else {
            log('  [' + cp.kind + '] PIN=' + (cp.p > 1.01 ? cp.p.toFixed(2) : '-') +
              ' BF-DC-Back=' + (cp.bf > 1.01 ? cp.bf.toFixed(2) : '-') + ' (' + cp.d + ') ==> ' +
              (!(cp.p > 1.01) ? 'KEIN PIN-Back' : '') + ' | ' +
              (!(cp.bf > 1.01) ? 'KEIN BF-Back' : ''));
          }
        }
      } else if (k === 'euh') {
        // Europaeisches Handicap (3-Weg): PIN h.euhs-Special vs BF pos/neg/draw
        // (BL je Ausgang; Spiegel-Specs werden wie im Scanner per MAX gemergt).
        const cands = (h.euhs || []).filter(c => Math.abs(c.line) === b.line);
        if (!cands.length)
          add(k, null, null, 'kein PIN-3-Way-Handicap (Linie ' + b.line + ')',
            'BF ' + b.name, '');
        else {
          const bfPosTeam = b.pos.nm.replace(/\s*[+-]\d+\s*$/, '').trim();
          const bfNegTeam = b.neg.nm.replace(/\s*[+-]\d+\s*$/, '').trim();
          let pinSide = 0, pinDraw = 0, pinOpp = 0, pinLine = 0, srcTeam = '';
          for (const c of cands) {
            const sameMkt = (c.line > 0 && teamMatch(c.team, bfPosTeam)) ||
              (c.line < 0 && teamMatch(c.team, bfNegTeam));
            if (!sameMkt) continue;
            pinLine = c.line; srcTeam = c.team;
            pinSide = Math.max(pinSide, c.side);
            pinDraw = Math.max(pinDraw, c.draw);
            pinOpp = Math.max(pinOpp, c.opp);
          }
          if (!pinLine)
            add(k, null, null, 'kein Seiten-Match', 'BF ' + b.name, '');
          else {
            const sign = pinLine > 0 ? '+' : '-';
            const bfSide = pinLine > 0 ? b.pos : b.neg;
            const bfOpp = pinLine > 0 ? b.neg : b.pos;
            const oppTeam = pinLine > 0 ? bfNegTeam : bfPosTeam;
            const sideLetter = h.teams[0] && teamMatch(srcTeam, h.teams[0]) ? 'H' :
              (h.teams[1] && teamMatch(srcTeam, h.teams[1]) ? 'A' : '?');
            const oppLetter = h.teams[0] && teamMatch(oppTeam, h.teams[0]) ? 'H' :
              (h.teams[1] && teamMatch(oppTeam, h.teams[1]) ? 'A' : '?');
            const srcTxt = 'PIN 3-Way Handicap ' + srcTeam + ' ' +
              (pinLine > 0 ? '+' : '') + pinLine;
            add(k + ' ' + sideLetter + sign, pinSide > 1.01 ? pinSide : null,
              bfSide && bfSide.lay || null, srcTxt, 'BF ' + (bfSide ? bfSide.nm : '?'), '');
            add(k + ' D', pinDraw > 1.01 ? pinDraw : null,
              b.draw && b.draw.lay || null, srcTxt, 'BF Draw', '');
            add(k + ' ' + oppLetter + (sign === '+' ? '-' : '+'),
              pinOpp > 1.01 ? pinOpp : null, bfOpp && bfOpp.lay || null, srcTxt,
              'BF ' + (bfOpp ? bfOpp.nm : '?'), '');
          }
        }
      } else if (k === 'mo3' || k === 'mo3h') {
        // Match Odds: PIN moneyline (mo3 = period 0, mo3h = period 1/HT) vs BF layH/layD/layA
        const per = k === 'mo3h' ? 1 : 0;
        const mlMk = straight.find(m => /^moneyline$/i.test(String(m.type || '')) &&
          Number(m.period) === per);
        const mpx = mlMk ? pinPrices(mlMk) : {};
        const mtag = k === 'mo3h' ? 'PIN HT-ML' : 'PIN ML';
        if (!mlMk) add(k, null, null, 'kein PIN-Moneyline (period ' + per + ')', 'BF ' + b.name, '');
        else {
          add(k + ' H', toDecU(mpx['home']) || null, b.layH || null, mtag, 'BF H', '');
          add(k + ' D', toDecU(mpx['draw'] || mpx['tie']) || null, b.layD || null, mtag, 'BF D', '');
          add(k + ' A', toDecU(mpx['away']) || null, b.layA || null, mtag, 'BF A', '');
        }
      } else if (k === 'tq') {
        // To Qualify: PIN moneyline period=8 vs BF r0/r1
        const tqMkt = straight.find(m => /^moneyline$/i.test(String(m.type || '')) &&
          Number(m.period) === 8);
        if (!tqMkt) add(k, null, null, 'kein period=8-moneyline (To Qualify)', 'BF ' + b.name, '');
        else {
          const px = pinPrices(tqMkt);
          const a = toDecU(px['home'] || px['1']);
          const bb = toDecU(px['away'] || px['2']);
          add(k + ' A', a > 1.01 ? a : null, b.r0 ? b.r0.lay : null, 'PIN TQ (period 8)', 'BF r0', '');
          add(k + ' B', bb > 1.01 ? bb : null, b.r1 ? b.r1.lay : null, 'PIN TQ (period 8)', 'BF r1', '');
        }
      } else if (k === 'w2n') {
        // Win to Nil: PIN h.w2ns-Spec vs BF team/layYes/layNo — wie der Scanner
        // je Team BOTH Back-Lay-Seiten (Yes/No) UND die Back-Back-Crosslegs
        // (w2nBBY: PIN-Yes + BF-No-Back, w2nBBN: PIN-No + BF-Yes-Back).
        const cand = (h.w2ns || []).find(w => teamMatch(w.team, b.team));
        if (!cand) add(k, null, null, 'kein w2n-Special fuer ' + b.team, 'BF ' + b.team, '');
        else {
          // Team-Suffix wie im Snapshot-Scanner (scan.js): w2nH/w2nA (Yes-Seite)
          // und w2nNoH/w2nNoA (No-Seite) anhand des Heimteams — damit die
          // Boost-Arb-Score-Gruppe („Win to Nil (Heim) ∧ Under 3.5") die Legs
          // im WHY-Pull genauso findet wie im Scan. Ohne Suffix waeren die Kinds
          // team-agnostisch (w2n Yes/w2n No) und kollidieren mit dem Dropdown.
          const w2nIsHome = teamMatch(pinTeams[0] || '', b.team);
          const srcW2n = 'PIN W2N-Spec ' + cand.sid;
          // W2N-Aequivalente (v8.16.0, analog Scanner): "Team gewinnt + BTTS
          // No" = "Team gewinnt zu Nil" — bester PIN-Back aus W2N-Special und
          // BTSW "No & Team", kleinster BF-Lay aus W2N-Markt und BTSW-"Team/No".
          let pinYes = cand.yes, pinYesSrc = srcW2n;
          for (const bs of (h.btsws || [])) for (const o of (bs.outs || [])) {
            if (o.yn === 'no' && o.team !== 'Draw' && teamMatch(o.team, b.team) &&
              o.back > pinYes) {
              pinYes = o.back;
              pinYesSrc = 'PIN BTSW No&' + o.team + ' (Spec ' + bs.sid + ')';
            }
          }
          let bfLayYes = b.layYes || null, bfLayYesSrc = 'BF layYes';
          const btswBfKey = Object.keys(b.btsw || {}).find(k2 => {
            const p = k2.split(':');
            return p.length === 2 && p[1] === 'no' && teamMatch(p[0], b.team);
          });
          if (btswBfKey && b.btsw[btswBfKey].lay > 0 &&
            (!bfLayYes || b.btsw[btswBfKey].lay < bfLayYes)) {
            bfLayYes = b.btsw[btswBfKey].lay;
            bfLayYesSrc = 'BF ' + btswBfKey + ' Lay';
          }
          add(w2nIsHome ? 'w2nH' : 'w2nA', pinYes > 1.01 ? pinYes : null, bfLayYes, pinYesSrc, bfLayYesSrc, '', '',
            isValidPrice(b.backNo) ? b.backNo : 0);
          add(w2nIsHome ? 'w2nNoH' : 'w2nNoA', cand.no > 1.01 ? cand.no : null, b.layNo || null, srcW2n, 'BF layNo', '', '',
            isValidPrice(b.backYes) ? b.backYes : 0);
          // Back-Back-Crosslegs (Gegenwette): PIN-Back der einen Seite + BF-Back
          // der anderen. Hier ist kein Lay im Spiel, daher eigener Edge-Check.
          if (isValidPrice(pinYes) && isValidPrice(b.backNo)) {
            const eBb = computeBBEdge(pinYes, b.backNo);
            const r = eBb > 0 ? 'BB-Edge ' + (eBb * 100).toFixed(1) + '%' : 'kein BB-Edge: ' + (eBb * 100).toFixed(1) + '%';
            const line = '  [w2nBBY] PIN-Yes=' + pinYes.toFixed(2) + ' BF-No-Back=' + b.backNo.toFixed(2) +
              ' (PIN ' + b.team + ' Yes + BF No-Back) ==> ' + r;
            log(line);
            out.channels.push({ kind: 'w2nBBY', pinBack: pinYes, bfLay: b.backNo,
              pinSrc: pinYesSrc + ' + BF No-Back', bfSrc: 'BF No-Back', reason: [r] });
          }
          if (isValidPrice(cand.no) && isValidPrice(b.backYes)) {
            const eBb = computeBBEdge(cand.no, b.backYes);
            const r = eBb > 0 ? 'BB-Edge ' + (eBb * 100).toFixed(1) + '%' : 'kein BB-Edge: ' + (eBb * 100).toFixed(1) + '%';
            const line = '  [w2nBBN] PIN-No=' + cand.no.toFixed(2) + ' BF-Yes-Back=' + b.backYes.toFixed(2) +
              ' (PIN ' + b.team + ' No + BF Yes-Back) ==> ' + r;
            log(line);
            out.channels.push({ kind: 'w2nBBN', pinBack: cand.no, bfLay: b.backYes,
              pinSrc: srcW2n + ' No + BF Yes-Back', bfSrc: 'BF Yes-Back', reason: [r] });
          }
        }
      } else if (k === 'hf') {
        // HT/FT: PIN h.hfs-Special vs BF outs — echter Pair-Check wie im
        // Scanner (hfSide/hfSame + arbDir je Ausgang), damit Stichproben
        // zeigen, welches Paar nahe am Arb liegt und welches nicht.
        const hfs = h.hfs || [];
        if (!hfs.length) add(k, null, null, 'kein hf-Special', 'BF ' + b.name + ' outs=' + (b.outs || []).length, '');
        else {
          const teams = h.teams || [];
          const hfSide = s => {
            if (s === 'Draw') return 'D';
            if (teams[0] && teamMatch(teams[0], s)) return 'H';
            if (teams[1] && teamMatch(teams[1], s)) return 'A';
            return '?';
          };
          const hfSame = (a, c) => {
            const pa = String(a).split(' - '), pc = String(c).split('/');
            if (pa.length !== 2 || pc.length !== 2) return false;
            const la = pa.map(hfSide), lc = pc.map(hfSide);
            if (la.some(x => x === '?') || lc.some(x => x === '?')) return false;
            return la[0] === lc[0] && la[1] === lc[1];
          };
          log('  [hf] PIN-Special ' + hfs[0].sid + ': ' + (hfs[0].outs || []).slice(0, 4)
            .map(x => x.name + '@' + x.back.toFixed(2)).join(' | '));
          log('  [hf] BF ' + b.name + ': ' + (b.outs || []).slice(0, 4)
            .map(x => x.nm + '@' + x.lay.toFixed(2)).join(' | '));
          let hfCand = 0, hfHit = 0;
          for (const o of hfs) for (const out of o.outs || []) {
            hfCand++;
            const hits = (b.outs || []).filter(x => hfSame(out.name, x.nm));
            const letters = out.name.split(' - ').map(hfSide);
            const kind2 = letters.some(x => x === '?') ? k : (k + letters[0] + letters[1]);
            const srcTxt = 'PIN HT/FT ' + out.name + ' (Spec ' + hfs[0].sid + ')';
            if (hits.length !== 1) {
              add(kind2, out.back, null, srcTxt,
                hits.length ? 'BF Mehrfach-Match!' : 'kein BF-Match', '');
              continue;
            }
            hfHit++;
            add(kind2, out.back, hits[0].lay, srcTxt,
              'BF HT/FT ' + hits[0].nm, '');
          }
          log('  [hf] Pair-Check: ' + hfCand + ' PIN-Outs, ' + hfHit + ' mit BF-Match');
        }
      } else if (k === 'hfou') {
        // HT O/U: PIN total period=1-Maerkte (reale Scan-Logik) vs BF hfou line/layO/layU
        const t1 = straight.filter(m => /^total/i.test(String(m.type || '')) &&
          !m.side && Number(m.period || 0) === 1);
        let lineHits = [];
        for (const mkt of t1) {
          const ps = (mkt.prices || []).filter(p => typeof p.price === 'number');
          if (ps.length !== 2) continue;
          const des = p => String(p.d || p.designation || '');
          const ov = ps.find(p => /over/i.test(des(p)));
          const un = ps.find(p => /under/i.test(des(p)));
          let over, under;
          if (ov && un) { over = dec(ov.price); under = dec(un.price); }
          else { over = dec(ps[0].price); under = dec(ps[1].price); }
          let line = parseFloat(mkt.line ?? mkt.points ?? NaN);
          if (isNaN(line)) line = parseFloat(ps[0].points ?? ps[1].points ?? NaN);
          if (isNaN(line)) continue;
          lineHits.push({ line, over, under });
        }
        // HT Under 0.5: auch via htNeither/htExact0 als PIN-Under-Quelle
        const pin05 = Math.max(h.htNeither || 0, h.htExact0 || 0);
        if (pin05 > 1.01) lineHits.push({ line: 0.5, over: 0, under: pin05, alt: true });
        const hf = lineHits.find(x => Math.abs(x.line - b.line) < 0.01);
        if (!hf) {
          // Keine PIN-HT-Linie: BF-Lay trotzdem liefern (pinBack=null), damit der
          // Boost-Arb die Lay-Both-Strategie ueber die BF-Lays rechnen kann
          // (vgl. "Lay bei Betfair, beste Version finden"). Statische Gaps
          // (BF-HT-Linien 2.5/3.5 ohne PIN-Pendant) nur kompakt melden.
          const pinLinesTxt = 'keine PIN-HT-Linie (period1=' +
            lineHits.map(x => x.line).join(',') + ')';
          const fam = 'HT ' + b.line + ' (nur BF)';
          if (b.layO > 0) add(k + ' O' + b.line, null, b.layO, pinLinesTxt, 'BF over', '', fam);
          if (b.layU > 0) add(k + ' U' + b.line, null, b.layU, pinLinesTxt, 'BF under', '', fam);
          if (!(b.layO > 0) && !(b.layU > 0)) add(k + ' ' + b.line, null, null,
            pinLinesTxt, 'BF ' + b.name + ' line=' + b.line, '', fam);
        } else {
          if (b.layO > 0) add(k + ' O' + b.line, hf.over > 1.01 ? hf.over : null, b.layO,
            hf.alt ? 'PIN NEITHER/Exact0 (HT U' + b.line + ' alt-Quelle)' : 'PIN HT (period 1)',
            'BF over', hf.alt ? 'alt-Quelle' : '', '',
            b.backU > 1.01 && b.backU !== 0 ? b.backU : 0);
          if (b.layU > 0) add(k + ' U' + b.line, hf.under > 1.01 ? hf.under : null, b.layU,
            hf.alt ? 'PIN NEITHER/Exact0 (HT U' + b.line + ' alt-Quelle)' : 'PIN HT (period 1)',
            'BF under', hf.alt ? 'alt-Quelle' : '', '',
            b.backO > 1.01 && b.backO !== 0 ? b.backO : 0);
        }
      } else if (k === 'ttot') {
        // Team-Totals: PIN team_total period 0 (0.5–2.5 je Team) vs BF
        // "Team X Over/Under Y Goals" — Back-Lay + Back-Back-Crosslegs.
        // Analog scan.js (emitTeamTotalEs): Team-Match + Linien-Cover.
        const sideChar = teamMatch(b.team, h.teams[0]) ? 'H' :
          (teamMatch(b.team, h.teams[1]) ? 'A' : '');
        if (!sideChar) {
          add(k, null, null, 'kein PIN-Team-Match fuer ' + b.team,
            'BF ' + b.team + ' line=' + b.line, '');
        } else {
          // Inline teamTotalsOf: team_total period 0, Linien 0.5–2.5
          const ttSide = m => {
            const d = String(m.designation || m.side || '').toLowerCase();
            if (d === 'home') return 'home';
            if (d === 'away') return 'away';
            return null;
          };
          const desig = p => String(p.d || p.designation || '').toLowerCase();
          const pinTotals = [];
          for (const m of straight) {
            if (m.type !== 'team_total' || Number(m.period) !== 0) continue;
            const side = ttSide(m);
            if (!side) continue;
            const tp = {};
            for (const p of (m.prices || [])) {
              const d = desig(p);
              if ((d === 'over' || d === 'under') && typeof p.price === 'number') tp[d] = p.price;
              if (p.points != null && typeof p.points === 'number' && !tp.line) tp.line = p.points;
            }
            const over = toDecU(tp['over']), under = toDecU(tp['under']);
            if (over > 1.01 && under > 1.01 && typeof tp.line === 'number' &&
              tp.line >= 0.5 && tp.line <= 2.5) {
              pinTotals.push({ team: side, line: tp.line, over, under });
            }
          }
          const pinTeam = sideChar === 'H' ? 'home' : 'away';
          const cover = pinTotals.find(o =>
            o.team === pinTeam && Math.abs(o.line - b.line) < 0.01);
          if (!cover) {
            // Statischer Linien-Gap (PIN hat z.B. nur 0.5, BF 1.5/2.5): nur
            // kompakt melden, kein vollstaendiger Log-Eintrag.
            add(k + ' ' + b.line, null, null,
              'keine PIN-Linie (team_total=' + pinTotals.filter(o => o.team === pinTeam)
                .map(o => o.line).join(',') + ')',
              'BF ' + b.team + ' line=' + b.line, '',
              'team-total ' + b.team + ' ' + b.line + ' (nur BF)');
          } else {
            // Back-Lay: PIN Over/Under vs BF layO/layU
            if (b.layO > 0) add('tt' + String(Math.round(b.line * 10)).padStart(2, '0') + sideChar + 'O',
              cover.over > 1.01 ? cover.over : null, b.layO,
              'PIN Team ' + sideChar + ' Over ' + b.line, 'BF over', '', '',
              b.backU > 1.01 && b.backU !== 0 ? b.backU : 0);
            if (b.layU > 0) add('tt' + String(Math.round(b.line * 10)).padStart(2, '0') + sideChar + 'U',
              cover.under > 1.01 ? cover.under : null, b.layU,
              'PIN Team ' + sideChar + ' Under ' + b.line, 'BF under', '', '',
              b.backO > 1.01 && b.backO !== 0 ? b.backO : 0);
            // Back-Back-Crosslegs (analog emitTeamTotalEs)
            const code = String(Math.round(b.line * 10)).padStart(2, '0');
            if (cover.under > 1.01 && b.backO > 1.01 && b.backO !== 0 &&
              crossBackEdge(cover.under, bfEffQ(b.backO)) > 0) {
              const eBb = crossBackEdge(cover.under, bfEffQ(b.backO));
              const r = 'BB-Edge ' + (eBb * 100).toFixed(1) + '%';
              const line = '  [ttBB' + code + sideChar + 'U] PIN-Under=' + cover.under.toFixed(2) +
                ' BF-Over-Back=' + b.backO.toFixed(2) + ' ==> ' + r;
              log(line);
              out.channels.push({ kind: 'ttBB' + code + sideChar + 'U',
                pinBack: cover.under, bfLay: b.backO,
                pinSrc: 'PIN U ' + b.line + ' + BF O-Back', bfSrc: 'BF Over-Back', reason: [r] });
            }
            if (cover.over > 1.01 && b.backU > 1.01 && b.backU !== 0 &&
              crossBackEdge(cover.over, bfEffQ(b.backU)) > 0) {
              const eBb = crossBackEdge(cover.over, bfEffQ(b.backU));
              const r = 'BB-Edge ' + (eBb * 100).toFixed(1) + '%';
              const line = '  [ttBB' + code + sideChar + 'O] PIN-Over=' + cover.over.toFixed(2) +
                ' BF-Under-Back=' + b.backU.toFixed(2) + ' ==> ' + r;
              log(line);
              out.channels.push({ kind: 'ttBB' + code + sideChar + 'O',
                pinBack: cover.over, bfLay: b.backU,
                pinSrc: 'PIN O ' + b.line + ' + BF U-Back', bfSrc: 'BF Under-Back', reason: [r] });
            }
          }
        }
      } else if (k === 'ah') {
        // Asian Handicap: PIN straight-AH-Markt vs BF ah-Keys
        const keys = Object.keys(b.ah || {});
        if (!keys.length) add(k, null, null, 'BF ohne AH-Lays', 'BF ' + b.name, '');
        else log('  [ah] BF ' + b.name + ' AH-Keys: ' + keys.join(' | ') +
          ' (PIN-AH-Preise liegen in h.back/straight; AH-Detail via __bfmkt ' + b.marketId + ')');
      } else if (k === 'btsw') {
        // BTTS+Winner: PIN h.btsws-Spec vs BF btsw-Keys (Team:Yes/No -> lay).
        // Emittiert je kombiniertem Ausgang eine btw-Zeile (btwHY/btwAY/...),
        // analog scan.js (pushRow kind='btw'+side+Y/N) — damit die Boost-Arb-
        // BTSW-Reduktion (v8.52.0: „Tipp 1 ∧ BTTS Ja ≡ BTSW Heim & Yes“) auch
        // im WHY-Pull die BTSW-Lays findet (vorher nur geloggt, nie gepusht).
        const btsws = h.btsws || [];
        const spec = btsws.find(bs => bs.outs && bs.outs.length);
        if (!spec) add(k, null, null, 'kein btsw-Special', 'BF ' + b.name +
          ' keys=' + Object.keys(b.btsw || {}).length, '');
        else {
          log('  [btsw] PIN-Spec ' + spec.sid + ' outs=' + spec.outs.length +
            ' | BF ' + b.name + ' keys=' + Object.keys(b.btsw || {}).join(' | '));
          let emitted = 0;
          for (const out of (spec.outs || [])) {
            const bfKey = Object.keys(b.btsw || {}).find(k2 => {
              const si = k2.lastIndexOf(':');
              if (si < 0) return false;
              const team = k2.slice(0, si), yn = k2.slice(si + 1);
              if (yn !== out.yn) return false;
              if (out.team === 'Draw') return /^(draw|tie)$/i.test(team);
              return teamMatch(out.team, team);
            });
            if (!bfKey) continue;
            const bfLay = b.btsw[bfKey];
            if (!bfLay || !(bfLay.lay > 0)) continue;
            let side = 'D';
            if (out.team !== 'Draw') {
              if (teamMatch(pinTeams[0] || '', out.team)) side = 'H';
              else if (teamMatch(pinTeams[1] || '', out.team)) side = 'A';
              else continue;
            }
            const bkind = 'btw' + side + (out.yn === 'yes' ? 'Y' : 'N');
            add(bkind, out.back > 1.01 ? out.back : null, bfLay.lay,
              'PIN ' + out.yn + '&' + out.team + ' (Spec ' + spec.sid + ')',
              'BF ' + bfKey + ' Lay', '');
            emitted++;
          }
          if (!emitted)
            add(k, null, null, 'kein BF-Key-Match', 'BF ' + b.name +
              ' keys=' + Object.keys(b.btsw || {}).length, '');
        }
      } else if (k === 'resou') {
        // Result+O/U: PIN h.resous-Spec vs BF resou-Keys -> Zeilen emittieren
        // (Button „kombinierter Markt“ einzeln nutzbar; kind linien-kodiert
        // roH35O analog ou35O). BF-Key ist team:side:line (3 Teile).
        const resous = h.resous || [];
        const spec = resous.find(bs => bs.outs && bs.outs.length);
        if (!spec) add(k, null, null, 'kein resou-Special', 'BF ' + b.name +
          ' keys=' + Object.keys(b.resou || {}).length, '');
        else {
          log('  [resou] PIN-Spec ' + spec.sid + ' outs=' + spec.outs.length +
            ' | BF ' + b.name + ' keys=' + Object.keys(b.resou || {}).join(' | '));
          let emitted = 0;
          for (const out of (spec.outs || [])) {
            const bfKey = Object.keys(b.resou || {}).find(k2 => {
              const p = k2.split(':');
              if (p.length !== 3) return false;
              const [rteam, rside, rline] = p;
              if (rside !== out.side) return false;
              if (Math.abs(parseFloat(rline) - out.line) > 0.01) return false;
              if (out.team === 'Draw') return /^(draw|tie)$/i.test(rteam);
              return teamMatch(out.team, rteam);
            });
            if (!bfKey) continue;
            const bfLay = b.resou[bfKey];
            if (!bfLay || !(bfLay.lay > 0)) continue;
            let rside = 'D';
            if (out.team !== 'Draw') {
              if (teamMatch(pinTeams[0] || '', out.team)) rside = 'H';
              else if (teamMatch(pinTeams[1] || '', out.team)) rside = 'A';
              else continue;
            }
            const code = String(Math.round(out.line * 10)).padStart(2, '0');
            const bkind = 'ro' + rside + code +
              (out.side === 'over' ? 'O' : 'U');
            add(bkind, out.back > 1.01 ? out.back : null, bfLay.lay,
              'PIN ' + out.team + '&' + out.side + ' ' + out.line +
                ' (Spec ' + spec.sid + ')',
              'BF ' + bfKey + ' Lay', '');
            emitted++;
          }
          if (!emitted)
            add(k, null, null, 'kein BF-Key-Match', 'BF ' + b.name +
              ' keys=' + Object.keys(b.resou || {}).length, '');
        }
      } else if (k === 'pts') {
        // Torschuetze (Player To Score): PIN-Special "X To Score" Yes/No vs
        // BF-Markt "Player To Score" (Runner = Spieler). Back-Lay: PIN Yes vs
        // BF Lay; Back-Back-Cross (ptsBB, v8.48.3): PIN No („trifft NICHT") +
        // BF Yes-Back („trifft") — analog scan.js PTS-Block (v8.44.0).
        // v8.70.1: BF-Lays werden auch OHNE PIN-To-Score-Special emittiert
        // (pinBack=null). PIN hat fuer viele Ligen/Spieler keinen To-Score-
        // Markt, Betfair aber schon — der Boost-Arb „Torschuetze trifft"
        // braucht genau diesen BF-Lay als Gegenwette (analog ou/hfou-BF-only-
        // Kanaele fuer Lay-Both). Vorher meldete der Check faelschlich
        // „pts (kein verwandter Markt im Scan)", obwohl der Lay da war.
        const pinSpecs = h.pts || [];
        const entries = Object.entries(b.pts || {});
        let mitLay = 0, matched = 0, bfOnly = 0;
        for (const [player, bf] of entries) {
          const cand = pinSpecs.find(p => teamMatch(p.player, player));
          // Back-Lay: PIN Yes vs BF Lay
          if (bf.lay) {
            mitLay++;
            if (cand) {
              matched++;
              add(k + ' ' + player, cand.yes, bf.lay,
                'PIN To-Score-Spec ' + cand.sid + ' (' + player + ')',
                'BF ' + player, cand.no > 1.01 ? 'No ' + cand.no.toFixed(2) : '');
            } else {
              // BF-Lay-only-Kanal: Spielername in den pinSrc, damit das
              // Python-Spieler-Matching (src-Feld) den Boost-Leg findet.
              bfOnly++;
              add(k + ' ' + player, null, bf.lay,
                'kein PIN-To-Score-Special (' + player + ')',
                'BF ' + player, '');
            }
          }
          // Back-Back-Cross (ptsBB): PIN No + BF Yes-Back
          if (cand && isValidPrice(cand.no) && isValidPrice(bf.back)) {
            const eBb = computeBBEdge(cand.no, bf.back);
            const r = eBb > 0 ? 'BB-Edge ' + (eBb * 100).toFixed(1) + '%' :
              'kein BB-Edge: ' + (eBb * 100).toFixed(1) + '%';
            const line = '  [ptsBB] ' + player + ' PIN-No=' + cand.no.toFixed(2) +
              ' BF-Back=' + bf.back.toFixed(2) + ' (trifft nicht + trifft) ==> ' + r;
            log(line);
            out.channels.push({ kind: 'ptsBB', pinBack: cand.no, bfLay: bf.back,
              pinSrc: 'PIN ' + player + ' No-Back + BF Yes-Back (Spec ' + cand.sid + ')',
              bfSrc: 'BF ' + player + ' Back', reason: [r] });
          }
        }
        if (!pinSpecs.length)
          log('  [pts] ' + b.name + ': kein PIN-To-Score-Special (' + entries.length +
            ' BF-Runner, davon ' + bfOnly + ' mit Lay als BF-only-Kanal)');
        else if (!mitLay) log('  [pts] ' + b.name + ': BF ohne Lay je Spieler');
        else log('  [pts] ' + b.name + ': ' + matched + '/' + entries.length +
          ' Spieler mit PIN-Match' + (bfOnly ? ' (+' + bfOnly +
            ' BF-only ohne PIN-Special)' : '') +
          (mitLay !== entries.length ?
            ' (' + (entries.length - mitLay) + ' ohne BF-Lay)' : ''));
      } else {
        log('  [' + k + '] ' + b.name + ' (Kanal ohne Detail im Helper)');
      }
    }

    // Kompakte Zusammenfassung der Linien-Gaps (statisch kein PIN-Pendant).
    if (skipped.length) {
      const cnt = {};
      for (const n of skipped) cnt[n] = (cnt[n] || 0) + 1;
      log('  Linien-Gaps ohne PIN-Pendant (nur BF-Seite — fuer Lay-Both nutzbar): ' +
        Object.keys(cnt).map(n => n + (cnt[n] > 1 ? ' x' + cnt[n] : '')).join(' | '));
    }

    // Luecken-Erkennung: PIN-w2n-Specials fuer Teams, zu denen KEIN BF-w2n-Markt
    // existiert, sichtbar machen (Stichprobe: Betfair hat hier z.B. nur einen
    // "Win To Nil"-Markt fuer ein Team, obwohl PIN beide Teams liefert).
    const w2nBFTeams = (bs || []).filter(x => x.kind === 'w2n').map(x => x.team);
    for (const w of (h.w2ns || [])) {
      if (!w2nBFTeams.some(t => teamMatch(t, w.team))) {
        add('w2n ' + w.team, w.yes > 1.01 ? w.yes : null, null,
          'PIN W2N-Spec ' + w.sid + ' (' + w.team + ')',
          'kein BF-w2n-Markt fuer ' + w.team, 'Luecke: BF fehlt');
      }
    }

    if (o.download === true) {
      const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'why_' + mid + '.json';
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }
    log('=== WHY FERTIG (' + out.channels.length + ' Kanal-Checks)' +
      (out.reasons.length ? ' — Gruende: ' + out.reasons.join(' | ') : '') + ' ===');
    return out;
  };

  // ---------- Konsole-Helper: Such-Rohtreffer anzeigen ----------
  // __bfsearchRaw("Australia Cup") -> zeigt, was die Betfair-Suche wirklich liefert
  // (cid + aufgeloester COMP-Name + sportId/effSid). Deckt auf, warum ein COMP trotz
  // exakt passendem Namen NICHT im Discovery-Vorschlag landet (z.B. weil der
  // Suchindex ihn unter anderem Namen rankt oder der Treffer ein anderer COMP ist).
  // Angezeigt werden BEIDE Sport-IDs: sportId = Facette der Suche (Suchindex),
  // effSid = from nodeInfo (what the Sport-Guard in scoreCands vergleicht).
  // Umbenannt von __bfsearch -> __bfsearchRaw: die dokumentierte 3-Arg-Variante
  // __bfsearch(kw, sport, budget) (COMP-Suche, WORKFLOW.md) wurde ueberschrieben.
  unsafeWindow.__bfsearchRaw = async (q, max) => {
    const log = devlog;
    const n = Math.max(1, Math.min(50, Number(max) || 20));
    log('BF-Search: "' + q + '" (max ' + n + ')');
    const res = await bfSearch(String(q)).catch(e => { log('ERROR: ' + e); return []; });
    if (!res.length) { log('Keine Treffer.'); return; }
    log(res.length + ' Treffer, lade Namen...');
    const out = [];
    for (const o of res.slice(0, n)) {
      await sleep(40);
      const info = await nodeInfo(o.cid).catch(() => null);
      out.push({ cid: o.cid, sportId: o.sportId,
        name: info ? info.cn : '(kein Name)', effSid: info ? info.effSid : undefined });
    }
    out.forEach(x => log('  ' + x.cid +
      ' sportId=' + (x.sportId !== undefined ? x.sportId : '-') +
      ' effSid=' + (x.effSid !== undefined ? x.effSid : '-') +
      ' | ' + x.name));
    return out;
  };

  // ---------- Konsole-Helper: Mapping-Verifikation (COMP-Reuse-Erkennung) ----------
  // __bfverify('soccer') -> prueft alle COMPs einer Sportart aus dem Mapping
  // Gegen das LIVE bynode-Ergebnis. Erkennt COMP-Reuse:
  //   OK     = COMP-Name passt zum Mapping
  //   REUSED = COMP-Name weicht ab (anderer Wettbewerb im selben COMP!)
  //   EMPTY  = COMP liefert keine Events
  //   ERROR  = COMP nicht abrufbar
  unsafeWindow.__bfverify = async (sport) => {
    const log = devlog;
    const section = (sport || 'cs').toLowerCase() === 'h2h' ? 'h2h' : 'cs';
    log('BF-Verify: Sektion ' + section);

    // Mapping vom lokalen Server laden (App-API: GET /league-map auf Port 8765)
    let mapping = null;
    try {
      const r = await fetch(PIPE + '/league-map').catch(() => null);
      if (r && r.ok) {
        const j = await r.json().catch(() => null);
        if (j && j.mapping) mapping = j.mapping;
      }
    } catch (e) {}
    if (!mapping || !mapping[section]) {
      log('Mapping nicht vom Server ladbar - nutze eingebettete Tabelle');
      mapping = null;
    }

    const comps = [];
    if (mapping) {
      for (const [pid, info] of Object.entries(mapping[section])) {
        const compStr = info.comp || '';
        const m = compStr.match(/^COMP:(\d+)$/);
        if (m) comps.push({ pid, cid: m[1], name: info.name || '', mappedName: info.name || '' });
      }
    } else {
      log('Kein Mapping verfuegbar. Bitte zuerst Server starten (Scanner).');
      return;
    }
    log(comps.length + ' COMPs in Mapping-Sektion ' + section);

    const results = [];
    for (let i = 0; i < comps.length; i++) {
      const c = comps[i];
      await sleep(60);
      const j = await bfBynode('COMP:' + c.cid, 'MENU,EVENT', 6, 500).catch(() => null);
      if (!j || !j.nodes) {
        results.push({ pid: c.pid, cid: c.cid, mappedName: c.mappedName, status: 'ERROR', liveName: '' });
        continue;
      }
      // Live-Name des COMP: Knoten-Name der COMP selbst
      const compNode = j.nodes.find(n => String(n.nodeId||n.id) === 'COMP:' + c.cid);
      const liveName = (compNode && compNode.name) || '';
      // Events im COMP
      const events = j.nodes.filter(n => {
        const nm = n.name || '';
        return nm.includes(' v ') || nm.includes(' vs ');
      });
      const evNames = events.slice(0, 5).map(e => e.name);
      const hasEvents = events.length > 0;

      let status;
      if (!liveName && !hasEvents) status = 'EMPTY';
      else if (liveName && liveName.trim() !== c.mappedName.trim()) status = 'REUSED';
      else status = 'OK';

      results.push({ pid: c.pid, cid: c.cid, mappedName: c.mappedName, status, liveName, events: events.length, evNames });
      const marker = status === 'OK' ? '  ' : status === 'REUSED' ? '!!' : status === 'EMPTY' ? '--' : 'XX';
      log(marker + ' pid ' + c.pid + ' (' + c.mappedName + ') [' + status + ']' +
          (liveName ? ' -> live: ' + liveName : '') + ' | ' + events.length + ' Events');
      if (i % 20 === 19) log('... Fortschritt: ' + (i+1) + '/' + comps.length);
    }

    // Report zaehlen
    const counts = {};
    for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
    log('\n=== VERIFY-REPORT (' + section + ') ===');
    for (const [s, n] of Object.entries(counts)) log('  ' + s + ': ' + n);

    const blob = new Blob([JSON.stringify({ section, counts, results }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'verify_report_' + section + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    log('Download: verify_report_' + section + '.json');
  };

  // ---------- Konsole-Helper: SPORT-Knoten-Erkennung verifizieren ----------
  // __bfsport(857992) -> testet Parameter-Varianten von bynode und zeigt,
  // ob/wie der SPORT-Knoten (sportId) der COMP geliefert wird.
  // Bekannt: attachments=MENU,SPORT -> HTTP 400 (SPORT nicht erlaubt).
  unsafeWindow.__bfsport = async cid => {
    const id = 'COMP:' + String(cid).replace(/^COMP:/, '');
    const variants = [
      { att: 'MENU', out: 2, in: 5 },
      { att: 'MENU', out: 2, in: 1 },
      { att: 'MENU', out: 0, in: 0 },
      { att: 'MENU,EVENT', out: 2, in: 5 },
      { att: 'EVENT_TYPE', out: 2, in: 5 },
    ];
    for (const v of variants) {
      const url = 'https://www.betfair.com/www/sports/navigation/v2/graph/bynode?' +
        bfQ({ nodeIds: id, attachments: v.att, maxOutDistance: v.out,
          maxInDistance: v.in, maxResults: 50 });
      let r = null;
      try { r = await fetch(url); } catch (e) { r = e; }
      const status = r && r.status ? r.status : 'ERR';
      if (status !== 200) { devlog(v.att + ' out' + v.out + ' in' + v.in + ' -> HTTP ' + status); continue; }
      const j = await r.json().catch(() => null);
      const nodes = (j && j.nodes) || [];
      devlog('--- ' + v.att + ' out' + v.out + ' in' + v.in + ': ' + nodes.length + ' Knoten');
      const uniq = [...new Set(nodes.map(n => n.nodeType))];
      devlog('  NodeTypes: ' + uniq.join(', '));
      const effSid = sportFromNodes(nodes);
      devlog(effSid !== undefined ? '  effSid: ' + effSid : '  Sport-ID: NICHT gefunden');
      devlog('  Knoten: ' + nodes.slice(0, 10).map(n => n.nodeType + ' ' +
        (n.nodeId || n.id) + ' ' + JSON.stringify(n.name || '') +
        (n.sportId !== undefined ? ' (sportId ' + n.sportId + ')' : '')).join(' | '));
    }
  };

  // ---------- Tool-Registry (Debug-Werkzeuge) ----------
  // Zentrale Liste aller Dev-/Probe-Tools. Der GUI-Dialog "Dev-Tools",
  // __tools__() und (kuenftig) URL-Trigger werden daraus generiert:
  // neues Tool = { id, label, desc, params:[{k,v}], run } eintragen.
  const TOOLS = [    { id: 'bfht', group: 'diagnose', label: 'BF Marktnamen/FIlter', desc: 'Listet Marktnamen sowie optional gefilterte Maerkte einer COMP.',
      params: [{ k: 'comp', label: 'COMP', v: 'COMP:129' }, { k: 'kw', label: 'Keyword', v: '' }],
      run: a => unsafeWindow.__bfht(a.comp, a.kw) },
    // Generisches Einzelmarkt-Probe-Tool: ersetzt die frueheren Einzel-Buttons
    // (ahprobe/hfprobe/w2nprobe/fdprobe/gsprobe/oucombo/oeprobe/pprobe), die alle
    // dieselbe Signatur (comp, pinLid) hatten. Die Funktionen bleiben fuer
    // URL-Trigger (?ahprobe=…) erhalten.
    { id: 'marktprobe', group: 'probes', label: 'Markt-Probe (struktur)', desc: 'Markt-Struktur EINER Wettart (PIN + BF) anzeigen: Markttyp waehlen + COMP/(optional) PIN-Liga oder Matchup-ID. Deckt AH, HT/FT, Win-to-Nil, UFC-Decision, Torschuetze, Result+O/U, Odd/Even und Penalty ab.',
      params: [{ k: 'typ', label: 'Markttyp', v: 'ah', options: [
          { v: 'ah', label: 'AH (Asian Handicap)' }, { v: 'hf', label: 'HT/FT' },
          { v: 'w2n', label: 'Win-to-Nil' }, { v: 'fd', label: 'UFC Fight-Decision' },
          { v: 'gs', label: 'Torschuetze' }, { v: 'ou', label: 'Result + O/U' },
          { v: 'oe', label: 'Odd/Even' }, { v: 'pp', label: 'Penalty' }] },
        { k: 'comp', label: 'COMP/Name', v: 'COMP:129' }, { k: 'pinLid', label: 'PIN-Liga/-ID', v: '' }],
      run: async a => {
        const map = { ah: '__ahProbe', hf: '__hfprobe', w2n: '__w2nprobe',
          fd: '__fdprobe', gs: '__gsprobe', ou: '__oucombo', oe: '__oeprobe',
          pp: '__pprobe' };
        const fn = map[a.typ] || '__ahProbe';
        await window[fn](a.comp, a.pinLid);
      },
      flush: () => ahProbeOut.splice(0, ahProbeOut.length) },
    { id: 'hffind', group: 'diagnose', label: 'Spiel suchen (half/full)', desc: 'Spiele per Teamname in allen Ligen finden.',
      params: [{ k: 'kw', label: 'Suchbegriff', v: '' }],
      run: a => unsafeWindow.__hffind(a.kw) },
    // Generisches Liga-/COMP-Pflege-Tool: bündelt die frueheren Mapping-
    // Einzel-Buttons (bfnav/bfunmap/bfverify/bfsearch/bfsport/bfcapture) ueber
    // ein Aktionen-Dropdown — gleiche Signatur (kompakt) statt 6 Tools mit
    // teils aehnlicher Signatur. Die Funktionen bleiben fuer URL-Trigger
    // (?bfnav=… etc.) erhalten.
    { id: 'bfmapping', group: 'mapping', label: 'Liga-/COMP-Pflege (Mapping)', desc: 'Steuert Ligen- & COMP-Pflege: Verifikation aller COMPs einer Sektion, Rohtreffer-Suche, Navigationsbaum, Knoten-Varianten-Test, COMP-Capture oder Mapping entfernen (bündelt die früheren bfnav/bfsearch/bfverify/bfsport/bfcapture/bfunmap).',
      params: [{ k: 'akt', label: 'Aktion', v: 'verify', options: [
          { v: 'verify', label: 'Verifikation (alle COMPs, LIVE)' },
          { v: 'search', label: 'Such-Rohtreffer (custom)' },
          { v: 'nav', label: 'Navigationsbaum (bfnav)' },
          { v: 'sport', label: 'Knoten-Varianten (bfsport)' },
          { v: 'capture', label: 'COMP-Capture (absaugen)' },
          { v: 'unmap', label: 'Mapping entfernen' }] },
        { k: 'section', label: 'Sektion (verify)', v: 'cs' },
        { k: 'q', label: 'Query (search/nav)', v: 'Australia Cup' },
        { k: 'max', label: 'Max (search)', v: '20' },
        { k: 'bfSid', label: 'BF-Sport-ID (nav)', v: '1' },
        { k: 'cid', label: 'CID (sport)', v: '97' },
        { k: 'cmd', label: 'Capture-Cmd', v: 'start' },
        { k: 'pid', label: 'PID (unmap)', v: '' }],
      run: a => {
        switch (a.akt) {
          case 'search': return unsafeWindow.__bfsearchRaw(a.q, a.max);
          case 'nav': return unsafeWindow.__bfnav(a.bfSid, a.q);
          case 'sport': return unsafeWindow.__bfsport(a.cid);
          case 'capture': return unsafeWindow.__bfcapture(a.cmd);
          case 'unmap': return unsafeWindow.__bfunmap(a.pid);
          default: return unsafeWindow.__bfverify(a.section === 'h2h' ? 'h2h' : 'cs');
        }
      } },
    { id: 'pinlive', group: 'live', label: 'PIN Live-Erkennung', desc: 'Live-Felder aller Matchups einer PIN-Liga.',
      params: [{ k: 'lid', label: 'PIN-Liga', v: '30' }, { k: 'limit', label: 'Limit', v: '12' }],
      run: a => unsafeWindow.__pinlive(a.lid, a.limit) },
    { id: 'bflive', group: 'live', label: 'BF Live-Erkennung', desc: 'Live-Signale der ersten Maerkte einer COMP.',
      params: [{ k: 'comp', label: 'COMP', v: 'COMP:129' }, { k: 'limit', label: 'Limit', v: '4' }],
      run: a => unsafeWindow.__bflive(a.comp, a.limit) },
    { id: 'pinmatch', group: 'live', label: 'Spiel-Details (PIN)', desc: 'Live-/Status-Felder eines konkreten Spiels.',
      params: [{ k: 'kw', label: 'Suchbegriff', v: '' }],
      run: a => unsafeWindow.__pinmatch(a.kw) },
    { id: 'htcsprobe', group: 'probes', label: 'HT-CS-Probe (PIN Match)', desc: 'Alle Specials + straight-Maerkte eines Matches, HT-CS-Struktur markiert.',
      params: [{ k: 'mid', label: 'Matchup-ID', v: '1633236740' }, { k: 'lid', label: 'Liga-ID', v: '1843' }],
      run: a => unsafeWindow.__htcsprobe(a.mid, a.lid) },
    { id: 'probematch', group: 'diagnose', label: 'Match-Voll-Dump (PIN+BF)', desc: 'Komplette Markt-Struktur EINES Spiels: PIN alle Endpunkte (straight+alts/related/special, key/status) UND BF das Event mit allen Marktnamen+Runner.',
      params: [{ k: 'mid', label: 'PIN-Matchup-ID', v: '1633236740' }, { k: 'comp', label: 'COMP/Name', v: 'COMP:129' }, { k: 'opts', label: 'Opts (JSON)', v: '' }],
      run: a => unsafeWindow.__probeMatch(a.mid, a.comp, a.opts) },
    { id: 'uefaq', group: 'mapping', label: 'UEFA-Qualifiers', desc: 'Matchup-Listen von CL/EL-Qualifiers anzeigen.',
      params: [], run: () => unsafeWindow.__uefaq() },
    // Generisches Snapshot/Download-Tool: ersetzt bfevents/pinevents/bfsnapshot/
    // pinsnapshot durch ein Tool mit Quelle- und Art-Dropdown. Die Funktionen
    // bleiben fuer URL-Trigger erhalten.
    { id: 'snapshot', group: 'snapshot', label: 'Snapshot / Download', desc: 'Struktur-Snapshot oder Events einer Sportart als JSON (Pin oder Betfair). Quelle + Art waehlen, optional Zusatz-COMPs (nur bei BF-Snapshot: via ; oder , getrennt).',
      params: [{ k: 'quelle', label: 'Quelle', v: 'bf', options: [{ v: 'bf', label: 'Betfair' }, { v: 'pin', label: 'Pinnacle' }] },
        { k: 'art', label: 'Art', v: 'events', options: [{ v: 'snapshot', label: 'Snapshot (Struktur)' }, { v: 'events', label: 'Events (Spiele)' }] },
        { k: 'sport', label: 'Sport', v: 'soccer' }, { k: 'extraComps', label: 'Zusatz-COMPs (BF)', v: '' }],
      run: a => {
        const extra = a.extraComps ? String(a.extraComps).split(/[;,]/).map(s => s.trim()).filter(Boolean) : undefined;
        if (a.quelle === 'bf') {
          if (a.art === 'snapshot') return unsafeWindow.__bfsnapshot(a.sport);
          return unsafeWindow.__bfevents(a.sport, extra);
        }
        if (a.art === 'snapshot') return unsafeWindow.__pinsnapshot(a.sport);
        return unsafeWindow.__pinevents(a.sport);
      } },
    { id: 'tree', group: 'snapshot', label: 'Marktbaum Sportart', desc: 'Kompletten Markt-Baum einer Sportart auslesen (PIN-Ligen/straight-Typen + BF-COMPs/Marktnamen) als JSON. Mit {kw} wird ein Match auf beiden Seiten verortet.',
      params: [{ k: 'sport', label: 'Sport', v: 'tennis' }, { k: 'opts', label: 'Opts (JSON)', v: '' }],
      run: a => unsafeWindow.__tree(a.sport, a.opts) },
    { id: 'pinsniff', group: 'live', label: 'PIN-Netz-Schnueffler', desc: 'Zeichnet live auf, welcher Pinnacle-Endpunkt "s;...ou;..."-Keys / isAlternate liefert (fuer Total-Games-Debug).',
      params: [{ k: 'on', label: 'an/aus', v: 'true' }],
      run: a => unsafeWindow.__pinsniff(a.on === 'true' || a.on === true) },

    { id: 'bfdebug', group: 'live', label: 'BF-Debug Knoten', desc: 'Knoten-Struktur zu einer nodeId analysieren.',
      params: [{ k: 'nodeId', label: 'nodeId', v: '4.1' }, { k: 'dist', label: 'dist', v: '6' }],
      run: a => unsafeWindow.__bfdebug(a.nodeId, a.dist) },
    { id: 'bfmkt', group: 'diagnose', label: 'BF-Live-Markt', desc: 'byMarket-Live-Abfrage eines Markts mit voller Lay/Back-Leiter.',
      params: [{ k: 'marketId', label: 'Market-ID', v: '260961195' }],
      run: a => unsafeWindow.__bfmkt(a.marketId) },



    { id: 'leaguewatch', group: 'mapping', label: 'LigaWatch-Report', desc: 'Auslastung warnys: COMP leer / Reuse-Verdacht.',
      params: [], run: () => unsafeWindow.__leaguewatch() },
    { id: 'props', group: 'discovery', label: 'Discovery-Vorschlaege', desc: 'Persistierte Discovery-Ergebnisse (Proposal/Konflikt) auflisten.',
      params: [{ k: 'kind', label: 'Filter (proposal/conflict)', v: '' }],
      run: a => devlog(unsafeWindow.__props(a.kind ? String(a.kind).split('|') : undefined)) },
    { id: 'h2hscan', group: 'discovery', label: 'H2H-Scan (eine Liga)', desc: 'scanH2HLeague fuer genau eine PIN-Liga+COMP (mit Corners-Debug) ausfuehren.',
      params: [{ k: 'lid', label: 'PIN-Liga', v: '1982' }, { k: 'comp', label: 'COMP', v: 'COMP:2134' }],
      run: async a => unsafeWindow.__h2hscan(Number(a.lid), String(a.comp)) },
    { id: 'why', group: 'diagnose', label: 'Warum kein Arb?', desc: 'Fuer ein PIN-Matchup + BF-COMP die Scan-Pipeline fahren: je Wettart (ML/DNB/DC/BTTS/O/U/HT-FT/TQ) PIN-Leg vs BF-Leg und den Abbruch-Grund zeigen.',
      params: [{ k: 'mid', label: 'PIN-Matchup-ID', v: '' }, { k: 'comp', label: 'COMP', v: 'COMP:61' }, { k: 'opts', label: 'Opts (JSON, z.B. {"download":true})', v: '' }],
      // a.sport (App-Override): Die GUI kennt den Sport bereits aus der DB und
      // reicht ihn durch, damit der 2-Wege/3-Wege-Entscheid nicht vom
      // Namen-Regex abhaengt (v8.45.x: MMA/Rugby dauerhaft 2-Weg).
      run: a => {
        let opts = {};
        try { if (a.opts) Object.assign(opts, JSON.parse(a.opts)); } catch (e) {}
        if (a.sport) opts.sport = String(a.sport);
        return unsafeWindow.__why(a.mid, a.comp, JSON.stringify(opts));
      } },
    // pprobe/htcsprobe-Funktionen bleiben erhalten (URL-Trigger); pprobe ist
    // ueber das marktprobe-Tool (typ=pp) abgedeckt. htcsprobe bleibt als
    // eigenes Tool (Match-Lokal, andere Signatur mid/lid vs comp/pinLid).
    { id: 'pinwalk', group: 'snapshot', label: 'PIN-Komplett-Crawler', desc: 'Ligen->Matchups->straight Crawler mit generischer Key-Extraktion (JSON-Download).',
      params: [{ k: 'sport', label: 'Sport', v: 'soccer' }, { k: 'opts', label: 'Opts (JSON)', v: '' }],
      run: a => unsafeWindow.__pinwalk(a.sport, a.opts) },
    { id: 'misses', group: 'discovery', label: 'Discovery-Misses', desc: 'Persistierte Discovery-Misses (pid, name, reason, count, lastSeen) auflisten.',
      params: [], run: () => devlog(unsafeWindow.__misses()) },
    { id: 'discovery-deny', group: 'discovery', label: 'Discovery-Deny (GUI)', desc: 'Perm-Deny aus der VBSB-GUI ("Ablehnen dauerhaft") auf die Deny-Liste anwenden.',
      params: [{ k: 'pid', label: 'PIN-Liga', v: '' }, { k: 'comp', label: 'COMP', v: 'COMP:' }, { k: 'reason', label: 'Grund', v: '' }],
      run: a => {
        if (!a.pid || !a.comp) { devlog('discovery-deny: pid + comp erforderlich'); return; }
        denyUpsert(String(a.pid), String(a.comp),
          String(a.reason || 'GUI-Ablehnung (Discovery-Tab)'), true);
        devlog('Discovery-Deny dauerhaft: pid ' + a.pid + ' -> ' + a.comp +
          ' (' + (a.reason || 'GUI-Ablehnung (Discovery-Tab)') + ')');
      } },
    // Name-Matching: bestaetigtes Alias aus der VBSB-GUI (Name-Matching-Tab)
    // sofort im laufenden Scanner aktivieren — ohne Rebuild/Tampermonkey-
    // Update. aliases: [{from, to}, ...] oder {from: to}. Der naechste Build
    // uebernimmt die bestaetigten Aliase dauerhaft via synonyms.json.
    { id: 'alias-set', group: 'mapping', label: 'Alias setzen (Runtime)', desc: 'Runtime-Alias aus der VBSB-GUI (Name-Matching-Tab) sofort im laufenden Scanner aktivieren (wirkt in jedem teamMatch/findH/evMatch, kein Rebuild noetig). aliases: [{from,to}] oder {from:to}.',
      params: [],
      run: a => {
        const raw = a.aliases;
        let list = [];
        if (Array.isArray(raw)) list = raw;
        else if (raw && typeof raw === 'object') list = Object.entries(raw)
          .map(([from, to]) => ({ from, to }));
        let n = 0;
        for (const e of list) {
          if (setRuntimeAlias(e.from, e.to)) n++;
        }
        if (n) devlog('Runtime-Alias gesetzt: ' + n + ' (' + list.map(x => x.from + ' -> ' + x.to).join(' | ') + ')');
        else devlog('alias-set: keine Aliase uebernommen (leer/ungueltig)');
        return { ok: true, set: n };
      } },
  ];
  // Tool-Gruppen (Reihenfolge = Reihenfolge beim Rendern von Dropdown/Optgroup).
  const TOOL_GROUP_LABELS = [
    ['diagnose', 'Diagnose / Warum-kein-Arb'],
    ['probes', 'Markt-Probes (Einzelmarkt-Struktur)'],
    ['mapping', 'Liga- / COMP-Pflege & Mapping'],
    ['snapshot', 'Snapshots / Downloads'],
    ['live', 'Live / Netz-Debug'],
    ['discovery', 'Discovery / H2H'],
  ];
  const toolGroupLabel = g => {
    const row = TOOL_GROUP_LABELS.find(r => r[0] === g);
    return row ? row[1] : g;
  };
  const toolsGrouped = () => TOOL_GROUP_LABELS
    .map(([g]) => TOOLS.filter(t => t.group === g))
    .reduce((a, b) => a.concat(b), [])
    .concat(TOOLS.filter(t => !t.group));
  // Konsole: Liste aller Tools nach Gruppe anzeigen
  unsafeWindow.__tools = () => toolsGrouped()
    .map(t => '[' + toolGroupLabel(t.group) + '] ' + t.id + ' - ' + t.label)
    .join('\n');
  // ---------- Passiver Beobachter: COMP<->Liga-Plausibilitaet ----------
  // Loggt wenn ein COMP keine Events liefert, obwohl PIN die Liga zeigt,
  // oder wenn KEIN BF-Event zu den PIN-Teams passt (moegliches COMP-Reuse).
  // KEINE Aenderung am Mapping - nur Diagnose!
  const leagueWatch = { runs: 0, emptyComp: 0, noTeamMatch: 0, suppressed: 0, suppressedLids: [], suspicious: [] };
  // Pro Scan zuruecksetzen: Die Zaehler/Listen sind sonst module-scope und
  // wachsen bei Auto-Scans ueber Stunden unbegrenzt (Speicherleck).
  const leagueWatchReset = () => {
    leagueWatch.runs = 0;
    leagueWatch.emptyComp = 0;
    leagueWatch.noTeamMatch = 0;
    leagueWatch.suppressed = 0;
    leagueWatch.suppressedLids = [];
    leagueWatch.suspicious = [];
  };
  unsafeWindow.__leaguewatch = () => {
    const out = devlog;
    const fmt = m => typeof m === 'string' ? m : JSON.stringify(m);
    out(fmt({ runs: leagueWatch.runs, empty: leagueWatch.emptyComp, mismatch: leagueWatch.noTeamMatch }));
    leagueWatch.suspicious.slice(0, 30).forEach(s =>
      out('  pid ' + s.lid + ' (' + s.leagueName + ') COMP ' + s.comp +
        '\n    BF: ' + s.evs + '\n    PIN: ' + s.pinT +
        (s.st ? '  [PIN raw=' + s.st.pinRaw + '/kept=' + s.st.pinOut +
          ', BF raw=' + s.st.bfRaw + '/kept=' + s.st.bfOut + ']' : '')));
    return 'LigaWatch: ' + leagueWatch.emptyComp + ' leer / ' +
      leagueWatch.noTeamMatch + ' mismatch' +
      (leagueWatch.suppressed ? ' / ' + leagueWatch.suppressed + ' suppressed' : '');
  };
  async function bfLaysWrap(lid, comp, log) {
    const st = {};
    // PIN zuerst: liegen im Scan-Fenster (daysAhead) gar keine Spiele, brauchen
    // wir die BF-Maerkte (bynode + bymarket) nicht — spart bei kurzem Fenster
    // den kompletten BF-Abruf fuer Ligen ohne anstehende Spiele.
    const pin = await pinGames(lid, log, st);
    const lays = Object.keys(pin).length ? await bfLays(comp, log, st) : [];
    leagueWatch.runs++;
    const leagueName = LIGA_NAMEN[lid] || '';
    if (Object.keys(pin).length > 0 && (!lays || lays.length === 0)) {
      // Bekanntlich leere COMPs: nur als Zaehler (suppressed), keine laute Warnung.
      if (SUPPRESSED_EMPTY[lid] === comp) {
        leagueWatch.suppressed++;
        if (!leagueWatch.suppressedLids.includes(lid)) leagueWatch.suppressedLids.push(lid);
        return [pin, lays];
      }
      // Auch hier erst ab >=3 PIN-Spielen melden (Fenster/Pause-Rauschen).
      if (st.pinOut >= 3) {
        leagueWatch.emptyComp++;
        leagueWatch.suspicious.push({ lid, leagueName, comp,
          evs: '(COMP leer)',
          pinT: Object.values(pin).slice(0, 3).map(p => p.teams.join(' v ')).join(' | '),
          st });
        // Warning gesammelt in leagueWatch.suspicious — Zusammenfassung am Ende (ui.js)
      }
    } else if (lays && lays.length > 0 && Object.keys(pin).length > 0) {
      // Kein BF-Event passt zu einem PIN-Team?
      let anyMatch = false, matches = 0;
      for (const b of lays) {
        const hit = Object.values(pin).find(p =>
          evMatch([p.teams[0], p.teams[1]], b.name));
        if (hit) { anyMatch = true; matches++; }
      }
      if (st) st.matchCount = matches;
      // Erst ab >=3 PIN-Spielen melden: Bei 1-2 Spielen ist eine leere
      // Schnittmenge Zufall (PIN-Fenster 4 Tage vs BF-Gesamtprogramm,
      // Cup-Spiele im PIN-Liga-Feed). Ab 3+ ist Reuse-verdaechtig.
      if (!anyMatch && st.pinOut >= 3) {
        leagueWatch.noTeamMatch++;
        const seen = {}, evs = [];
        for (const b of lays) if (!seen[b.name]) { seen[b.name] = true; evs.push(b.name); }
        leagueWatch.suspicious.push({ lid, leagueName, comp,
          evs: evs.slice(0, 3).join(' | '),
          pinT: Object.values(pin).slice(0, 3).map(p => p.teams.join(' v ')).join(' | '),
          st });
        // Warning gesammelt in leagueWatch.suspicious — Zusammenfassung am Ende (ui.js)
      }
    }
    return [pin, lays];
  }

  // ---------- Pinnacle: BTTS-Special per Preis-Abgleich bestimmen ----------
  // Liefert { pre, bb }: pre = bester Preismatch (Score < Schwelle), bb = bester BB-Kandidat
  async function pinBtts(yn, b, log) {
    const bests = await pool(yn, async s => {
      let raw = null;
      const pr = await fetchStraight(s.sid, log, 'btts', null, r => (raw = r));
      if (!pr) { if (DBG) log('  BTTS-DBG ' + b.name + ' spec=' + s.sid + ': freshMkts null (raw=' + !!raw + ')'); return null; }
      const px = {};
      for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
      if (!px[s.yesId] || !px[s.noId]) {
        const ids = Object.keys(px);
        if (DBG) log('  BTTS-DBG ' + b.name + ' spec=' + s.sid + ': yesId=' + s.yesId + ' noId=' + s.noId +
          ' available=' + ids.length + ' sample=' + ids.slice(0, 6).join(','));
        return null;
      }
      const y = dec(px[s.yesId]), n = dec(px[s.noId]);
      const score = price(y, b.layYes) + price(n, b.layNo);
      return { score, yes: y, no: n, sid: s.sid, desc: s.desc || '' };
    }, POOL_CONCURRENCY);
    const ok = bests.filter(x => x);
    // Preismatch: Score < Schwelle
    const pre = bests.reduce((b2, x) =>
      (x && x.score < PRICE_MATCH_THRESHOLD && (!b2 || x.score < b2.score)) ? x : b2, null);
    // BB-Kandidat: bester Score unabhaengig von Schwelle
    const bb = bests.reduce((b2, x) =>
      (x && (!b2 || x.score < b2.score)) ? x : b2, null);
    if (!ok.length && yn.length)
      if (DBG) log('  BTTS-DBG ' + b.name + ': ' + yn.length + ' Specs geprueft, 0 OK');
    if (pre) log('  BTTS ' + b.name + ': Spec ' + pre.sid + ' "' + (pre.desc || '?') + '" (Yes ' + pre.yes.toFixed(2) +
      ' / No ' + pre.no.toFixed(2) + ') Score ' + pre.score.toFixed(3));
    else log('  BTTS ' + b.name + ': kein Preismatch (Score >= ' + PRICE_MATCH_THRESHOLD + ')');
    if (bb && (!pre || bb.sid !== pre.sid))
      log('  BTTS BB ' + b.name + ': Spec ' + bb.sid + ' "' + (bb.desc || '?') + '" (Yes ' + bb.yes.toFixed(2) +
        ' / No ' + bb.no.toFixed(2) + ') Score ' + bb.score.toFixed(3) +
        ' BF-Back: Y=' + b.backYes.toFixed(2) + ' N=' + b.backNo.toFixed(2));
    return { pre, bb };
  }

  // Odd/Even (Total Goals) ist bei PIN ein Special mit Teilnehmern
  // "Odd"/"Even" (nicht Straight). Preise kommen aus dem Straight-Fetch
  // des Specials. Rueckgabe { pre, bb } wie pinBtts.
  async function pinOeSpecs(specs, b, log) {
    const bests = await pool(specs, async s => {
      const pr = await fetchStraight(s.sid, log, 'oe');
      if (!pr) return null;
      const px = {};
      for (const mkt of pr) for (const p of (mkt.prices || [])) px[p.participantId] = p.price;
      if (!px[s.oddId] || !px[s.evenId]) {
        if (DBG) log('  OE-DBG ' + b.name + ' spec=' + s.sid + ': oddId=' + s.oddId + ' evenId=' + s.evenId +
          ' available=' + Object.keys(px).length + ' sample=' + Object.keys(px).slice(0, 6).join(','));
        return null;
      }
      const odd = dec(px[s.oddId]), even = dec(px[s.evenId]);
      if (!(odd > 1.01) || !(even > 1.01)) return null;
      const legs = [];
      if (b.odd && b.odd.lay > 0) legs.push(price(odd, b.odd.lay));
      if (b.even && b.even.lay > 0) legs.push(price(even, b.even.lay));
      const score = legs.length ? legs.reduce((a, l) => a + l) : 0;
      return { score, odd, even, sid: s.sid, desc: s.desc || '' };
    }, POOL_CONCURRENCY);
    const ok = bests.filter(x => x);
    const pre = bests.reduce((b2, x) =>
      (x && x.score < PRICE_MATCH_THRESHOLD && (!b2 || x.score < b2.score)) ? x : b2, null);
    const bb = bests.reduce((b2, x) =>
      (x && (!b2 || x.score < b2.score)) ? x : b2, null);
    if (!ok.length && specs.length)
      if (DBG) log('  OE-DBG ' + b.name + ': ' + specs.length + ' Specs geprueft, 0 OK');
    if (pre) log('  OE ' + b.name + ': Spec ' + pre.sid + ' "' + (pre.desc || '?') + '" (Odd ' +
      pre.odd.toFixed(2) + ' / Even ' + pre.even.toFixed(2) + ') Score ' + pre.score.toFixed(3));
    else log('  OE ' + b.name + ': kein Preismatch (Score >= ' + PRICE_MATCH_THRESHOLD + ')');
    if (bb && (!pre || bb.sid !== pre.sid))
      log('  OE BB ' + b.name + ': Spec ' + bb.sid + ' "' + (bb.desc || '?') + '" (Odd ' +
        bb.odd.toFixed(2) + ' / Even ' + bb.even.toFixed(2) + ') Score ' + bb.score.toFixed(3) +
        ' BF-Back odd=' + (b.odd && b.odd.back ? b.odd.back.toFixed(2) : '-') +
        ' even=' + (b.even && b.even.back ? b.even.back.toFixed(2) : '-'));
    return { pre, bb };
  }

  // ---------- Scan (eine Liga) ----------
  // TIMING-Sammlung je Liga: wird in scan() am Ende als Summary ausgegeben.
  // Kennzahlen:
  //   fetch = PIN- und BF-Daten abholen (Netzwerk)
  //   match = reine Verarbeitung (CPU)
  //   async = nachgelagerte Pools (O/U, HT-O/U, AH)
  //   total = Summe
  const scanTimings = [];
  async function scanLeague(lid, comp, log, rows, games) {
    const t0 = Date.now();
    const [pin, lays] = await bfLaysWrap(lid, comp, log);
    const tFetch = Date.now();
    // ALLE PIN-Matchups der Liga sammeln (auch ohne Arb/Edge): die Spielsuche
    // in Pruefung/Boost-Arb soll jedes Spiel des letzten Scans finden, damit
    // man z.B. mit Boost-Anbietern kombinieren kann (v8.39.0). Nur Spiele mit
    // handelbaren Preisen sind in pin enthalten — genau die sind relevant.
    if (games) {
      const lgName = LIGA_NAMEN[lid] || '';
      for (const p of Object.values(pin)) {
        const nm = (p.teams || []).filter(Boolean).join(' v ');
        if (!nm) continue;
        games.push({ league: lid, leagueName: lgName, name: nm,
          mid: String(p.id || ''), startTime: p.st || '', comp: comp });
      }
    }
    if (!Object.keys(pin).length) return;
    const btts = [], ous = [], hfous = [], mo3s = [], mo3hs = [], ahs = [], hfs = [], w2ns = [], btsws = [], tts = [], euhs = [];
    const dnbs = [], dcs = [], resous = [], oes = [], tqs = [], pts = [];
    const mo3hDbg = {}, mo3Dbg = {}, hcsDbg = {};
    let oeNoH = false, oeNoSpec = 0;
    const findH = (nb, rawName) => {
      for (const p of Object.values(pin)) {
        if (teamMatch(p.teams[0], nb) && teamMatch(p.teams[1], nb)) return p;
      }
      // Am ORIGINAL-Namen splitten (nicht normiert), damit Bindestriche in
      // Teamnamen (z.B. "Tokyo-V") nicht zu extra Tokens werden.
      const halves = (rawName || nb).split(/\s+v\s+/i).filter(Boolean);
      if (halves.length !== 2) return null;
      let hit = null, n = 0;
      for (const p of Object.values(pin)) {
        const ok =
          (teamMatch(p.teams[0], halves[0]) && teamMatch(p.teams[1], halves[1])) ||
          (teamMatch(p.teams[0], halves[1]) && teamMatch(p.teams[1], halves[0]));
        if (ok) { hit = p; n++; }
      }
      return n === 1 ? hit : null;
    };
    // To Qualify: PIN-Moneyline period=8 aus den straight-Maerkten eines Spiels
    // extrahieren (2-Wege "wer kommt weiter", kein Draw). Rueckgabe [home, away]
    // nur wenn beide Preise handelbar sind.
    const tqFromMl = (pr, teams) => {
      const mkt = (pr || []).find(m => /^moneyline$/i.test(String(m.type || '')) &&
        Number(m.period) === 8);
      if (!mkt) return null;
      const pxD = {};
      const nameById = {};
      for (const pt of (mkt.participants || []))
        nameById[pt.id ?? pt.participantId] = pt.name;
      for (const p of (mkt.prices || [])) {
        if (!p || typeof p.price !== 'number') continue;
        if (p.designation) pxD[String(p.designation).toLowerCase()] = p.price;
        else if (p.participantId != null) {
          pxD['p' + p.participantId] = p.price;
          const nm = nameById[p.participantId];
          if (nm) pxD[String(nm).toLowerCase()] = p.price;
        } else if (p.participant && p.participant.name)
          pxD[String(p.participant.name).toLowerCase()] = p.price;
      }
      const q = (team, d) => {
        const low = team ? String(team).toLowerCase() : '';
        return toDecU(pxD[d] ?? (low ? pxD[low] : 0) ?? 0);
      };
      const ta = q(teams[0], 'home') || q(teams[0], '1');
      const tb = q(teams[1], 'away') || q(teams[1], '2');
      return (ta > 1.01 && tb > 1.01) ? [ta, tb] : null;
    };
    const tqSurname = t => {
      const ws = norm(t).split(' ').filter(w => w && !STOPW.has(w));
      return ws.length ? ws[ws.length - 1] : '';
    };
    const tqMS = (team, rn) => {
      if (teamMatch(team, rn.nm)) return 3;
      const sn = tqSurname(team);
      return sn && norm(rn.nm).split(' ').includes(sn) ? 1 : 0;
    };
    for (const b of lays) {
      const nb = norm(b.name);
      const h = findH(nb, b.name);
      if (!h) {
        // Name-Candidates: Near-Miss-Sammlung fuer den Name-Matching-Tab
        // (v8.61.0) — nur bei Events, die wirklich keinem PIN-Spiel zuorden-
        // bar sind; Dedupe/Cap verhindern Fluten im Dauerbetrieb.
        if (!collectNameCand(b.name, pin, lid, comp, LIGA_NAMEN[lid] || ''))
          collectUnmatched(b.name, lid, comp, LIGA_NAMEN[lid] || '', b.st);
        if (b.kind === 'cs' || b.kind.startsWith('cs') || b.kind.startsWith('hcs'))
          pushRow(rows, lid, { name: b.name, hit: null, b,
            kind: b.kind, lay: b.lay, vol: b.vol });
        else if (b.kind === 'oe' && !oeNoH) {
          oeNoH = true;
          if (DBG) log('  OE-DBG ' + lid + ': BF "' + b.name + '" passt zu keinem PIN-Spiel');
        }
        continue;
      }
      if (b.kind === 'cs' || b.kind.startsWith('cs')) {
        // Bestimme Score-Key: "cs00" -> "0,0", "cs11" -> "1,1" etc.
        const csKey = b.kind.replace('cs', '').replace(/(\d)(\d)/, '$1,$2');
        // CS 1:1: max(CS 1:1, Y&U) — Y&U = BTTS Yes + Under 2.5 = nur 1:1
        // Andere CS: nur echter CS-Back-Preis, kein Y&U-Fallback
        let csBack = (h.csBacks && h.csBacks[csKey]) || 0;
        let csSrc = csKey === '1,1' ? (h.src || 'CS 1:1') : ('CS ' + csKey);
        // cs00 MAX: bester Back-Preis ueber CS 0:0, Under 0.5, Either TTS=No,
        // Exact Goals=0, First TTS=Neither (v8.15.0) — via cs00Backs
        if (csKey === '0,0' && h.cs00Backs && h.cs00Backs.length) {
          const allCs00 = [
            { back: csBack, src: csSrc },
            ...h.cs00Backs
          ].filter(s => s.back > 0);
          if (allCs00.length) {
            const best = allCs00.reduce((a, b) => b.back > a.back ? b : a);
            csBack = best.back;
            csSrc = best.src;
          }
        }
        // cs11 MAX: bester Back-Preis ueber CS 1:1 und "Yes & Under 2.5"
        // (= BTTS Yes + Under 2.5 = exakt 1:1). Analog cs00.
        if (csKey === '1,1' && h.cs11Backs && h.cs11Backs.length) {
          const allCs11 = [
            { back: csBack, src: csSrc },
            ...h.cs11Backs
          ].filter(s => s.back > 0);
          if (allCs11.length) {
            const best = allCs11.reduce((a, b) => b.back > a.back ? b : a);
            csBack = best.back;
            csSrc = best.src;
          }
        }
        // v8.60.34: CS-Rows auch OHNE Arb-Richtung speichern. Der Boost-Arb-
        // Solver braucht die BF-CS-Lays (Score-Mengen-Muster 6/7/9: Lay der
        // exakten Endstaende) und die PIN-CS-Backs (Score-Luecken-Back) auch
        // dann, wenn PIN-Back < BF-Lay ist (der Normalfall) — vorher
        // verwarf arbDir() genau diese Rows, der Snapshot hatte nie CS-Quoten
        // und die intelligenten Correct-Score-Strategien fehlten im
        // Boost-Check (User-Befund „BTTS Ja ∧ Over 5.5“: nur teurer
        // Doppel-Lay). Die App-Surebet-Liste zeigt weiterhin nur edge > 0
        // (pvb_odds_pipe), Nicht-Arb-CS-Rows sind dort unsichtbar, aber fuer
        // den Boost-Check nutzbar.
        if (b.lay >= 200) continue;                // BF-Platzhalter ohne Markt
        if (!csBack && !(b.lay > 1.01)) continue;  // weder PIN-Back noch BF-Lay
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: b.kind, back: csBack, src: csSrc,
          lay: b.lay, vol: b.vol });
      } else if (b.kind === 'hcs' || b.kind.startsWith('hcs')) {
        // Halbzeit-Correct-Score: PIN HT-CS-Back vs BF HT-CS-Lay
        const hcsKey = b.kind.replace('hcs', '').replace(/(\d)(\d)/, '$1,$2');
        const htBack = (h.htCsBacks && h.htCsBacks[hcsKey]) || 0;
        // Lay >= 200 = BF-Platzhalter ohne echten Markt -> ueberspringen
        // v8.60.34: HT-CS analog FT-CS auch ohne Arb-Richtung speichern
        // (Boost-Arb braucht die HT-CS-Quoten fuer HT-Muster).
        if (b.lay >= 200) continue;                 // BF-Platzhalter ohne Markt
        if (!htBack && !(b.lay > 1.01)) continue;   // weder PIN-Back noch BF-Lay
        if (!htBack) {
          if (!hcsDbg[b.name + ':' + hcsKey]) {
            hcsDbg[b.name + ':' + hcsKey] = true;
            log('  DEBUG HT-CS ' + hcsKey + ' ' + b.name + ': BF-Lay ' +
              b.lay.toFixed(2) + ', aber kein PIN-HT-CS-Back (PIN-Keys: ' +
              Object.keys(h.htCsBacks || {}).join(',') + ')');
          }
        } else if (!arbDir(htBack, b.lay)) {
          // Nur bei Nah-Marge (Back >= 80 % des Lays) loggen, sonst Rauschen
          if (htBack >= b.lay * 0.8 && !hcsDbg[b.name + ':' + hcsKey]) {
            hcsDbg[b.name + ':' + hcsKey] = true;
            log('  DEBUG HT-CS ' + hcsKey + ' ' + b.name + ': PIN ' +
              htBack.toFixed(2) + ' vs BF-Lay ' + b.lay.toFixed(2) + ' (Marge ' +
              (100 * (1 - htBack / b.lay)).toFixed(1) + ' %) => kein Arb');
          }
        }
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: b.kind, back: htBack, src: 'HT CS ' + hcsKey,
          lay: b.lay, vol: b.vol });
      } else if (b.kind === 'btts' && h.yn && h.yn.length) {
        btts.push({ h, b });
      } else if (b.kind === 'ou') {
        ous.push({ h, b });
      } else if (b.kind === 'oe') {
        oes.push({ h, b });
      } else if (b.kind === 'tq') {
        tqs.push({ h, b });
      } else if (b.kind === 'hfou') {
        hfous.push({ h, b });
      } else if (b.kind === 'ttot') {
        tts.push({ h, b });
      } else if (b.kind === 'mo3') {
        const layInfo = b => 'PIN: ' + h.teams[0] + ' (H) | ' + h.teams[1] +
          ' (A) | BF layH=' + (b.layHn || '?') + ' ' + (b.layH || '-') +
          ', layA=' + (b.layAn || '?') + ' ' + (b.layA || '-') +
          ', layD=' + (b.layD || '-');
        const mo3Clean = b.layHn && b.layAn &&
          ((teamMatch(h.teams[0], b.layHn) && teamMatch(h.teams[1], b.layAn)) ||
            (teamMatch(h.teams[1], b.layHn) && teamMatch(h.teams[0], b.layAn)));
        if (!mo3Clean && (b.layHn || b.layAn) && !mo3Dbg[b.name]) {
          mo3Dbg[b.name] = true;
          log('  DEBUG mo3 Seiten-Uneindeutig: "' + b.name + '" ' + layInfo(b));
        }
        mo3s.push({ h, b });
      } else if (b.kind === 'mo3h') {
        if (!mo3hDbg[b.name]) {
          mo3hDbg[b.name] = true;
          log('  DEBUG mo3h Seiten: "' + b.name + '" PIN: ' + h.teams[0] + ' (H) | ' +
            h.teams[1] + ' (A) | BF layH=' + (b.layHn || '?') + ' ' + (b.layH || '-') +
            ', layA=' + (b.layAn || '?') + ' ' + (b.layA || '-') +
            ', layD=' + (b.layD || '-'));
        }
        mo3hs.push({ h, b });
      } else if (b.kind === 'ah') {
        ahs.push({ h, b });
      } else if (b.kind === 'hf') {
        hfs.push({ h, b });
      } else if (b.kind === 'w2n') {
        w2ns.push({ h, b });
      } else if (b.kind === 'btsw') {
        btsws.push({ h, b });
      } else if (b.kind === 'resou') {
        resous.push({ h, b });
      } else if (b.kind === 'dnb') {
        dnbs.push({ h, b });
      } else if (b.kind === 'dc') {
        dcs.push({ h, b });
      } else if (b.kind === 'pts') {
        pts.push({ h, b });
      } else if (b.kind === 'euh') {
        euhs.push({ h, b });
      }
    }
    const tMatch = Date.now();
    for (const { h, b } of w2ns) {
      const cand = (h.w2ns || []).find(w => teamMatch(w.team, b.team));
      if (!cand) {
        log('  W2N ' + b.team + ' ' + b.name + ': kein PIN-Special');
        continue;
      }
      // W2N-Aequivalente (v8.16.0, analog cs00-Max): "Team gewinnt + BTTS No"
      // ist exakt "Team gewinnt zu Nil" — die kombinierte Quelle lebt im BTSW-
      // Markt (PIN "No & Team" / BF "Team/No"). PIN-Back = bester Preis aus
      // W2N-Special und BTSW-No&Team; BF-Lay = kleinster Lay aus W2N-Markt und
      // BTSW-"Team/No". Nur die Yes-Seite ist aequivalent (die W2N-No-
      // Gegenwette hat kein BTSW-Pendant).
      let pinYes = cand.yes;
      let pinYesSrc = 'W2N ' + b.team + ' (Spec ' + cand.sid + ')';
      for (const bs of (h.btsws || [])) for (const o of (bs.outs || [])) {
        if (o.yn === 'no' && o.team !== 'Draw' && teamMatch(o.team, b.team) &&
          o.back > pinYes) {
          pinYes = o.back;
          pinYesSrc = 'BTSW No&' + o.team + ' (Spec ' + bs.sid + ')';
        }
      }
      let bfLayYes = b.layYes, bfLayYesVol = b.volYes;
      let bfLayYesSrc = 'BF W2N Lay';
      const btswBfKey = Object.keys(b.btsw || {}).find(k => {
        const p = k.split(':');
        return p.length === 2 && p[1] === 'no' && teamMatch(p[0], b.team);
      });
      if (btswBfKey && b.btsw[btswBfKey].lay > 0 &&
        (!bfLayYes || b.btsw[btswBfKey].lay < bfLayYes)) {
        bfLayYes = b.btsw[btswBfKey].lay;
        bfLayYesVol = b.btsw[btswBfKey].vol;
        bfLayYesSrc = 'BF ' + btswBfKey;
      }
      // Back-Lay Yes-Seite: bester PIN-Yes-Back vs kleinster BF-Yes-Lay.
      // v8.62.20 (Boost-Quote-Carrier): die W2N-Rows (w2nH/w2nA) werden auch
      // OHNE Arb-Richtung gespeichert — der Boost-Solver braucht die W2N-
      // Quoten fuer den DB-Schnellpfad auch dann, wenn beim Scan kein Arb
      // besteht (analog Tennis v8.62.11 / Soccer-Kern v8.62.12). Daten-
      // Existenz-Gate: PIN-Back + BF-Lay vorhanden (lay >= 1000 = BF-
      // Platzhalter). App-Liste zeigt nur edge > 0. Die w2nBB-Cross-Gegen-
      // wetten bleiben bewusst arb-gegatet (test_bb_emission_gate-Barriere).
      const m = tryBL('W2N', 'W2N ' + b.team + ' ' + b.name, pinYes, bfLayYes,
        b.name + ' ' + b.team, log);
      if (m.ok) {
        log('  W2N ' + b.team + ' ' + b.name + ': ' + pinYesSrc +
          ' (Yes ' + pinYes.toFixed(2) + ') / ' + bfLayYesSrc +
          ' Score ' + m.score.toFixed(3));
      }
      if (m.ok || (pinYes > 1.01 && bfLayYes > 1.01 && bfLayYes < 1000)) {
        // xback (v8.62.23): BF-Back der No-Seite („gewinnt NICHT zu Nil") —
        // die Back-Back-Cross-Gegenwette fuer den Boost-Arb („Back ¬M @ BF").
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: teamMatch(h.teams[0], b.team) ? 'w2nH' : 'w2nA',
          back: pinYes, src: pinYesSrc + ' / ' + bfLayYesSrc,
          lay: bfLayYes, vol: bfLayYesVol,
          xback: isValidPrice(b.backNo) ? b.backNo : 0 });
      }
      // Back-Lay No-Seite: PIN "No" vs BF "No"-Lay (unabhaengig von Yes-Seite)
      const mNo = tryBL('W2N(No)', 'W2N(No) ' + b.team + ' ' + b.name, cand.no, b.layNo,
        b.name + ' ' + b.team, log);
      if (mNo.ok) {
        log('  W2N(No) ' + b.team + ' ' + b.name + ': Spec ' + cand.sid +
          ' (No ' + cand.no.toFixed(2) + ') Score ' + mNo.score.toFixed(3));
      }
      if (mNo.ok || (cand.no > 1.01 && b.layNo > 1.01 && b.layNo < 1000)) {
        // xback (v8.62.23): BF-Back der Yes-Seite („gewinnt zu Nil") — die
        // Back-Back-Cross-Gegenwette fuer den Boost-Arb („Back ¬M @ BF").
        pushRow(rows, lid, { name: b.name, hit: h, b,
          team: b.team, kind: teamMatch(h.teams[0], b.team) ? 'w2nNoH' : 'w2nNoA',
          back: cand.no, src: 'W2N(No) ' + b.team + ' (Spec ' + cand.sid + ')',
          lay: b.layNo, vol: b.volNo,
          xback: isValidPrice(b.backYes) ? b.backYes : 0 });
      }
      // Cross-Back (Gegenwette): PIN-Yes-Back + BF-No-Back bzw. PIN-No-Back + BF-Yes-Back
      // w2nBBY: der PIN-Yes-Back profitiert vom BTSW-Aequivalent (pinYes).
      if (isValidPrice(pinYes) && isValidPrice(b.backNo)) {
        const eBb = computeBBEdge(pinYes, b.backNo);
        if (eBb > 0) {
          log('  W2N-BB ' + b.team + ' ' + b.name + ': PIN Yes ' + pinYes.toFixed(2) +
            ' + BF No-Back ' + b.backNo.toFixed(2) + ' => Edge ' + (eBb * 100).toFixed(2) + '%');
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'w2nBBY', back: pinYes,
            src: 'PIN ' + pinYesSrc + ' + BF No-Back',
            lay: b.backNo, vol: b.volBNo });
        }
      }
      if (isValidPrice(cand.no) && isValidPrice(b.backYes)) {
        const eBb = computeBBEdge(cand.no, b.backYes);
        if (eBb > 0) {
          log('  W2N-BB ' + b.team + ' ' + b.name + ': PIN No ' + cand.no.toFixed(2) +
            ' + BF Yes-Back ' + b.backYes.toFixed(2) + ' => Edge ' + (eBb * 100).toFixed(2) + '%');
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'w2nBBN', back: cand.no,
            src: 'PIN ' + b.team + ' No Back + BF Yes-Back (Spec ' + cand.sid + ')',
            lay: b.backYes, vol: b.volBYes });
        }
      }
    }
    // ---------- Torschuetze (Player To Score) ----------
    // PIN-Special "X To Score" (Yes/No, X = Spielername) <-> BF-Markt "Player
    // To Score" (Runner = Spielername). Match ueber den Spielernamen
    // (teamMatch). Vor v8.48.3 gab es NUR die Back-Lay-Variante (PIN Yes vs
    // BF Lay); jetzt zusaetzlich das Back-Back-Cross (ptsBB): PIN No-Back
    // ("trifft NICHT") vs BF Yes-Back ("trifft") — komplementaere Ausgaenge,
    // kanonische BB-Edge-Formel inkl. BF-Kommission (computeBBEdge).
    // v8.70.1 (Boost-Quote-Carrier, analog w2n v8.62.20): die PTS-Rows werden
    // auch OHNE Arb-Richtung gespeichert — der Boost-Solver braucht die
    // BF-Lay-Quoten fuer „Torschuetze trifft"-Legs auch dann, wenn beim Scan
    // kein Cross-Arb besteht. Fehlt das PIN-Special komplett (PIN hat fuer
    // viele Ligen/Spieler keinen To-Score-Markt, BF aber schon), wird die
    // BF-Lay-only-Row mit back=0 gepusht (lay >= 1000 = BF-Platzhalter).
    for (const { h, b } of pts) {
      const pinSpecs = h.pts || [];
      if (!pinSpecs.length) {
        log('  PTS ' + b.name + ': kein PIN-To-Score-Special — BF-Lay-only-Rows als Boost-Quote-Carrier');
      }
      for (const [player, bf] of Object.entries(b.pts || {})) {
        // Back-Lay-Seite (benoetigt BF-Lay): PIN Yes vs BF Lay
        if (bf.lay) {
          const candBL = pinSpecs.find(p => teamMatch(p.player, player));
          if (!candBL) {
            if (bf.lay > 1.01 && bf.lay < 1000) {
              log('  PTS ' + player + ' ' + b.name + ': kein PIN-Special-Match — BF-Lay-only-Row');
              pushRow(rows, lid, { name: b.name, hit: h, b,
                kind: 'pts', back: 0,
                src: 'PTS ' + player + ' (kein PIN-To-Score-Special)',
                lay: bf.lay, vol: bf.vol });
            }
          } else {
            const m = tryBL('PTS', 'PTS ' + player + ' ' + b.name, candBL.yes, bf.lay,
              b.name + ' ' + player, log);
            if (m.ok) {
              log('  PTS ' + player + ' ' + b.name + ': Spec ' + candBL.sid +
                ' (Yes ' + candBL.yes.toFixed(2) + ') Score ' + m.score.toFixed(3));
            }
            if (m.ok || (candBL.yes > 1.01 && bf.lay > 1.01 && bf.lay < 1000)) {
              pushRow(rows, lid, { name: b.name, hit: h, b,
                kind: 'pts', back: candBL.yes, src: 'PTS ' + player + ' (Spec ' + candBL.sid + ')',
                lay: bf.lay, vol: bf.vol });
            }
          }
        }
        // Back-Back-Cross (ptsBB): PIN No (trifft nicht) + BF Yes-Back (trifft)
        const cand = pinSpecs.find(p => teamMatch(p.player, player));
        if (cand && isValidPrice(cand.no) && isValidPrice(bf.back)) {
          const eBb = computeBBEdge(cand.no, bf.back);
          if (eBb > 0) {
            log('  PTS-BB ' + player + ' ' + b.name + ': PIN No ' + cand.no.toFixed(2) +
              ' + BF Back ' + bf.back.toFixed(2) + ' => Edge ' + (eBb * 100).toFixed(2) + '%');
            pushRow(rows, lid, { name: b.name, hit: h, b,
              kind: 'ptsBB', back: cand.no,
              src: 'PIN ' + player + ' No-Back + BF Yes-Back (Spec ' + cand.sid + ')',
              lay: bf.back, vol: bf.volB });
          }
        }
      }
    }
    // ---------- BTSW (Both Teams To Score + Winner, kombinierter Ausgang) ----------
    // PIN-Special "Yes & Team"/"No & Team" (eigene Quote je Ausgang, Team kann
    // Draw sein) <-> BF "Match Odds and Both Teams To Score" Lay "Team/Yes".
    for (const { h, b } of btsws) {
      const pinSpec = (h.btsws || []).find(bs => bs.outs && bs.outs.length);
      if (!pinSpec) {
        log('  BTSW ' + b.name + ': kein PIN-Special');
        continue;
      }
      for (const out of pinSpec.outs) {
        const bfKey = Object.keys(b.btsw || {}).find(k => {
          const si = k.lastIndexOf(':');
          if (si < 0) return false;
          const team = k.slice(0, si), yn = k.slice(si + 1);
          if (yn !== out.yn) return false;
          if (out.team === 'Draw') return /^(draw|tie)$/i.test(team);
          return teamMatch(out.team, team);
        });
        if (!bfKey) continue;
        const bfLay = b.btsw[bfKey];
        if (!bfLay) continue;
        let side = 'D';
        if (out.team !== 'Draw') {
          if (teamMatch(h.teams[0], out.team)) side = 'H';
          else if (teamMatch(h.teams[1], out.team)) side = 'A';
          else continue;
        }
        const kind = 'btw' + side + (out.yn === 'yes' ? 'Y' : 'N');
        const m = tryBL('BTSW', 'BTSW ' + out.yn + ' ' + out.team + ' ' + b.name,
          out.back, bfLay.lay, b.name + ' ' + out.yn + ' ' + out.team, log);
        if (m.ok)
          log('  BTSW ' + out.yn + ' & ' + out.team + ' ' + b.name + ': Spec ' +
            pinSpec.sid + ' (PIN ' + out.back.toFixed(2) + ') / BF ' +
            bfLay.lay.toFixed(2) + ' Score ' + m.score.toFixed(3));
        // v8.71.2 (Boost-Quote-Carrier, analog RESOU v8.71.0): die BTSW-Rows
        // (btw<Seite><Y/N> = kombinierter Ausgang "Team & Yes/No") werden auch
        // OHNE Arb-Richtung gespeichert — der Boost-Solver braucht die
        // kombinierten Markt-Lays fuer die AQUIVALENZ-Reduktion („Tipp X ∧
        // BTTS Ja" ≡ BTSW X & Yes) im DB-Schnellpfad (Lay Äquivalent), auch
        // wenn beim Scan kein Arb besteht. Daten-Existenz-Gate: PIN-Back +
        // BF-Lay vorhanden (lay >= 1000 = BF-Platzhalter). App-Liste zeigt
        // weiterhin nur edge > 0.
        if (m.ok || (out.back > 1.01 && bfLay.lay > 1.01 && bfLay.lay < 1000)) {
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind, back: out.back, src: 'PIN ' + out.yn + '&' + out.team +
              ' (Spec ' + pinSpec.sid + ') / BF ' + bfKey + ' Lay',
            lay: bfLay.lay, vol: bfLay.vol });
        }
      }
    }
    // ---------- RESOU (Result + O/U, kombinierter Ausgang) ----------
    // PIN-Special "Team & Over X"/"Draw & Under X" (eigene Quote je Ausgang)
    // <-> BF "Match Odds and Over/Under X Goals" Lay "Team/Under X Goals".
    for (const { h, b } of resous) {
      const pinSpec = (h.resous || []).find(bs => bs.outs && bs.outs.length);
      if (!pinSpec) {
        log('  RESOU ' + b.name + ': kein PIN-Special');
        continue;
      }
      for (const out of pinSpec.outs) {
        const bfKey = Object.keys(b.resou || {}).find(k => {
          const p = k.split(':');
          if (p.length !== 3) return false;
          const [team, side, line] = p;
          if (side !== out.side) return false;
          if (Math.abs(parseFloat(line) - out.line) > 0.01) return false;
          if (out.team === 'Draw') return /^(draw|tie)$/i.test(team);
          return teamMatch(out.team, team);
        });
        if (!bfKey) continue;
        const bfLay = b.resou[bfKey];
        if (!bfLay) continue;
        let side = 'D';
        if (out.team !== 'Draw') {
          if (teamMatch(h.teams[0], out.team)) side = 'H';
          else if (teamMatch(h.teams[1], out.team)) side = 'A';
          else continue;
        }
        const code = String(Math.round(out.line * 10)).padStart(2, '0');
        const kind = 'ro' + side + code + (out.side === 'over' ? 'O' : 'U');
        const m = tryBL('RESOU', 'RESOU ' + out.team + ' & ' + out.side + ' ' + out.line + ' ' + b.name,
          out.back, bfLay.lay, b.name + ' ' + out.team + ' ' + out.line, log);
        if (m.ok) {
          log('  RESOU ' + out.team + ' & ' + out.side + ' ' + out.line + ' ' + b.name +
            ': Spec ' + pinSpec.sid + ' (PIN ' + out.back.toFixed(2) + ') / BF ' +
            bfLay.lay.toFixed(2) + ' Score ' + m.score.toFixed(3));
        }
        // v8.71.0 (Boost-Quote-Carrier, analog w2n v8.62.20 / pts v8.70.1):
        // die RESOU-Rows (ro<Seite><Linie>O/U = kombinierter Ausgang
        // "Team & Over/Under X") werden auch OHNE Arb-Richtung gespeichert —
        // der Boost-Solver braucht die kombinierten Markt-Lays fuer den
        // DB-Schnellpfad (Lay Sieg + Back Score-Luecke mit Kombi-Lay), auch
        // wenn beim Scan kein Arb besteht. Daten-Existenz-Gate: PIN-Back +
        // BF-Lay vorhanden (lay >= 1000 = BF-Platzhalter). App-Liste zeigt
        // weiterhin nur edge > 0.
        if (m.ok || (out.back > 1.01 && bfLay.lay > 1.01 && bfLay.lay < 1000)) {
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind, back: out.back, src: 'PIN ' + out.team + '&' + out.side + ' ' +
              out.line + ' (Spec ' + pinSpec.sid + ') / BF ' + bfKey + ' Lay',
            lay: bfLay.lay, vol: bfLay.vol });
        }
      }
    }
    // ---------- Pre-fetch straight markets fuer alle IDs ----------
    // EIN gemeinsamer, deduplizierter Pool fuer alle Kategorien (DNB/DC/mo3/mo3h/
    // ah/tq + O/U + HT-O/U). Frueher liefen drei getrennte Pools nacheinander
    // (mlIds, ouMlIds, hfouMlIds), sodass ein Spiel, das in mehrere Kategorien
    // faellt (z.B. DNB + O/U + HT-O/U), denselben /markets/straight-Call bis zu
    // 3x ausloeste. Das Set dedupliziert; alle Spiele werden parallel geladen.
    const mlIds = [...new Set([
      ...dnbs.map(d => d.h.id), ...dcs.map(d => d.h.id),
      ...mo3s.map(d => d.h.id), ...mo3hs.map(d => d.h.id),
      ...ahs.map(d => d.h.id), ...tqs.map(d => d.h.id),
      ...ous.map(d => d.h.id), ...hfous.map(d => d.h.id),
      ...tts.map(d => d.h.id)
    ])];
    const mlCache = {};
    if (mlIds.length) {
      const fetched = await pool(mlIds, id =>
        pinGet('/matchups/' + id + '/markets/straight')
          .then(mkts => freshMkts(mkts, id, log, 'ml'))
          .catch(() => null), POOL_CONCURRENCY);
      mlIds.forEach((id, i) => { mlCache[id] = fetched[i]; });
    }
    // ---------- To Qualify (K.o.-Duell, 2-Wege "wer kommt weiter") ----------
    // PIN moneyline period=8 (h.tq) gegen BF-Markt "To Qualify" — eigener Kanal,
    // nie mit dem Einzelspiel-p0-Moneyline paaren (waere Single-Leg vs. Aggregat).
    // Die period=8-Preise liegen in demselben straight-Fetch wie DNB/DC/mo3/ah.
    let tqHit = 0, tqSkipped = 0;
    const tqSeen = new Map();
    for (const { h, b } of tqs) {
      const pr = mlCache[h.id];
      const tq = tqFromMl(pr, h.teams || []);
      if (!tq) { tqSkipped++; continue; }
      let x = null, y = null;
      const s1 = tqMS(h.teams[0], b.r0) + tqMS(h.teams[1], b.r1);
      const s2 = tqMS(h.teams[0], b.r1) + tqMS(h.teams[1], b.r0);
      if (s1 > s2) { x = b.r0; y = b.r1; }
      else if (s2 > s1) { x = b.r1; y = b.r0; }
      else continue;
      tqHit++;
      if (arbDir(tq[0], x.lay))
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: 'tqA', back: tq[0], src: 'PIN To Qualify / BF Lay',
          lay: x.lay, vol: x.volL });
      if (arbDir(tq[1], y.lay))
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: 'tqB', back: tq[1], src: 'PIN To Qualify / BF Lay',
          lay: y.lay, vol: y.volL });
      // BB-Dedup: gleicher Markt kann als Pre-Match + In-Play zweimal kommen.
      const pushTqBB = (kind, src, pinBack, bfBack, bfVol) => {
        if (!(isValidPrice(pinBack) && isValidPrice(bfBack) &&
          crossBackEdge(pinBack, bfEffQ(bfBack)) > 0)) return;
        const key = b.name + '|' + kind + '|' + pinBack;
        const prev = tqSeen.get(key);
        if (prev !== undefined) {
          if (bfVol > rows[prev].vol) {
            rows[prev].lay = bfBack;
            rows[prev].vol = bfVol;
            rows[prev].marketId = b.marketId;
          }
          return;
        }
        tqSeen.set(key, rows.length);
        pushRow(rows, lid, { name: b.name, kind, back: pinBack, src,
          lay: bfBack, vol: bfVol, mkId: b.marketId, hit: h,
          live: h.live || b.live });
      };
      if (y.back > 1.01) pushTqBB('bbTqA', 'PIN A + BF B', tq[0], y.back, y.volB);
      if (x.back > 1.01) pushTqBB('bbTqB', 'PIN B + BF A', tq[1], x.back, x.volB);
    }
    if (tqs.length)
      log('  To Qualify ' + lid + ': ' + tqs.length + ' BF-Maerkte, ' + tqHit +
        ' gematcht' + (tqSkipped ? ' (' + tqSkipped + ' ohne period=8-Preis)' : ''));
    // ---------- DNB (Draw No Bet) ----------
    for (const { h, b } of dnbs) {
      const pr = mlCache[h.id];
      if (!pr) continue;
      const mkt = re => (pr || []).find(m => re.test(String(m.type || '')) && (m.period || 0) === 0);
      const dnbMkt = mkt(/^(draw ?no ?bet|draw_no_bet|drawnobet)$/i);
      if (!dnbMkt) { log('  DNB ' + b.name + ': kein PIN-DNB-Markt'); continue; }
      const px = pinPrices(dnbMkt);
      const teams = (h.teams || []);
      // Home = 1 / Home Win / Home Team
      const pinHome = dec(px['home'] || px['1'] || px['home win'] || 0);
      const pinAway = dec(px['away'] || px['2'] || px['away win'] || 0);
if (pinHome > 1.01 && b.dnb.home) {
        const m = tryBL('DNB-H', 'DNB Home ' + b.name, pinHome, b.dnb.home.lay, b.name, log);
        if (m.ok) {
          log('  DNB Home ' + b.name + ': PIN ' + pinHome.toFixed(2) +
            ' / BF ' + b.dnb.home.lay.toFixed(2) + ' Score ' + m.score.toFixed(3));
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'dnbH', back: pinHome, src: 'PIN DNB / BF DNB Lay',
            lay: b.dnb.home.lay, vol: b.dnb.home.vol });
        }
      }
      if (pinAway > 1.01 && b.dnb.away) {
        const m = tryBL('DNB-A', 'DNB Away ' + b.name, pinAway, b.dnb.away.lay, b.name, log);
        if (m.ok) {
          log('  DNB Away ' + b.name + ': PIN ' + pinAway.toFixed(2) +
            ' / BF ' + b.dnb.away.lay.toFixed(2) + ' Score ' + m.score.toFixed(3));
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'dnbA', back: pinAway, src: 'PIN DNB / BF DNB Lay',
            lay: b.dnb.away.lay, vol: b.dnb.away.vol });
        }
      }
      // --- DNB Cross-Arb: PIN Home DNB Back + BF Away DNB Back (oder umgekehrt) ---
      // Back-Back-Cross auf das Gegenereignis: Home DNB = Home gewinnt,
      // Away DNB = Away gewinnt; Remis erstattet beide DNB-Legs (0).
      // BF-Kommission: 3% auf Nettogewinn => effektive Back-Odds = 1 + (q-1)*(1-COMM)
      if (pinHome > 1.01 && pinAway > 1.01 && b.dnb.home && b.dnb.away &&
          b.dnb.home.back > 1.01 && b.dnb.away.back > 1.01) {
        const effH = bfEffQ(b.dnb.home.back);
        const effA = bfEffQ(b.dnb.away.back);
        if (effH > 1.01 && effA > 1.01) {
          // Richtung 1: PIN Home DNB Back + BF Away DNB Back (Gegenereignis)
          const edge1 = crossBackEdge(pinHome, effA);
          if (edge1 > 0) {
            log('  DNB Cross ' + b.name + ': PIN H ' + pinHome.toFixed(2) +
              ' + BF A ' + b.dnb.away.back.toFixed(2) + '(eff ' + effA.toFixed(2) + ') => Edge ' + edge1.toFixed(2) + '%');
            pushRow(rows, lid, { name: b.name, hit: h, b,
              kind: 'dnbCross', back: pinHome, src: 'PIN DNB H + BF DNB A',
              lay: b.dnb.away.back, vol: b.dnb.away.volB || b.dnb.away.vol });
          }
          // Richtung 2: PIN Away DNB Back + BF Home DNB Back (Gegenereignis)
          const edge2 = crossBackEdge(pinAway, effH);
          if (edge2 > 0) {
            log('  DNB Cross ' + b.name + ': PIN A ' + pinAway.toFixed(2) +
              ' + BF H ' + b.dnb.home.back.toFixed(2) + '(eff ' + effH.toFixed(2) + ') => Edge ' + edge2.toFixed(2) + '%');
            pushRow(rows, lid, { name: b.name, hit: h, b,
              kind: 'dnbCross', back: pinAway, src: 'PIN DNB A + BF DNB H',
              lay: b.dnb.home.back, vol: b.dnb.home.volB || b.dnb.home.vol });
          }
        }
      }
    }
    // ---------- Double Chance ----------
    for (const { h, b } of dcs) {
      // PIN DC-Preise bevorzugt aus dem "Double Chance"-Special (h.dc),
      // Fallback auf straight-Markt (mlCache)
      let pin1x = 0, pinX2 = 0, pin12 = 0;
      if (h.dcs && h.dcs.length) {
        const d = h.dcs[0];
        pin1x = (d.dc && d.dc['1x']) || 0;
        pinX2 = (d.dc && d.dc['x2']) || 0;
        pin12 = (d.dc && d.dc['12']) || 0;
      }
      if (!pin1x && !pinX2 && !pin12) {
        const pr = mlCache[h.id];
        if (pr) {
          const mkt = re => (pr || []).find(m => re.test(String(m.type || '')) && (m.period || 0) === 0);
          const dcMkt = mkt(/^(double ?chance|double_chance|doublechance)$/i);
          if (dcMkt) {
            const px = pinPrices(dcMkt);
            pin1x = dec(px['1x'] || px['home/draw'] || px['home or draw'] || 0);
            pinX2 = dec(px['x2'] || px['draw/away'] || px['draw or away'] || 0);
            pin12 = dec(px['12'] || px['home/away'] || px['home or away'] || 0);
          }
        }
        if (!pin1x && !pinX2 && !pin12) {
          log('  DC ' + b.name + ': kein PIN-DC-Markt');
          continue;
        }
      }
      if (b.dc) {
        const dbg1 = b.dc['1x'] ? '1X ' + pin1x.toFixed(2) + '/' + b.dc['1x'].lay.toFixed(2) : '';
        const dbgX = b.dc['x2'] ? ' X2 ' + pinX2.toFixed(2) + '/' + b.dc['x2'].lay.toFixed(2) : '';
        const dbg2 = b.dc['12'] ? ' 12 ' + pin12.toFixed(2) + '/' + b.dc['12'].lay.toFixed(2) : '';
        log('  DEBUG DC ' + b.name + ': PIN/BF-Lay ' + dbg1 + dbgX + dbg2);
      }
      if (pin1x > 1.01 && b.dc['1x']) {
        const m = tryBL('DC-1X', 'DC 1X ' + b.name, pin1x, b.dc['1x'].lay, b.name, log);
        if (m.ok) {
          log('  DC 1X ' + b.name + ': PIN ' + pin1x.toFixed(2) +
            ' / BF ' + b.dc['1x'].lay.toFixed(2) + ' Score ' + m.score.toFixed(3));
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'dc1x', back: pin1x, src: 'PIN DC 1X / BF DC Lay',
            lay: b.dc['1x'].lay, vol: b.dc['1x'].vol });
        }
      }
      if (pinX2 > 1.01 && b.dc['x2']) {
        const m = tryBL('DC-X2', 'DC X2 ' + b.name, pinX2, b.dc['x2'].lay, b.name, log);
        if (m.ok) {
          log('  DC X2 ' + b.name + ': PIN ' + pinX2.toFixed(2) +
            ' / BF ' + b.dc['x2'].lay.toFixed(2) + ' Score ' + m.score.toFixed(3));
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'dcX2', back: pinX2, src: 'PIN DC X2 / BF DC Lay',
            lay: b.dc['x2'].lay, vol: b.dc['x2'].vol });
        }
      }
      if (pin12 > 1.01 && b.dc['12']) {
        const m = tryBL('DC-12', 'DC 12 ' + b.name, pin12, b.dc['12'].lay, b.name, log);
        if (m.ok) {
          log('  DC 12 ' + b.name + ': PIN ' + pin12.toFixed(2) +
            ' / BF ' + b.dc['12'].lay.toFixed(2) + ' Score ' + m.score.toFixed(3));
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'dc12', back: pin12, src: 'PIN DC 12 / BF DC Lay',
            lay: b.dc['12'].lay, vol: b.dc['12'].vol });
        }
      }
    }
    // ---------- 3-Wege-Back-Cross-Matching ----------
    // PIN DC + BF Einzel-Back oder BF DC + PIN Einzel-Back
    // Kombinationen die alle 3 Ergebnisse abdecken:
    //   PIN DC 1X + BF B,  PIN DC X2 + BF A,  PIN DC 12 + BF D
    //   PIN H + BF DC X2,  PIN A + BF DC 1X,  PIN D + BF DC 12
    // BF-Kommission: 3% auf Nettogewinn => effektive Back-Odds = 1 + (q-1)*(1-COMM)
    for (const { h, b } of dcs) {
      // PIN DC-Preise bevorzugt aus dem "Double Chance"-Special (h.dc),
      // Fallback auf straight-Markt (mlCache)
      let pin1x = 0, pinX2 = 0, pin12 = 0;
      if (h.dcs && h.dcs.length) {
        const d = h.dcs[0];
        pin1x = (d.dc && d.dc['1x']) || 0;
        pinX2 = (d.dc && d.dc['x2']) || 0;
        pin12 = (d.dc && d.dc['12']) || 0;
      }
      const pr = mlCache[h.id];
      let pinH = 0, pinD = 0, pinA = 0;
      if (pr) {
        const mkt = re => (pr || []).find(m => re.test(String(m.type || '')) && (m.period || 0) === 0);
        const ml = {};
        for (const p of ((mkt(/^moneyline$/i) || {}).prices || [])) {
          if (typeof p.price !== 'number') continue;
          const d = desig(p);
          ml[d] = p.price;
        }
        pinH = dec(ml['home'] || ml['1'] || ml['home win'] || 0);
        pinD = dec(ml['draw'] || ml['x'] || 0);
        pinA = dec(ml['away'] || ml['2'] || ml['away win'] || 0);
        if (!pin1x && !pinX2 && !pin12) {
          const dcMkt3 = mkt(/^(double ?chance|double_chance|doublechance)$/i);
          const dpx = {};
          for (const p of ((dcMkt3 || {}).prices || [])) {
            if (typeof p.price !== 'number') continue;
            const d = desig(p);
            dpx[d || ('p' + (p.participantId ?? p.id))] = p.price;
          }
          pin1x = dec(dpx['1x'] || dpx['home/draw'] || dpx['home or draw'] || 0);
          pinX2 = dec(dpx['x2'] || dpx['draw/away'] || dpx['draw or away'] || 0);
          pin12 = dec(dpx['12'] || dpx['home/away'] || dpx['home or away'] || 0);
        }
      }
      if (!pinH && !pinD && !pinA && !pin1x && !pinX2 && !pin12) continue;
      // Richtung 1: PIN DC Back + BF Einzel-Back (mo3)
      const mo3Row = lays.find(r => r.kind === 'mo3' && r.name === b.name);
      if (mo3Row) {
        // BF mo3: echte Back-Preise (backH/backD/backA). Seitenzuordnung ueber
        // Runner-Namen (layHn/layAn = gleiche Runner wie Back-Seite), wobei die
        // Orientierung beruecksichtigt wird (BF-Heim kann bei PIN auswaerts stehen).
        // H2H-Konvention: A = Heim, B = Gast, D = Draw.
        const bfHomeBack = mo3Row.layHn && teamMatch(h.teams[0], mo3Row.layHn) ? mo3Row.backH :
          (mo3Row.layAn && teamMatch(h.teams[0], mo3Row.layAn) ? mo3Row.backA : 0);
        const bfAwayBack = mo3Row.layAn && teamMatch(h.teams[1], mo3Row.layAn) ? mo3Row.backA :
          (mo3Row.layHn && teamMatch(h.teams[1], mo3Row.layHn) ? mo3Row.backH : 0);
        const bfDBack = mo3Row.backD || 0;
        const crossPairs = [
          { pinDc: pin1x, bfSingle: bfAwayBack, kind: 'dc1xB', desc: 'PIN DC 1X + BF B' },
          { pinDc: pinX2, bfSingle: bfHomeBack, kind: 'dcX2A', desc: 'PIN DC X2 + BF A' },
          { pinDc: pin12, bfSingle: bfDBack, kind: 'dc12D', desc: 'PIN DC 12 + BF D' },
        ];
        for (const cp of crossPairs) {
          if (cp.pinDc <= 1.01 || cp.bfSingle <= 1.01) continue;
          const effBf = bfEffQ(cp.bfSingle);
          if (effBf <= 1.01) continue;
          const edge = crossBackEdge(cp.pinDc, effBf);
          if (edge > 0) {
            log('  3Way ' + cp.desc + ' ' + b.name + ': PIN ' + cp.pinDc.toFixed(2) +
              ' + BF ' + cp.bfSingle.toFixed(2) + '(eff ' + effBf.toFixed(2) + ') => Edge ' + edge.toFixed(2) + '%');
            pushRow(rows, lid, { name: b.name, hit: h, b,
              kind: cp.kind, back: cp.pinDc, src: cp.desc,
              lay: cp.bfSingle, vol: 0 });
          }
        }
      }
      // Richtung 2: PIN Einzel-Back + BF DC Back
      const dcBf1xBack = b.dcBack && b.dcBack['1x'] ? b.dcBack['1x'].back : 0;
      const dcBfX2Back = b.dcBack && b.dcBack['x2'] ? b.dcBack['x2'].back : 0;
      const dcBf12Back = b.dcBack && b.dcBack['12'] ? b.dcBack['12'].back : 0;
      const crossPairs2 = [
        { pinSingle: pinH, bfDcBack: dcBfX2Back, kind: 'A dcX2', desc: 'PIN H + BF DC X2' },
        { pinSingle: pinA, bfDcBack: dcBf1xBack, kind: 'B dc1x', desc: 'PIN A + BF DC 1X' },
        { pinSingle: pinD, bfDcBack: dcBf12Back, kind: 'D dc12', desc: 'PIN D + BF DC 12' },
      ];
for (const cp of crossPairs2) {
        if (cp.pinSingle <= 1.01 || cp.bfDcBack <= 1.01) continue;
        const effBf = bfEffQ(cp.bfDcBack);
        if (effBf <= 1.01) continue;
        const edge = crossBackEdge(cp.pinSingle, effBf);
        if (edge > 0) {
          log('  3Way ' + cp.desc + ' ' + b.name + ': PIN ' + cp.pinSingle.toFixed(2) +
            ' + BF ' + cp.bfDcBack.toFixed(2) + '(eff ' + effBf.toFixed(2) + ') => Edge ' + edge.toFixed(2) + '%');
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: cp.kind, back: cp.pinSingle, src: cp.desc,
            lay: cp.bfDcBack, vol: 0 });
        }
      }
    }
    // ---------- Europaeisches Handicap (3-Weg, Back-Lay) ----------
    // PIN "3-Way Handicap <Team> <±N>" (Special, h.euhs) vs BF "<Team> +N"-Markt
    // (3 Runner: Team+N, Gegner-N, Draw). BL je Ausgang; eine 3-Weg-Abdeckung
    // braucht 3 Beine (analog mo3 -> kein BB-Kanal). Ein BF-Markt wird von
    // ZWEI PIN-Specials gespiegelt ("3-Way Handicap Blackburn +1" ==
    // "3-Way Handicap Sheffield United -1") — Preise daher je Ausgang MAX.
    for (const { h, b } of euhs) {
      const cands = (h.euhs || []).filter(c => Math.abs(c.line) === b.line);
      if (!cands.length) continue;
      const bfPosTeam = b.pos.nm.replace(/\s*[+-]\d+\s*$/, '').trim();
      const bfNegTeam = b.neg.nm.replace(/\s*[+-]\d+\s*$/, '').trim();
      let pinSide = 0, pinDraw = 0, pinOpp = 0, pinLine = 0, srcTeam = '';
      let mktHit = false;
      for (const c of cands) {
        // Markt-Zuordnung: PIN-Team bekommt die Linie mit gleichem Vorzeichen
        // wie der BF-Ausgang (L>0 -> PIN-Team = BF-pos, L<0 -> PIN-Team = BF-neg).
        const sameMkt = (c.line > 0 && teamMatch(c.team, bfPosTeam)) ||
          (c.line < 0 && teamMatch(c.team, bfNegTeam));
        if (!sameMkt) continue;
        mktHit = true;
        pinLine = c.line;
        srcTeam = c.team;
        pinSide = Math.max(pinSide, c.side);
        pinDraw = Math.max(pinDraw, c.draw);
        pinOpp = Math.max(pinOpp, c.opp);
      }
      if (!mktHit) continue;
      if (!pinLine || !pinSide || !pinDraw || !pinOpp) continue;
      const sign = pinLine > 0 ? '+' : '-';
      const bfSide = pinLine > 0 ? b.pos : b.neg;   // Lay der PIN-Team-Seite
      const bfOpp = pinLine > 0 ? b.neg : b.pos;    // Lay der PIN-Gegner-Seite
      const oppTeam = pinLine > 0 ? bfNegTeam : bfPosTeam;
      const sideLetter = h.teams[0] && teamMatch(srcTeam, h.teams[0]) ? 'H' :
        (h.teams[1] && teamMatch(srcTeam, h.teams[1]) ? 'A' : '?');
      const oppLetter = h.teams[0] && teamMatch(oppTeam, h.teams[0]) ? 'H' :
        (h.teams[1] && teamMatch(oppTeam, h.teams[1]) ? 'A' : '?');
      const bl = [
        [sideLetter, sign, pinSide, bfSide],
        ['D', '', pinDraw, b.draw],
        [oppLetter, sign === '+' ? '-' : '+', pinOpp, bfOpp],
      ];
      for (const [letter, sg, back, bfOut] of bl) {
        if (letter === '?' || !(back > 1.01) || !bfOut || !(bfOut.lay > 0)) continue;
        if (!arbDir(back, bfOut.lay)) continue;
        const kind = 'euh' + b.line + letter + sg;
        pushRow(rows, lid, { name: b.name, hit: h, b, kind, back,
          src: 'PIN 3-Way Handicap ' + srcTeam + ' ' + (pinLine > 0 ? '+' : '') + pinLine +
            ' / BF ' + b.name,
          lay: bfOut.lay, vol: bfOut.vol });
      }
    }
    // ---------- Sieg-Cross N=1 (Back-Back): PIN euh "Team +1" + BF mo3 Back Gegner ----------
    // EH 1(1:0) = Heim+1 ↔ Sieg 2; EH 2(0:1) = Auswärts+1 ↔ Sieg 1 — komplementaere
    // 2-Beiner (81/81 Spielstaende verifiziert, kein Push). Back-Back-Cross wie
    // dnbCross: BF-Kommission via bfEffQ, Gate crossBackEdge > 0.
    for (const { h, b } of euhs) {
      if (b.line !== 1) continue;
      const mo3Row = lays.find(r => r.kind === 'mo3' && r.name === b.name);
      if (!mo3Row || !mo3Row.layHn || !mo3Row.layAn) continue;
      const bfHomeBack = teamMatch(h.teams[0], mo3Row.layHn) ? mo3Row.backH :
        (teamMatch(h.teams[0], mo3Row.layAn) ? mo3Row.backA : 0);
      const bfAwayBack = teamMatch(h.teams[1], mo3Row.layAn) ? mo3Row.backA :
        (teamMatch(h.teams[1], mo3Row.layHn) ? mo3Row.backH : 0);
      for (const c of (h.euhs || [])) {
        if (c.line !== 1 || !(c.side > 1.01)) continue;
        const pinLetter = teamMatch(c.team, h.teams[0]) ? 'H' :
          (teamMatch(c.team, h.teams[1]) ? 'A' : '?');
        if (pinLetter === '?') continue;
        const oppBack = pinLetter === 'H' ? bfAwayBack : bfHomeBack;
        if (!(oppBack > 1.01)) continue;
        const effBf = bfEffQ(oppBack);
        if (effBf <= 1.01) continue;
        const edge = crossBackEdge(c.side, effBf);
        if (edge > 0) {
          const kind = 'euh' + b.line + pinLetter + '+' + (pinLetter === 'H' ? 'B' : 'H');
          log('  SiegCross ' + b.name + ': PIN ' + c.team + ' +1 ' + c.side.toFixed(2) +
            ' + BF ' + (pinLetter === 'H' ? 'Auswärts' : 'Heim') + ' ' +
            oppBack.toFixed(2) + '(eff ' + effBf.toFixed(2) + ') => Edge ' + edge.toFixed(2) + '%');
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind, back: c.side,
            src: 'PIN euh ' + c.team + ' +1 + BF mo3 ' +
              (pinLetter === 'H' ? 'Auswärts' : 'Heim') + ' Back',
            lay: oppBack, vol: 0 });
        }
      }
    }
    for (const { h, b } of btts) {
      const { pre, bb } = await pinBtts(h.yn, b, log);
      // BB-Arb immer pruefen (unabhaengig vom Preismatch)
      if (bb && isValidPrice(b.backNo) && isValidPrice(bb.yes)) {
        const eBBY = computeBBEdge(bb.yes, b.backNo);
        log('  BTTS BBY ' + b.name + ': PIN Yes ' + bb.yes.toFixed(2) +
          ' + BF No ' + b.backNo.toFixed(2) + ' => Edge ' + (eBBY * 100).toFixed(2) + '%');
        if (eBBY > 0)
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'bttsBBY', back: bb.yes, src: 'BTTS Yes + BF No (Spec ' + bb.sid + ')',
            lay: b.backNo, vol: b.volBNo });
      }
      if (bb && isValidPrice(b.backYes) && isValidPrice(bb.no)) {
        const eBBN = computeBBEdge(bb.no, b.backYes);
        log('  BTTS BBN ' + b.name + ': PIN No ' + bb.no.toFixed(2) +
          ' + BF Yes ' + b.backYes.toFixed(2) + ' => Edge ' + (eBBN * 100).toFixed(2) + '%');
        if (eBBN > 0)
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'bttsBBN', back: bb.no, src: 'BTTS No + BF Yes (Spec ' + bb.sid + ')',
            lay: b.backYes, vol: b.volBYes });
      }
      if (!pre) continue;
      // v8.62.12 (Boost-Quote-Carrier): BTTS-Single-Rows (bttsY/bttsN) auch
      // OHNE Arb-Richtung speichern (DB-Schnellpfad fuer „BTTS Ja/Nein"-
      // Boost-Combos). Die BB-Crosslegs (bttsBBY/bttsBBN oben) bleiben
      // arb-gegatet.
      if (pre.yes > 1.01 && b.layYes > 1.01 && b.layYes < 1000)
        // xback (v8.62.23): BF-Back der No-Seite — die Back-Back-Cross-
        // Gegenwette fuer den Boost-Arb („Back ¬M @ BF").
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: 'bttsY', back: pre.yes, src: 'BTTS Yes (Spec ' + pre.sid + ')',
          lay: b.layYes, vol: b.volYes,
          xback: isValidPrice(b.backNo) ? b.backNo : 0 });
      else trackMissed('BTTS-Y', pre.yes, b.layYes, pre.score, b.name);
      if (pre.no > 1.01 && b.layNo > 1.01 && b.layNo < 1000)
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: 'bttsN', back: pre.no, src: 'BTTS No (Spec ' + pre.sid + ')',
          lay: b.layNo, vol: b.volNo,
          xback: isValidPrice(b.backYes) ? b.backYes : 0 });
      else trackMissed('BTTS-N', pre.no, b.layNo, pre.score, b.name);
    }
    // ---------- O/U: gemeinsamer Matcher (PIN straight goals vs BF Lays) ----------
    {
      const ouMlIds = [...new Set(ous.map(e => e.h.id))];
      if (ouMlIds.length) {
        let ouHits = 0;
        for (const { h, b } of ous) {
          // Corners-Maerkte laufen gegen den PIN-Corners-Kanal (h.cornersOu aus
          // dem lg-straight), alle uebrigen O/U (Tore/Goals) gegen ouGoals aus
          // dem Kern-straight -- nie vermischt (8.5-Kollision, wie im H2H-Pfad).
          let pinSrc = b.corners ? h.cornersOu : ouGoals(mlCache[h.id]);
          if (!pinSrc || !pinSrc.length) continue;
          // Diagnose PIN-Designation: Wie heisst der Range-7-Markt (7+ oder 7)?
          if (lid === 2331 && !b.corners) {
            const totD = (mlCache[h.id] || []).filter(m => m.type === 'total' &&
              Number(m.period) === 0).map(m =>
              (m.name || '?') + ': ' + (m.prices || []).map(p =>
                String(p.designation) + '@' + p.points).join(','));
            if (totD.length)
              log('  DEBUG PIN-totals[2331] ' + h.teams.join(' v ') + ' [' + totD.join(' | ') + ']');
          }
          // Exact Total Goals (Special, liegt nicht im straight-Fetch): ergaenzen,
          // wenn die jeweilige Linie nicht schon aus dem straight-Pool vorliegt.
          //   - Max-Bucket "N+" -> Over (N-0.5), analog "Total Goals Range"
          //   - "0" -> Under 0.5 als Cross-Leg ueber 0.5 (crossOnly, Lay-Vergleich
          //     laeuft ueber cs00)
          if (!b.corners) {
            const coveredLines = new Set(pinSrc.map(o => Math.round(o.line * 10)));
            const add = [];
            const exMax = h.exactMax;
            if (exMax && exMax.back > 1.01 &&
              !coveredLines.has(Math.round(exMax.line * 10)))
              add.push({ line: exMax.line, over: exMax.back, under: 0, range: true });
            // Total Goals Range Low-Bucket "0 - N" (exactMin) als Under-Quelle:
            // z.B. "0 - 1" = Under 1.5 — ergaenzen, wenn die straight-Linie
            // fehlt (analog exactMax, aber unter-seitig). Der Matcher baut daraus
            // ou{line}U (Back-Lay) UND ouBB{line}U (Back-Back mit BF Over-Back).
            const exMin = h.exactMin;
            if (exMin && exMin.back > 1.01 &&
              !coveredLines.has(Math.round(exMin.line * 10)))
              add.push({ line: exMin.line, over: 0, under: exMin.back, range: true });
            const ex0 = Math.max(0, ...(h.cs00Backs || [])
              .filter(x => x.src === 'Exact Goals=0').map(x => x.back));
            if (ex0 > 1.01 && !coveredLines.has(5))
              add.push({ line: 0.5, over: 0, under: ex0, crossOnly: true });
            if (add.length) pinSrc = pinSrc.concat(add);
          }
          const cover = pinSrc.find(o => Math.abs(o.line - b.line) < 0.01);
          if (b.corners)
            log('  DEBUG corners-match[' + lid + '] BF ' + b.name + ' line=' + b.line +
              ' -> PIN ' + h.teams.join(' v ') + ' ' + (cover ? cover.line + '=' + cover.over.toFixed(2) : 'KEIN 10.5-Kandidat'));
          if (!cover) continue;
          const bf = {
            name: b.name, line: b.line, marketId: b.marketId, live: b.live,
            over: { lay: b.layO, vol: b.volO, back: b.backO, volB: b.volBO },
            under: { lay: b.layU, vol: b.volU, back: b.backU, volB: b.volBU }
          };
          ouHits += emitOUEs(lid, log, rows, LIGA_NAMEN[lid] || '', h, bf, cover);
        }
        if (ouHits) log('  O/U (gemeinsamer Matcher): ' + ouHits + ' Zeilen aus ' + ouMlIds.length + ' Spielen');
      }
    }
    // ---------- Team-Totals (Soccer): PIN team_total 0.5–2.5 je Team vs BF
    // "Team X Over/Under Y Goals" — Back-Lay + Back-Back-Crosslegs ----------
    {
      const ttMlIds = [...new Set(tts.map(e => e.h.id))];
      if (ttMlIds.length) {
        let ttHits = 0;
        for (const { h, b } of tts) {
          const sideChar = teamMatch(b.team, h.teams[0]) ? 'H' :
            (teamMatch(b.team, h.teams[1]) ? 'A' : '');
          if (!sideChar) continue;
          const pinSrc = teamTotalsOf(mlCache[h.id]);
          if (!pinSrc || !pinSrc.length) continue;
          const cover = pinSrc.find(o =>
            o.team === (sideChar === 'H' ? 'home' : 'away') &&
            Math.abs(o.line - b.line) < 0.01);
          if (!cover) continue;
          const bf = {
            name: b.name, team: b.team, line: b.line, marketId: b.marketId, live: b.live,
            over: { lay: b.layO, vol: b.volO, back: b.backO, volB: b.volBO },
            under: { lay: b.layU, vol: b.volU, back: b.backU, volB: b.volBU }
          };
          ttHits += emitTeamTotalEs(lid, log, rows, LIGA_NAMEN[lid] || '', h, bf, cover, sideChar);
        }
        if (ttHits) log('  Team-Totals: ' + ttHits + ' Zeilen aus ' + ttMlIds.length + ' Spielen');
      }
    }
    // ---------- Odd/Even (Total Goals): PIN Special (Odd/Even) vs BF Odd/Even-Markt ----------
    let oeHits = 0;
    for (const { h, b } of oes) {
      if (!h.oes || !h.oes.length) {
        oeNoSpec++;
        continue;
      }
      const { pre, bb } = await pinOeSpecs(h.oes, b, log);
      if (bb && isValidPrice(bb.odd) && b.even && isValidPrice(b.even.back)) {
        const eBBN = computeBBEdge(bb.odd, b.even.back);
        log('  OE BBN ' + b.name + ': PIN Odd ' + bb.odd.toFixed(2) +
          ' + BF Even ' + b.even.back.toFixed(2) + ' => Edge ' + (eBBN * 100).toFixed(2) + '%');
        if (eBBN > 0)
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'oeBBN', back: bb.odd,
            src: 'PIN Odd + BF Even (Back) (Spec ' + bb.sid + ')',
            lay: b.even.back, vol: b.even.volB || b.even.vol });
      }
      if (bb && isValidPrice(bb.even) && b.odd && isValidPrice(b.odd.back)) {
        const eBBY = computeBBEdge(bb.even, b.odd.back);
        log('  OE BBY ' + b.name + ': PIN Even ' + bb.even.toFixed(2) +
          ' + BF Odd ' + b.odd.back.toFixed(2) + ' => Edge ' + (eBBY * 100).toFixed(2) + '%');
        if (eBBY > 0)
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind: 'oeBBY', back: bb.even,
            src: 'PIN Even + BF Odd (Back) (Spec ' + bb.sid + ')',
            lay: b.odd.back, vol: b.odd.volB || b.odd.vol });
      }
      if (!pre) continue;
      if (pre.odd > 1.01 && b.odd && arbDir(pre.odd, b.odd.lay)) {
        oeHits++;
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: 'oeY', back: pre.odd,
          src: 'PIN Odd (Spec ' + pre.sid + ')',
          lay: b.odd.lay, vol: b.odd.vol,
          xback: isValidPrice(b.even.back) ? b.even.back : 0 });
      }
      if (pre.even > 1.01 && b.even && arbDir(pre.even, b.even.lay)) {
        oeHits++;
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: 'oeN', back: pre.even,
          src: 'PIN Even (Spec ' + pre.sid + ')',
          lay: b.even.lay, vol: b.even.vol,
          xback: isValidPrice(b.odd.back) ? b.odd.back : 0 });
      }
    }
    if (oes.length || oeNoSpec)
      log('  Odd/Even: ' + oeHits + ' Treffer aus ' + oes.length + ' Spielen' +
        (oeNoSpec ? ' (' + oeNoSpec + ' ohne PIN-Special)' : ''));
    // ---------- HT O/U Pre-filter: nur Lines die auf PIN (period=1) + BF existieren ----------
    // Preise kommen aus dem gemeinsamen mlCache-Pool (kein eigener Fetch mehr).
    const hfouMlIds = [...new Set(hfous.map(e => e.h.id))];
    const hfouPinLines = {};
    if (hfouMlIds.length) {
      for (const id of hfouMlIds) {
        const pr = mlCache[id];
        if (!pr) { hfouPinLines[id] = new Set(); continue; }
        const lines = new Set();
        for (const mkt of pr) {
          const t = String(mkt.type || '');
          if (!/^total/i.test(t) || mkt.side) continue;
          if ((mkt.period || 0) !== 1) continue;
          const ps = (mkt.prices || []).filter(p => typeof p.price === 'number');
          if (ps.length !== 2) continue;
          let line = parseFloat(mkt.line ?? mkt.points ?? NaN);
          if (isNaN(line)) line = parseFloat(ps[0].points ?? ps[1].points ?? NaN);
          if (!isNaN(line)) lines.add(line);
        }
        // HT Under 0.5 via "First Team To Score 1st Half NEITHER" bzw.
        // "Exact Total Goals 1st Half 0" als PIN-Quelle
        if ((pin[id] || {}).htNeither > 0 || (pin[id] || {}).htExact0 > 0) lines.add(0.5);
        hfouPinLines[id] = lines;
      }
    }
    const hfousFiltered = hfous.filter(({ h, b }) => {
      const pinSet = hfouPinLines[h.id];
      if (!pinSet || pinSet.size === 0) return false;
      for (const pl of pinSet) if (Math.abs(pl - b.line) < 0.01) return true;
      return false;
    });
    if (hfousFiltered.length < hfous.length)
      log('  HT O/U Pre-filter: ' + hfous.length + ' -> ' + hfousFiltered.length + ' (' +
        (hfous.length - hfousFiltered.length) + ' Lines nur auf einer Seite gefiltert)');
    const hfouGot = await pool(hfousFiltered, async ({ h, b }) => {
      const pr = mlCache[h.id];
      if (!pr) return null;
      for (const mkt of pr) {
        const t = String(mkt.type || '');
        if (!/^total/i.test(t) || mkt.side) continue;
        if ((mkt.period || 0) !== 1) continue;
        const ps = (mkt.prices || []).filter(p => typeof p.price === 'number');
        if (ps.length !== 2) continue;
        const des = p => String(p.d || p.designation || '');
        const ov = ps.find(p => /over/i.test(des(p)));
        const un = ps.find(p => /under/i.test(des(p)));
        let over, under;
        if (ov && un) { over = ov.price; under = un.price; }
        else { over = ps[0].price; under = ps[1].price; }
        let line = parseFloat(mkt.line ?? mkt.points ?? NaN);
        if (isNaN(line)) line = parseFloat(ps[0].points ?? ps[1].points ?? NaN);
        if (isNaN(line)) continue;
        if (Math.abs(line - b.line) < 0.01) {
          // HT Under 0.5: beste PIN-Under-Quelle aus total period=1 0.5,
          // "First Team To Score 1st Half NEITHER" und "Exact Total Goals 1st Half 0".
          let underP = dec(under);
          let nSrc = '';
          if (Math.abs(b.line - 0.5) < 0.01) {
            const aN = h.htNeither || 0, aE = h.htExact0 || 0;
            const alt = Math.max(aN, aE);
            const altSrc = aE >= aN && aE > 0 ? ' (Exact 0)' : (alt > 0 ? ' (Neither)' : '');
            if (alt > underP) { underP = alt; nSrc = altSrc; }
          }
          return { h, b, over: dec(over), under: underP, sid: h.id, nSrc };
        }
      }
      // PIN "First Team To Score 1st Half NEITHER" / "Exact Total Goals 1st Half 0"
      // auch ohne total period=1 0.5: als reine Under-0.5-Quelle gegen BF
      // "First Half Goals 0.5" emittieren.
      if (Math.abs(b.line - 0.5) < 0.01) {
        const aN = h.htNeither || 0, aE = h.htExact0 || 0;
        const alt = Math.max(aN, aE);
        const altSrc = aE >= aN && aE > 0 ? ' (Exact 0)' : (alt > 0 ? ' (Neither)' : '');
        if (alt > 1.01)
          return { h, b, over: 0, under: alt, sid: h.id, nSrc: altSrc };
      }
      return null;
    }, POOL_CONCURRENCY);
    for (const g of hfouGot) {
      if (!g) continue;
      const code = String(Math.round(g.b.line * 10)).padStart(2, '0');
      const sU = g.nSrc || '';
      // BB-Arb immer pruefen (unabhaengig vom Preismatch); nur emittieren,
      // wenn der Cross eine positive Marge hat (konsistent zu emitOUEs/emitOEs).
      if (isValidPrice(g.b.backO) && isValidPrice(g.under) &&
        crossBackEdge(g.under, bfEffQ(g.b.backO)) > 0) {
        pushRow(rows, lid, { name: g.b.name, hit: g.h, b: g.b,
          kind: 'hfouBB' + code + 'U', back: g.under, src: 'PIN U + BF O HT ' + g.b.line + sU,
          lay: g.b.backO, vol: g.b.volBO });
      }
      if (isValidPrice(g.b.backU) && isValidPrice(g.over) &&
        crossBackEdge(g.over, bfEffQ(g.b.backU)) > 0) {
        pushRow(rows, lid, { name: g.b.name, hit: g.h, b: g.b,
          kind: 'hfouBB' + code + 'O', back: g.over, src: 'PIN O + BF U HT ' + g.b.line,
          lay: g.b.backU, vol: g.b.volBU });
      }
      if (g.over <= 1.01) {
        // Reine NEITHER-Quelle (kein PIN total period=1 0.5): nur Under-Leg pruefen.
        // v8.62.12 (Boost-Quote-Carrier): auch ohne Arb-Richtung speichern.
        if (g.under > 1.01 && g.b.layU > 1.01 && g.b.layU < 1000)
          pushRow(rows, lid, { name: g.b.name, hit: g.h, b: g.b,
            kind: 'hfou' + code + 'U', back: g.under,
            src: 'HT O/U ' + g.b.line + ' (Spec ' + g.sid + ')' + sU,
            lay: g.b.layU, vol: g.b.volU,
            xback: g.b.backO > 1.01 && g.b.backO !== 0 ? g.b.backO : 0 });
        continue;
      }
      // v8.62.12 (Boost-Quote-Carrier): HT-O/U-Single-Rows auch OHNE
      // Arb-Richtung speichern (Boost-Combos „Tore Over/Under X 1.HZ"). Die
      // BB-Crosslegs (hfouBB*) oben bleiben arb-gegatet.
      if (g.over > 1.01 && g.b.layO > 1.01 && g.b.layO < 1000)
        // xback (v8.62.23): BF-Back der Gegenseite — die Back-Back-Cross-
        // Gegenwette fuer den Boost-Arb („Back ¬M @ BF").
        pushRow(rows, lid, { name: g.b.name, hit: g.h, b: g.b,
          kind: 'hfou' + code + 'O', back: g.over,
          src: 'HT O/U ' + g.b.line + ' (Spec ' + g.sid + ')',
          lay: g.b.layO, vol: g.b.volO,
          xback: g.b.backU > 1.01 && g.b.backU !== 0 ? g.b.backU : 0 });
      if (g.under > 1.01 && g.b.layU > 1.01 && g.b.layU < 1000)
        pushRow(rows, lid, { name: g.b.name, hit: g.h, b: g.b,
          kind: 'hfou' + code + 'U', back: g.under,
          src: 'HT O/U ' + g.b.line + ' (Spec ' + g.sid + ')' + sU,
          lay: g.b.layU, vol: g.b.volU,
          xback: g.b.backO > 1.01 && g.b.backO !== 0 ? g.b.backO : 0 });
    }
    // ---------- Match Odds (Full Time + Half Time) — gemeinsame Helfer-Funktion ----------
    async function processMatchOdds(pairs, period, kindPrefix, srcLabel, logFn) {
      const htDbg = {};
      for (const { h, b } of pairs) {
        const pr = mlCache[h.id];
        if (!pr) continue;
        const mm = pr.find(mkt => /^moneyline$/i.test(String(mkt.type || '')) &&
          (mkt.period || 0) === period);
        if (!mm) {
          if (period === 1 && !htDbg[lid]) {
            htDbg[lid] = true;
            log('  DEBUG pinSoccer HT[' + lid + '] kein PIN-ML period=1 (' +
              (pr && pr.length ? 'Markets=' + pr.length : 'kein straight') + ')');
          }
          continue;
        }
        const px = pinPrices(mm);
        const toDec = toDecU;
        if (period === 1 && !htDbg[lid]) {
          htDbg[lid] = true;
          log('  DEBUG pinSoccer HT[' + lid + '] ml=' +
            [toDec(px['home']), toDec(px['draw']), toDec(px['away'])].map(v =>
              (v && v.toFixed ? v.toFixed(2) : v || '-')).join('/'));
        }
        const sHome = sideLay(h.teams[0], b);
        const sAway = sideLay(h.teams[1], b);
        const sides = [
          [kindPrefix + 'A', 'home', sHome && sHome.lay, sHome && sHome.vol],
          [kindPrefix + 'D', 'draw', b.layD, b.volD],
          [kindPrefix + 'B', 'away', sAway && sAway.lay, sAway && sAway.vol],
        ];
        for (const [kind, d, lay, vol] of sides) {
          const back = toDec(px[d] ?? px['tie']);
          // v8.62.12 (Boost-Quote-Carrier): 1X2-ML-Rows (h3A/h3D/h3B,
          // h3hA/D/B) auch OHNE Arb-Richtung speichern — der Boost-Solver
          // braucht die ML-Quoten fuer den DB-Schnellpfad auch dann, wenn
          // beim Scan kein Arb besteht (analog Tennis v8.62.11 / CS
          // v8.60.34). Daten-Existenz-Gate: PIN-Back + BF-Lay vorhanden
          // (lay >= 1000 = BF-Platzhalter). App-Liste zeigt nur edge > 0.
          if (!(back > 1.01) || !(lay > 1.01) || lay >= 1000) continue;
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind, back, src: 'PIN Moneyline ' + srcLabel + ' ' + d + ' / BF ' + (period === 0 ? 'Match Odds' : 'First Half'),
            lay, vol });
        }
      }
    }
    await processMatchOdds(mo3s, 0, 'h3', '', log);
    await processMatchOdds(mo3hs, 1, 'h3h', 'HT', log);
    const hfSide = (s, teams) => {
      if (s === 'Draw') return 'D';
      if (teams[0] && teamMatch(teams[0], s)) return 'H';
      if (teams[1] && teamMatch(teams[1], s)) return 'A';
      return '?';
    };
    const hfSame = (a, c, teams) => {
      const pa = String(a).split(' - '), pc = String(c).split('/');
      if (pa.length !== 2 || pc.length !== 2) return false;
      const la = pa.map(x => hfSide(x, teams)), lc = pc.map(x => hfSide(x, teams));
      if (la.some(x => x === '?') || lc.some(x => x === '?')) return false;
      return la[0] === lc[0] && la[1] === lc[1];
    };
    let hfCand = 0, hfPushed = 0;
    for (const { h, b } of hfs) {
      for (const o of h.hfs || []) for (const out of o.outs || []) {
        hfCand++;
        const hits = (b.outs || []).filter(x => hfSame(out.name, x.nm, h.teams));
        if (hits.length !== 1) continue;
        const letters = out.name.split(' - ').map(s => hfSide(s, h.teams));
        if (letters.some(x => x === '?')) continue;
        const hfLay = hits[0].lay;
        if (!arbDir(out.back, hfLay)) continue;
        hfPushed++;
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: 'hf' + letters[0] + letters[1], back: out.back,
          src: 'PIN HT/FT ' + out.name + ' / BF Half Time/Full Time',
          lay: hfLay, vol: hits[0].vol });
      }
    }
    if (hfs.length || hfCand)
      log('  DEBUG hf-emit[' + lid + '] Paare=' + hfs.length + ' Kandidaten=' + hfCand +
        ' gepusht=' + hfPushed);
    const ahDebug = {};
    const relCache = {};
    const relSrcCache = {};
    for (const { h, b } of ahs) {
      const pr = mlCache[h.id];
      if (!pr) continue;
      let rel = relCache[h.id];
      let relSrc = relSrcCache[h.id];
      if (rel === undefined) {
        let errL = '', errM = '';
        const leagueRel = await pinGet('/leagues/' + lid + '/markets/related')
          .catch(e => { errL = String(e && e.message || e); return null; });
        if (Array.isArray(leagueRel) && leagueRel.length) {
          rel = freshMkts(leagueRel, lid, log, 'related');
          relSrc = 'leagues/related';
        } else {
          const relRaw = await pinGet('/matchups/' + h.id + '/markets/related')
            .catch(e => { errM = String(e && e.message || e); return null; });
          relSrc = (Array.isArray(relRaw) && relRaw.length)
            ? 'matchups/related'
            : 'keine [' + (errL || 'leer') + ' / ' + (errM || 'leer') + ']';
          rel = freshMkts(relRaw, h.id, log, 'related');
          if (!Array.isArray(rel)) rel = [];
        }
        relCache[h.id] = rel;
        relSrcCache[h.id] = relSrc;
      }
      const mkt = re => (pr || []).concat(rel)
        .filter(m => !m || String(m.matchupId) === String(h.id))
        .find(m => re.test(String(m.type || '')) && (m.period || 0) === 0);
      const px = pinPrices;
      const pick = (o, re) => {
        for (const k of Object.keys(o)) if (re.test(k)) return o[k];
        return 0;
      };
      const ml = px(mkt(/^moneyline$/i));
      const dnb = px(mkt(/^(draw ?no ?bet|draw_no_bet|drawnobet)$/i));
      const dc = px(mkt(/^(double ?chance|double_chance|doublechance)$/i));
      const toDec = toDecU;
      const ahLine = {};
      for (const m of (pr || [])) {
        if (!/^spread$/i.test(String(m.type || '')) || (m.period || 0) !== 0) continue;
        const mline = parseFloat(m.line ?? m.points ?? NaN);
        for (const p of (m.prices || [])) {
          if (typeof p.price !== 'number') continue;
          const d = desig(p);
          const pLineRaw = p.line ?? p.points;
          let pline = mline;
          if (pLineRaw != null && pLineRaw !== '' && !isNaN(parseFloat(pLineRaw))) {
            pline = parseFloat(pLineRaw);
          } else if (isNaN(mline)) {
            pline = NaN;
          }
          if (isNaN(pline)) continue;
          if (d) ahLine[d + ':' + pline] = p.price;
        }
      }
      if (!ahDebug[lid]) {
        ahDebug[lid] = true;
        const rt = (rel || []).map(m => String(m.type || ''))
          .filter((v, i, a) => a.indexOf(v) === i).join(',');
        const st = (pr || []).map(m => String(m.type || '')).filter(Boolean)
          .filter((v, i, a) => a.indexOf(v) === i).join(',');
        const spM = (pr || []).find(m => /^spread$/i.test(String(m.type || '')) && (m.period || 0) === 0)
          || (pr || []).find(m => /^spread$/i.test(String(m.type || '')));
        const spS = spM ? JSON.stringify({
          type: spM.type, period: spM.period, line: spM.line, points: spM.points,
          prices: (spM.prices || []).map(p => ({
            d: p.designation, l: p.line, pts: p.points, pr: p.price })) }).slice(0, 300)
          : '-';
        const mh = pick(ml, /^(home|1)$/i), md = pick(ml, /^(draw|x)$/i), ma = pick(ml, /^(away|2)$/i);
        const ahL = [];
        for (let l = -MAX_AH_LINE; l <= MAX_AH_LINE; l += 0.25) {
          ahL.push('h' + (l > 0 ? '+' : '') + l + '=' +
            (ahLine['home:' + l] ? toDec(ahLine['home:' + l]).toFixed(2) : '-') +
            ' a' + (l > 0 ? '+' : '') + l + '=' +
            (ahLine['away:' + l] ? toDec(ahLine['away:' + l]).toFixed(2) : '-'));
        }
        log('  DEBUG pinSoccer[' + lid + '] ml=' + (mh ? 'ja' : 'nein') +
          ' dnb=' + (pick(dnb, /home/) ? 'ja' : 'nein') +
          ' dc=' + ((pick(dc, /1x|x1/) || pick(dc, /x2|2x/) || pick(dc, /home/) || pick(dc, /away/)) ? 'ja' : 'nein') +
          ' mlVals=' + [toDec(mh), toDec(md), toDec(ma)].map(v => (v && v.toFixed ? v.toFixed(2) : v || '-')).join('/') +
          ' ahLines=' + ahL +
          ' straightTypes=' + (st || 'leer') +
          ' spreadSample=' + spS +
          ' relatedTypes=' + (rt || 'keine') + ' (src=' + relSrc + ')');
        const hfM = (pr || []).concat(rel)
          .filter(m => !m || String(m.matchupId) === String(h.id))
          .find(m => /half ?\/ ?full|half ?full|ht\/ft/i.test(String(m.type || '')))
          || (pr || []).concat(rel)
          .filter(m => !m || String(m.matchupId) === String(h.id))
          .find(m => /full/i.test(String(m.type || '')) && (m.period || 0) === 0);
        log('  DEBUG pinSoccer[' + lid + '] halfFull=' + (hfM ? JSON.stringify({
          type: hfM.type, period: hfM.period,
          prices: (hfM.prices || []).map(p => ({
            d: p.designation, id: p.participantId, pr: p.price })) }).slice(0, 600)
          : '-'));
      }
      const push = (kind, back, l, src) => {
        if (!arbDir(back, l && l.lay)) return;
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind, back, src, lay: l.lay, vol: l.vol });
      };
      for (const k of Object.keys(b.ah)) {
        const [ln, tm] = k.split(':');
        const line = parseFloat(ln);
        let i = -1;
        if (teamMatch(h.teams[0], tm)) i = 0;
        else if (teamMatch(h.teams[1], tm)) i = 1;
        if (i < 0) continue;
        const side = i === 0 ? 'home' : 'away';
        if (line === -0.5) {
          push('ah' + (i === 0 ? 'A' : 'B'),
            toDec(pick(ml, side === 'home' ? /^(home|1)$/i : /^(away|2)$/i)),
            b.ah[k], 'PIN Moneyline / BF AH -0.5 Lay');
        } else if (line === 0) {
          const back = Math.max(
            toDec(pick(dnb, side === 'home' ? /^(home|1)$/i : /^(away|2)$/i)),
            toDec(ahLine[side + ':0']));
          if (back > 1.01)
            push('dn' + (i === 0 ? 'A' : 'B'), back, b.ah[k], 'PIN DNB / BF AH 0 Lay');
        } else if (line === 0.5) {
          const dcV = toDec(i === 0 ? (pick(dc, /^(1x|x1)$/i) || pick(dc, /home/i))
            : (pick(dc, /^(x2|2x)$/i) || pick(dc, /away/i)));
          const back = Math.max(dcV, toDec(ahLine[side + ':0.5']));
          if (back > 1.01)
            push('dc' + (i === 0 ? 'A' : 'B'), back, b.ah[k],
              'PIN DC / AH +0.5 / BF AH +0.5 Lay');
        } else if (Math.abs(line) <= MAX_AH_LINE &&
          Math.abs(Math.abs(line) * 4 - Math.round(Math.abs(line) * 4)) <= 1e-6) {
          const back = toDec(ahLine[side + ':' + line]);
          if (back > 1.01) {
            const prefix = line < 0 ? 'ahm' : 'ahp';
            const enc = String(Math.abs(line * 100)).padStart(3, '0');
            const lk = prefix + enc + (i === 0 ? 'A' : 'B');
            push(lk, back, b.ah[k], 'PIN Spread ' + (line > 0 ? '+' : '') + line +
              ' / BF AH ' + (line > 0 ? '+' : '') + line + ' Lay');
          }
        }
      }
      // --- EH↔AH-Cross (Back-Lay): PIN euh-Seite ±N + BF AH Lay gleiche Seite ---
      // Matrix §26a: die Lay-Linie ist immer c.line − 0.5 (Heim+N ↔ Lay
      // Heim +(N−0.5), Heim−N ↔ Lay Heim −(N+0.5)). Komplementaere 2-Beiner
      // ohne Push — Edge ueber die Standard-Back-Lay-Formel (BF-Kommission
      // steckt in der Lay-Quote; arbDir-Guard via push).
      for (const c of (h.euhs || [])) {
        if (!(c.side > 1.01)) continue;
        const cTeam = (h.teams[0] && teamMatch(c.team, h.teams[0])) ? h.teams[0] :
          ((h.teams[1] && teamMatch(c.team, h.teams[1])) ? h.teams[1] : '');
        if (!cTeam) continue;
        const hedgeLine = c.line - 0.5;
        const key = Object.keys(b.ah).find(k => {
          const [ln, tm] = k.split(':');
          return Math.abs(parseFloat(ln) - hedgeLine) < 1e-6 && teamMatch(cTeam, tm);
        });
        if (!key) continue;
        const letter = teamMatch(cTeam, h.teams[0]) ? 'H' : 'A';
        push('euhAH' + Math.abs(c.line) + letter + (c.line > 0 ? '+' : '-'),
          c.side, b.ah[key], 'PIN euh ' + cTeam + ' ' + (c.line > 0 ? '+' : '') +
            c.line + ' / BF AH ' + cTeam + ' ' + (hedgeLine > 0 ? '+' : '') +
            hedgeLine + ' Lay');
      }
      // --- EH↔AH-Cross BB: PIN euh-Seite ±N + BF AH Back auf den Gegner ---
      // Matrix §26a „Back-Gegenwette": Heim+N ↔ Gegner −(N−0.5), Heim−N ↔
      // Gegner +(N+0.5) — die Gegner-Linie ist immer 0.5 − c.line. Back-Back-
      // Cross wie dnbCross: BF-Kommission via bfEffQ, Gate crossBackEdge > 0.
      for (const c of (h.euhs || [])) {
        if (!(c.side > 1.01)) continue;
        const cTeam = (h.teams[0] && teamMatch(c.team, h.teams[0])) ? h.teams[0] :
          ((h.teams[1] && teamMatch(c.team, h.teams[1])) ? h.teams[1] : '');
        if (!cTeam) continue;
        const oppTeam = cTeam === h.teams[0] ? h.teams[1] : h.teams[0];
        const oppLine = 0.5 - c.line;
        const key = Object.keys(b.ah).find(k => {
          const [ln, tm] = k.split(':');
          return Math.abs(parseFloat(ln) - oppLine) < 1e-6 && teamMatch(oppTeam, tm);
        });
        if (!key) continue;
        const oppBack = b.ah[key].back;
        if (!(oppBack > 1.01)) continue;
        const effBf = bfEffQ(oppBack);
        if (effBf <= 1.01) continue;
        const edge = crossBackEdge(c.side, effBf);
        if (edge > 0) {
          const pinLetter = cTeam === h.teams[0] ? 'H' : 'A';
          const kind = 'euhAH' + Math.abs(c.line) + pinLetter +
            (c.line > 0 ? '+' : '-') + (pinLetter === 'H' ? 'B' : 'H');
          log('  EH↔AH-BB ' + b.name + ': PIN euh ' + cTeam + ' ' +
            (c.line > 0 ? '+' : '') + c.line + ' ' + c.side.toFixed(2) +
            ' + BF AH ' + oppTeam + ' ' + (oppLine > 0 ? '+' : '') + oppLine +
            ' ' + oppBack.toFixed(2) + '(eff ' + effBf.toFixed(2) + ') => Edge ' +
            edge.toFixed(2) + '%');
          pushRow(rows, lid, { name: b.name, hit: h, b,
            kind, back: c.side,
            src: 'PIN euh ' + cTeam + ' ' + (c.line > 0 ? '+' : '') + c.line +
              ' + BF AH ' + oppTeam + ' ' + (oppLine > 0 ? '+' : '') + oppLine +
              ' Back',
            lay: oppBack, vol: b.ah[key].volB || 0 });
        }
      }
    }
    const tEnd = Date.now();
    const dtFetch = tFetch - t0, dtMatch = tMatch - tFetch, dtAsync = tEnd - tMatch;
    if (DBG) log('  TIMING[' + lid + '] fetch=' + dtFetch + 'ms match=' + dtMatch + 'ms async=' + dtAsync + 'ms total=' + (tEnd - t0) + 'ms');
    scanTimings.push({ lid, name: LIGA_NAMEN[lid] || lid, fetch: dtFetch,
      match: dtMatch, async: dtAsync, total: tEnd - t0 });
  }

  async function scanH2HLeague(lid, comp, log, rows, seenRen, games) {
    // PIN und BF parallel laden (wie bfLaysWrap im CS-Pfad). BF-Fehler werden in
    // ein leeres Ergebnis gewandelt, damit eine BF-Fehlerlage weder den Scan der
    // Liga stoppt noch bei leerem PIN den autoTourLid-Remap verhindert.
    const [pin, bf] = await Promise.all([
      pinH2H(lid, log),
      bfH2H(comp, log).catch(e => {
        try { devlog('bfH2H[' + comp + '] Fehler: ' + ((e && e.message) || e)); } catch (e2) {}
        return { mo: [], sb: [], sw: [], ou: [], oe: [] };
      })
    ]);
    // Turnier-Runde auf PIN in mehrere Lids gesplittet (v8.62.6): solange das
    // gemappte lid Spiele hat (kein autoTourLid-Remap), aber BF mehr Events
    // zeigt als PIN deckt, koennen Spiele im Nachbar-Runden-lid liegen (z.B.
    // US Open 2026: "ATP US Open - R1" (3451) fuehrt nur die fruehen
    // Tagesmatches, der Rest inkl. Topspielen liegt in "ATP US Open - R2"
    // (3453)). Nachbar-Runden-lids desselben Turniers mit Fenster-Matchups
    // werden namensbasiert in den PIN-Pool gemergt — Fehlmatches sind dadurch
    // ausgeschlossen (nur identische Paarungen treffen).
    const mergedSiblings = [];
    if (Object.keys(pin).length && bf.mo.length > Object.keys(pin).length &&
        tourKey2(H2H_NAMEN[lid] || '')) {
      const keyOf = p => (p.teams || []).map(t => norm(t || '')).filter(Boolean).join('|');
      const sibs = await h2hRoundSiblings(lid, log);
      for (const s of sibs) {
        const sp = await pinH2H(Number(s.lid), log);
        const have = new Set(Object.values(pin).map(keyOf));
        let added = 0;
        for (const p of Object.values(sp)) {
          const k = keyOf(p);
          if (!k || have.has(k)) continue;
          have.add(k);
          pin[p.id] = p;
          added++;
        }
        if (added) {
          mergedSiblings.push({ lid: Number(s.lid), name: s.name, pin: sp });
          log('  ♻ Runden-sibling ' + (H2H_NAMEN[lid] || lid) + ' -> ' + s.name +
            ' (lid ' + s.lid + '): ' + added + ' Spiele gemerged');
        }
      }
    }
    // Alle PIN-Matchups (auch ohne Arb) fuer die Spielsuche sammeln (v8.39.0).
    // Sibling-Pools ergaenzen nur Paarungen, die der Primaer-Pool nicht schon
    // fuehrt (gleiche Paarung aus mehreren Lids -> nur einmal eintragen).
    if (games) {
      const seenG = new Set();
      const pushGames = (lidX, nameX, pool) => {
        for (const p of Object.values(pool)) {
          const nm = (p.teams || []).filter(Boolean).join(' v ');
          if (!nm) continue;
          const k = (p.teams || []).map(t => norm(t || '')).filter(Boolean).join('|');
          if (seenG.has(k)) continue;
          seenG.add(k);
          games.push({ league: lidX, leagueName: nameX, name: nm,
            mid: String(p.id || ''), startTime: p.st || '', comp: comp });
        }
      };
      pushGames(lid, H2H_NAMEN[lid] || '', pin);
      for (const s of mergedSiblings) pushGames(s.lid, s.name, s.pin);
    }
    if (!Object.keys(pin).length) {
      // Turnier-Runde vorbei: gleichen COMP auf den Folge-Runden-lid umbuchen
      const succ = await autoTourLid(lid, comp, log);
      if (succ) {
        const seen = seenRen || new Set();
        if (!seen.has(lid)) {
          seen.add(lid);
          try {
            log('  ♻ Runden-remap: ' + (H2H_NAMEN[lid] || lid) +
              ' -> ' + succ.name + ' (lid ' + succ.lid +
              ', COMP bleibt ' + comp + ', ' + succ.cnt + ' Spiele)');
          } catch (e) {}
          delete H2H[lid];
          delete H2H_NAMEN[lid];
          H2H[succ.lid] = comp;
          H2H_NAMEN[succ.lid] = succ.name;
          try { localStorage.setItem('vbsb_csarb_map2',
            JSON.stringify({ leagues: H2H, names: H2H_NAMEN })); } catch (e) {}
          try {
            GM_xmlhttpRequest({
              method: 'POST', url: PIPE + '/league-map',
              headers: { 'Content-Type': 'application/json' },
              data: JSON.stringify({ remove: true, pid: lid }),
            });
            GM_xmlhttpRequest({
              method: 'POST', url: PIPE + '/league-map',
              headers: { 'Content-Type': 'application/json' },
              data: JSON.stringify({ merge: true, section: 'h2h', pid: succ.lid, comp: comp, name: succ.name }),
            });
          } catch (e) { /* App nicht erreichbar */ }
          return scanH2HLeague(succ.lid, comp, log, rows, seen, games);
        } else {
          log('  => 0 gematcht (Turnier vorbei, kein unbekannter Folge-Remap)');
          return { pin: 0, bf: 0, hit: 0 };
        }
      }
      log('  => 0 gematcht (keine PIN-Spiele)');
      return { pin: 0, bf: 0, hit: 0 };
    }
    if (!bf.mo.length && !(bf.sb || []).length && !(bf.sw || []).length && !(bf.ou || []).length && !(bf.oe || []).length && !(bf.gd || []).length) {
      log('  => 0 gematcht (keine BF-Maerkte)');
      return { pin: Object.keys(pin).length, bf: 0, hit: 0 };
    }
      const surname = t => {
        const ws = norm(t).split(' ').filter(w => w && !STOPW.has(w));
        return ws.length ? ws[ws.length - 1] : '';
      };
      const mScore = (team, rn) => {
        if (teamMatch(team, rn.nm)) return 3;
        const sn = surname(team);
        return sn && norm(rn.nm).split(' ').includes(sn) ? 1 : 0;
      };
      const womenMark = s => /(^|\s)(w|women|womens|ladies)(\s|$)/.test(norm(s));
      const ovl = (a, b) => {
        const A = toks(a), B = toks(b);
        let h = 0;
        for (const t of A) if (B.has(t)) h++;
        return h;
      };
      const halfHit = (team, half, ht) => {
        if (!ht.size) return false;
        if (teamMatch(team, half)) return true;
        const tt = toks(team);
        let sub = true;
        for (const t of ht) if (!tt.has(t)) { sub = false; break; }
        if (sub) return true;
        const sn = surname(team);
        return !!sn && ht.has(sn);
      };
      const findH = nb => {
        // BF-Kurznamen ("Richmond v West Coast") gegen PIN-Namen mit
        // Maskottchen ("Richmond Tigers v West Coast Eagles"): seitenweise
        // vergleichen, halbe Seite muss in Team-Tokens enthalten sein.
        const sides = norm(nb).split(' v ');
        let best = null, bestS = -1;
        for (const p of Object.values(pin)) {
          const ok = sides.length === 2
            ? (halfMatch(p, sides[0], sides[1]) || halfMatch(p, sides[1], sides[0]))
            : (teamMatch(p.teams[0], nb) && teamMatch(p.teams[1], nb));
          if (!ok) continue;
          const s = ovl(p.teams[0], nb) + ovl(p.teams[1], nb);
          if (s > bestS) { bestS = s; best = p; }
        }
        return best;
      };
      const halfMatch = (p, a, b) =>
        halfHit(p.teams[0], a, toks(a)) && halfHit(p.teams[1], b, toks(b));
      let hit = 0, skipped = 0;
      const leagueW = womenMark(H2H_NAMEN[lid] || '');
      const bbSeen = new Map();  // key -> idx in rows (BB-Dedup)
      for (const b of bf.mo) {
        const nb = norm(b.name);
        // Nur explizit markierte Gegengeschlecht-Events ueberspringen:
        // in Damen-Ligen sind unmarkierte Events korrekt (getrennte COMPs),
        // in Herren-Ligen nur markierte Damen-Events aussortieren.
        if (!leagueW && womenMark(nb)) { skipped++; continue; }
        const h = findH(nb, b.name);
      if (!h) {
        if (!collectNameCand(b.name, pin, lid, comp, H2H_NAMEN[lid] || ''))
          collectUnmatched(b.name, lid, comp, H2H_NAMEN[lid] || '', b.st);
        pushRow(rows, lid, { name: b.name, hit: null, b,
          kind: 'h2h', back: 0, lay: 0, vol: 0, live: null });
        continue;
      }
      let x = null, y = null;
      const s1 = mScore(h.teams[0], b.r0) + mScore(h.teams[1], b.r1);
      const s2 = mScore(h.teams[0], b.r1) + mScore(h.teams[1], b.r0);
      if (s1 > s2) { x = b.r0; y = b.r1; }
      else if (s2 > s1) { x = b.r1; y = b.r0; }
      else continue;
      hit++;
      const a = h.back[0], bb = h.back[1];
      // v8.62.16 (Boost-Quote-Carrier): 2-Wege-ML-Rows (blA/blB) auch OHNE
      // Arb-Richtung speichern (Daten-Existenz-Gate: PIN-Back > 1.01 +
      // BF-Match-Odds-Lay > 1.01 und < 1000 = kein BF-Platzhalter). Damit
      // werden h2h-Boosts ("X gewinnt" bei Tennis/MMA/Boxen/…) aus der DB
      // bedient statt per why-Pull (Verifikation: lay ist das BF-MO-Lay des
      // jeweiligen Runners, identisch zur straight-ML im why-Tool).
      if (a > 1.01 && x && x.lay > 1.01 && x.lay < 1000)
        // xback (v8.62.23): BF-Back des Gegner-Runners — die Back-Back-Cross-
        // Gegenwette fuer den Boost-Arb („Back ¬M @ BF").
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: 'blA', back: a, src: 'PIN A', lay: x.lay, vol: x.volL,
          xback: y && isValidPrice(y.back) ? y.back : 0 });
      if (bb > 1.01 && y && y.lay > 1.01 && y.lay < 1000)
        pushRow(rows, lid, { name: b.name, hit: h, b,
          kind: 'blB', back: bb, src: 'PIN B', lay: y.lay, vol: y.volL,
          xback: x && isValidPrice(x.back) ? x.back : 0 });
      // BB-Dedup: gleicher Markt kann als Pre-Match + In-Play zweimal geliefert werden
      const pushBB = (kind, src, pinBack, bfBack, bfVol) => {
        if (!(isValidPrice(pinBack) && isValidPrice(bfBack) &&
          crossBackEdge(pinBack, bfEffQ(bfBack)) > 0)) return;
        const key = b.name + '|' + kind + '|' + pinBack;
        const prev = bbSeen.get(key);
        if (prev !== undefined) {
          if (bfVol > rows[prev].vol) {
            rows[prev].lay = bfBack;
            rows[prev].vol = bfVol;
            rows[prev].marketId = b.marketId;
          }
          return;
        }
        bbSeen.set(key, rows.length);
        rows.push({ league: lid, leagueName: H2H_NAMEN[lid] || '', name: b.name,
          kind, back: pinBack, src, lay: bfBack, vol: bfVol,
          marketId: b.marketId, hit: h, live: h.live || b.live,
          startTime: h.st || '', score: h.score || '' });
      };
      // Back-Back NUR bei echten 2-Runner-Maerkten (kein BF-Draw-Runner):
      // Bei 3-Wege-Maerkten (Boxen/MMA/Rugby mit Draw) preisen die BF-Backs
      // den Draw ein — PIN-Back + BF-Back verlieren bei einem Draw BEIDE
      // (PIN 2-Wege = Push, BF-Back = verloren), die Kombi ist nicht
      // wasserdicht (Fake-Arb, Live-Fall Sam Noakes v Denys Berinchyk mit
      // 26 % Schein-Edge). Der BF-Lay (blA/blB) deckt den Draw dagegen mit
      // ab und bleibt immer erlaubt.
      if (!b.hadDraw) {
        pushBB('bbA', 'PIN A + BF B', a, y.back, y.volB);
        pushBB('bbB', 'PIN B + BF A', bb, x.back, x.volB);
      }
    }
    if (bf.mo.length && hit === 0) {
      log('  DEBUG NAMEN BF: ' + bf.mo.slice(0, 3).map(b => b.name).join(' | '));
      log('  DEBUG NAMEN PIN: ' + Object.values(pin).slice(0, 3)
        .map(p => p.teams.join(' v ')).join(' | '));
    }
    let sbHit = 0;
    for (const sb of bf.sb || []) {
      const nb = norm(sb.name);
      if (!leagueW && womenMark(nb)) { skipped++; continue; }
      const h = findH(nb, sb.name);
      if (!h) continue;
      const layByTeam = {};
      for (const p of sb.players) {
        let i = -1;
        if (mScore(h.teams[0], { nm: p.name }) > 0) i = 0;
        else if (mScore(h.teams[1], { nm: p.name }) > 0) i = 1;
        if (i >= 0 && !layByTeam[i] && h.back2 && h.back2[i] && p.s20.lay) layByTeam[i] = p;
      }
      for (const i of [0, 1]) {
        const s = layByTeam[i];
        // v8.62.11: s2/sdPlus/s5/sd5Plus auch OHNE Arb-Richtung speichern
        // (analog s51/sd15Plus-Locks und CS-Rows v8.60.34, exakt wie der
        // why-Pull in tools.js): der Boost-Arb-Solver braucht die BF-Set-
        // Betting-Lays und PIN-Satz-Handicap-Quoten fuer den DB-Schnellpfad
        // auch dann, wenn beim Scan gerade kein Arb besteht (der Normalfall)
        // — vorher verwarfen arbDir()/crossBackEdge() genau diese Rows, der
        // Snapshot hatte nie 2:0/3:0-Legs und der Boost-Check fiel immer in
        // den langsamen why-Pull. Die App-Liste zeigt weiterhin nur edge > 0
        // (pvb_odds_pipe), Nicht-Arb-Rows sind dort unsichtbar, aber fuer
        // den Boost-Check nutzbar.
        if (!s || !isValidPrice(s.s20.lay)) continue;
        sbHit++;
        pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
          kind: 's2' + (i === 0 ? 'A' : 'B'),
          back: isValidPrice(h.back2[i]) ? h.back2[i] : 0,
          src: 'PIN ' + h.teams[i] + ' -1.5 / BF 2-0',
          lay: s.s20.lay, vol: s.s20.vol });
      }
      // +1.5-Back (Underdog) <-> BF-Gegner-2:0-Back (Back-Back):
      // PIN +1.5 und BF "Gegner 2:0" sind komplementaere Ereignisse
      // (verliert der Underdog 0:2, gewinnt der Gegner exakt 2 Gerrate).
      for (const i of [0, 1]) {
        const j = 1 - i;
        const pinPlus = (h.back15 || [])[i];
        const opp = layByTeam[j];
        if (!(isValidPrice(pinPlus) && opp && isValidPrice(opp.s20.back))) continue;
        sbHit++;
        pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
          kind: 'sdPlus' + (i === 0 ? 'A' : 'B'), back: pinPlus,
          src: 'PIN ' + h.teams[i] + ' +1.5 / BF ' + h.teams[j] + ' 2-0 (BB)',
          lay: opp.s20.back, vol: opp.s20.volB });
      }
      // Grand-Slam-3:0 (Best-of-5): PIN Satz-Handicap ±2.5 gegen BF Set
      // Betting 3-0/3-1/3-2. Parallele Logik zur 2:0-Feature (bo3), aber auf
      // den ±2.5-Linien: b25 = "gewinnt 3:0", b25plus = "verliert nicht 0:3".
      const b25A = (h.back25 || [])[0], b25B = (h.back25 || [])[1];
      const b25pA = (h.back25plus || [])[0], b25pB = (h.back25plus || [])[1];
      // Set-Betting-Runner je Spieler auf 3:0 suchen (s30 = "3-0"-Lay/Back).
      const tByTeam = {};
      for (const p of sb.players) {
        if (!p.s30) continue;
        let i = -1;
        if (mScore(h.teams[0], { nm: p.name }) > 0) i = 0;
        else if (mScore(h.teams[1], { nm: p.name }) > 0) i = 1;
        if (i >= 0 && tByTeam[i] === undefined) tByTeam[i] = p;
      }
      for (const i of [0, 1]) {
        const j = 1 - i;
        const pinMinus = i === 0 ? b25A : b25B;          // <- gewinnt 3:0
        const pinPlus = i === 0 ? b25pA : b25pB;          // verliert nicht 0:3
        const t = tByTeam[i];                              // "Team 3-0"-Runner
        const opp = tByTeam[j];                            // "Gegner 3-0"-Runner
        if (isValidPrice(pinMinus) && t && isValidPrice(t.s30.lay)) {
          sbHit++;
          pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
            kind: 's5' + (i === 0 ? 'A' : 'B'), back: pinMinus,
            src: 'PIN ' + h.teams[i] + ' -2.5 / BF ' + h.teams[i] + ' 3-0 (Lay)',
            lay: t.s30.lay, vol: t.s30.vol });
        }
        // +2.5-Back (Underdog, "nicht 0:3") <-> BF-Gegner-3:0-Back (Back-Back):
        // verliert der Underdog 0:3, gewinnt der Gegner exakt 3:0.
        if (isValidPrice(pinPlus) && opp && isValidPrice(opp.s30.back)) {
          sbHit++;
          pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
            kind: 'sd5Plus' + (i === 0 ? 'A' : 'B'), back: pinPlus,
            src: 'PIN ' + h.teams[i] + ' +2.5 / BF ' + h.teams[j] + ' 3-0 (BB)',
            lay: opp.s30.back, vol: opp.s30.volB });
        }
      }
      // 3:1-Satz-Score (Best-of-5, v8.60.21): BF Set Betting „X 3-1" als
      // Lay gegen die Boost-Combo „X gewinnt 3:1" — analog s5 (3:0), aber
      // auf dem 3-1-Runner (s31). PIN ±1.5 (back15neg/back15): -1.5 =
      // „X gewinnt 3:0 oder 3:1" (Info-Seite), +1.5 = „X 3:2 oder Y gewinnt"
      // — die +1.5-Seite des GEGNERS ist die 3:1-Gegenwette (zusammen mit
      // dem Lay X 3-1 ergibt sie den No-Loss-Lock, siehe boost_arb_core).
      const t31ByTeam = {};
      for (const p of sb.players) {
        if (!p.s31) continue;
        let i = -1;
        if (mScore(h.teams[0], { nm: p.name }) > 0) i = 0;
        else if (mScore(h.teams[1], { nm: p.name }) > 0) i = 1;
        if (i >= 0 && t31ByTeam[i] === undefined) t31ByTeam[i] = p;
      }
      for (const i of [0, 1]) {
        const t31 = t31ByTeam[i];                              // "Team 3-1"-Runner
        if (!t31 || !isValidPrice(t31.s31.lay)) continue;
        const pinMinus15 = (h.back15neg || [])[i];             // X -1.5 (Info)
        sbHit++;
        pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
          kind: 's51' + (i === 0 ? 'A' : 'B'),
          back: isValidPrice(pinMinus15) ? pinMinus15 : 0,
          src: 'PIN ' + h.teams[i] + ' -1.5 / BF ' + h.teams[i] + ' 3-1 (Lay)',
          lay: t31.s31.lay, vol: t31.s31.vol });
        // +1.5-Back (Gegner holt 2 Sätze oder gewinnt): die Gegen-Seite zu
        // „X 3:1". Zusammen mit dem Lay X 3-1 (s51) der No-Loss-Lock.
        const pinPlus15 = (h.back15 || [])[i];
        if (isValidPrice(pinPlus15)) {
          sbHit++;
          pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
            kind: 'sd15Plus' + (i === 0 ? 'A' : 'B'), back: pinPlus15,
            src: 'PIN ' + h.teams[i] + ' +1.5 / BF ' + h.teams[i] + ' 3-1 (Lay)',
            lay: t31.s31.lay, vol: t31.s31.vol });
        }
      }
      // 2:1 (bo3) / 3:2 (bo5), v8.60.24: BF Set Betting „X 2-1"/„X 3-2" als
      // Lay gegen die Boost-Combo „X gewinnt 2:1/3:2" (Runner s21/s32). Der
      // Lock-Back ist hier die PIN-**Moneyline des Gegners** (Y): Y +0,5
      // Sätze gibt es als Markt nicht, und „nicht X 2:1" = {X 2:0, Y-Sieg}
      // bzw. „nicht X 3:2" = {X 3:0, X 3:1, Y-Sieg} — der Gegner-Back deckt
      // den Y-Sieg-Teil, der Lay den Rest. Lock via _ten_score_lock.
      const tXY = { 21: {}, 32: {} };
      for (const key of ['21', '32']) {
        const pf = 's' + key;
        for (const p of sb.players) {
          if (!p[pf]) continue;
          let k = -1;
          if (mScore(h.teams[0], { nm: p.name }) > 0) k = 0;
          else if (mScore(h.teams[1], { nm: p.name }) > 0) k = 1;
          if (k >= 0 && tXY[key][k] === undefined) tXY[key][k] = p;
        }
      }
      for (const key of ['21', '32']) {
        const pf = 's' + key;
        const scoreTxt = key === '21' ? '2-1' : '3-2';
        for (const i of [0, 1]) {
          const j = 1 - i;
          const t = tXY[key][i];
          if (!t || !isValidPrice(t[pf].lay)) continue;
          const pinY = (h.back || [])[j];        // Gegner-Moneyline (Y)
          sbHit++;
          pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
            kind: 's' + key + (i === 0 ? 'A' : 'B'),
            back: isValidPrice(pinY) ? pinY : 0,
            src: 'PIN ' + h.teams[j] + ' (Moneyline) / BF ' + h.teams[i] +
              ' ' + scoreTxt + ' (Lay)',
            lay: t[pf].lay, vol: t[pf].vol });
        }
      }
      if (h.sou && sb.ns) {
        if (sb.ns.three && arbDir(h.sou.over, sb.ns.three.lay)) {
          sbHit++;
          pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
            kind: 'soO', back: h.sou.over,
            src: 'PIN Satze Over 2.5 / BF Three Sets',
            lay: sb.ns.three.lay, vol: sb.ns.three.vol });
        }
        if (sb.ns.two && arbDir(h.sou.under, sb.ns.two.lay)) {
          sbHit++;
          pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
            kind: 'soU', back: h.sou.under,
            src: 'PIN Satze Under 2.5 / BF Two Sets',
            lay: sb.ns.two.lay, vol: sb.ns.two.vol });
        }
        // Grand Slam Sets-O/U 3.5: PIN Satz-Total 3.5 (bo5) gegen BF "Number
        // of Sets" — Over 3.5 = 4 oder 5 Saetze, Under 3.5 = 3 Saetze.
        if (sb.ns.five && arbDir(h.sou.over, sb.ns.five.lay)) {
          sbHit++;
          pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
            kind: 'so5O', back: h.sou.over,
            src: 'PIN Satze Over 3.5 / BF Five Sets (Lay)',
            lay: sb.ns.five.lay, vol: sb.ns.five.vol });
        }
        if (sb.ns.three && arbDir(h.sou.under, sb.ns.three.lay)) {
          sbHit++;
          pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
            kind: 'so5U', back: h.sou.under,
            src: 'PIN Satze Under 3.5 / BF Three Sets (Lay)',
            lay: sb.ns.three.lay, vol: sb.ns.three.vol });
        }
      }
      // Tennis „Mehr als 4,5 Sätze“ (so45, v8.68.0): Boost-M = 5 Sätze (bo5,
      // Grand Slam) = X 3:2 ∨ Y 3:2, ¬M = 3 oder 4 Sätze. Pinnacle hat KEINE
      // 4,5er-Satz-Total-Linie — die Legs kommen aus dem BF „Number of Sets“-
      // Markt (identisch zur why-Emission in tools.js):
      //   lay   = BF-Lay „Five Sets“       (= ¬M, sauberes 2-Wege-Komplement)
      //   xback = kombinierte BF-Back-Quote „Three Sets + Four Sets“
      //           1/(1/q3 + 1/q4) — die beiden disjunkten ¬M-Ausgänge als
      //           Back-Back-Cross-Kanal (v8.62.23-xback, reine BF-Legs).
      // Ungegatet wie s2/sw-Rows (v8.62.11): der Boost-Arb-Solver braucht die
      // Quoten im DB-Schnellpfad auch dann, wenn beim Scan gerade kein Arb
      // besteht (nur fuer den Boost-Arb, kein PvB-Paar — TEN_LOCK_KINDS).
      const ns45 = sb.ns;
      if (ns45 && ns45.five &&
          ((ns45.five.lay != null && isValidPrice(ns45.five.lay)) ||
           (ns45.three && ns45.four && isValidPrice(ns45.three.back) &&
            isValidPrice(ns45.four.back)))) {
        let so45xb = 0;
        if (ns45.three && ns45.four && isValidPrice(ns45.three.back) &&
            isValidPrice(ns45.four.back)) {
          so45xb = 1 / (1 / ns45.three.back + 1 / ns45.four.back);
        }
        sbHit++;
        pushRow(rows, lid, { name: sb.name, hit: h, b: sb,
          kind: 'so45',
          back: 0,
          lay: (ns45.five.lay != null && isValidPrice(ns45.five.lay))
            ? ns45.five.lay : 0,
          src: 'BF Five Sets (Lay) / 3+4 Sets (Back, ¬M)',
          vol: (ns45.five.vol) || 0,
          xback: so45xb });
      }
    }
    let swHit = 0;
    for (const sw of bf.sw || []) {
      const nb = norm(sw.name);
      if (!leagueW && womenMark(nb)) { skipped++; continue; }
      const h = findH(nb, sw.name);
      if (!h) continue;
      const wk = h.w && h.w[sw.per];
      if (!wk) continue;
      const s1 = mScore(h.teams[0], sw.r0) + mScore(h.teams[1], sw.r1);
      const s2 = mScore(h.teams[0], sw.r1) + mScore(h.teams[1], sw.r0);
      let x = null, y = null;
      if (s1 > s2) { x = sw.r0; y = sw.r1; }
      else if (s2 > s1) { x = sw.r1; y = sw.r0; }
      else continue;
      swHit++;
      // v8.62.11: swA/swB auch OHNE Arb-Richtung speichern (analog s2/s5
      // oben und wie der why-Pull in tools.js): der Boost-Solver braucht
      // die Set-Winner-Lays/Backs beider Seiten fuer sw1/sw2 im
      // DB-Schnellpfad. swBB (cross) bleibt bewusst arb-gegatet.
      if (x && isValidPrice(x.lay))
        pushRow(rows, lid, { name: sw.name, hit: h, b: sw,
          kind: 'sw' + sw.per + 'A',
          back: isValidPrice(wk[0]) ? wk[0] : 0,
          src: 'PIN Satz ' + sw.per + ' ' + h.teams[0] + ' / BF Set ' + sw.per + ' Winner',
          lay: x.lay, vol: x.volL });
      if (y && isValidPrice(y.lay))
        pushRow(rows, lid, { name: sw.name, hit: h, b: sw,
          kind: 'sw' + sw.per + 'B',
          back: isValidPrice(wk[1]) ? wk[1] : 0,
          src: 'PIN Satz ' + sw.per + ' ' + h.teams[1] + ' / BF Set ' + sw.per + ' Winner',
          lay: y.lay, vol: y.volL });
      // Satz-Sieger als Back-Back (cross): "PIN A gewinnt Satz" und
      // "BF B gewinnt Satz" sind komplementaere Ereignisse (wie bbA/bbB).
      const pushSwBB = (pinB, bfB, side) => {
        if (!(isValidPrice(pinB) && bfB && isValidPrice(bfB.back))) return;
        if (crossBackEdge(pinB, bfEffQ(bfB.back)) <= 0) return;
        swHit++;
        const pi = side === 'A' ? 0 : 1;
        const bj = 1 - pi;
        pushRow(rows, lid, { name: sw.name, hit: h, b: sw,
          kind: 'sw' + sw.per + 'BB' + side, back: pinB,
          src: 'PIN ' + h.teams[pi] + ' Satz ' + sw.per + ' + BF ' +
            h.teams[bj] + ' Satz ' + sw.per + ' (BB)',
          lay: bfB.back, vol: bfB.volB || bfB.vol });
      };
      pushSwBB(wk[0], y, 'A');
      pushSwBB(wk[1], x, 'B');
    }
    let ouHit = 0;
    for (const ou of bf.ou || []) {
      const nb = norm(ou.name);
      if (!leagueW && womenMark(nb)) { skipped++; continue; }
      const h = findH(nb, ou.name);
      if (!h) continue;
      // Corners-Maerkte laufen gegen den PIN-Corners-Kanal, alle uebrigen O/U
      // (Tore/Goals/Games) gegen goalsOu -- nie vermischt (8.5-Kollision).
      const pinSrc = ou.corners ? h.cornersOu : h.goalsOu;
      if (!pinSrc || !pinSrc.length) continue;
      const pinOu = pinSrc.find(o => Math.abs(o.line - ou.line) < 0.01);
      if (ou.corners)
        log('  DEBUG corners-match[' + lid + '] BF ' + ou.name + ' line=' + ou.line +
          ' -> PIN ' + h.teams.join(' v ') + ' ' + (pinOu ? pinOu.line + '=' + pinOu.over.toFixed(2) : 'KEIN 10.5-Kandidat'));
      if (!pinOu) continue;
      ouHit += emitOUEs(lid, log, rows, H2H_NAMEN[lid] || '', h, ou, pinOu);
    }
    let oeHit = 0;
    for (const oe of bf.oe || []) {
      const nb = norm(oe.name);
      if (!leagueW && womenMark(nb)) { skipped++; continue; }
      const h = findH(nb, oe.name);
      if (!h || !h.oe) continue;
      oeHit += emitOEs(lid, log, rows, H2H_NAMEN[lid] || '', h, oe, h.oe);
    }
    // MMA/UFC: "Go The Distance" (BF) vs "Fight Goes To Decision" (PIN).
    // Back-Lay je Seite (fdY/fdN) UND Back-Back-Crosslegs (fdBBY/fdBBN):
    // PIN-Yes + BF-No-Back bzw. PIN-No + BF-Yes-Back (Gegenwette).
    let gdHit = 0;
    for (const gd of bf.gd || []) {
      const nb = norm(gd.name);
      if (!leagueW && womenMark(nb)) { skipped++; continue; }
      const h = findH(nb, gd.name);
      if (!h || !h.fd) continue;
      // Back-Lay (gleiche Seite): PIN Yes vs BF Yes-Lay, PIN No vs BF No-Lay
      if (h.fd.yes > 1.01 && gd.yes.lay > 0 && arbDir(h.fd.yes, gd.yes.lay)) {
        gdHit++;
        pushRow(rows, lid, { name: gd.name, hit: h, b: gd,
          kind: 'fdY', back: h.fd.yes, src: 'PIN Fight Goes To Decision Yes',
          lay: gd.yes.lay, vol: gd.yes.vol });
      }
      if (h.fd.no > 1.01 && gd.no.lay > 0 && arbDir(h.fd.no, gd.no.lay)) {
        gdHit++;
        pushRow(rows, lid, { name: gd.name, hit: h, b: gd,
          kind: 'fdN', back: h.fd.no, src: 'PIN Fight Goes To Decision No',
          lay: gd.no.lay, vol: gd.no.vol });
      }
      // Back-Back-Crosslegs (Gegenwette): PIN-Yes + BF-No-Back, PIN-No + BF-Yes-Back
      if (isValidPrice(h.fd.yes) && isValidPrice(gd.no.back)) {
        const eBb = computeBBEdge(h.fd.yes, gd.no.back);
        if (eBb > 0) {
          gdHit++;
          pushRow(rows, lid, { name: gd.name, hit: h, b: gd,
            kind: 'fdBBY', back: h.fd.yes,
            src: 'PIN Decision Yes + BF Distance No-Back',
            lay: gd.no.back, vol: gd.no.volB });
        }
      }
      if (isValidPrice(h.fd.no) && isValidPrice(gd.yes.back)) {
        const eBb = computeBBEdge(h.fd.no, gd.yes.back);
        if (eBb > 0) {
          gdHit++;
          pushRow(rows, lid, { name: gd.name, hit: h, b: gd,
            kind: 'fdBBN', back: h.fd.no,
            src: 'PIN Decision No + BF Distance Yes-Back',
            lay: gd.yes.back, vol: gd.yes.volB });
        }
      }
    }
    const bfTotal = bf.mo.length + bf.sb.length + bf.sw.length + (bf.ou || []).length +
      (bf.oe || []).length + (bf.gd || []).length;
    log('  => gematcht: ' + (hit + sbHit + swHit + ouHit + oeHit + gdHit) + ' von ' + bfTotal +
      ' BF-Maerkten' +
      (skipped ? ' (' + skipped + ' anderes Geschlecht uebersprungen)' : '') +
      ((hit + sbHit + swHit + ouHit + oeHit + gdHit) < bfTotal - skipped ?
        ' | ' + (bfTotal - skipped - hit - sbHit - swHit - ouHit - oeHit - gdHit) + ' UNMATCHED' : ''));
    return { pin: Object.keys(pin).length, bf: bfTotal, hit: hit + sbHit + swHit + ouHit + oeHit + gdHit };
  }

  // H2H-Scan fuer genau eine Liga (DevTool h2hscan): scanH2HLeague direkt
  // ausfuehren und die Debug-Ausgaben (cornersOu/lg-straight/ouM) ins Panel
  // schreiben. rows bleibt lokal — kein Schreiben in state.rows.
  unsafeWindow.__h2hscan = async (lid, comp) => {
    const log = window.__ahLog || console.log;
    const rows = [];
    try {
      if (DBG) log('__h2hscan lid=' + lid + ' comp=' + comp + ' ...');
      const r = await scanH2HLeague(lid, comp, log, rows);
      if (DBG) log('__h2hscan fertig: PIN=' + r.pin + ' BF=' + r.bf + ' Hit=' + r.hit +
        (rows.length ? ' (' + rows.length + ' Rows)' : ''));
      return r;
    } catch (e) {
      if (DBG) log('__h2hscan FEHLER: ' + (e && e.stack || e));
      return null;
    }
  };

  // ---------- Snapshot ----------
  const KIND = { cs: '1:1', cs00: 'CS 0:0', cs10: 'CS 1:0', cs01: 'CS 0:1', cs20: 'CS 2:0',
    cs02: 'CS 0:2', cs21: 'CS 2:1', cs12: 'CS 1:2', cs22: 'CS 2:2', cs30: 'CS 3:0',
    cs03: 'CS 0:3', cs31: 'CS 3:1', cs13: 'CS 1:3', cs32: 'CS 3:2', cs23: 'CS 2:3',
    cs33: 'CS 3:3',
    hcs00: 'HT CS 0:0', hcs10: 'HT CS 1:0', hcs01: 'HT CS 0:1', hcs20: 'HT CS 2:0',
    hcs02: 'HT CS 0:2', hcs21: 'HT CS 2:1', hcs12: 'HT CS 1:2', hcs22: 'HT CS 2:2',
    hcs30: 'HT CS 3:0', hcs03: 'HT CS 0:3', hcs31: 'HT CS 3:1', hcs13: 'HT CS 1:3',
    hcs32: 'HT CS 3:2', hcs23: 'HT CS 2:3', hcs33: 'HT CS 3:3',
    bttsY: 'BTTS Yes', bttsN: 'BTTS No', bttsBBY: 'BTTS BB Yes', bttsBBN: 'BTTS BB No', h2h: 'H2H',
    blA: 'H2H BL A', blB: 'H2H BL B', bbA: 'H2H BB A', bbB: 'H2H BB B',
    tqA: 'To Qualify BL A', tqB: 'To Qualify BL B',
    bbTqA: 'To Qualify BB A', bbTqB: 'To Qualify BB B',
    s2A: 'Set 2:0 A', s2B: 'Set 2:0 B',
    s5A: 'Set 3:0 A (Grand Slam)', s5B: 'Set 3:0 B (Grand Slam)',
    sdPlusA: 'Set +1.5 A (BB Gegen 2:0)', sdPlusB: 'Set +1.5 B (BB Gegen 2:0)', soO: 'Sets O/U 2.5 Over', soU: 'Sets O/U 2.5 Under',
    sd5PlusA: 'Set +2.5 A (BB Gegen 3:0)', sd5PlusB: 'Set +2.5 B (BB Gegen 3:0)',    so5O: 'Sets O/U 3.5 Over', so5U: 'Sets O/U 3.5 Under',
    so45: 'Saetze >4.5 (BF Five Sets Lay/Back)',
    s51A: 'Set 3:1 A (Lay)', s51B: 'Set 3:1 B (Lay)',
    sd15PlusA: 'Set +1.5 A (Gegen 3:1)', sd15PlusB: 'Set +1.5 B (Gegen 3:1)',
    s21A: 'Set 2:1 A (Lay)', s21B: 'Set 2:1 B (Lay)',
    s32A: 'Set 3:2 A (Lay)', s32B: 'Set 3:2 B (Lay)',
    sw1A: 'Satz 1 Winner A', sw1B: 'Satz 1 Winner B',
    sw2A: 'Satz 2 Winner A', sw2B: 'Satz 2 Winner B',
    sw1BBA: 'Satz 1 Winner BB A', sw1BBB: 'Satz 1 Winner BB B',
    sw2BBA: 'Satz 2 Winner BB A', sw2BBB: 'Satz 2 Winner BB B',
    h3A: 'H2H 3-Way Home', h3D: 'H2H 3-Way Draw', h3B: 'H2H 3-Way Away',
    h3hA: 'HT 3-Way Home', h3hD: 'HT 3-Way Draw', h3hB: 'HT 3-Way Away',
    ahA: 'AH -0.5 A', ahB: 'AH -0.5 B', dnA: 'AH 0 (DNB) A', dnB: 'AH 0 (DNB) B',
    dcA: 'AH +0.5 (1X) A', dcB: 'AH +0.5 (X2) B',
    dnbH: 'DNB Home', dnbA: 'DNB Away', dnbCross: 'DNB Cross-Arb',
    dc1x: 'DC 1X', dcX2: 'DC X2', dc12: 'DC 12',
    dc1xB: 'DC 1X + B', dcX2A: 'DC X2 + A', dc12D: 'DC 12 + D',
    'A dcX2': 'A + DC X2', 'B dc1x': 'B + DC 1X', 'D dc12': 'D + DC 12',
    w2nH: 'Win to Nil H', w2nA: 'Win to Nil A',
    w2nNoH: 'Win to Nil No H', w2nNoA: 'Win to Nil No A',
    w2nBBY: 'Win to Nil BB Yes-PIN / No-BF', w2nBBN: 'Win to Nil BB No-PIN / Yes-BF',
    fdY: 'Fight Decision Yes (BL)', fdN: 'Fight Decision No (BL)',
    fdBBY: 'Fight Decision BB Yes-PIN / No-BF', fdBBN: 'Fight Decision BB No-PIN / Yes-BF',
    oeY: 'Odd/Even Odd (PIN back vs BF lay)', oeN: 'Odd/Even Even (PIN back vs BF lay)',
    oeBBY: 'Odd/Even Cross (PIN Even + BF Odd back)', oeBBN: 'Odd/Even Cross (PIN Odd + BF Even back)',
    btwHY: 'BTTS+Winner H/Yes', btwHN: 'BTTS+Winner H/No',
    btwDY: 'BTTS+Winner D/Yes', btwDN: 'BTTS+Winner D/No',
    btwAY: 'BTTS+Winner A/Yes', btwAN: 'BTTS+Winner A/No',
    pts: 'Torschuetze To Score',
    ptsBB: 'Torschuetze BB: PIN trifft nicht + BF trifft' };
  const kindLabel = k => {
    const m = /^ou(\d{2,3})([OU])$/.exec(k);
    if (m) return 'O/U ' + (parseInt(m[1], 10) / 10) +
      (m[2] === 'O' ? ' Over' : ' Under');
    const mbb = /^ouBB(\d{2,3})([OU])$/.exec(k);
    if (mbb) return 'O/U BB ' + (parseInt(mbb[1], 10) / 10) +
      (mbb[2] === 'O' ? ' Over' : ' Under');
    const mhbb = /^hfouBB(\d{1,3})([OU])$/.exec(k);
    if (mhbb) return 'HT O/U BB ' + (parseInt(mhbb[1], 10) / 10) +
      (mhbb[2] === 'O' ? ' Over' : ' Under');
    const mh = /^hfou(\d{2,3})([OU])$/.exec(k);
    if (mh) return 'HT O/U ' + (parseInt(mh[1], 10) / 10) +
      (mh[2] === 'O' ? ' Over' : ' Under');
    const mtt = /^tt(\d{2})([HA])([OU])$/.exec(k);
    if (mtt) return 'Team-Total ' + (parseInt(mtt[1], 10) / 10) + ' ' +
      (mtt[2] === 'H' ? 'Heim' : 'Auswärts') + ' ' +
      (mtt[3] === 'O' ? 'Over' : 'Under');
    const mttb = /^ttBB(\d{2})([HA])([OU])$/.exec(k);
    if (mttb) return 'Team-Total BB ' + (parseInt(mttb[1], 10) / 10) + ' ' +
      (mttb[2] === 'H' ? 'Heim' : 'Auswärts') + ' ' +
      (mttb[3] === 'O' ? 'Over' : 'Under');
    const ah = /^ah([mp])(\d{3})([AB])$/.exec(k);
    if (ah) {
      const sign = ah[1] === 'p' ? '+' : '-';
      const line = parseInt(ah[2], 10) / 100;
      return 'AH ' + sign + line + ' ' + (ah[3] === 'A' ? 'Home' : 'Away');
    }
    const cs = /^cs(\d)(\d)$/.exec(k);
    if (cs) return 'CS ' + cs[1] + ':' + cs[2];
    const hcs = /^hcs(\d)(\d)$/.exec(k);
    if (hcs) return 'HT CS ' + hcs[1] + ':' + hcs[2];
    const meuhX = /^euh1([HA])\+([BH])$/.exec(k);
    if (meuhX) return 'EH 1 ' + meuhX[1] + '+ ↔ BF ' + meuhX[2] + ' (Sieg-Cross)';
    const meuhAhB = /^euhAH(\d+)([HA])([+-])([HB])$/.exec(k);
    if (meuhAhB) return 'EH ' + meuhAhB[1] + ' ' + meuhAhB[2] + meuhAhB[3] +
      ' ↔ BF AH ' + (meuhAhB[4] === 'H' ? 'Heim' : 'Auswärts') + ' Back (BB)';
    const meuhAh = /^euhAH(\d+)([HA])([+-])$/.exec(k);
    if (meuhAh) return 'EH ' + meuhAh[1] + ' ' + meuhAh[2] + meuhAh[3] + ' via AH Lay';
    const meuh = /^euh(\d+)([HDA])([+-])?$/.exec(k);
    if (meuh) return 'Europ. Handicap ' + meuh[1] + ' ' + meuh[2] + (meuh[3] || '');
    const mro = /^ro([HDA])(\d{2,3})([OU])$/.exec(k);
    if (mro) return 'Winner+O/U ' + mro[1] + ' ' +
      (parseInt(mro[2], 10) / 10) + ' ' +
      (mro[3] === 'O' ? 'Over' : 'Under');
    return KIND[k] || '?';
  };

  // ---------- Name-Candidates (Near-Miss-Sammlung, v8.61.0) ----------
  // Schicht 1 des Name-Matching-Konzepts: JEDES BF-Event, das findH nicht
  // besteht (CS- wie H2H-Pfad), wird gegen die PIN-Matchups der Liga
  // fuzzy-gescort (src/matching.js nearMissCand). Eindeutige Beinahe-
  // Treffer landen im Snapshot als `nameCandidates` -> Name-Matching-Tab
  // der App (bestaetigen -> synonyms.json + Runtime-Push, ablehnen ->
  // dauerhaft ausblenden). Dedupe pro Session + Cap je Scan-Lauf, damit
  // der Dauerbetrieb nicht geflutet wird.
  const nameCands = [];
  const nameCandsSeen = new Set();
  let nameCandsRunCap = 0;
  const NAME_CANDS_PER_RUN = 10;
  // Unmatched-Events (v8.62.0, Option A): BF-Events ohne PIN-Match UND ohne
  // Near-Miss-Kandidat (Score < 0.5 / mehrdeutig) — der „Rest", der sonst
  // still verloren geht. Wird gecappt je Lauf + dedupliziert pro Session an
  // die App gemeldet, damit der User sieht, WIE VIELE es sind und sie dort
  // als „irrelevant" ausblenden kann. Wichtig: ein groesserer Teil davon
  // sind keine echten Verluste (BF-Events, die PIN gar nicht anbietet).
  const unmatchedEvents = [];
  let unmatchedRunCap = 0;
  const UNMATCHED_PER_RUN = 20;

  function collectNameCand(bfName, pinMap, lid, comp, leagueName) {
    if (!bfName || nameCandsRunCap >= NAME_CANDS_PER_RUN) return false;
    const dedupeKey = norm(bfName) + '|' + lid;
    if (nameCandsSeen.has(dedupeKey)) return false;
    const cand = nearMissCand(bfName, Object.values(pinMap));
    if (!cand) return false;
    nameCandsSeen.add(dedupeKey);
    nameCandsRunCap++;
    nameCands.push({
      pin: (cand.matchup.teams || []).join(' v '),
      pinTeam: cand.pinTeam, bfTeam: cand.bfTeam, bf: bfName,
      score: Math.round(cand.score * 100) / 100,
      lid, comp, league: leagueName || ''
    });
    return true;
  }

  // Sammelt BF-Events, die findH NICHT besteht und fuer die es keinen
  // Near-Miss-Kandidaten gibt. Aufruf nur, wenn collectNameCand false
  // lieferte (bzw. das Event nicht schon dort behandelt wurde):
  // nameCandsSeen markiert das Event auch bei fehlendem Kandidaten, damit
  // das Event pro Liga nur EINMAL gemeldet wird (erster Markt entscheidet).
  // evSt (v8.62.5): BF-Event-Start (epoch ms, aus bymarket description.marketTime
  // in bfLays/bfH2H gestempelt). Liegt der Start AUSSERHALB des PIN-Scan-
  // Fensters, ist das Event kein echter Verlust: BF-COMPs listen oft mehrere
  // Spieltage/Turnier-Runden (z.B. US Open 52 Events, Argentinien-Liga zwei
  // Runden), PIN aber nur das aktuelle Fenster — solche Events matchen an
  // ihrem eigenen Spieltag normal. Ohne Fenster-Check wuerden sie bei JEDEM
  // Lauf als "unmatched" gemeldet und die Liste mit Folgerunden-Rauschen
  // fluten (seen-Zaehler in die Hunderte). Events ohne Start (evSt fehlt)
  // werden weiter gemeldet (konservativ: kein echter Verlust ausschliessen).
  function collectUnmatched(bfName, lid, comp, leagueName, evSt) {
    if (!bfName || unmatchedRunCap >= UNMATCHED_PER_RUN) return;
    const dedupeKey = norm(bfName) + '|' + lid;
    if (nameCandsSeen.has(dedupeKey)) return;
    if (evSt) {
      const now = Date.now();
      if (evSt < now - HOURS_BACK * MS_PER_HOUR || evSt > now + daysAhead * MS_PER_DAY) return;
    }
    nameCandsSeen.add(dedupeKey);
    unmatchedRunCap++;
    unmatchedEvents.push({
      bf: bfName, lid, comp, league: leagueName || ''
    });
  }

  function makeSnapshot(rows, games) {
    // Delegiert an den reinen Builder (src/snapshot.js) — dort Node-testbar.
    return makeSnapshotCandidates(rows, edgeOf, sportVonLiga, COMM, games,
      nameCands, unmatchedEvents);
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  // ---------- Reiner Snapshot-Builder (Node-testbar) ----------
  // Baut aus den scan-Zeilen die finale Snapshot-Liste (die Struktur, die
  // UI + Pipe erwarten). Bewusst als PURE Funktion mit injizierten
  // Abhaengigkeiten (edgeOf, sportVonLiga, COMM), damit sie in Node
  // standalone testbar ist, ohne die komplette Browser-IIFE laden zu muessen.
  // Kanonisch fuer den Browser; pvb_odds_pipe/Python muss dieselbe Struktur
  // parsen. Siehe test/snapshot.test.js.
  function makeSnapshotCandidates(rows, edgeOf, sportVonLiga, COMM, games, nameCands, unmatched) {
    const cands = rows.filter(r => r.hit).map(r => ({
      league: r.league, leagueName: r.leagueName || '', name: r.name, kind: r.kind,
      back: r.back, src: r.src, lay: r.lay, vol: r.vol, edge: edgeOf(r),
      marketId: r.marketId || '',
      live: !!r.live, sport: sportVonLiga(r.league), score: r.score || '',
      startTime: r.startTime || '',
      // comp/mid aus pushRow (v8.38.0): BF-COMP + PIN-Matchup-ID je Kandidat.
      // Die Pipe speichert beide in odds_history, damit Pruefung/Boost-Arb
      // sie per Suchleiste statt manuell bekommen (v8.38.2-Bug: Felder fehlten
      // hier, DB blieb trotz 8.38.2-Scanner leer).
      comp: r.comp || '', mid: r.mid || ''
    }));
    // Alle Spiele des letzten Scans (auch ohne Arb/Edge): je PIN-Matchup der
    // gescannten Ligen mit comp/mid, damit die Spielsuche z.B. HSV heute
    // findet und man mit Boost-Anbietern kombinieren kann (v8.39.0).
    const glist = (games || []).map(g => ({
      league: g.league, leagueName: g.leagueName || '', name: g.name || '',
      startTime: g.startTime || '', comp: g.comp || '', mid: g.mid || ''
    }));
    // Name-Candidates (v8.61.0): Near-Miss-Treffer der Name-Matching-
    // Sammlung (src/scan.js collectNameCand). Die App legt sie in der
    // name_candidates-Tabelle ab -> Name-Matching-Tab (bestaetigen/ablehnen).
    const nlist = (nameCands || []).map(c => ({
      pin: c.pin || '', pinTeam: c.pinTeam || '', bfTeam: c.bfTeam || '',
      bf: c.bf || '', score: c.score || 0, lid: c.lid || '',
      comp: c.comp || '', league: c.league || ''
    }));
    // Unmatched-Events (v8.62.0, Option A): BF-Events ohne PIN-Match und
    // ohne Near-Miss-Kandidat (Score < 0.5). Nur die BF-Namen + Kontext
    // (Liga/COMP) — der User sieht, WIE VIELE es sind und kann sie in der
    // App als "irrelevant" ausblenden. Kein PIN-Bezug moeglich (deshalb
    // hier KEIN Alias-Kandidat).
    const ulist = (unmatched || []).map(u => ({
      bf: u.bf || '', lid: u.lid || '', comp: u.comp || '', league: u.league || ''
    }));
    return { ts: new Date().toISOString(), comm: COMM,
      candidates: cands.sort((a, b) => b.edge - a.edge),
      games: glist, nameCandidates: nlist, unmatched: ulist };
  }

  // ---------- Schlanker Persistenz-Snapshot (localStorage) ----------
  // localStorage hat eine Quota (~5 MB pro Origin). Der volle Snapshot mit
  // games/nameCandidates/unmatched kann bei vielen Ligen mehrere MB gross
  // werden und die Quota sprengen (User-Befund 2026-09-04: QuotaExceededError
  // beim setItem von vbsb_csarb_snapshot brach den Auto-Scan ab, bevor dbSend
  // lief). Die Verify-Funktion liest NUR snap.candidates (src/ui.js verify) —
  // alles andere ist fuer die Pipe/App bestimmt. Deshalb wird fuer die
  // localStorage-Persistenz ein schlanker Snapshot abgeleitet: nur
  // ts/comm/candidates. Pure Funktion (Node-testbar, test/snapshot.test.js).
  function snapshotFuerStorage(snap) {
    const s = snap || {};
    return {
      ts: s.ts || '',
      comm: s.comm || 0,
      candidates: (s.candidates || []).map(c => ({
        league: c.league, leagueName: c.leagueName || '', name: c.name,
        kind: c.kind, back: c.back, src: c.src, lay: c.lay, vol: c.vol,
        edge: c.edge, marketId: c.marketId || '', live: !!c.live,
        sport: c.sport || '', score: c.score || '',
        startTime: c.startTime || '', comp: c.comp || '', mid: c.mid || ''
      })),
    };
  }
  // ---------- Helfer ----------


  function sportVonLiga(lid) {
    const n = String(LIGA_NAMEN[lid] || H2H_NAMEN[lid] || '').toLowerCase();
    if (/atp|wta|tennis|us open|grand slam|mixed doubles|australian open|french open|roland garros|wimbledon/.test(n)) return 'Tennis';
    if (/basketball|baloncesto|\bnbl\b|wnba|\bnba\b|\bpba\b|\bkbl\b|governors cup/.test(n)) return 'Basketball';
    if (/cricket|the hundred|one day|twenty20|\bt20\b|test match|test matches|t20i|ipl|\bcpl\b|caribbean premier|\bbbl\b|big bash|pakistan super league|\blpl\b|lanka premier|\bsa20\b|\bilt20\b|county championship|marsh cup/.test(n)) return 'Cricket';
    if (/esport|cs:go|counter[- ]?strike|league of legends|dota|valorant/.test(n)) return 'Esports';
    if (/baseball|\bmlb\b|\bnpb\b|\bkbo\b/.test(n)) return 'Baseball';
    if (/hockey|\bnhl\b|\bkhl\b/.test(n)) return 'Ice Hockey';
    if (/volleyball/.test(n)) return 'Volleyball';
    if (/handball/.test(n)) return 'Handball';
    if (/american football|\bnfl\b|\bncaa\b/.test(n)) return 'American Football';
    if (/rugby|\bnpc\b|\bnrl\b|super rugby|six nations|the championship|mitre|currie cup|top 14|united rugby|aviva premiership|^super league/.test(n)) return 'Rugby';
    if (/aussie rules|australian rules|\bafl\b|\bwafl\b/.test(n)) return 'Aussie Rules';
    if (/ufc|mma|mixed martial arts|boxing/.test(n)) return 'MMA';
    // H2H-Ligen ohne erkennbaren Sport-Marker (z.B. "International Friendlies",
    // "Nations League" — Rugby-Laenderspiele/-Turniere) duerfen NICHT auf den
    // Soccer-Fallback fallen: Soccer laeuft immer ueber die cs-Sektion (3-Wege),
    // die h2h-Sektion ist per Konvention 2-Wege (Boxen, Rugby, …).
    if (H2H_NAMEN[lid]) return 'Rugby';
    return 'Soccer';
  }

  function rawLbl(o) {
    const lb = o && o.raw && o.raw.label;
    const lname = lb && typeof lb === 'object' ? (lb.competition || lb.name || lb.text) : lb;
    return lname ? norm(String(lname)) : '';
  }


  // Liefert den Lay (Preis) für team aus mo3/mo3h-Zeile b.
  // Nur wenn GENAU EIN Runner-Name zur Seite passt, sonst null (uneindeutig -> Zeile verwerfen).
  function sideLay(team, b) {
    if (!team) return null;
    const hits = [];
    if (b.layHn && b.layH > 0 && teamMatch(team, b.layHn)) hits.push([b.layH, b.volH]);
    if (b.layAn && b.layA > 0 && teamMatch(team, b.layAn)) hits.push([b.layA, b.volA]);
    return hits.length === 1 ? { lay: hits[0][0], vol: hits[0][1] } : null;
  }

  // PIN-Preis-Map eines Markts: designation (desig) oder p+participantId -> Preis.
  // Gemeinsamer Baustein fuer alle PIN-Preis-Parser (ML/DNB/DC/AH-Uebernahme).
  const pinPrices = mk => {
    const px = {};
    for (const p of (mk && mk.prices) || []) {
      if (typeof p.price !== 'number') continue;
      const d = desig(p);
      if (d) px[d] = p.price;
      else px['p' + (p.participantId ?? p.id)] = p.price;
    }
    return px;
  };
  const womenMark = s => /(^|\s)(w|women|womens|ladies)(\s|$)/.test(norm(s));
  // Extrahiert O/U-Totals aus PIN-Straight (period 0, designation over/under).
  // type-Filter (nur 'total') ist PFLICHT: der straight-Pool enthaelt auch
  // team_total/spread/moneyline (period 0). Ohne Filter wuerde ouGoals
  // Team-Totals als Match-Totals matchen (falsche over/under -> Under-Rows
  // verschwinden, da cover.under mit Team-Total-Preisen belegt wird).
  const ouGoals = pr => {
    const out = [], ranges = [];
    const covered = new Set();
    for (const m of (pr || [])) {
      if (m.type !== 'total' || Number(m.period) !== 0) continue;
      const tp = {};
      let range = null;
      for (const p of (m.prices || [])) {
        const d = desig(p);
        if ((d === 'over' || d === 'under') && typeof p.price === 'number') tp[d] = p.price;
        if (p.points != null && typeof p.points === 'number' && !tp.line) tp.line = p.points;
        // "Totals Goals Range": offener Max-Bucket "N+" (z.B. 7+) entspricht dem
        // BF-Markt "Over (N-0.5)" (7+ <-> Over 6.5). Aus jedem reinen Range-Markt
        // (kein over/under-Designation) wird der groesste Bucket genommen. under=0,
        // da es keine einzelne Gegen-Quote gibt -> es entstehen nur O-Seiten-Rows.
        const rm = /^(\d+)\+$/.exec(d.replace(/^pinnacle\s+/, ''));
        if (rm && typeof p.price === 'number') {
          const n = Number(rm[1]);
          if (!range || n > range.topN) range = { topN: n, price: p.price };
        }
      }
      const over = toDecU(tp['over']), under = toDecU(tp['under']);
      if (over > 1.01 && under > 1.01 && typeof tp.line === 'number' && tp.line >= 0.5) {
        out.push({ line: tp.line, over, under });
        covered.add(tp.line);
      } else if (range && !tp['over'] && !tp['under']) {
        ranges.push({ line: range.topN - 0.5, over: toDecU(range.price) });
      }
    }
    // Range-Rows nur als Fallback fuer Linien, die nicht schon als Standard-O/U
    // vorliegen (Standard-Markt hat auch die Under-Seite -> bevorzugt).
    for (const r of ranges) {
      if (!covered.has(r.line) && r.over > 1.01)
        out.push({ line: r.line, over: r.over, under: 0, range: true });
    }
    return out;
  };
  // Extrahiert Team-Totals (Team X Over/Under 0.5–2.5) aus PIN-Straight
  // (type='team_total', period 0, designation over/under). Die Seite (home/
  // away) steckt im key-Feld ("s;0;tt;0.5;home"), Fallback m.team/m.side.
  // Nur Linien 0.5–2.5 — nicht alle Maerkte sind zu jedem Zeitpunkt da,
  // fehlende Linien werden einfach uebersprungen (defensiv).
  const ttSide = m => {
    const km = /^s;\d+;tt;[\d.]+;(home|away)$/i.exec(String(m.key || ''));
    if (km) return km[1].toLowerCase();
    const t = String(m.team || m.side || '').toLowerCase();
    return (t === 'home' || t === 'away') ? t : null;
  };
  const teamTotalsOf = pr => {
    const out = [];
    for (const m of (pr || [])) {
      if (m.type !== 'team_total' || Number(m.period) !== 0) continue;
      const side = ttSide(m);
      if (!side) continue;
      const tp = {};
      for (const p of (m.prices || [])) {
        const d = desig(p);
        if ((d === 'over' || d === 'under') && typeof p.price === 'number') tp[d] = p.price;
        if (p.points != null && typeof p.points === 'number' && !tp.line) tp.line = p.points;
      }
      const over = toDecU(tp['over']), under = toDecU(tp['under']);
      if (over > 1.01 && under > 1.01 && typeof tp.line === 'number' &&
        tp.line >= 0.5 && tp.line <= 2.5) {
        out.push({ team: side, line: tp.line, over, under });
      }
    }
    return out;
  };
  // Eckball-Linien (Corners) liegen real bei 8.5–12.5 (auch 7.5/13.5 moeglich).
  // Alles ausserhalb (z.B. 75.5er-Nicht-Corners-Totals) gehoert nicht in den
  // Corners-Kanal und wird als Nicht-Corners-Linie verworfen.
  const cornerLine = l => {
    const L = Math.abs(Number(l));
    return Number.isFinite(L) && L >= 6.5 && L <= 13.5;
  };

  // Extrahiert "Total Goals Odd/Even" (und generell 2-Wege-Odd/Even-Maerkte)
  // aus PIN-Straight (period 0, designation odd/even bzw. yes/no).
  // Liefert { odd, even } oder null.
  const pinOdd = pr => {
    for (const m of (pr || [])) {
      if (Number(m.period) !== 0) continue;
      const tp = {};
      for (const p of (m.prices || [])) {
        const d = desig(p);
        if ((d === 'odd' || d === 'yes') && typeof p.price === 'number') tp.odd = p.price;
        else if ((d === 'even' || d === 'no') && typeof p.price === 'number') tp.even = p.price;
      }
      const odd = toDecU(tp['odd']), even = toDecU(tp['even']);
      if (odd > 1.01 && even > 1.01) return { odd, even };
    }
    return null;
  };
  // Gemeinsames O/U-Row-Generieren (CS- und H2H-Pfad verwenden dieselbe Funktion).
  // b: { name, line, over: {lay,vol,back,volB}, under: {lay,vol,back,volB}, marketId, live }
  function emitOUEs(lid, log, rows, lgName, h, b, cover) {
    const code = String(Math.round(b.line * 10)).padStart(2, '0');
    let n = 0;
    if (cover.crossOnly) {
      // Nur Cross-Leg (PIN-Back + BF-Back), kein Lay-Leg: Exact Total Goals=0
      // als Under-0.5-Quelle (der Lay-Vergleich "0 vs BF Under 0.5" laeuft ueber
      // den cs00-Kanal, hier nur der Back-Back-Cross ueber 0.5).
      if (cover.under > 1.01 && b.over && b.over.back > 1.01 && b.over.back !== 0 &&
        crossBackEdge(cover.under, bfEffQ(b.over.back)) > 0) {
        n++;
        pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
          live: h.live || b.live, kind: 'ouBB' + code + 'U', back: cover.under,
          src: 'PIN Exact 0 + BF O ' + b.line, lay: b.over.back,
          vol: b.over.volB || b.over.vol });
      }
      return n;
    }
    // v8.62.12 (Boost-Quote-Carrier): O/U-Single-Rows (ou..O/ou..U) auch
    // OHNE Arb-Richtung speichern — der Boost-Solver braucht die O/U-Quoten
    // fuer den DB-Schnellpfad („Tore Over/Under X"-Legs, auch in Combos),
    // analog CS v8.60.34 / Tennis v8.62.11. Die BB-Crosslegs (ouBB..)
    // bleiben unten arb-gegatet.
    if (cover.over > 1.01 && b.over && b.over.lay > 1.01 && b.over.lay < 1000) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'ou' + code + 'O', back: cover.over,
        src: 'PIN Over ' + b.line, lay: b.over.lay, vol: b.over.vol,
        xback: (b.under && b.under.back > 1.01 && b.under.back !== 0)
          ? b.under.back : 0 });
    }
    if (cover.under > 1.01 && b.under && b.under.lay > 1.01 && b.under.lay < 1000) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'ou' + code + 'U', back: cover.under,
        src: 'PIN Under ' + b.line, lay: b.under.lay, vol: b.under.vol,
        xback: (b.over && b.over.back > 1.01 && b.over.back !== 0)
          ? b.over.back : 0 });
    }
    // BB-Gate: nur emittieren, wenn der Cross eine positive Marge hat
    // (crossBackEdge > 0), sonst landen sichere Verlust-Kandidaten in der DB.
    if (cover.under > 1.01 && b.over && b.over.back > 1.01 && b.over.back !== 0 &&
      crossBackEdge(cover.under, bfEffQ(b.over.back)) > 0) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'ouBB' + code + 'U', back: cover.under,
        src: 'PIN U + BF O ' + b.line, lay: b.over.back, vol: b.over.volB || b.over.vol });
    }
    if (cover.over > 1.01 && b.under && b.under.back > 1.01 && b.under.back !== 0 &&
      crossBackEdge(cover.over, bfEffQ(b.under.back)) > 0) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'ouBB' + code + 'O', back: cover.over,
        src: 'PIN O + BF U ' + b.line, lay: b.under.back, vol: b.under.volB || b.under.vol });
    }
    return n;
  }

  // Team-Totals (Soccer): PIN team_total (0.5–2.5 je Heim/Auswaerts) vs BF
  // "Team X Over/Under Y Goals" — Back-Lay + Back-Back-Crosslegs, analog
  // emitOUEs. Kinds: tt{line}{H|A}{O|U} (BL), ttBB{line}{H|A}{O|U} (BB).
  // b: { name, team, line, over:{lay,vol,back,volB}, under:{...}, marketId, live }
  function emitTeamTotalEs(lid, log, rows, lgName, h, b, cover, sideChar) {
    const code = String(Math.round(b.line * 10)).padStart(2, '0');
    const suf = sideChar + '';
    let n = 0;
    if (cover.over > 1.01 && b.over && arbDir(cover.over, b.over.lay)) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'tt' + code + suf + 'O', back: cover.over,
        src: 'PIN Team ' + sideChar + ' Over ' + b.line, lay: b.over.lay, vol: b.over.vol,
        xback: (b.under && b.under.back > 1.01 && b.under.back !== 0)
          ? b.under.back : 0 });
    }
    if (cover.under > 1.01 && b.under && arbDir(cover.under, b.under.lay)) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'tt' + code + suf + 'U', back: cover.under,
        src: 'PIN Team ' + sideChar + ' Under ' + b.line, lay: b.under.lay, vol: b.under.vol,
        xback: (b.over && b.over.back > 1.01 && b.over.back !== 0)
          ? b.over.back : 0 });
    }
    // BB-Gate: nur emittieren, wenn der Cross eine positive Marge hat.
    if (cover.under > 1.01 && b.over && b.over.back > 1.01 && b.over.back !== 0 &&
      crossBackEdge(cover.under, bfEffQ(b.over.back)) > 0) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'ttBB' + code + suf + 'U', back: cover.under,
        src: 'PIN U + BF O ' + b.line, lay: b.over.back, vol: b.over.volB || b.over.vol });
    }
    if (cover.over > 1.01 && b.under && b.under.back > 1.01 && b.under.back !== 0 &&
      crossBackEdge(cover.over, bfEffQ(b.under.back)) > 0) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'ttBB' + code + suf + 'O', back: cover.over,
        src: 'PIN O + BF U ' + b.line, lay: b.under.back, vol: b.under.volB || b.under.vol });
    }
    return n;
  }

  // Odd/Even-"Total Goals" (PIN odd/even vs BF Odd/Even): identische Logik wie
  // emitOUEs, nur 2-Weg. b: { name, odd: {lay,vol,back,volB}, even: {...}, marketId, live }
  function emitOEs(lid, log, rows, lgName, h, b, oe) {
    let n = 0;
    if (oe.odd > 1.01 && b.odd && arbDir(oe.odd, b.odd.lay)) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'oeY', back: oe.odd,
        src: 'PIN Odd', lay: b.odd.lay, vol: b.odd.vol,
        xback: (b.even && b.even.back > 1.01 && b.even.back !== 0)
          ? b.even.back : 0 });
    }
    if (oe.even > 1.01 && b.even && arbDir(oe.even, b.even.lay)) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'oeN', back: oe.even,
        src: 'PIN Even', lay: b.even.lay, vol: b.even.vol,
        xback: (b.odd && b.odd.back > 1.01 && b.odd.back !== 0)
          ? b.odd.back : 0 });
    }
    if (oe.odd > 1.01 && b.even && b.even.back > 1.01 && b.even.back !== 0 &&
      crossBackEdge(oe.odd, bfEffQ(b.even.back)) > 0) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'oeBBN', back: oe.odd,
        src: 'PIN Odd + BF Even (Back)', lay: b.even.back,
        vol: b.even.volB || b.even.vol });
    }
    if (oe.even > 1.01 && b.odd && b.odd.back > 1.01 && b.odd.back !== 0 &&
      crossBackEdge(oe.even, bfEffQ(b.odd.back)) > 0) {
      n++;
      pushRow(rows, lid, { lg: lgName, name: b.name, hit: h, b,
        live: h.live || b.live, kind: 'oeBBY', back: oe.even,
        src: 'PIN Even + BF Odd (Back)', lay: b.odd.back,
        vol: b.odd.volB || b.odd.vol });
    }
    return n;
  }

  const missedDirArbs = [];
  const trackMissed = (kind, back, lay, scroll, name) => {
    if (back > 1.01 && lay > 0 && lay < back && scroll >= PRICE_MATCH_THRESHOLD) {
      missedDirArbs.push({ kind, name, back, lay, score: scroll });
    }
  };

  // Versucht den Back-Lay-Match. Rueckgabe { ok, dir, score }.
  // - Richtung falsch (Lay >= Back): ok=false, dir=false → keine Marge, still skip.
  // - Richtung ok, aber Identitaet verletzt (Score >= Schwelle):
  //   ok=false, dir=true + trackMissed + 'kein Preismatch'-Log.
  // - Alles ok: ok=true.
  const tryBL = (kind, label, back, lay, name, log) => {
    if (!(back > 1.01 && lay > 0 && lay < back)) return { ok: false, dir: false, score: null };
    const score = price(back, lay);
    if (score >= PRICE_MATCH_THRESHOLD) {
      trackMissed(kind, back, lay, score, name);
      log('  ' + label + ': kein Preismatch (Score ' + score.toFixed(3) +
        ', PIN ' + back.toFixed(2) + ' / BF ' + lay.toFixed(2) + ')');
      return { ok: false, dir: true, score };
    }
    return { ok: true, dir: true, score };
  };

  // Einheitlicher Kandidaten-Emitter (CS- und H2H-Zeilen identisch).
  const pushRow = (rows, lid, o) => {
    const h = o.hit || null;
    // Heim/Auswaerts aus der PIN-Teilnehmer-Reihenfolge (home zuerst) statt
    // aus dem BF-Eventnamen: BF listet z.B. bei WNBA/Basketball das
    // Auswaertsteam zuerst ("Las Vegas Aces v Toronto Tempo" = Aces ist
    // Auswaerts, v8.14.14). Nur bei gematchtem PIN-Hit mit 2 Teams.
    let name = o.name;
    if (h && Array.isArray(h.teams) && h.teams.length >= 2 &&
        h.teams[0] && h.teams[1]) {
      name = h.teams[0] + ' v ' + h.teams[1];
    }
    rows.push({
      league: lid, leagueName: o.lg || LIGA_NAMEN[lid] || H2H_NAMEN[lid] || '',
      name, kind: o.kind, back: o.back || 0, src: o.src || '',
      lay: o.lay || 0, vol: o.vol || 0,
      // xback (v8.62.23): BF-Back des Komplement-Ausgangs desselben
      // BF-Markts — die Back-Back-Cross-Gegenwette fuer den Boost-Arb
      // („Back ¬M @ Betfair"). Nur fuer 2-Weg-Maerkte gesetzt; 0 sonst.
      xback: o.xback || 0,
      marketId: o.mkId || (o.b && o.b.marketId) || '',
      // comp = BF-COMP aus dem Liga-Mapping (LEAGUES/H2H im IIFE-Scope),
      // mid = PIN-Matchup-ID des Spiels (h.id). Die Pipe speichert beide,
      // damit Pruefung/Boost-Arb sie per Suchleiste statt manuell bekommen.
      comp: o.comp || LEAGUES[lid] || H2H[lid] || '',
      mid: (h && h.id) || o.mid || '',
      hit: h,
      live: o.live !== undefined ? !!o.live : !!((h && h.live) || (o.b && o.b.live)),
      startTime: (h && h.st) || '', score: (h && h.score) || ''
    });
  };


  // ---------- BF-Helper (Markt-Name/Chunks/Traversal) ----------
  // Marktname einer bynode-/bymarket-Knotens (marketInfo oder description).
  const bfMktName = n => (n.marketInfo && n.marketInfo.marketName) ||
    (n.description && n.description.marketName) || '';
  // MARKET-Knoten in 20er-ID-Chunks aufteilen (bymarket limitiert die ID-Menge).
  const bfChunkIds = nodes => {
    const out = [];
    for (let i = 0; i < nodes.length; i += 20)
      out.push(nodes.slice(i, i + 20).map(c => c.nodeId.split(':')[1]).join(','));
    return out;
  };
  // Chunks abrufen (Pool 3), Fehler still schlucken — liefert nur valide Bloecke.
  async function bfFetchChunks(chunks) {
    const bms = [];
    await pool(chunks, async chunk => {
      const bm = await bfByMarket(chunk).catch(() => null);
      if (bm) bms.push(bm);
    }, 3);
    return bms;
  }
  // Traversal ueber alle bymarket-Bloecke: eventTypes -> eventNodes -> marketNodes.
  function bfEachMarket(bms, fn) {
    (bms || []).forEach(bm => ((bm && bm.eventTypes) || []).forEach(et =>
      (et.eventNodes || []).forEach(e => (e.marketNodes || []).forEach(mk =>
        fn(mk, e, et, bm)))));
  }
  // Liga-Maerkte einer COMP zentral abrufen (bynode: EVENT+MARKET, Distanz 6).
  // Einziger Ort fuer die (comp) -> nodes/edges-Auswahl; alle Scans/Probes
  // nutzen denselben Pfad statt je eigener bfBynodeAuto-Aufrufe.
  async function bfLeagueMarkets(comp) {
    return bfBynodeAuto(comp, 'EVENT,MARKET', 6).catch(() => null);
  }
  // Marktdaten nur von offenen Maerkten verarbeiten (kein SUSPENDED/CLOSED).
  // Gemeinsamer Zustands-Check fuer alle Markt-Lesepfade (bfLays + bfH2H).
  const bfOpen = mk => {
    const st = ((mk.state || {}).status || "").toUpperCase();
    return !st || st === "OPEN";
  };
  // Event-Namen der MARKET-Knoten einer bynode-Antwort aufloesen
  // (parent-Kette bis zum EVENT-Knoten). Liefert {marketId -> eventName}.
  function bfEventNames(j, markets) {
    const parent = {};
    (j.edges || []).forEach(e => { parent[e.to] = e.from; });
    const byId = Object.fromEntries((j.nodes || []).map(n => [n.nodeId, n]));
    const evName = {};
    (markets || []).forEach(m => {
      let c = m.nodeId;
      while (c && byId[c] && byId[c].nodeType !== 'EVENT') c = parent[c];
      if (c && byId[c]) evName[m.nodeId.split(':')[1]] = byId[c].name;
    });
    return evName;
  }

  async function bfSearch(kw, tries) {
    const attempts = tries || 0;
    let r;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
      r = await fetch('https://scan-inbf.betfair.com/www/sports/navigation/facet/v1/search?' +
        bfQ({}), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            filter: { marketBettingTypes: [], productTypes: ['EXCHANGE'], marketTypeCodes: [],
              selectBy: 'RANK', maxResults: 50 },
            textQuery: { query: kw, facetsToSearch: ['COMPETITION'] }, facets: []
          }),
          signal: ac.signal
        });
      clearTimeout(timer);
    } catch (e) {
      if (e.name === 'AbortError') { return []; }
      if (attempts < 3) { await sleep(backoff(800, attempts)); return bfSearch(kw, attempts + 1); }
      return [];
    }
    if (r.status === 429 || r.status >= 500) {
      if (attempts < 3) { await sleep(backoff(1200, attempts)); return bfSearch(kw, attempts + 1); }
      return [];
    }
    if ((r.status === 400 || r.status === 403) && attempts < 3) {
      // _ak rotiert: warten, bis der Proxy den frischen Token uebernimmt, dann neu bauen.
      await sleep(backoff(1200, attempts));
      return bfSearch(kw, attempts + 1);
    }
    if (!r.ok) return [];
    let out = [];
    try {
      const j = await r.json();
      for (const f of (j.facets || [])) for (const v of (f.values || [])) {
        const key = v.key || {};
        const cid = key.competitionId;
        const sid = Number(key.sportId);
        if (cid && !out.some(o => o.cid === cid)) {
          out.push({ cid: cid, sportId: Number.isFinite(sid) ? sid : undefined, raw: v });
        }
      }
    } catch (e) { out = []; }
    return out;
  }

  // Pinnacle-Sport-ID -> Betfair-EventType-ID (Suche liefert Wettbewerbe ALLER
  // Sportarten; ohne Filter landen Fremd-Sport-Treffer im Ergebnis)
  const BF_SID = { 29: 1, 33: 2, 3: 7511, 4: 7522, 8: 4, 18: 468328, 34: 998917,
    19: 7524, 15: 6423, 39: 61420, 22: 26420387, 6: 6, 12: 27454571, 27: 5, 26: 1477 };
  // Achtung (reale Betfair-EventType-IDs, per Recherche + Live-Suche verifiziert):
  //   8  (Cricket)        -> 4    (nicht 9/Motor Sport)
  //   3  (Baseball)       -> 7511 (COMP:11196870 MLB; nicht 4)
  //   4  (Basketball)     -> 7522 (alt faelschlich 5 = Rugby Union)
  //   18 (Handball)       -> 468328 (alt faelschlich 19 = Ice Hockey)
  //   34 (Volleyball)     -> 998917 (alt faelschlich 35 = nie verifiziert)
  //   19 (Ice Hockey)     -> 7524, 15 (Am. Football) -> 6423
  //   39 (Aussie Rules)   -> 61420, 22 (MMA) -> 26420387, 6 (Boxing) -> 6
  //   12 (Esports)        -> 27454571 (kein Arb-Wert, aber sauber mappbar)
  // Falsche IDs liessen den Sport-Guard in scoreCands alle Kandidaten verwerfen
  // (name-Miss mit leerem Sample), der Nav-Baum zeigte auf den falschen Sport.
  const BF_SIDS = new Set(Object.values(BF_SID));

  async function bfNode(cid, tries) {
    const attempts = tries || 0;
    let j = null;
    try {
      // maxInDistance=5: SPORT-Knoten liegt OBEN (Elternkette COMP->MENU->EVENT_TYPE->SPORT)
      // und wird ohne maxInDistance nie geliefert -> Sport-Guard bliebe blind.
      // attachments=NUR MENU (SPORT/EVENT_TYPE sind dort nicht erlaubt -> HTTP 400).
      j = await bfBynode('COMP:' + cid, 'MENU', 2, 50, 5);
    } catch (e) {
      try { j = await bfBynode('COMP:' + cid, 'MENU', 1, 50); } catch (e2) { j = null; }
    }
    if (!j && attempts < 3) {
      await sleep(backoff(500, attempts));
      return bfNode(cid, attempts + 1);
    }
    return j;
  }

  // Gemeinsamer Nav-Baum-Sammel-Pfad: COMPs des Landes aus dem BF-Nav-Baum
  // laden (Gruppen, deren Name das Land/Adjektiv enthaelt, z.B. "france" ->
  // "French Super Cup"). Wird von searchComps (Textsuche leer) UND vom
  // Zweipass in proposeComp (Suchtreffer, aber kein Namens-Match) benutzt —
  // eine Quelle fuer die likeParts-Logik statt zwei parallel gewachsenen.
  async function navCompsFor(bfSid, country, root) {
    if (bfSid === undefined) return [];
    const c = norm(country);
    const cc = root || c;
    try { return await bfNavComps(bfSid, [cc, c]); } catch (e) { return []; }
  }

  async function searchComps(parts, full, bfSid) {
    // Slash-Normalisierung: BF-Suchindex kennt kein "/" (z.B. PIN
    // "K3/K4 Championship" -> Suche "K3 K4 Championship", norm() wuerde das
    // ohnehin tun, aber searchComps sieht den Rohstring).
    const sq = s => String(s || '').replace(/\//g, ' ');
    const p0 = sq(parts[0]), p1 = sq(parts[1]), full2 = sq(full);
    const queries = [];
    if (p1) {
      if (p0 && p0.length > 3 && p1 !== p0) queries.push(p0 + ' ' + p1);
      if (full2 !== queries[0]) queries.push(full2);
      if (p0 && p0.length > 3 && p1 !== p0 && p0 !== queries[0])
        queries.push(p0);
      if (p1 !== queries[0] && !queries.includes(p1)) queries.push(p1);
    } else {
      queries.push(full2);
    }
    const out = [];
    const ress = await Promise.all(queries.map((q, i) =>
      sleep(60 * (i + 1)).then(() => bfSearch(clean(q)).catch(() => []))));
    for (let k = 0; k < queries.length && out.length < 14; k++) {
      for (const o of ress[k].slice(0, 8)) if (!out.some(x => x.cid === o.cid)) out.push(o);
    }
    if (!out.length) {
      let kw = clean(p1 || full2);
      const wl = String(kw).split(' ');
      while (wl.length > 1 && out.length < 14) {
        wl.pop();
        kw = wl.join(' ');
        if (String(kw).length < 3) break;
        await sleep(120);
        const res = await bfSearch(kw).catch(() => []);
        for (const o of res.slice(0, 8)) if (!out.some(x => x.cid === o.cid)) out.push(o);
      }
      // Wettbewerbs-Synonyme: BF benennt Pokale landessprachlich ("Coppa
      // Italia"), PIN englisch ("Italy - Cup"). Wenn "italy cup" nichts findet,
      // zusaetzlich "italy coppa"/"italy copa"/... probieren.
      const p1w = clean(p1).toLowerCase();
      const isCupLike = Object.values(COMP_SYN).includes(p1w);
      if (p0 && p1 && isCupLike) {
        for (const [syn, v] of Object.entries(COMP_SYN)) {
          if (v !== p1w || out.length >= 14) continue;
          await sleep(120);
          const res = await bfSearch(clean(p0 + ' ' + syn)).catch(() => []);
          for (const o of res.slice(0, 8)) if (!out.some(x => x.cid === o.cid)) out.push(o);
        }
      }
      // Freundschaftsspiele: BF nennt "Club/International Matches", PIN
      // "Club/International Friendlies" -> zusaetzlich "... matches" suchen.
      const p1Stem = p1w.replace(/^.*\s/, '');
      const mSyn = MATCH_SYN[p1Stem];
      if (p1 && mSyn) {
        const p1Syn = p1w.replace(/\s*\S+\s*$/, ' ') + mSyn;
        const friendQueries = [p1Syn];
        if (p0 && p0 !== p1) friendQueries.push(p0 + ' ' + p1Syn);
        for (const fq of friendQueries) {
          if (out.length >= 14) break;
          await sleep(120);
          const res = await bfSearch(clean(fq)).catch(() => []);
          for (const o of res.slice(0, 8)) if (!out.some(x => x.cid === o.cid)) out.push(o);
        }
      }
      // Acronym-Fallback (z.B. "Aussie Rules Football (AFL)" -> "afl")
      const acroQueries = [...new Set(String(parts[1] || full).split(/[^A-Za-z0-9]+/)
        .filter(t => /^[A-Z]{2,5}$/.test(t)).map(t => t.toLowerCase()))];
      for (const a of acroQueries) {
        if (out.length >= 14) break;
        await sleep(120);
        const res = await bfSearch(a).catch(() => []);
        for (const o of res.slice(0, 8)) if (!out.some(x => x.cid === o.cid)) out.push(o);
      }
    }
    if (!out.length && bfSid !== undefined && parts[0]) {
      // Textsuche ohne Treffer (z.B. "South Africa - PSL" steht im BF-Suchindex
      // nicht als "South African Premier Division"): COMPs per Nav-Baum sammeln.
      const country = parts[0].toLowerCase().trim();
      const nav = await navCompsFor(bfSid, country, countryRoot(country) || '');
      for (const o of nav) if (!out.some(x => x.cid === o.cid)) out.push(o);
    }
    return out;
  }

  // ---------- PIN-Sniff-Proxy (dauerhaft, @run-at document-start) ----------
  // Pinnacle main.js friert window.fetch/XMLHttpRequest beim Laden ein. Damit der
  // Schnueffler die Requests der Seite wirklich sieht, wird der Proxy HIER (vor der
  // Seite) installiert. __pinsniff(true/false) setzt nur das Scharf-Flag __pinSniffOn.
  const __pinSniffOn = { v: false };
  const __pinSniffHits = [];
  const __pinSniffLog = [];
  const __pinShuffleReport = new Set();
  const __pinKeyRe = /"key":"s;[0-9;]+(ou|tt|s);[^"]*"/g;
  const __pinAltRe = /"isAlternate":(true|false)/g;
  const __pinSniffLimit = 2 * 1024 * 1024;
  const __pinSay = (m) => { __pinSniffLog.push(m); const s = window.__pinSink; if (s) s(m); console.log(m); };
  const __pinSniffReport = (url, txt) => {
    const keys = [...new Set((txt.match(__pinKeyRe) || []).map(x => x.slice(7, -1)))];
    const alt = (txt.match(__pinAltRe) || []).filter(x => x.indexOf('true') > 0).length;
    const found = keys.find(k => k.indexOf(';ou;') !== -1 || /;o[uv];\d/.test(k));
    if (!keys.length && !found) return;   // ohne s;. ou.-Keys ist es fuer Games-Debug irrelevant
    __pinSniffHits.push({ url, keys, alt });
    if (__pinSniffHits.length > 40) __pinSniffHits.shift();
    const ident = url + '#' + (keys.join() || 'alt');
    if (__pinShuffleReport.has(ident)) return;
    __pinShuffleReport.add(ident);
    __pinSay('[PIN-Sniff] ' + url + '  ->  otw_keys=' + keys.length + ' alt=' + alt);
    if (keys.length) __pinSay('   keys: ' + keys.join(' | '));
    if (alt) __pinSay('   isAlternate=true an ' + alt + ' Knoten');
    if (__pinShuffleReport.size > 200) __pinShuffleReport.clear();
  };
  const __pinNeedle = txt => txt && txt.indexOf('"key":"s;') !== -1;
  const __pinTell = (kind, url, desc) => {
    if (!__pinSniffOn.v) return;
    __pinSay('[PIN-Stream] ' + kind + ' ' + url + ' (' + desc + ')');
  };
  // fetch-Proxy (auf dem Stats-Wrapper oben aufsetzen)
  {
    const _f = window.fetch;
    window.fetch = async function (input, init) {
      const url = String(input && typeof input === 'object' ? input.url : input);
      if (!(init && init.__bf)) __akSniff(url);
      const resp = await _f.apply(this, arguments);
      if (url.indexOf('arcadia') === -1 || !__pinSniffOn.v) return resp;
      try {
        const len = resp.headers ? Number(resp.headers.get('content-length') || 0) : 0;
        if (len > __pinSniffLimit) { __pinTell('fetch', url, 'zu gross (' + len + ')'); return resp; }
        const txt = await resp.clone().text();
        if (!txt.length) { __pinTell('fetch', url, 'leer'); return resp; }
        __pinTell('fetch', url, txt.length + ' B');
        if (__pinNeedle(txt)) __pinSniffReport(url, txt);
      } catch (e) { /* ignorieren */ }
      return resp;
    };
  }
  // XMLHttpRequest-Proxy (die Seite instanziiert via new XMLHttpRequest)
  if (window.XMLHttpRequest) {
    const _X = window.XMLHttpRequest;
    const ProxyXHR = function () {
      const x = new _X();
      try {
        const _open = x.open;
        x.__pinUrl = '';
        x.open = function (m, u) {
          x.__pinUrl = String(u);
          __akSniff(x.__pinUrl);
          return _open.apply(this, arguments);
        };
        if (__pinSniffOn.v) {
          x.addEventListener('load', () => {
            const u = x.__pinUrl || '';
            if (u.indexOf('arcadia') === -1) return;
            try {
              const txt = String(x.responseText || '');
              if (!txt.length) { __pinTell('xhr', u, 'leer'); return; }
              __pinTell('xhr', u, txt.length + ' B');
              if (__pinNeedle(txt)) __pinSniffReport(u, txt);
            } catch (e) { /* ignorieren */ }
          });
        }
      } catch (e) { /* ignorieren */ }
      return x;
    };
    ProxyXHR.prototype = _X.prototype;
    ProxyXHR.prototype.open = _X.prototype.open;
    ProxyXHR.prototype.send = _X.prototype.send;
    window.XMLHttpRequest = ProxyXHR;
  }
  // WebSocket-Proxy: Pinnacle streamt Live-Odds manchmal per WS statt fetch/XHR.
  if (window.WebSocket) {
    const _WS = window.WebSocket;
    const ProxyWS = function (url, protos) {
      const SUrl = String(url);
      if (__pinSniffOn.v && /arcadia|pinnacle/.test(SUrl)) __pinTell('ws', SUrl, 'verbinden');
      return new _WS(SUrl, protos);
    };
    ProxyWS.prototype = _WS.prototype;
    window.WebSocket = ProxyWS;
  }
  window.__pinSniffOn = __pinSniffOn;
  window.__pinSniffHits = __pinSniffHits;

  // ---------- Betfair: Navigation-Fallback (COMPs per Nav-Baum) ----------
  const bfNavCache = new Map();        // bfSid -> {groups:[{id,name}]} (Session)
  async function bfNavGroups(bfSid) {
    const c = bfNavCache.get(bfSid);
    if (c) return c.groups;
    // Wurzel-Knoten: "EVENT_TYPE:<sportId>" (z.B. EVENT_TYPE:1 = Soccer).
    // attachments akzeptiert nur MENU/EVENT/MARKET (SPORT -> HTTP 400).
    let root = null;
    for (const id of ['EVENT_TYPE:' + bfSid, 'SPORT:' + bfSid]) {
      root = await bfBynode(id, 'MENU', 1, 500).catch(() => null);
      if (root) break;
    }
    const groups = ((root && root.nodes) || [])
      .filter(n => n.name && (String(n.nodeType) === 'MENU' || String(n.nodeType) === 'GROUP' ||
        String(n.nodeType) === 'COMPETITION' ||
        /^(MENU|GROUP|COMP):/.test(String(n.nodeId || n.id))))
      .map(n => ({ id: String(n.nodeId || n.id), name: norm(n.name) }));
    bfNavCache.set(bfSid, { groups });
    return groups;
  }

  // Sammelt alle COMPs der Gruppen, deren Name einen der likeParts enthaelt
  // (z.B. "South Africa - PSL" -> Gruppe "south africa" -> "South African Premier Division").
  async function bfNavComps(bfSid, likeParts) {
    const groups = await bfNavGroups(bfSid);
    const targets = groups.filter(g => likeParts.some(p => rootHit(g.name, p)));
    const out = [];
    for (const g of targets.slice(0, 4)) {
      await sleep(60);
      const sub = await bfBynode(g.id, 'MENU,EVENT', 2, 800).catch(() => null);
      for (const n of ((sub && sub.nodes) || [])) {
        const cid = String(n.nodeId || n.id || '');
        if (/^COMP:/.test(cid) && n.name) {
          const cidNum = Number(cid.slice(5));
          if (Number.isFinite(cidNum) && !out.some(o => o.cid === cidNum))
            out.push({ cid: cidNum, sportId: bfSid, raw: { label: n.name } });
        }
      }
    }
    return out;
  }
  // ---------- UI ----------
  const state = { rows: [], games: [], props: [], busy: false, auto: false, timer: null, lastArbs: 0 };
  // lastActive: Deklaration in discovery.js (autoTourLid/h2hRoundSiblings +
  // discovery bauen es; hier wird es nur gelesen/restauriert).

  function beep() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx = new Ctx();
      const play = f => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.type = 'square'; o.frequency.value = f; g.gain.value = 0.12;
        o.start(); o.stop(ctx.currentTime + 0.12);
      };
      play(880); setTimeout(play, 180, 1175);
      setTimeout(() => ctx.close(), 600);
    } catch (e) { /* kein Audio */ }
  }

  try {
    const la = JSON.parse(localStorage.getItem('vbsb_csarb_lastactive') || 'null');
    if (Array.isArray(la) && la.length) lastActive = la;
  } catch (e) { /* ignorieren */ }

  let leagueMapLoaded = false;
  let leagueMapResolve = null;
  const leagueMapReady = new Promise(r => { leagueMapResolve = r; });

  // v8.65.0: Gemeinsamer Merge fuer den Erst-Load (loadLeagueMap) und das
  // Live-Refresh pro Scan-Zyklus (refreshLeagueMap). Uebernimmt die Pipe-
  // Mappings in LEAGUES/H2H (add/update, NIE entfernen — In-Memory-Eintraege
  // wie autoTourLid-Remaps oder das Hardcoded-Fallback bleiben erhalten),
  // Namen und pipeDenies. Rueckgabe: Anzahl der CS+H2H-Eintraege im Payload.
  const applyLeagueMapPayload = (d) => {
    let n = 0;
    if (d.mapping.cs) {
      for (const [pid, info] of Object.entries(d.mapping.cs)) {
        LEAGUES[pid] = info.comp;
        if (info.name) LIGA_NAMEN[pid] = info.name;
        n++;
      }
    }
    if (d.mapping.h2h) {
      for (const [pid, info] of Object.entries(d.mapping.h2h)) {
        H2H[pid] = info.comp;
        if (info.name) H2H_NAMEN[pid] = info.name;
        n++;
      }
    }
    // Discovery-Denies (v8.44.3): Single Source of Truth ist
    // deny_mapping.json; die Pipe liefert sie im /league-map-Payload
    // mit. pipeDenies (discovery.js) ersetzt die alten hartcodierten
    // STATIC_DENY/Seeds — eine Dateiaenderung wirkt beim naechsten
    // Mapping-Load ohne Userscript-Build.
    if (d.denies) {
      pipeDenies = {};
      for (const [key, info] of Object.entries(d.denies)) {
        if (info && info.reason)
          pipeDenies[key] = { reason: String(info.reason),
            kind: info.kind === 'never' ? 'never' : 'wrong-comp' };
      }
    }
    return n;
  };

  const loadLeagueMap = (retries) => {
    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url: PIPE + '/league-map',
        timeout: 5000,
        onload(resp) {
          if (resp.status === 200) {
            const d = JSON.parse(resp.responseText);
            if (d.ok && d.mapping) {
              const n = applyLeagueMapPayload(d);
              leagueMapLoaded = true;
              if (leagueMapResolve) { leagueMapResolve(); leagueMapResolve = null; }
              console.log('[VBSB] League-Mapping geladen: ' + n + ' Eintraege (CS+H2H)');
              pruneProps(true);
            }
          }
        },
        onerror() {
          if (retries > 0) {
            console.log('[VBSB] League-Mapping fehlgeschlagen, Retry in 2s ...');
            setTimeout(() => loadLeagueMap(retries - 1), 2000);
          } else {
            console.log('[VBSB] League-Mapping nicht erreichbar — Hardcoded-Ligen werden verwendet');
            if (leagueMapResolve) { leagueMapResolve(); leagueMapResolve = null; }
          }
        },
        ontimeout() {
          if (retries > 0) {
            console.log('[VBSB] League-Mapping Timeout, Retry in 2s ...');
            setTimeout(() => loadLeagueMap(retries - 1), 2000);
          } else {
            console.log('[VBSB] League-Mapping Timeout — Hardcoded-Ligen werden verwendet');
            if (leagueMapResolve) { leagueMapResolve(); leagueMapResolve = null; }
          }
        },
      });
    } catch (e) { /* ignorieren */ }
  };

  // v8.65.0: Live-Refresh des Mappings vor jedem Scan-Zyklus. In der App
  // uebernommene Discovery-Vorschlaege (Einstellungen -> Discovery) wirken
  // damit OHNE Browser-/Scanner-Neustart ab dem naechsten Zyklus — der
  // Browser bleibt im Hintergrund. Merge-only (add/update), kurzer Timeout;
  // bei Fehler/Timeout laeuft der Scan mit der bestehenden Map weiter.
  const refreshLeagueMap = () => new Promise((resolve) => {
    try {
      GM_xmlhttpRequest({
        method: 'GET',
        url: PIPE + '/league-map',
        timeout: 4000,
        onload(resp) {
          try {
            if (resp.status === 200) {
              const d = JSON.parse(resp.responseText);
              if (d.ok && d.mapping) {
                const before = Object.keys(LEAGUES).length + Object.keys(H2H).length;
                const n = applyLeagueMapPayload(d);
                if (n > before) {
                  pruneProps(true);
                  // Hinweis ins Panel (window.__ahLog = log aus buildPanel)
                  // bzw. Konsole, wenn das Panel noch nicht gebaut ist.
                  const meldung = 'Mapping live aktualisiert (+' +
                    (n - before) + ' Ligen aus der App).';
                  console.log('[VBSB] ' + meldung);
                  try {
                    if (typeof window !== 'undefined' && window.__ahLog)
                      window.__ahLog(meldung);
                  } catch (e) { /* Panel-Log nicht verfuegbar */ }
                }
                console.log('[VBSB] League-Mapping live aktualisiert (' + n + ' Eintraege).');
                return resolve(true);
              }
            }
          } catch (e) { /* parse-Fehler: bestehende Map behalten */ }
          resolve(false);
        },
        onerror: () => resolve(false),
        ontimeout: () => resolve(false),
      });
    } catch (e) { /* GM_xmlhttpRequest nicht verfuegbar */
      resolve(false);
    }
  });

  if (IS_BETFAIR) loadLeagueMap(3);
  else if (leagueMapResolve) { leagueMapResolve(); leagueMapResolve = null; }

  function el(tag, text, style) {
    const e = document.createElement(tag);
    if (text !== undefined) e.textContent = text;
    if (style) e.style.cssText = style;
    return e;
  }

  function buildPanel() {
    const p = el('div', undefined,
      'position:fixed;right:16px;bottom:16px;width:46vw;min-width:860px;max-width:1200px;' +
      'max-height:85vh;z-index:2147483647;' +
      'background:#1e2229;color:#e8e8e8;font:12px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;' +
      'border:1px solid #3a4250;border-radius:8px;box-shadow:0 6px 24px rgba(0,0,0,.5);' +
      'display:flex;flex-direction:column;overflow:hidden;');
    // v8.62.31: Das Panel bekommt seine id (Guard in ensurePanel + der
    // eingebettete Scanner-Klick auf "Auto an" referenzieren #vbsb-csarb —
    // die id fehlte seit der Modularisierung (303f2f4), buildPanel setzte
    // sie nie; dadurch fand der Auto-Scan-Start das Panel nie).
    p.id = 'vbsb-csarb';
    const head = el('div', 'VBSB CS-Arb Scanner v' + VERSION + ' (3% Komm.)',
      'padding:8px 10px;background:#262c37;font-weight:600;cursor:move;');
    const bar = el('div', undefined, 'padding:8px 10px;display:flex;gap:6px;flex-wrap:wrap;');
    const status = el('div', 'Bereit. VPN aktiv? Dann auf "Scan" klicken.',
      'padding:4px 10px;color:#9aa3b2;white-space:pre-wrap;max-height:52vh;min-height:220px;overflow:auto;');
    const out = el('div', undefined,
      'padding:4px 10px 8px;overflow:auto;min-height:180px;font:11px/1.5 Menlo,Consolas,monospace;');
    const btn = (t, fn) => { const b = el('button', t,
      'padding:5px 10px;background:#34507c;color:#fff;border:0;border-radius:4px;cursor:pointer;');
      b.onclick = fn; return b; };

    const logLines = [];
    const log = (msg, style) => {
      // Debug-Gating: '  DEBUG'-Zeilen (Scan-Diagnose) nur bei DBG aktiv. In der
      // Produktion laufen sie sonst bei jedem Scan mit (Log-Volumen + Overhead).
      if (!DBG && typeof msg === 'string' && /^\s*DEBUG\b/.test(msg)) return;
      const t = new Date().toLocaleTimeString('de-DE', { hour12: false });
      const line = '[' + t + '] ' + msg;
      logPipe(line);
      logLines.push(line);
      if (logLines.length > 2000) logLines.splice(0, logLines.length - 2000);
      console.log('%c' + line, style || '');
      const div = el('div', line, style);
      status.appendChild(div);
      while (status.children.length > 500) status.removeChild(status.firstChild);
      status.scrollTop = status.scrollHeight;
    };
    window.__ahLog = log;

    const render = () => {
      out.innerHTML = '';
      const snap = makeSnapshot(state.rows, state.games);
      const matched = state.rows.filter(r => r.hit).length;
      const unm = state.rows.filter(r => !r.hit);
      out.appendChild(el('div', 'Gematcht: ' + matched + ' | Unmatched: ' + unm.length +
        ' (davon H2H: ' + unm.filter(r => r.kind === 'h2h').length + ') | Arbs: ' +
        snap.candidates.filter(c => c.edge > 0).length, 'color:#9aa3b2;'));
      for (const c of snap.candidates) {
        const isBB = c.kind === 'bbA' || c.kind === 'bbB' || /^ouBB/.test(c.kind) || /^hfouBB/.test(c.kind) || /^ttBB/.test(c.kind) ||
          c.kind === 'bbTqA' || c.kind === 'bbTqB' ||
          c.kind === 'bttsBBY' || c.kind === 'bttsBBN' ||
          c.kind === 'oeBBY' || c.kind === 'oeBBN' ||
          c.kind === 'w2nBBY' || c.kind === 'w2nBBN' ||
          c.kind === 'fdBBY' || c.kind === 'fdBBN' ||
          c.kind === 'sdPlusA' || c.kind === 'sdPlusB' ||
          c.kind === 'sd5PlusA' || c.kind === 'sd5PlusB' ||
          c.kind === 'dnbCross' ||
          /^euh1[HA]\+[HB]$/.test(c.kind) ||
          /^euhAH\d+[HA][+-][HB]$/.test(c.kind) ||
          /^sw[12]BB[AB]$/.test(c.kind);
        const line = el('div',
          (c.edge > 0 ? '*** ARB *** ' : '') + c.name + ' [' + (kindLabel(c.kind)) +
          '] | PIN ' + c.back.toFixed(2) +
          ' (' + c.src + ') | ' + (isBB ? 'BF Back ' : 'Lay ') + c.lay.toFixed(2) +
          '@' + Math.round(c.vol) + ' | Edge ' + c.edge.toFixed(2) +
          (c.live ? ' [LIVE]' : ''),
          c.edge > 0 ? 'color:#ffd479;font-weight:700;' : 'color:#cfd6e4;');
        out.appendChild(line);
      }
      for (const r of state.rows.filter(r => !r.hit)) {
        const tag = r.kind === 'h2h' ? 'H2H' : 'Lay ' + r.lay.toFixed(2);
        out.appendChild(el('div', 'UNMATCHED ' + r.name + ' [' + tag + ']' +
          (r.live ? ' [LIVE]' : ''), 'color:#77818f;'));
      }
      // Schlanker Persistenz-Snapshot + try/catch: localStorage hat eine
      // Quota (~5 MB). Bei grossen Scans kann der volle Snapshot (inkl.
      // games/nameCandidates/unmatched) sie sprengen — der QuotaExceededError
      // wuerde render() werfen und damit scan() VOR dbSend() abbrechen
      // (Daten kamen nicht mehr in der App an, User-Befund 2026-09-04).
      // Verify liest nur snap.candidates -> snapshotFuerStorage reicht.
      // Schlaegt auch das fehl (Quota voll), ist der Scan trotzdem nicht
      // verloren: dbSend(snap) in scan() laeuft unabhaengig davon.
      try {
        localStorage.setItem('vbsb_csarb_snapshot',
          JSON.stringify(snapshotFuerStorage(snap)));
      } catch (e) { /* Quota voll - Snapshot nur im RAM, Verify ohne Historie */ }
    };

    const scan = async (auto) => {
      if (state.busy) return;
      state.busy = true;
      state.lastScanTs = Date.now();
      // Auto-Scan: nur Fehler + Zusammenfassung loggen (kein Liga-fuer-Liga-
      // Rauschen im Dauerbetrieb). Manueller Scan zeigt alle Details.
      const quiet = !!auto;
      state.rows = [];
      state.games = [];  // alle PIN-Matchups des Scans (Spielsuche, v8.39.0)
      out.innerHTML = '';
      status.innerHTML = '';
      straightCache.clear();
      // bfLaysCache/bfH2HCache bleiben erhalten (Cross-Scan-Cache, TTL 60s)
      // Nur bei Verify/WHY aktiv leeren.
      scanTimings.length = 0;
      missedDirArbs.length = 0;
      leagueWatchReset();
      reqStatsReset();
      nameCandsRunCap = 0;  // Name-Candidates: Cap je Scan-Lauf (v8.61.0)
      unmatchedRunCap = 0;  // Unmatched-Events: Cap je Scan-Lauf (v8.62.0)
      const scanStart = Date.now();
      if (!leagueMapLoaded) {
        log('Warte auf League-Mapping ...');
        await Promise.race([leagueMapReady, sleep(10000)]);
      }
      await dbFlush(log);
      logPipeFlush(true);
      // v8.65.0: Mapping live von der Pipe holen (merge-only) — in der App
      // uebernommene Discovery-Vorschlaege/Um-Mappings wirken ohne Neustart
      // ab diesem Zyklus. Kein Block: Fehler/Timeout -> Scan mit bestehender
      // Map (refreshLeagueMap resolved immer).
      await refreshLeagueMap();
      const rows = state.rows;
      const games = state.games;
      const total = Object.keys(LEAGUES).length + Object.keys(H2H).length;
      log('Scan gestartet (v' + VERSION + ', ' + total + ' Ligen, ' + daysAhead + ' Tage)' +
        (auto ? ' [Auto]' : '') + ' ...');
      if (!leagueMapLoaded)
        log('WARNUNG: League-Mapping noch nicht geladen! App erreichbar? Nur Hardcoded-Ligen.');
      if (!Object.keys(H2H).length)
        log('Hinweis: H2H-Map leer — erst "Discovery" + "Map uebernehmen" fuer Tennis/Basketball/Esports/Cricket.');
      let streamLast = 0;
      const streamToDb = async () => {
        if (Date.now() - streamLast < 5000) return;
        streamLast = Date.now();
        const partial = makeSnapshot(rows, games);
        if (!partial.candidates.length) return;
        partial.partial = true; // Teilsnapshot: Pipe per UPSERT, kein DELETE
        const ok = await dbSend(partial);
        if (ok && !quiet) log('DB: Zwischenstand gesendet (' + partial.candidates.length + ' Kandidaten).');
        else if (!ok) log('DB: Zwischenstand nicht gesendet (App nicht erreichbar).');
      };
      let i = 0;
      let scanErrors = 0;
      // CS- und h2h-Ligen in EINEM Pool verschraenken (Interleaving): statt erst
      // alle CS-, dann alle h2h-Ligen abzuarbeiten, werden die h2h-Ligen
      // gleichmaessig ueber die CS-Liste verteilt. Dadurch ist Tennis/Basketball
      // kontinuierlich frisch statt erst nach dem kompletten CS-Durchlauf —
      // ohne zusaetzliche Requests (Rate-Limits und Semaphor bleiben unangetastet).
      const csEntries = Object.entries(LEAGUES);
      const h2hEntries = Object.entries(H2H);
      const allLeagues = [];
      if (h2hEntries.length) {
        const step = Math.max(1, Math.floor(csEntries.length / h2hEntries.length));
        let h = 0;
        for (let c = 0; c < csEntries.length; c++) {
          allLeagues.push({ h2h: false, lid: csEntries[c][0], comp: csEntries[c][1] });
          if ((c + 1) % step === 0 && h < h2hEntries.length) {
            allLeagues.push({ h2h: true, lid: h2hEntries[h][0], comp: h2hEntries[h][1] });
            h++;
          }
        }
        while (h < h2hEntries.length) {
          allLeagues.push({ h2h: true, lid: h2hEntries[h][0], comp: h2hEntries[h][1] });
          h++;
        }
      } else {
        for (const [lid, comp] of csEntries) allLeagues.push({ h2h: false, lid, comp });
      }
      const h2hTot = { pin: 0, bf: 0, hit: 0 };
      await adaptivePool(allLeagues, async ({ h2h, lid, comp }) => {
        i++;
        if (!quiet) log((h2h ? 'H2H ' : 'Liga ') + i + '/' + total + ': ' +
          ((h2h ? H2H_NAMEN : LIGA_NAMEN)[lid] || lid) + ' (' + comp + ')');
        try {
          if (h2h) {
            const r = await scanH2HLeague(lid, comp, log, rows, null, games);
            if (r) { h2hTot.pin += r.pin; h2hTot.bf += r.bf; h2hTot.hit += r.hit; }
          } else {
            await scanLeague(lid, comp, log, rows, games);
          }
        } catch (e) { scanErrors++; log('  FEHLER: ' + e.message); }
        await sleep(LEAGUE_SLEEP_MS);
        await streamToDb();
      }, POOL_CONCURRENCY);
      if (Object.keys(H2H).length)
        log('H2H gesamt: ' + h2hTot.pin + ' PIN-Spiele | ' + h2hTot.bf + ' BF-Maerkte | ' +
          h2hTot.hit + ' gematcht' +
          (h2hTot.bf > h2hTot.hit ? ' | ' + (h2hTot.bf - h2hTot.hit) + ' UNMATCHED' : ''));
      render();
      const snap = makeSnapshot(rows, games);
      const arbs = snap.candidates.filter(c => c.edge > 0);
      if (arbs.length > state.lastArbs) {
        if (state.auto) {
          beep();
          p.style.borderColor = '#ffd479';
          setTimeout(() => { p.style.borderColor = '#3a4250'; }, 8000);
          log('!!! NEUER ARB: ' + arbs.map(a => a.name + ' +' + a.edge.toFixed(2)).join(' | '));
        }
        state.lastArbs = arbs.length;
      }
      const scanSec = (Date.now() - scanStart) / 1000;
      const matched = rows.filter(r => r.hit).length;
      const totalReqs = reqStats.pin + reqStats.bf;
      const totalErrs = reqStats.pin429 + reqStats.bf429 + reqStats.pinTimeout + reqStats.bfTimeout + reqStats.pin5xx + reqStats.bf5xx;
      log('Fertig. ' + total + ' Ligen, ' + scanSec.toFixed(0) + 's | '
        + matched + ' gematcht → ' + arbs.length + ' Arbs | '
        + totalReqs + ' Req' + (totalErrs ? ' (' + totalErrs + ' Fehler)' : ''),
        'color:#9aa3b2;');
      if (scanTimings.length) {
        const avg = t => Math.round(scanTimings.reduce((a, x) => a + x[t], 0) / scanTimings.length);
        const max = t => scanTimings.reduce((a, x) => Math.max(a, x[t]), 0);
        const scanSec = (Date.now() - scanStart) / 1000;
        log('Timing: ' + scanTimings.length + ' Ligen, ' + scanSec.toFixed(0) + 's | '
          + 'fetch max=' + max('fetch') + 'ms avg=' + avg('fetch') + 'ms | '
          + 'match max=' + max('match') + 'ms avg=' + avg('match') + 'ms | '
          + 'total max=' + max('total') + 'ms avg=' + avg('total') + 'ms',
          'color:#9aa3b2;');
        const byTotal = scanTimings.slice().sort((a, b) => b.total - a.total);
        const top = byTotal.slice(0, 5);
        if (top.length && top[0].total > avg('total') * 2)
          log('  Top-5 langsamste: ' + top.map(t => t.name + ' ' + t.total + 'ms').join(' | '),
            'color:#9aa3b2;');
      }
      // Scan-Metrik an die App (Tabelle scan_metrics): strukturiertes Monitoring
      // fuer Dauer/Arbs/Fehler ueber die Zeit + Watchdog (App warnt, wenn bei
      // Auto-Scan der letzte Lauf aelter als das Intervall ist).
      try {
        const avg = t => scanTimings.length
          ? Math.round(scanTimings.reduce((a, x) => a + x[t], 0) / scanTimings.length) : 0;
        const max = t => scanTimings.reduce((a, x) => Math.max(a, x[t]), 0);
        postPipe('/scan-metrics', {
          ts: new Date().toISOString(),
          duration_ms: Math.round(Date.now() - scanStart),
          leagues: total,
          arbs: arbs.length,
          matched: rows.filter(r => r.hit).length,
          errors: scanErrors,
          auto: !!auto,
          fetch_avg: avg('fetch'), fetch_max: max('fetch'),
          match_avg: avg('match'), match_max: max('match'),
          async_avg: avg('async'), async_max: max('async'),
          requests_pin: reqStats.pin, requests_bf: reqStats.bf,
          pin_429: reqStats.pin429, bf_429: reqStats.bf429,
          timeouts: reqStats.pinTimeout + reqStats.bfTimeout,
          http_5xx: reqStats.pin5xx + reqStats.bf5xx
        });
      } catch (e) { /* Metrik darf den Scan-Abschluss nicht brechen */ }
      // LigaCheck-Zusammenfassung (nur wenn es Auffaelligkeiten gibt)
      if (leagueWatch.suppressed || leagueWatch.emptyComp || leagueWatch.noTeamMatch) {
        const parts = [];
        if (leagueWatch.suppressed)
          parts.push(leagueWatch.suppressed + ' unterdrueckt (' + leagueWatch.suppressedLids.join(', ') + ')');
        if (leagueWatch.emptyComp)
          parts.push(leagueWatch.emptyComp + ' COMP leer');
        if (leagueWatch.noTeamMatch)
          parts.push(leagueWatch.noTeamMatch + ' mismatch');
        log('LigaCheck: ' + parts.join(' | ') + '. Details unter ?debug.');
      }
      if (DBG) {
        const blue = 'color:#59a8ff;';
        if (!quiet && missedDirArbs.length) {
          log('TEST: ' + missedDirArbs.length + ' Back-Lay-Kandidaten mit Lay < Back aber Score >= ' +
            PRICE_MATCH_THRESHOLD + ' verworfen (moegl. echte Arbs):', blue);
          const seen = {};
          for (const m of missedDirArbs.slice(0, 25)) {
            const k = m.kind + '|' + m.name + '|' + m.back.toFixed(2) + '|' + m.lay.toFixed(2);
            if (seen[k]) continue;
            seen[k] = true;
            log('  ' + m.kind + ' ' + m.name + ': PIN ' + m.back.toFixed(2) +
              ' / Lay ' + m.lay.toFixed(2) + ' Score ' + m.score.toFixed(3), blue);
          }
          if (Object.keys(seen).length > 25)
            log('  ... + ' + (Object.keys(seen).length - 25) + ' weitere', blue);
        } else if (!quiet) {
          log('TEST: 0 Back-Lay-Kandidaten mit Lay < Back aber Score >= ' +
            PRICE_MATCH_THRESHOLD + ' verworfen.', blue);
        }
      }
      state.busy = false;
      const dbOk = await dbSend(snap);
      if (!dbOk) {
        let q = [];
        try { q = JSON.parse(localStorage.getItem('vbsb_csarb_queue') || '[]'); } catch (e) { q = []; }
        q.push(snap);
        // Queue begrenzen: Bei länger ausgeschalteter App wuerde sie sonst
        // unbegrenzt wachsen und die localStorage-Quota sprengen (setItem wirft).
        q = q.slice(-QUEUE_MAX);
        try { localStorage.setItem('vbsb_csarb_queue', JSON.stringify(q)); } catch (e) { /* Quota voll - Queue nur im RAM */ }
        log('DB: App nicht erreichbar - Snapshot gequeued (' + q.length + ').');
      } else {
        log('DB: Snapshot gespeichert (' + snap.candidates.length + ' Kandidaten).');
      }
      if (!auto) {
        download('csarb_snapshot_' + new Date().toISOString().slice(0, 16).replace(/[^0-9]/g, '') +
          '.json', JSON.stringify(snap, null, 1));
      }
      logPipeFlush(true);
    };

    const verify = async () => {
      if (state.busy) return;
      const snap = JSON.parse(localStorage.getItem('vbsb_csarb_snapshot') || 'null');
      if (!snap || !snap.candidates.length) { log('Kein Snapshot vorhanden — erst scannen.'); return; }
      state.busy = true;
      status.innerHTML = '';
      bfH2HCache.clear();
      bfLaysCache.clear();
      straightCache.clear();
      log('Verify: ' + snap.candidates.length + ' Kandidaten werden neu geholt ...');
      const leagues = {};
      snap.candidates.forEach(c => {
        if (LEAGUES[c.league]) leagues[c.league] = LEAGUES[c.league];
        else if (H2H[c.league]) leagues[c.league] = H2H[c.league];
      });
      const fresh = [];
      let i = 0;
      const vLeagues = Object.entries(leagues);
      await pool(vLeagues, async ([lid, comp]) => {
        i++;
        log('Liga ' + i + '/' + vLeagues.length + ' (' + comp + ')');
        try {
          if (LEAGUES[lid]) await scanLeague(lid, comp, log, fresh);
          else await scanH2HLeague(lid, comp, log, fresh);
        }
        catch (e) { log('  FEHLER: ' + e.message); }
        await sleep(20);
      }, 8);
      for (const c of snap.candidates) {
        const f = fresh.find(x => x.hit && x.kind === c.kind && norm(x.name) === norm(c.name));
        if (!f) { log('VERWAIST: ' + c.name + ' [' + (kindLabel(c.kind)) + ']'); continue; }
        const edgeNew = edgeOf(f);
        log((edgeNew > 0 ? '*** ARB *** ' : '') + c.name +
          ' [' + (kindLabel(c.kind)) + ']' +
          ' | ALT: Back ' + c.back.toFixed(2) + ' / Lay ' + c.lay.toFixed(2) +
          ' (Edge ' + c.edge.toFixed(2) + ')' +
          ' | NEU: Back ' + f.back.toFixed(2) + ' / Lay ' + f.lay.toFixed(2) +
          ' (Edge ' + edgeNew.toFixed(2) + ')');
      }
      state.busy = false;
    };

    const disc = async () => {
      if (state.busy) return;
      state.busy = true;
      status.innerHTML = '';
      // Ohne geladenes Mapping waeren saemtliche bereits gemappten Ligen
      // "ungemappt" (nur Hardcoded-Fallback aktiv) -> massenhaft falsche
      // Vorschlaege (bekannter Vorfall vom 01.08., 06:35). Deshalb kurz auf
      // das Mapping warten und sonst klar abbrechen statt blind zu raten.
      if (!leagueMapLoaded) {
        log('Warte auf League-Mapping ...');
        await Promise.race([leagueMapReady, sleep(10000)]);
      }
      if (!leagueMapLoaded) {
        log('⚠ ABBRUCH: League-Mapping nicht geladen (App nicht erreichbar?).');
        log('Discovery wuerde gegen die Hardcoded-Ligen laufen und laengst gemappte');
        log('Ligen als Vorschlaege melden. App starten und erneut versuchen.');
        state.busy = false;
        return;
      }
      log('Discovery: Pruefe verfuegbare Ligen ... (dauert ~1-3 min)');
      log('  Userscript v' + VERSION + (typeof GM_info !== 'undefined' && GM_info &&
        GM_info.script && GM_info.script.updateTime ?
        ' | installiert ' + new Date(GM_info.script.updateTime).toLocaleString('de-DE') : ''));
      const sports = [{ sid: 29, name: 'Soccer' }].concat(await findSports());
      log('Sportarten: ' + sports.map(s => s.name + '(' + s.sid + ')').join(' | '));
      const { props: results, lastActive: discActive } = await discovery(log, sports);
      // Zaehle gemappte/ungemappte Ligen aus dem vollen Satz aktiver Ligen
      let csMappedCt = 0, h2hMappedCt = 0;
      for (const sa of discActive) {
        for (const lg of sa.leagues) {
          if (sa.sid === 29) { if (LEAGUES[lg.id]) csMappedCt++; }
          else { if (H2H[lg.id]) h2hMappedCt++; }
        }
      }
      // Pruefe ob COMP bereits unter anderem PID gemappt ist. Wichtig: die
      // Kandidaten-Sektion wird UEBERGEBEN (nicht aus pid abgeleitet) —
      // sonst sucht der Check fuer ungemappte CS-Ligen im H2H-Map und
      // meldet Konflikte in LEAGUES nie (Bug aus v7.38.7).
      // Seit 7.93 auch CROSS-BLOCK: dieselbe COMP darf nur einmal existieren,
      // egal ob cs- oder h2h-Block (sonst landen zwei Sportarten auf einer COMP).
      const compMappedElsewhere = (pid, comp) => {
        for (const [p, c] of Object.entries(LEAGUES)) {
          if (p !== pid && c === comp) return true;
        }
        for (const [p, c] of Object.entries(H2H)) {
          if (p !== pid && c === comp) return true;
        }
        return false;
      };
      // Nur Bericht — kein Mapping
      const csUnmapped = results.filter(r => r.sid === 29 && !LEAGUES[r.pid] && !compMappedElsewhere(r.pid, r.comp));
      const h2hUnmapped = results.filter(r => r.sid !== 29 && !H2H[r.pid] && !compMappedElsewhere(r.pid, r.comp));
      const csCompExisting = results.filter(r => r.sid === 29 && !LEAGUES[r.pid] && compMappedElsewhere(r.pid, r.comp));
      const h2hCompExisting = results.filter(r => r.sid !== 29 && !H2H[r.pid] && compMappedElsewhere(r.pid, r.comp));
      for (const x of csUnmapped.concat(h2hUnmapped))
        propsUpsert(x.pid, x.comp, x.cn, x.name, x.sid, 'proposal');
      for (const x of csCompExisting.concat(h2hCompExisting))
        propsUpsert(x.pid, x.comp, x.cn, x.name, x.sid, 'conflict');
      // Discovery-Nacharbeit (GUI-Tab "Discovery"): die Zusammenfassung an die
      // App schicken, damit die Vorschlaege/Konflikte dort direkt uebernommen
      // oder dauerhaft abgelehnt werden koennen (statt Log-Kopieren).
      postPipe('/discovery-result', {
        ts: new Date().toISOString(),
        props: csUnmapped.concat(h2hUnmapped).map(r => ({
          sid: r.sid, pid: String(r.pid), name: r.name,
          comp: r.comp, cn: r.cn, kind: 'proposal' })),
        conflicts: csCompExisting.concat(h2hCompExisting).map(r => ({
          sid: r.sid, pid: String(r.pid), name: r.name,
          comp: r.comp, cn: r.cn, kind: 'conflict' })),
        counts: { csMapped: csMappedCt, h2hMapped: h2hMappedCt }
      });
      log('---');
      log('ZUSAMMENFASSUNG:');
      log('  Bereits gemappt: ' + csMappedCt + ' CS, ' + h2hMappedCt + ' H2H');
      if (csCompExisting.length || h2hCompExisting.length) {
        log('  COMP bereits woanders gemappt (' + (csCompExisting.length + h2hCompExisting.length) + '):');
        for (const r of csCompExisting.concat(h2hCompExisting))
          log('    ' + r.name + ' (pid ' + r.pid + ' -> ' + r.comp + ' [' + r.cn + '])');
      }
      log('  Fehlend (kann nachgetragen werden):');
      if (csUnmapped.length) {
        log('  CS:');
        for (const r of csUnmapped)
          log('    pid ' + r.pid + ' -> ' + r.comp + ' [' + r.cn + '] ' + r.name);
      }
      if (h2hUnmapped.length) {
        log('  H2H:');
        for (const r of h2hUnmapped)
          log('    pid ' + r.pid + ' -> ' + r.comp + ' [' + r.cn + '] ' + r.name);
      }
      if (!csUnmapped.length && !h2hUnmapped.length && !csCompExisting.length && !h2hCompExisting.length)
        log('  Alles gemappt!');
      log('Eintragen ueber: GUI -> Einstellungen -> Liga-Mapping');
      pruneProps(true);
      // Pipe-Sync: entschiedene Eintraege (accepted/rejected) aus propList
      // entfernen — loest die Diskrepanz zwischen Userscript-propList und
      // Pipe-DB-Status (v8.18.1).
      syncPropListFromPipe();
      log('Vorschlaege persistiert (' + propList.length + ' gesamt, ' +
        propList.filter(p => p.kind === 'proposal').length + ' Proposals, ' +
        propList.filter(p => p.kind === 'conflict').length + ' Konflikte) in "Vorschlaege"-Button.');
      state.busy = false;
    };


    // ---------- Manuell mappen + COMP-Suche ----------
    let manualSid = 29;
    const manualBox = el('div', undefined,
      'padding:6px 10px;display:none;gap:6px;flex-wrap:wrap;align-items:center;' +
      'border-top:1px solid #3a4250;');
    const sportSel = el('select', undefined,
      'padding:3px;background:#262c37;color:#e8e8e8;border:1px solid #3a4250;border-radius:4px;');
    const ligaSel = el('select', undefined,
      'max-width:280px;padding:3px;background:#262c37;color:#e8e8e8;border:1px solid #3a4250;' +
      'border-radius:4px;');
    const pidIn = el('input', undefined,
      'width:90px;padding:3px;background:#262c37;color:#e8e8e8;border:1px solid #3a4250;' +
      'border-radius:4px;');
    pidIn.type = 'number';
    pidIn.placeholder = 'PID manuell';
    const compIn = el('input', undefined,
      'width:110px;padding:3px;background:#262c37;color:#e8e8e8;border:1px solid #3a4250;' +
      'border-radius:4px;');
    compIn.placeholder = 'COMP-ID';
    const compSearch = el('input', undefined,
      'flex:1;min-width:150px;padding:3px;background:#262c37;color:#e8e8e8;' +
      'border:1px solid #3a4250;border-radius:4px;');
    compSearch.placeholder = 'Betfair-Name suchen (z.B. "Premier Padel") ...';
    const fillLigas = () => {
      ligaSel.innerHTML = '';
      const o0 = el('option', '— aus letzter Discovery waehlen —');
      o0.value = '';
      ligaSel.appendChild(o0);
      const sp = lastActive.find(s => s.sid === manualSid);
      for (const L of (sp ? sp.leagues : [])) {
        const o = el('option', L.name + ' (pid ' + L.id + ')');
        o.value = String(L.id);
        ligaSel.appendChild(o);
      }
    };
    const manualOpen = () => {
      sportSel.innerHTML = '';
      const sports = [{ sid: 29, name: 'Soccer' }]
        .concat(lastActive.filter(s => s.sid !== 29).map(s => ({ sid: s.sid, name: s.name })));
      for (const s of sports) {
        const o = el('option', s.name + ' (sid ' + s.sid + ')');
        o.value = String(s.sid);
        sportSel.appendChild(o);
      }
      manualSid = Number(sportSel.value) || 29;
      fillLigas();
      manualBox.style.display = 'flex';
    };
    sportSel.onchange = () => { manualSid = Number(sportSel.value) || 29; fillLigas(); };
    const doSearch = async () => {
      const q = compSearch.value.trim();
      if (!q) { log('COMP-Suche: Suchbegriff fehlt.'); return; }
      log('COMP-Suche: "' + q + '" ...');
      let res = await bfSearch(q).catch(() => []);
      if (!res.length) {
        const bfSid = BF_SID[manualSid];
        const words = q.toLowerCase().split(/\s+/).filter(w => w.length >= 3);
        if (bfSid !== undefined && words.length) {
          const groups = await bfNavGroups(bfSid).catch(() => []);
          const hit = groups.filter(g => words.some(w => g.name.includes(w)));
          log('  Nav-Fallback: ' + groups.length + ' Gruppen geladen | Match: ' +
            (hit.map(g => g.id + ' "' + g.name + '"').join(', ') || '(keine)'));
          const nav = await bfNavComps(bfSid, words).catch(() => []);
          res = nav.slice(0, 14);
          if (res.length) log('  Nav-Fallback: ' + res.length + ' COMPs per Navigation gefunden.');
        }
      }
      if (!res.length) { log('COMP-Suche: keine Treffer.'); return; }
      const lines = [];
      await pool(res.slice(0, 10), async o => {
        const n = await bfNode(o.cid).catch(() => null);
        const nodes = (n && n.nodes) || [];
        const compNode = nodes.find(x => String(x.nodeId || x.id) === 'COMP:' + o.cid);
        const named = nodes.filter(x => x.name && x !== compNode);
        let node = compNode || named[0];
        for (const a of named) {
          if (a.name.length > (node ? node.name.length : 0)) node = a;
        }
        const nm = node ? node.name : (rawLbl(o) || '(kein Name)');
        lines.push('[' + o.cid + '] ' + nm);
      }, 4);
      for (const line of lines) log('  COMP-Suche: ' + line);
      if (res.length === 1) {
        const bfSid = BF_SID[manualSid];
        if (bfSid !== undefined && res[0].sportId !== undefined && res[0].sportId !== bfSid) {
          log('  -> einziger Treffer ist fremder Sport (sid ' + res[0].sportId +
            ', erwartet ' + bfSid + ') — NICHT uebernommen.');
        } else {
          compIn.value = String(res[0].cid);
          log('  -> eindeutig, COMP-' + res[0].cid + ' ins COMP-Feld uebernommen.');
        }
      } else {
        log('  ' + lines.length + ' Treffer — passende Nummer ins COMP-Feld kopieren.');
      }
    };
    const manualApply = async () => {
      const sid = manualSid;
      const pid = ligaSel.value || pidIn.value.trim();
      if (!pid) { log('Manuell mappen: PID fehlt (Liste oder Feld).'); return; }
      const comp = compIn.value.trim().replace(/^COMP[: ]*/i, '');
      if (!comp) { log('Manuell mappen: COMP-ID fehlt.'); return; }
      const opt = ligaSel.selectedOptions[0];
      const name = opt && opt.value ? opt.textContent.replace(/\s*\(pid \d+\)$/, '') : ('Liga ' + pid);
      // Sport-Guard: COMP nicht uebernehmen, wenn der Betfair-Sport der COMP
      // eindeutig nicht zum gewaehlten Pinnacle-Sport passt (Fehler z.B. beim
      // manuellen Eintragen einer Basketball-COMP unter einer Soccer-Liga).
      const bfSid = BF_SID[sid];
      if (bfSid !== undefined) {
        const info = await nodeInfo(Number(comp)).catch(() => null);
        if (info && info.effSid !== undefined && info.effSid !== bfSid) {
          log('Manuell mappen: ABBRUCH — COMP:' + comp + ' ist Sport ' + info.effSid +
            ' (erwartet ' + bfSid + ' fuer sid ' + sid + ').');
          return;
        }
      }
      // Kollisionspruefung: COMP darf nur unter EINEM pid stehen (auch
      // blockuebergreifend), sonst landen zwei Sportarten auf einer COMP.
      for (const [p, c] of Object.entries(LEAGUES)) {
        if (p !== pid && c === 'COMP:' + comp) {
          log('Manuell mappen: ABBRUCH — COMP:' + comp + ' bereits unter CS-pid ' + p + ' gemappt.');
          return;
        }
      }
      for (const [p, c] of Object.entries(H2H)) {
        if (p !== pid && c === 'COMP:' + comp) {
          log('Manuell mappen: ABBRUCH — COMP:' + comp + ' bereits unter H2H-pid ' + p + ' gemappt.');
          return;
        }
      }
      if (sid === 29) {
        LEAGUES[pid] = 'COMP:' + comp;
        LIGA_NAMEN[pid] = name;
      } else {
        H2H[pid] = 'COMP:' + comp;
        H2H_NAMEN[pid] = name;
      }
      // Mapping in JSON-Datei speichern (via App-API)
      const section = sid === 29 ? 'cs' : 'h2h';
      const mapping = { cs: {}, h2h: {} };
      mapping[section][pid] = { comp: 'COMP:' + comp, name: name };
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: PIPE + '/league-map',
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ merge: true, section, pid, comp: 'COMP:' + comp, name }),
        });
      } catch (e) { /* App nicht erreichbar */ }
      log('Manuell gemappt: ' + name + ' (pid ' + pid + ', sid ' + sid + ') -> COMP:' + comp +
        ' (Map gesamt ' + (Object.keys(LEAGUES).length + Object.keys(H2H).length) + ').');
      manualBox.style.display = 'none';
    };

    const daysIn = el('input', undefined,
      'width:52px;padding:4px;background:#262c37;color:#e8e8e8;border:1px solid #3a4250;' +
      'border-radius:4px;font:12px Menlo,monospace;');
    daysIn.type = 'number';
    daysIn.min = '1';
    daysIn.max = '30';
    daysIn.step = '1';
    daysIn.value = String(daysAhead);
    daysIn.title = 'Scan-Horizont in Tagen voraus (Standard ' + DAYS_AHEAD + ')';
    daysIn.onchange = () => {
      const v = Math.min(30, Math.max(1, parseInt(daysIn.value, 10) || DAYS_AHEAD));
      daysAhead = v;
      daysIn.value = String(v);
      try { localStorage.setItem(DAYS_AHEAD_KEY, String(v)); } catch (e) { /* vol */ }
      log('Scan-Horizont gesetzt: ' + daysAhead + ' Tage voraus.');
    };

    const interval = el('input', undefined,
      'width:58px;padding:4px;background:#262c37;color:#e8e8e8;border:1px solid #3a4250;' +
      'border-radius:4px;font:12px Menlo,monospace;');
    interval.type = 'number';
    interval.min = '1';
    interval.step = '1';
    interval.value = '20';
    interval.title = 'Auto-Scan-Pause in Sekunden NACH jedem Scan-Ende (Dauerschleife). Default 20 s.';
    interval.placeholder = 'Sek';

    const toggleAuto = () => {
      if (state.auto) {
        clearTimeout(state.timer);
        state.timer = null;
        state.auto = false;
        document.removeEventListener('visibilitychange', onVisChange);
        autoBtn.textContent = 'Auto an';
        log('Auto-Scan (Dauerschleife) aus.');
      } else {
        const sec = Math.max(1, parseFloat(interval.value) || 20);
        state.auto = true;
        state.autoIntervalMs = sec * 1000;
        autoBtn.textContent = 'Auto aus';
        state.lastArbs = makeSnapshot(state.rows).candidates.filter(c => c.edge > 0).length;
        // Dauerschleife: laeuft einmal komplett durch und plant den naechsten
        // Lauf erst NACH dessen Ende — Timeout = Pause in Sekunden. Kein
        // festes Intervall mehr, das unabhaengig vom Scan-Ende feuert. Der
        // busy-Guard in scan() verhindert Ueberlappung; ein Fehler im Scan
        // bricht die Schleife NICHT (try/catch, Schleife laeuft weiter).
        const loop = async () => {
          if (!state.auto) return;
          try {
            await scan(true);
          } catch (e) {
            log('Auto-Scan-Fehler: ' + e.message);
          }
          if (!state.auto) return;
          state.timer = setTimeout(loop, state.autoIntervalMs);
        };
        // Hintergrund-Tab-Drosselung: Browsers verlangsamen setTimeout in
        // inaktiven Tabs stark. Bei Rueckkehr sofort nachscannen, wenn die
        // Pause seit dem letzten Lauf bereits abgelaufen ist.
        document.addEventListener('visibilitychange', onVisChange);
        loop();
        log('Auto-Scan an (Dauerschleife: ' + sec + ' s Pause nach jedem Scan-Ende). Alarm nur bei NEUEM Arb.');
      }
    };

    const onVisChange = () => {
      if (document.visibilityState !== 'visible' || !state.auto || state.busy) return;
      if (!state.lastScanTs || !state.autoIntervalMs) return;
      if (Date.now() - state.lastScanTs >= state.autoIntervalMs) {
        log('Tab wieder aktiv — Auto-Scan nachgeholt (Intervall abgelaufen).');
        scan(true);
      }
    };

    const autoBtn = btn('Auto an', toggleAuto);

    const dbg = async () => {
      if (state.busy) return;
      state.busy = true;
      status.innerHTML = '';
      const [lid, comp] = Object.entries(LEAGUES)[0];
      log('Debug Liga ' + lid + ' (' + comp + ') ...');
      const mus = await pinGet('/leagues/' + lid + '/matchups').catch(() => []);
      const mains = (mus || []).filter(x => x.type === 'matchup' && !x.parentId);
      const m = mains[0];
      log('Spiel: ' + (m.participants || []).map(p => p.name).join(' v ') + ' (id ' + m.id + ')');
      const specs = (mus || []).filter(x => x.type === 'special' && x.parentId === m.id);
      const yn = specs.filter(s => (s.participants || []).length === 2 &&
        (s.participants || []).some(p => p.name === 'Yes') &&
        (s.participants || []).some(p => p.name === 'No'));
      log('Yes/No-Specials: ' + yn.length + ' (IDs: ' + yn.map(s => s.id).join(', ') + ')');
      const sid = yn[0] && yn[0].id;
      if (sid) {
        const det = await pinGet('/matchups/' + sid).catch(() => null);
        log('Detail /matchups/' + sid + ': ' + JSON.stringify(det).slice(0, 700));
        const pr = await pinGet('/matchups/' + sid + '/markets/straight').catch(() => null);
        log('Straight /matchups/' + sid + '/markets/straight: ' + JSON.stringify(pr).slice(0, 700));
      }
      const sps = await pinGet('/sports').catch(() => []);
      log('Pinnacle-Sports (H2H): ' + (sps || []).filter(s =>
        /tennis|basketball|esport|baseball|ice hockey|volleyball|handball|american football|cricket/i
          .test(s.name || '')).map(s => s.id + '=' + s.name).join(' | '));
      state.busy = false;
    };

    const dbgBtn = btn('Debug', dbg);

    // ---------- Dev-Tool-Dialog (aus TOOLS-Registry) ----------
    const devBox = el('div', undefined,
      'padding:6px 10px;display:none;gap:4px;flex-wrap:wrap;align-items:center;' +
      'border-top:1px solid #3a4250;');
    const devSel = el('select', undefined,
      'padding:3px;background:#262c37;color:#e8e8e8;border:1px solid #3a4250;border-radius:4px;' +
      'max-width:220px;');
    const devParams = el('div', undefined,
      'flex:1;min-width:200px;display:flex;gap:4px;flex-wrap:wrap;align-items:center;');
    const devLogBtn = btn('Ausfuehren', null);
    function devToolGroups() {
      const labels = {
        diagnose: 'Diagnose / Warum-kein-Arb',
        probes: 'Markt-Probes (Einzelmarkt-Struktur)',
        mapping: 'Liga- / COMP-Pflege & Mapping',
        snapshot: 'Snapshots / Downloads',
        live: 'Live / Netz-Debug',
        discovery: 'Discovery / H2H',
      };
      const order = ['diagnose', 'probes', 'mapping', 'snapshot', 'live', 'discovery'];
      const used = {};
      const groups = [];
      for (const g of order) {
        const list = TOOLS.filter(t => t.group === g);
        if (list.length) { used[g] = 1; groups.push([g, labels[g], list]); }
      }
      const ungrouped = TOOLS.filter(t => !used[t.group]);
      if (ungrouped.length) groups.push(['', 'Übrige', ungrouped]);
      return groups;
    }
    for (const [gid, glabel, list] of devToolGroups()) {
      const og = document.createElement('optgroup');
      og.label = glabel;
      for (const t of list) {
        const o = el('option', t.id + ' — ' + t.label);
        o.value = t.id;
        og.appendChild(o);
      }
      devSel.appendChild(og);
    }
    // Ausgabe eines Tools in Panels-Log umleiten (console.log abfangen).
    const runDevTool = async () => {
      const t = TOOLS.find(x => x.id === devSel.value);
      if (!t) return;
      if (state.busy) { log('Tool läuft nur wenn kein Scan aktiv.'); return; }
      const args = {};
      devParams.querySelectorAll('input').forEach(inp => { args[inp.dataset.k] = inp.value; });
      devParams.querySelectorAll('select').forEach(sel => { args[sel.dataset.k] = sel.value; });
      devBox.classList.add('disabled'); devBox.style.opacity = '0.6';
      log('Tool "' + t.id + ' (' + t.label + ')" gestartet ...');
      // Alle devlog()-Ausgaben des Tools zusaetzlich ins Panel-Log schreiben.
      devSink = msg => {
        const line = '[' + new Date().toLocaleTimeString('de-DE', { hour12: false }) + '] ' + String(msg);
        logLines.push(line);
        const div = el('div', line);
        status.appendChild(div);
        while (status.children.length > 500) status.removeChild(status.firstChild);
        status.scrollTop = status.scrollHeight;
      };
      try {
        await t.run(args);
        if (t.flush) (t.flush() || []).forEach(m => devSink(m));
      } catch (e) {
        devSink('Tool-Fehler: ' + (e && e.message));
      } finally {
        devSink = null;
        devBox.style.opacity = '1';
        log('Tool "' + t.id + '" fertig.');
      }
    };
    const fillDevParams = () => {
      devParams.innerHTML = '';
      const t = TOOLS.find(x => x.id === devSel.value);
      if (!t) return;
      const desc = el('span', t.desc, 'color:#9aa3b2;flex:1 1 100%;font-style:italic;');
      devParams.appendChild(desc);
      for (const p of t.params) {
        const lbl = el('label', p.label + ': ', 'color:#cfd6e4;');
        lbl.style.fontSize = '11px';
        if (p.options && p.options.length) {
          // Dropdown-Param (z.B. Markttyp / Quelle): select statt Textfeld.
          const sel = document.createElement('select');
          sel.style.cssText = 'padding:3px;background:#262c37;color:#e8e8e8;border:1px solid #3a4250;' +
            'border-radius:4px;max-width:200px;';
          for (const op of p.options) {
            const o = el('option', op.label);
            o.value = op.v;
            sel.appendChild(o);
          }
          sel.dataset.k = p.k;
          devParams.appendChild(lbl);
          devParams.appendChild(sel);
          continue;
        }
        const inp = el('input', undefined,
          'width:110px;padding:3px;background:#262c37;color:#e8e8e8;border:1px solid #3a4250;' +
          'border-radius:4px;font:12px Menlo,monospace;');
        inp.dataset.k = p.k;
        inp.value = p.v;
        devParams.appendChild(lbl);
        devParams.appendChild(inp);
      }
    };
    devSel.onchange = fillDevParams;
    devLogBtn.onclick = runDevTool;
    const devBtn = btn('Dev-Tools', () => {
      if (devBox.style.display === 'flex') { devBox.style.display = 'none'; return; }
      fillDevParams();
      devBox.style.display = 'flex';
    });
    devBox.appendChild(devSel);
    devBox.appendChild(devParams);
    devBox.appendChild(devLogBtn);
    devBox.appendChild(btn('Schliessen', () => { devBox.style.display = 'none'; }));

    // ---------- Deny-Liste (Discovery-Override) ----------
    const denyBox = el('div', undefined,
      'padding:6px 10px;display:none;gap:4px;flex-wrap:wrap;align-items:center;' +
      'border-top:1px solid #3a4250;max-height:40vh;overflow:auto;');
    // Manueller Deny-Eintrag (pid + COMP + Grund) — einmal angelegt und in
    // renderDeny() unten wieder angehaengt (innerHTML='' raeumt den Box-Inhalt).
    const denyIn = el('div', undefined,
      'display:flex;gap:4px;align-items:center;flex-wrap:wrap;width:100%;margin-top:4px;');
    const denyPid = el('input', undefined,
      'width:70px;padding:3px 6px;background:#1e2229;border:1px solid #3a4250;color:#e8e8e8;' +
      'border-radius:4px;');
    denyPid.placeholder = 'pid';
    const denyComp = el('input', undefined,
      'width:130px;padding:3px 6px;background:#1e2229;border:1px solid #3a4250;color:#e8e8e8;' +
      'border-radius:4px;');
    denyComp.placeholder = 'COMP:xxxxx';
    const denyReason = el('input', undefined,
      'flex:1;min-width:120px;padding:3px 6px;background:#1e2229;border:1px solid #3a4250;' +
      'color:#e8e8e8;border-radius:4px;');
    denyReason.placeholder = 'Grund (optional)';
    const denyAdd = btn('Einfuegen', () => {
      const pid = String(denyPid.value || '').trim();
      const comp = String(denyComp.value || '').trim().toUpperCase();
      if (!pid || !comp) {
        log('Deny-Einfuegen: pid und COMP angeben (z.B. 236247 / COMP:12658350).');
        return;
      }
      denyUpsert(pid, comp, (denyReason.value || '').trim() || 'manuell eingefuegt', true);
      denyPid.value = ''; denyComp.value = ''; denyReason.value = '';
      log('Deny eingefuegt (dauerhaft): ' + pid + ' -> ' + comp);
      renderDeny();
    });
    denyIn.appendChild(denyPid); denyIn.appendChild(denyComp);
    denyIn.appendChild(denyReason); denyIn.appendChild(denyAdd);
    const renderDeny = () => {
      denyBox.innerHTML = '';
      if (!denyList.length) {
        denyBox.appendChild(el('span', 'Deny-Liste leer.'));
        denyBox.appendChild(btn('Schliessen', () => { denyBox.style.display = 'none'; }));
      }
      const now = Date.now();
      if (denyList.length) {
        denyBox.appendChild(el('span', 'Deny-Liste (paarweise; manuell/Seed = dauerhaft, Auto = ' +
          Math.round(DENY_TTL_MS / 864e5) + ' T):'));
        for (const d of denyList.slice().reverse()) {
          const rest = Math.max(0, DENY_TTL_MS - (now - (d.ts || 0)));
          const lbl = el('span', d.pid + ' -> ' + d.comp + ' [' + (d.kind || (d.perm ? 'wrong-comp' : 'auto')) +
            (d.perm ? ', perm' : ', auto') + '] (' + d.reason + ', ' +
            (d.perm ? 'dauerhaft' : (rest > 0 ? 'noch ' + Math.ceil(rest / 864e5) + ' T' : 'abgelaufen')) + ') ',
            'background:#2b3340;border:1px solid #3a4250;border-radius:4px;padding:2px 6px;');
          denyBox.appendChild(lbl);
          denyBox.appendChild(btn('X', () => {
            denyList = denyList.filter(x => x.key !== d.key);
            denySave();
            renderDeny();
            log('Deny entfernt: ' + d.pid + ' -> ' + d.comp + ' (wird wieder vorgeschlagen).');
          }));
        }
        denyBox.appendChild(btn('Schliessen', () => { denyBox.style.display = 'none'; }));
      }
      denyBox.appendChild(denyIn);
    };
    const denyBtn = btn('Deny-Liste', () => {
      if (denyBox.style.display === 'flex') { denyBox.style.display = 'none'; return; }
      renderDeny();
      denyBox.style.display = 'flex';
    });

    // ---------- Vorschlaege (persistierte Discovery-Ergebnisse) ----------
    const propBox = el('div', undefined,
      'padding:6px 10px;display:none;flex-direction:column;gap:4px;' +
      'border-top:1px solid #3a4250;max-height:220px;overflow:auto;');
    const fmtProp = p => '[' + p.kind + '] ' + p.pid + ' -> ' + p.comp +
      (p.cn ? ' [' + p.cn + ']' : '') + ' ' + p.name +
      ' | erst ' + new Date(p.firstSeen).toLocaleDateString('de-DE') +
      ' | zuletzt ' + new Date(p.lastSeen).toLocaleDateString('de-DE') +
      ' | ' + p.seen + 'x gesehen';
    // Proposal gilt als uebernommen, wenn der Eintrag (Zeile oder Button) angetippt
    // wird: Mapping in LEAGUES/H2H + POST /league-map, Eintrag danach entfernt.
    const applyProposal = (p) => {
      const sid = Number(p.sid) || 29;
      const pid = String(p.pid);
      const comp = String(p.comp).replace(/^COMP[: ]*/i, '');
      const name = p.name || (p.cn || 'Liga ' + pid);
      if (sid === 29) {
        LEAGUES[pid] = 'COMP:' + comp;
        LIGA_NAMEN[pid] = name;
      } else {
        H2H[pid] = 'COMP:' + comp;
        H2H_NAMEN[pid] = name;
      }
      const section = sid === 29 ? 'cs' : 'h2h';
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: PIPE + '/league-map',
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ merge: true, section, pid, comp: 'COMP:' + comp, name }),
        });
      } catch (e) { /* App nicht erreichbar */ }
      log('[Proposal] ' + (p.kind === 'conflict' ? 'Konflikt-Compat gutgeheissen' : 'Uebernommen') +
        ': ' + name + ' (pid ' + pid + ') -> COMP:' + comp +
        (p.kind === 'conflict' ? ' — Achtung: COMP wird woanders mitgenutzt' : ''));
      propList = propList.filter(x => x.key !== p.key);
      propsSave();
      renderProp();
    };
    const renderProp = () => {
      propBox.innerHTML = '';
      propBox.appendChild(el('div', 'Discovery-Vorschlaege (' + propList.length + ' gesamt):',
        'color:#9aa3b2;font-weight:600;'));
      propBox.appendChild(el('div', 'Klick auf einen Eintrag = Mapping uebernehmen und eintragen. ' +
        'Gemerkt: Konflikte (COMP woanders genutzt) bitte pruefen. Details: console __props().',
        'color:#77818f;font-style:italic;'));
      for (const p of propList.slice().reverse()) {
        const row = el('div', undefined,
          'display:flex;align-items:center;gap:6px;background:#2b3340;border:1px solid #3a4250;' +
          'border-radius:4px;padding:2px 6px;cursor:pointer;flex-wrap:wrap;');
        const lbl = el('span', fmtProp(p) + (p.kind === 'conflict' ? ' ⚠' : ''));
        row.appendChild(lbl);
        row.appendChild(btn('Uebernehmen', ev => { ev.stopPropagation(); applyProposal(p); }));
        row.appendChild(btn('X', ev => {
          ev.stopPropagation();
          propList = propList.filter(x => x.key !== p.key);
          propsSave();
          renderProp();
        }));
        row.onclick = () => applyProposal(p);
        propBox.appendChild(row);
      }
    };
    const propBtn = btn('Vorschlaege', () => {
      if (propBox.style.display === 'flex') { propBox.style.display = 'none'; return; }
      renderProp();
      propBox.style.display = 'flex';
    });

    bar.appendChild(btn('Scan', () => { state.lastArbs = makeSnapshot(state.rows).candidates.filter(c => c.edge > 0).length; scan(false); }));
    bar.appendChild(btn('Verify', verify));
    bar.appendChild(btn('Discovery', disc));
    bar.appendChild(btn('Manuell mappen', manualOpen));
    bar.appendChild(denyBtn);
    bar.appendChild(propBtn);
    bar.appendChild(dbgBtn);
    bar.appendChild(devBtn);
    bar.appendChild(daysIn);
    bar.appendChild(interval);
    bar.appendChild(autoBtn);
    bar.appendChild(btn('Panel leeren', () => { out.innerHTML = ''; }));
    bar.appendChild(btn('Log kopieren', () => {
      if (!logLines.length) { log('Log ist leer.'); return; }
      const txt = logLines.join('\n');
      const done = ok => log(ok ? 'Log kopiert (' + logLines.length + ' Zeilen).' :
        'Kopieren fehlgeschlagen — Log manuell markieren.');
      const fallback = () => {
        const ta = el('textarea'); ta.value = txt; document.body.appendChild(ta);
        ta.select(); let ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { /* leer */ }
        ta.remove(); done(ok);
      };
      if (navigator.clipboard && navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(() => done(true), fallback);
      else fallback();
    }));
    bar.appendChild(btn('Log speichern', () => {
      if (!logLines.length) { log('Log ist leer.'); return; }
      const blob = new Blob([logLines.join('\n')], { type: 'text/plain;charset=utf-8' });
      const a = el('a'); a.href = URL.createObjectURL(blob);
      a.download = 'cs_arb_scan_' + new Date().toISOString().slice(0, 16).replace(/:/g, '-') + '.log';
      a.click(); URL.revokeObjectURL(a.href);
      log('Log gespeichert (' + logLines.length + ' Zeilen).');
    }));
    bar.appendChild(btn('Schliessen', () => p.remove()));
    p.appendChild(head);
    p.appendChild(bar);
    manualBox.appendChild(sportSel);
    manualBox.appendChild(ligaSel);
    manualBox.appendChild(pidIn);
    manualBox.appendChild(compIn);
    manualBox.appendChild(compSearch);
    manualBox.appendChild(btn('Suchen', doSearch));
    manualBox.appendChild(btn('Uebernehmen', manualApply));
    manualBox.appendChild(btn('Zu', () => { manualBox.style.display = 'none'; }));
    p.appendChild(manualBox);
    p.appendChild(denyBox);
    p.appendChild(propBox);
    p.appendChild(devBox);
    p.appendChild(status);
    p.appendChild(out);
    document.body.appendChild(p);
  }

  if (IS_BETFAIR) {
    const ensurePanel = () => { if (!document.getElementById('vbsb-csarb')) buildPanel(); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ensurePanel);
    else ensurePanel();
  }

  // ---------- Pruefungs-Modul: Pipe-Befehle aus der VBSB-GUI ausfuehren ----------
  // Die GUI schreibt per POST /cmd einen Pruefauftrag (Tool + Parameter) in die
  // Pipe-Warteschlange. Dieses Script pollt GET /cmd, fuehrt den passenden
  // TOOLS-Handler aus (standardmaessig 'why' = Warum kein Arb?), sammelt die
  // devlog-Ausgabe und schickt das Ergebnis per POST /cmd/result zurueck.
  const CMD_URL = PIPE + '/cmd';
  let cmdBusy = false;
  async function runCmd(cmd) {
    const lines = [];
    const prevSink = devSink;
    devSink = m => lines.push(String(m));
    let ok = false, err = '', data = null, timedOut = false;
    // Budget etwas grosszuegiger als die GUI-Wartezeit (150s), damit ein
    // langsamer PIN/BF-Abruf (z.B. VPN-Schwankung) bis 180s liefern kann,
    // statt knapp vor Ende als „Timeout" zu enden.
    const deadline = setTimeout(() => { timedOut = true; }, 180000);
    try {
      const tool = TOOLS.find(t => t.id === cmd.tool);
      if (!tool) err = 'unbekanntes Tool: ' + cmd.tool;
      else {
        const ret = await tool.run(cmd);
        ok = true;
        try { if (ret && typeof ret === 'object') data = JSON.parse(JSON.stringify(ret)); }
        catch (e) { data = null; }
      }
    } catch (e) { err = String((e && e.stack) || e); }
    clearTimeout(deadline);
    if (timedOut) { ok = false; err = err || 'Timeout (180s) — Analyse haengt'; }
    devSink = prevSink;
    if (!ok && !err) err = 'unbekannter Fehler';
    const body = { id: cmd.id, tool: cmd.tool, ok, error: err || undefined,
      lines, data, ts: new Date().toISOString() };
    console.log('[Pruefung] liefere Ergebnis id=' + cmd.id + ' ok=' + ok +
      ' data=' + (data ? 'ja' : 'nein') + ' lines=' + lines.length + ' err=' + (err || '-'));
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: PIPE + '/cmd/result',
        data: JSON.stringify(body),
        headers: { 'content-type': 'application/json' }, timeout: 5000,
        onload: () => {}, onerror: () => {}, ontimeout: () => {}
      });
    } catch (e) {
      console.log('[Pruefung] POST /cmd/result Fehler: ' + e);
    }
  }
  // v8.62.14: Long-Poll statt setInterval-Polling. Chrome drosselt setInterval
  // in versteckten Tabs auf ~1x/Minute — dadurch wartete ein eingereihter
  // Pruefauftrag bis ~80s auf die Abholung, obwohl der Tool-Lauf selbst nur
  // Sekunden dauert (Befund data/api_calls.log). Jetzt haelt die Pipe den
  // GET /cmd?wait=25 bis 25s offen; 204/Timeout/Fehler/Ende verkettet sofort
  // den naechsten Request — offene Netzwerk-Requests werden in
  // Hintergrund-Tabs NICHT gedrosselt, ein Timer existiert nicht mehr.
  // cmdBusy hielt die Einzelausfuehrung: waehrend ein Tool laeuft, ist kein
  // Poll offen; nach dem Ende wird sofort nachpollt.
  // v8.62.15 (Tab-Routing): Der Poller nennt seine Seite (?site=bf|pin).
  // Auftraege MIT Ziel-Site (why/discovery-deny/alias-set -> bf) darf nur der
  // passende Tab uebernehmen — why braucht bfLays gegen betfair.com, ein
  // PIN-Tab-Poller wuerde sonst mit leerem BF-Teil antworten (bfLays-Cache).
  const CMD_SITE = IS_BETFAIR ? 'bf' : 'pin';
  function cmdPoll() {
    if (typeof GM_xmlhttpRequest === 'undefined' || cmdBusy) {
      console.log('[Pruefung] Poll uebersprungen: ' +
        (typeof GM_xmlhttpRequest === 'undefined' ? 'kein GM_xmlhttpRequest' : 'busy=' + cmdBusy));
      return;
    }
    GM_xmlhttpRequest({
      method: 'GET', url: CMD_URL + '?wait=25&site=' + CMD_SITE, timeout: 30000,
      onload: r => {
        console.log('[Pruefung] GET /cmd -> status ' + r.status);
        // 204 = kein Auftrag in der Haltezeit -> sofort weiterpollt
        if (!(r.status >= 200 && r.status < 300) || r.status === 204) { cmdPoll(); return; }
        let cmd = null;
        try { cmd = JSON.parse(r.responseText); } catch (e) { cmdPoll(); return; }
        if (!cmd || !cmd.id || !cmd.tool) { cmdPoll(); return; }
        console.log('[Pruefung] Auftrag erhalten: id=' + cmd.id + ' tool=' + cmd.tool);
        cmdBusy = true;
        runCmd(cmd).then(() => { cmdBusy = false; cmdPoll(); })
          .catch(() => { cmdBusy = false; cmdPoll(); });
      },
      onerror: e => {
        console.log('[Pruefung] GET /cmd Fehler: ' + e);
        // Pipe kurz nicht erreichbar (Start/Neustart) -> mit Pause erneut
        setTimeout(() => cmdPoll(), 2000);
      },
      ontimeout: () => cmdPoll()  // Haltezeit ueberschritten -> sofort weiter
    });
  }
  cmdPoll();
  // Zusaetzlicher Weckruf bei Tab-Rueckkehr (deckt auch den Fehler-Pfad ab,
  // dessen 2s-Pause in versteckten Tabs gedehnt werden kann).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') cmdPoll();
  });

  // ---------- URL-Trigger: ?ahprobe=COMP:129 fuehrt Probe im Script-Kontext aus ----------
  const apm = location.search.match(/[?&]ahprobe=([^&]+)/);
  if (apm) {
    const comp = decodeURIComponent(apm[1]);
    const logTo = window.__ahLog || (msg => console.log(msg));
    logTo('AH-Probe fuer ' + comp + ' ...');
    window.__ahProbe(comp).then(() => {
      ahProbeOut.forEach(m => logTo(m));
      logTo('AH-Probe fertig.');
    }).catch(e => logTo('AH-Probe Fehler: ' + e));
  }
// ---------- Selbst-Update (Tampermonkey-Auto-Update + Reload) ----------
  // Tampermonkey installiert neuere @version automatisch (Standard 24h,
  // min. 6h einstellbar). Der NEUE Code greift aber erst nach einem
  // Seiten-Reload. Dieses Modul:
  //   1. merkt sich die installierte Version im localStorage,
  //   2. erkennt beim naechsten Start, dass Tampermonkey ein Update
  //      installiert hat (installierte Version != letzte geladene),
  //   3. laedt die Seite EINMAL neu, damit der neue Code aktiv wird.
  // Zusaetzlich prueft es beim Start gegen die Update-Quelle
  // (PIPE/cs_arb_scanner.user.js, X-Userscript-Meta: 1) und loggt, wenn eine
  // neuere Version verfuegbar ist (der Nutzer muss nichts manuell tun).
  // Quelle des Musters: SO 77646258 ("Tampermonkey script update logic").
  const UPDATE_STORE_KEY = 'vbsb_csarb_last_version';
  const UPDATE_URL = PIPE + '/cs_arb_scanner.user.js';

  // Vergleicht zwei Versionsstrings "a.b.c" numerisch (nur Zahlen relevant).
  function cmpVersion(a, b) {
    const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
    const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
    const n = Math.max(pa.length, pb.length);
    for (let i = 0; i < n; i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d;
    }
    return 0;
  }

  function installedVersion() {
    return (typeof GM_info !== 'undefined' && GM_info && GM_info.script)
      ? GM_info.script.version : null;
  }

  // Schritt 1-3: Update-Installation erkennen -> Seite einmalig neu laden.
  function selfUpdateLog(msg) {
    try { (window.__ahLog || console.log)('[' + new Date().toLocaleTimeString('de-DE') + '] ' + msg); }
    catch (e) { try { console.log(msg); } catch (e2) { /* ok */ } }
  }

  function handleAutoUpdate() {
    try {
      const inst = installedVersion();
      if (!inst) return;
      const prev = localStorage.getItem(UPDATE_STORE_KEY);
      if (prev && prev !== inst) {
        selfUpdateLog('Update installiert: ' + prev + ' -> ' + inst +
          ' (Seite wird neu geladen)');
        localStorage.setItem(UPDATE_STORE_KEY, inst);
        try { location.reload(); } catch (e) { /* ok */ }
        return;
      }
      localStorage.setItem(UPDATE_STORE_KEY, inst);
    } catch (e) { /* localStorage kann blockiert sein */ }
  }

  // Proaktiver Check gegen die Update-Quelle (nur Log, kein Reload).
  function checkRemoteVersion() {
    if (typeof GM_xmlhttpRequest === 'undefined') return;
    try {
      GM_xmlhttpRequest({
        method: 'GET', url: UPDATE_URL, timeout: 5000,
        headers: { 'X-Userscript-Meta': '1' },
        onload: (r) => {
          try {
            const m = /@version\s+([0-9.]+)/.exec(r.responseText || '');
            const inst = installedVersion();
            if (m && inst && cmpVersion(m[1], inst) > 0) {
              selfUpdateLog('Update ' + m[1] + ' verfuegbar (installiert: ' +
                inst + ') — Tampermonkey holt es beim naechsten automatischen Check.');
            }
          } catch (e) { /* ok */ }
        },
        onerror: () => {}, ontimeout: () => {},
      });
    } catch (e) { /* ok */ }
  }

  handleAutoUpdate();
  setTimeout(checkRemoteVersion, 3000);
})();
