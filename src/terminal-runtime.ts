import { writeClipboard } from "./clipboard.ts";
import { call } from "./ipc.ts";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebglAddon } from "@xterm/addon-webgl";
import type { MonitoredRuntime } from "./agent-monitor.ts";
import { createSearchBar } from "./terminal-search.ts";
import { $, el } from "./dom.ts";
import { errorText } from "./i18n.ts";
import { terminalTheme } from "./theme.ts";
import { appWheelSteps, copiedText, isTypedInput, isUuid, normalizeScrollback, type Session, type PersistedState, type Status } from "./model.ts";

export interface Runtime extends MonitoredRuntime {
  outputId?: string;
  term: Terminal;
  fit: FitAddon;
  webgl?: WebglAddon;
  search: SearchAddon;
  searchBar: HTMLElement;
  pane: HTMLElement;
  host: HTMLElement;
  head: HTMLElement;
  /** Odložená zmena šírky, pozri fitTerminal. */
  colsTimer?: ReturnType<typeof setTimeout>;
  /** Mobil prebral veľkosť PTY; desktop ju vráti pri vlastnej aktivite. */
  remoteSized?: boolean;
  /** Odkaz pod myšou, pre menu na pravom kliku. */
  hoverLink?: { url: string } | { file: string; line?: number };
  /** Tento terminál stratil WebGL kontext; ostane na DOM rendereri. */
  webglLost?: boolean;
}

// Ako VS Code: terminál, ktorý stratil kontext, ostane na DOM rendereri, inak by sa WebGL
// skúšal znova pri každom layoute. Ak WebGL nejde vytvoriť alebo ho stratí viac terminálov
// (resetované GPU), DOM renderer dostanú všetky.
let webglFailed = false;
let webglLosses = 0;
export function attachWebgl(rt: Runtime) {
  if (webglFailed || rt.webglLost) return;
  let gl: WebglAddon | undefined;
  try {
    gl = new WebglAddon();
    gl.onContextLoss(() => {
      rt.webglLost = true;
      if (++webglLosses >= 3) webglFailed = true;
      gl?.dispose();
      rt.webgl = undefined;
    });
    rt.term.loadAddon(gl);
    rt.webgl = gl;
  } catch {
    webglFailed = true;
    gl?.dispose();
    rt.webgl = undefined; // DOM renderer stačí
  }
}

/** Desktop si vezme veľkosť PTY späť od mobilu (rozmery sú tie z desktopového xtermu). */
export function reclaimSize(rt: Runtime, id: string) {
  if (!rt.remoteSized) return;
  rt.remoteSized = false;
  if (rt.running) void call("pty_resize", { id, cols: rt.term.cols, rows: rt.term.rows }).catch(() => {});
}

/**
 * Ako terminál vo VS Code: pri dlhej histórii mení výšku hneď, ale šírku až po
 * 100 ms pokoja. Prepočet zalomenia je drahý a agent pri každej zmene šírky prekresľuje,
 * takže ťahanie okna mu nepošle desiatky zmien za sebou.
 */
export function fitTerminal(rt: Runtime) {
  const dims = rt.fit.proposeDimensions();
  if (!dims || isNaN(dims.cols) || isNaN(dims.rows)) return;
  const { term } = rt;
  clearTimeout(rt.colsTimer);
  rt.colsTimer = undefined;
  if (term.buffer.normal.length < 200) {
    if (dims.cols !== term.cols || dims.rows !== term.rows) term.resize(dims.cols, dims.rows);
    return;
  }
  if (dims.rows !== term.rows) term.resize(term.cols, dims.rows);
  if (dims.cols === term.cols) return;
  rt.colsTimer = setTimeout(() => {
    rt.colsTimer = undefined;
    const latest = rt.fit.proposeDimensions();
    if (latest && !isNaN(latest.cols) && !isNaN(latest.rows) && (latest.cols !== term.cols || latest.rows !== term.rows)) term.resize(latest.cols, latest.rows);
  }, 100);
}

interface Dependencies {
  toast: (message: string) => void;
  getState: () => PersistedState;
  /** macOS: kopírovanie a vkladanie je na Cmd, Ctrl ostáva terminálu. */
  isMac: () => boolean;
  runtimes: Map<string, Runtime>;
  setupLinks: (rt: Runtime, session: Session) => void;
  isAppShortcut: (event: KeyboardEvent) => boolean;
  handleGlobalKey: (event: KeyboardEvent) => boolean;
  isWatched: (id: string) => boolean;
  unread: Set<string>;
  renderSidebar: () => void;
  notify: (id: string, status: Status) => Promise<void>;
  select: (id: string, focus?: boolean) => void;
  /** Text the user typed or pasted (not terminal replies such as focus reports). */
  onTyped?: (id: string) => void;
}

/** Owns xterm construction and input events; process lifetime is managed separately. */
export function createTerminalFactory({ toast, getState, isMac, runtimes, setupLinks, isAppShortcut, handleGlobalKey,
  isWatched, unread, renderSidebar, notify, select, onTyped }: Dependencies) {
  return function createRuntime(s: Session): Runtime {
    const pane = el("div", "pane");
    const head = el("div", "pane-head");
    const host = el("div", "term");
    pane.append(head, host);
    $("#stage").append(pane);

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace',
      fontSize: getState().settings.fontSize,
      // Bliká len aktívny terminál (`layout`), skryté nebudia procesor.
      cursorBlink: false,
      scrollback: normalizeScrollback(getState().settings.terminalScrollback),
      allowProposedApi: true,
      theme: terminalTheme(getState().settings.theme),
      macOptionIsMeta: getState().settings.optionAsMeta,
      // Codex TUI a vim zachytávajú myš; Option+ťahanie potom aj tak označí text.
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    // Agents measure emoji such as ✅ and ✍️ (base + VS16) as two cells; Unicode 6/11 widths
    // ignore the variation selector and shift their table borders. The addon activates "15-graphemes".
    term.loadAddon(new UnicodeGraphemesAddon());
    term.open(host);

    const searchBar = createSearchBar(term, search, isAppShortcut);
    pane.append(searchBar);
    const rt: Runtime = { term, fit, search, searchBar, pane, host, head, running: false, closing: false };
    setupLinks(rt, s);

    let lastInputError = -Infinity;
    const writeInput = (data: string) => {
      if (!rt.running) return;
      void call("pty_write", { id: s.id, data }).catch((error: unknown) => {
        if (!rt.running || rt.closing) return;
        // Holding a key against a stalled process must not flood the UI.
        const now = performance.now();
        if (now - lastInputError >= 3000) {
          lastInputError = now;
          toast(errorText(error));
        }
      });
    };

    // In the alternate screen or with mouse tracking (Codex TUI, vim), xterm.js 6 turns each wheel event
    // into a single arrow key or wheel report, so one mouse notch moves just one line. Replay the event
    // so the app receives a native terminal's three steps per notch.
    const replayedWheel = new WeakSet<WheelEvent>();
    term.attachCustomWheelEventHandler((e) => {
      if (replayedWheel.has(e) || e.shiftKey) return true;
      if (term.buffer.active.type !== "alternate" && term.modes.mouseTrackingMode === "none") return true;
      const target = e.target instanceof Element ? e.target : host;
      for (let i = 1; i < appWheelSteps(e.deltaY, e.deltaMode); i++) {
        const copy = new WheelEvent("wheel", {
          deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY,
          ctrlKey: e.ctrlKey, altKey: e.altKey, metaKey: e.metaKey, bubbles: true, cancelable: true,
        });
        replayedWheel.add(copy);
        target.dispatchEvent(copy);
      }
      return true;
    });

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      reclaimSize(rt, s.id);
      // Na macu ide Ctrl do terminálu (Ctrl+C preruší, Ctrl+V vloží obrázok v Claude Code).
      const mod = isMac() ? e.metaKey : e.ctrlKey;
      if (isAppShortcut(e) && $("#overlay").hidden) return handleGlobalKey(e);
      // Ctrl+C kopíruje, keď je niečo označené; inak ide do procesu ako prerušenie.
      if (mod && e.key.toLowerCase() === "c" && term.hasSelection()) {
        // Zalomenie od agenta sa od dvoch riadkov kódu odlíšiť nedá, preto riadky spája len Ctrl+Shift+C.
        // V shelli môžu byť riadky zarovnané zámerne (stĺpce, tabuľky).
        const columns = e.shiftKey && s.provider !== "shell" ? term.cols : undefined;
        void writeClipboard(copiedText(term.getSelection(), term.getSelectionPosition()?.start.x, columns));
        term.clearSelection();
        e.preventDefault();
        return false;
      }
      // Ctrl+V nechá prehliadač vyvolať paste, ktorý xterm spracuje (vrátane bracketed paste).
      if (mod && e.key.toLowerCase() === "v") return false;
      // Shift+Enter = nový riadok v Claude Code (rovnako ako Alt+Enter).
      if (e.key === "Enter" && e.shiftKey && !mod) {
        writeInput("\x1b\r");
        e.preventDefault();
        return false;
      }
      return true;
    });

    term.onData((data) => {
      if (isTypedInput(data)) onTyped?.(s.id);
      writeInput(data);
    });
    // Zmena rozmerov na desktope (aj z fitTerminal) posiela veľkosť sama, takže vráti aj nárok od mobilu.
    term.onResize(({ cols, rows }) => {
      rt.remoteSized = false;
      if (rt.running) void call("pty_resize", { id: s.id, cols, rows }).catch(() => {});
    });
    term.onBell(() => {
      // Claude a Codex so známou konverzáciou hlásia stav inak; zvonček by notifikáciu zdvojil.
      const tracked = (s.provider === "claude" || s.provider === "antigravity") || (s.provider === "codex" && isUuid(s.agentSessionId));
      // Kým relácia nie je prečítaná, ďalšie zvončeky nič nepridajú (cat binárky ich pošle stovky).
      if (!tracked && !isWatched(s.id) && !unread.has(s.id)) {
        unread.add(s.id);
        renderSidebar();
        void notify(s.id, "needs-you");
      }
    });
    term.textarea?.addEventListener("focus", () => {
      reclaimSize(rt, s.id);
      if (getState().ui.activeSessionId !== s.id) select(s.id, false);
    });
    head.addEventListener("click", event => {
      if (!(event.target instanceof Element && event.target.closest("button"))) select(s.id);
    });

    runtimes.set(s.id, rt);
    return rt;
  };
}
