# Project Desk (desktop app)

Samostatná aplikácia na správu terminálov s Claude Code, Codexom a shellom naprieč projektmi. Nahrádza rozšírenie do Cursora (`C:\Users\adria\project-desk`). Editor sa otvára len na požiadanie tlačidlom ↗.

## Čo vie

- **Projekty a relácie** v bočnom paneli, šírka sa mení ťahaním. Pri projekte sú tlačidlá ✳ Claude, ‹› Codex, ▣ Shell, ↗ editor, ☆ pripnúť a ✕. Poradie projektov sa mení ťahaním, pripnuté sú vždy hore.
- **Stav Claude z hookov:** Pracuje · Čaká na teba · Hotovo · Pripravený · Agent skončil. Claude dostane `--settings` s HTTP hookmi na lokálny endpoint aplikácie. Tvoje `~/.claude` nastavenia sa nemenia.
- **Stav Codexu zo session súboru:** Pracuje · Hotovo. Aplikácia číta z `~/.codex/sessions` iba typ udalosti (`task_started`, `task_complete`). Codex hooky by vyžadovali zmenu jeho konfigurácie, preto sa nepoužívajú.
- **Info o relácii** (ⓘ alebo pravý klik): model, kontext, tokeny (nové, z cache, výstup), pri Codexe aj minutý limit, ID konverzácie. Čísla platia pre aktuálnu konverzáciu; po `/clear` sa počíta odznova.
- **Notifikácie** systému a neprečítaná bodka, keď agent skončí alebo čaká a ty sa práve nepozeráš.
- **Pokračovanie po reštarte.** Po spustení sa relácie obnovia (Claude cez `--resume <id>`, Codex cez `codex resume <id>`); dá sa vypnúť v nastaveniach.
- **Šablóny promptov** (✦ alebo Ctrl+Shift+T): spoločné alebo pre konkrétny projekt. Vložia sa do aktívnej relácie ako jeden paste, voliteľne sa hneď odošlú.
- **Hľadanie v termináli** (Ctrl+Shift+F), Enter ďalší, Shift+Enter predchádzajúci.
- **Ctrl+klik** na URL otvorí prehliadač, na cestu k súboru (`src/main.ts:120`) editor na danom riadku.
- **Výber editora** v ⚙ Nastaveniach. Ponúknu sa nainštalované editory: Cursor, VS Code, Windsurf, VSCodium, Zed, Sublime, JetBrains IDE, Notepad++. Hľadajú sa podľa inštalácie (Windows register s kontrolou vydavateľa, macOS bundle ID, Linux PATH), nie podľa PATH, lebo Cursor si do PATH pridáva aj vlastný `code`. „Iný program…“ = cesta k programu + argumenty s `%TARGET_PATH%` a `%LINE%`. Editor sa spúšťa priamo, bez shellu, a mimo Job Objectu, takže zatvorenie appky ho neukončí.
- **Mriežka 2×2** (Ctrl+G) zobrazí až 4 bežiace relácie naraz. **Ctrl+K** hľadá relácie.
- Zatvorenie terminálu (✕ alebo `exit`) odstráni položku zo zoznamu.
- Terminál: Ctrl+C kopíruje označený text (inak preruší proces), Ctrl+V vkladá, Shift+Enter dá v Claude nový riadok.

## Technológie a prečo

| Vrstva | Voľba | Prečo |
|---|---|---|
| Shell aplikácie | **Tauri 2** (Rust) | Používa systémový WebView (WebView2 / WKWebView / WebKitGTK) namiesto pribaleného Chromia. Inštalátor má pár MB, menej RAM než Electron. Funguje na Windows, macOS aj Linuxe. |
| Terminál | **xterm.js 6** + WebGL renderer, addony search a web-links | Rovnaký emulátor ako VS Code a Cursor. WebGL sa pripája len k viditeľným terminálom. |
| PTY | **portable-pty** (z WezTermu) | ConPTY na Windows, openpty na Unixe, jedno API. |
| Stav agenta | Claude Code **HTTP hooky** + `tiny_http`; Codex session súbor | Spoľahlivé udalosti namiesto parsovania výstupu. Posiela sa iba typ udalosti, nikdy text promptov. |
| UI | Vanilla TypeScript + Vite | Bez frameworku, malý bundle. |

## Bezpečnosť

- Do shellového príkazu ide iba príkaz z nastavení, overené UUID a odkaz na env premennú. Názov projektu ani úlohy sa tam nikdy nedostane, `cwd` sa nastavuje cez option.
- Hook endpoint počúva iba na `127.0.0.1`, na náhodnom porte, s náhodným tokenom v hlavičke. Telo hooku sa obmedzí na typ udalosti a ID relácie.
- Zo session súborov agentov sa berú iba čísla a typy udalostí; text konverzácie sa neukladá ani neposiela do UI.
- Šablóny sa vkladajú ako bracketed paste; ukončovacia sekvencia v texte sa odstráni, takže text sa nedá vykonať ako príkaz shellu.
- Editor sa spúšťa priamo ako program so zoznamom argumentov, bez `cmd`/shellu; cesta je vždy samostatný argument. Vlastný program musí byť na Windows `.exe`/`.com`.
- **Poistka proti sirotám:** na Windows je aplikácia v Job Objecte s `KILL_ON_JOB_CLOSE`, takže pri jej skončení (aj páde) zaniknú všetky terminály a agenti. Na macOS/Linuxe sa pri zatvorení posiela SIGHUP celej skupine procesov terminálu.
- Predvolený Claude príkaz je `claude --dangerously-skip-permissions`, Codex `--dangerously-bypass-approvals-and-sandbox`. Agent vtedy vykonáva príkazy bez pýtania. Zmena: ⚙ Nastavenia.

## Vývoj

Potrebuješ Node 22+, Rust (rustup) a na Windows MSVC Build Tools.

```powershell
npm install
npm run app:dev       # vývojová verzia s oddeleným stavom („Project Desk (dev)“)
npm test              # unit testy doménovej logiky
cd src-tauri; cargo test
npm run tauri build   # release: src-tauri\target\release\project-desk.exe + NSIS inštalátor
```

Stav sa ukladá do `%APPDATA%\eu.effistream.projectdesk\state.json`.

## Ďalej (nápady)

- automatické aktualizácie a build pre macOS/Linux cez GitHub Actions
- skratky Ctrl+1–9
