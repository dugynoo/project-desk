# Vzdialené ovládanie z mobilu — návrh

Stav: návrh na schválenie (2026-11-07)

## Zámer

Project Desk beží doma na PC. Keď od neho používateľ odíde, chce ho kedykoľvek a odkiaľkoľvek
ovládať z mobilu: pozrieť, čo agenti robia, odpovedať im, schváliť krok a poslať ďalšiu úlohu.
Mobil nie je plnohodnotné pracovisko, je to diaľkový ovládač k bežiacim sessions.

Používa to jediný človek (vlastník PC). Žiadna mobilná appka: webová stránka, ktorú servuje
samotný Project Desk, otvorená v mobilnom prehliadači.

## Ciele (prvá verzia)

1. Na mobile vidieť zoznam projektov a ich sessions (Claude, Codex, Antigravity, shell) s rovnakým
   stavom, aký ukazuje desktop (beží / čaká na teba / hotovo / zastavené).
2. Otvoriť session a vidieť **živý terminál** (xterm.js) s aktuálnou obrazovkou a nedávnou históriou,
   nielen výstupom od chvíle pripojenia.
3. Písať do session: text + Enter a malý riadok špeciálnych kláves, bez ktorých sa agent na mobile
   ovládať nedá (Esc, Tab, ↑, ↓, Ctrl+C, Enter, Shift+Enter). *(Rozsah klávesového riadku je moje rozhodnutie;
   ladenie klávesnice je inak mimo prvej verzie.)*
4. Prístup odkiaľkoľvek bez otvárania portov do internetu: cez **Tailscale** (tailnet používateľa).
5. Funkcia je predvolene **vypnutá**; zapína sa v nastaveniach Project Desk.
6. Desktop a mobil sa navzájom nerozbijú: keď sa používateľ vráti k PC, všetko je tak, ako bolo,
   a terminál má opäť veľkosť okna na PC.

## Mimo prvej verzie (neskôr)

Push notifikácie, inštalácia ako PWA, vylepšená mobilná klávesnica (IME, gestá), zakladanie a mazanie
projektov či sessions z mobilu, nastavenia z mobilu, editor súborov, prompt šablóny, vyhľadávanie v termináli,
viac používateľov alebo rolí.

## Anti-ciele (zlyhanie, aj keby to „fungovalo“)

- Shell na domácom PC dostupný z verejného internetu alebo bez autentifikácie.
- Mobil zmení stav tak, že desktop po návrate ukazuje niečo iné ako realitu (rozsynchronizované stavy,
  zaseknutá veľkosť terminálu, stratený vstup).
- Zapnutý vzdialený prístup spomalí alebo zneistí desktop (výstup terminálov, ukončenie appky, cleanup procesov).
- Terminálový výstup alebo konverzácie sa niekam ukladajú alebo posielajú mimo spojenia s mobilom.

## Obmedzenia (z projektu)

- Tauri 2 / Rust, vanilla TypeScript / Vite, xterm.js; bez frameworkov. Windows, macOS aj Linux.
- Existujúci hook server ostáva na loopbacku s náhodným tokenom; vzdialený server je samostatný.
- Nič neinterpolovať do shell príkazov; vstup z mobilu ide do PTY rovnako ako vstup z desktopu
  (cez `PtyManager::write`, s existujúcimi limitmi `pty.inputTooLarge` / `pty.inputFull`).
- UI reťazce v EN/SK/CS (aj na mobilnej stránke), chybové kódy z Rustu s prekladmi, `src/i18n.test.ts` prechádza.
- Doménová logika (napr. protokol správ, arbitráž veľkosti terminálu) v testovateľných moduloch
  (`src/model.ts` alebo nový čistý modul + testy), natívne testy vedľa Rust implementácie.
- Vypnutá funkcia = žiadny otvorený port a žiadna zmena správania oproti dnešku.

## Ako to bude fungovať

### Kde je zdroj pravdy

Dnes je „mozog“ v desktopovom webview: stavy agentov počíta frontend (`agent-monitor.ts`, hook udalosti,
`model.ts`), Rust len drží PTY a posiela výstup cez Tauri `Channel` priamo do okna. Návrh to nemení:

- **Desktop webview ostáva jediným zdrojom pravdy** pre projekty, sessions a stavy. Pri každej zmene
  (debounced) publikuje do Rustu zjednodušený snímok: projekty, sessions, stav, či session beží.
  Bez konverzačného textu.
- **Rust** drží vzdialený server a posiela mobilu tento snímok, terminálový výstup a prijíma vstup.
- Ak desktopové okno nebeží (appka zatvorená), nebeží ani vzdialený prístup. To je v poriadku.

### Terminálový výstup a história

PTY výstup sa v Ruste rozdvojí: ide do okna ako dnes **a** do kruhového buffra na session (rádovo
1–2 MB na session, len v pamäti, nikdy na disk). Pripojený mobil dostane najprv obsah buffra (aby videl
aktuálnu obrazovku), potom živý výstup. Spätný tlak k desktopu (`OutputFlow`, ack) sa nesmie zmeniť;
pomalý alebo odpojený mobil nesmie brzdiť čítanie PTY ani desktop: mobilu sa pri zahltení zahadzuje
alebo pošle čerstvý snímok.

*Builder sa rozhodne:* raw kruhový buffer (jednoduchší, riziko orezaného escape kódu na začiatku — vyriešiť
napr. resetom terminálu pred prehratím) alebo snímok obrazovky z desktopového xterm cez `@xterm/addon-serialize`.

### Veľkosť terminálu

PTY má jednu veľkosť. Pravidlo (moje rozhodnutie): **veľkosť určuje zariadenie, ktoré session naposledy
aktívne použilo.** Na mobile je to už otvorenie session (inak by bol terminál v šírke desktopu, 150+ stĺpcov,
na mobile nečitateľný), ďalej písanie. Na PC písanie alebo klik do terminálu, prípadne zmena veľkosti okna.
Vtedy sa PTY vráti na rozmer desktopu. Desktopový xterm počas mobilného ovládania môže dočasne ukazovať
zalomenie podľa mobilu; po návrate sa prekreslí.

### Prečítané a upozornenia

Otvorenie session na mobile sa počíta ako „videné“, rovnako ako keby bola viditeľná a zameraná na desktope:
zruší značku neprečítané a položky pozornosti, aby desktop po návrate neukazoval vybavené veci ako nevybavené
(moje rozhodnutie). Vyžaduje to správu mobil → desktop. Systémové notifikácie na desktope sa v prvej verzii nemenia.

### Napájanie a beh okna

Uspávanie PC si používateľ nastaví sám v systéme. Project Desk ho nedrží hore (jeho rozhodnutie).
Okno môže byť minimalizované, za iným oknom alebo pod zamknutou obrazovkou. Builder musí zabezpečiť, že
desktopový webview v takom stave nie je škrtený tak, že prestane posielať ack výstupu a snímky stavu
(webview je jediný zdroj pravdy; pri škrtení by zamrzol desktop aj mobil).

### Sieť a prístup

- Server počúva len na **loopbacku** na pevnom porte (nastaviteľnom).
- Prístup zvonku cez `tailscale serve`, ktorý to sprístupní ako HTTPS len v tailnete používateľa.
  Nastavenia ukážu presný príkaz na skopírovanie (napr. `tailscale serve --bg <port>`) a stav, či server beží.
  Project Desk Tailscale neinštaluje ani nekonfiguruje sám.
- **Adresa v tailnete** (`https://<pc>.<tailnet>.ts.net`) je potrebná pre párovací odkaz/QR aj pre kontrolu
  `Origin`. Project Desk ju zistí len čítaním z `tailscale` CLI (`status --json`, `serve status`; spúšťať
  so samostatnými argumentmi, bez shellu). Z toho zistí aj, či `serve` beží. Ak CLI nie je
  dostupné, používateľ adresu zadá v nastaveniach ručne (moje rozhodnutie).
- **Párovanie:** v nastaveniach sa zobrazí párovací odkaz/QR s náhodným tokenom. Mobil si token uloží;
  tlačidlo „vygenerovať nový“ zneplatní staré zariadenia. Token sa overuje pri HTTP aj WebSocket spojení,
  WebSocket kontroluje aj `Origin`. Token sa ukladá v stave appky, nie v plaintext logoch.
- Server servuje len mobilnú stránku a jej API; žiadne iné súbory z disku.

### Mobilná stránka

Samostatný Vite vstup (napr. `remote.html` + `src/remote/*.ts`), zbalený do `dist/` a servovaný z Rustu
(cez Tauri asset resolver alebo embed). Obrazovky:

1. **Zoznam:** projekty → sessions so stavom, rovnaké farby/ikonky ako desktop.
2. **Session:** hlavička (projekt, session, stav, späť), xterm na celú plochu, riadok špeciálnych kláves,
   pole na písanie textu s tlačidlom Odoslať (spoľahlivejšie než písanie priamo do xterm na mobile).
3. Stav spojenia (pripojené / odpojené, automatické znovupripojenie).

Vzhľad: tmavá téma ako desktop; detaily sa doladia neskôr.

## Rozhodnutia, ktoré som urobil sám (na kontrolu)

- Tailscale + `tailscale serve` namiesto vlastného relay servera alebo Cloudflare Tunnel.
- Server len na loopbacku + token, aj keď je tailnet už súkromný (obrana do hĺbky).
- Desktop ostáva zdrojom pravdy; bez desktopového okna žiadny vzdialený prístup.
- „Kto session naposledy aktívne použil, ten určuje veľkosť terminálu“; na mobile už samotné otvorenie.
- Otvorenie session na mobile ju označí ako prečítanú aj na desktope.
- Adresa v tailnete sa číta z `tailscale` CLI, s ručným zadaním ako záloha.
- Klávesový riadok a samostatné textové pole už v prvej verzii.
- Mobil v prvej verzii nespúšťa ani nereštartuje sessions — len ovláda bežiace.

## Necháva sa na buildera

Voľba HTTP/WebSocket knižnice v Ruste (napr. axum na existujúcom tokio runtime Tauri), formát správ,
veľkosť buffra, spôsob prehratia histórie (pozri vyššie), presné umiestnenie nastavení v UI, štruktúra
mobilného kódu, testovacia stratégia pre server a protokol.
