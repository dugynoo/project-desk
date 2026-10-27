import { invoke } from "@tauri-apps/api/core";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebglAddon } from "@xterm/addon-webgl";
import type { MonitoredRuntime } from "./agent-monitor.ts";
import { createSearchBar } from "./terminal-search.ts";
import { $, el } from "./dom.ts";
import { errorText } from "./i18n.ts";
import { copiedText, isUuid, type Session, type PersistedState, type Status } from "./model.ts";

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
  /** Odkaz pod myšou, pre menu na pravom kliku. */
  hoverLink?: { url: string } | { file: string; line?: number };
}

export function attachWebgl(rt: Runtime) {
  try {
    const gl = new WebglAddon();
    gl.onContextLoss(() => {
      gl.dispose();
      rt.webgl = undefined;
    });
    rt.term.loadAddon(gl);
    rt.webgl = gl;
  } catch {
    rt.webgl = undefined; // DOM renderer stačí
  }
}

interface Dependencies {
  toast: (message: string) => void;
  getState: () => PersistedState;
  runtimes: Map<string, Runtime>;
  setupLinks: (rt: Runtime, session: Session) => void;
  isAppShortcut: (event: KeyboardEvent) => boolean;
  handleGlobalKey: (event: KeyboardEvent) => boolean;
  isWatched: (id: string) => boolean;
  unread: Set<string>;
  renderSidebar: () => void;
  notify: (id: string, status: Status) => Promise<void>;
  select: (id: string, focus?: boolean) => void;
}

/** Owns xterm construction and input events; process lifetime is managed separately. */
export function createTerminalFactory({ toast, getState, runtimes, setupLinks, isAppShortcut, handleGlobalKey,
  isWatched, unread, renderSidebar, notify, select }: Dependencies) {
  return function createRuntime(s: Session): Runtime {
    const pane = el("div", "pane");
    const head = el("div", "pane-head");
    const host = el("div", "term");
    pane.append(head, host);
    $("#stage").append(pane);

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace',
      fontSize: getState().settings.fontSize,
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
      theme: { background: "#111317", foreground: "#e6e8ee", cursor: "#7cc4ff", selectionBackground: "#2d3a52" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const search = new SearchAddon();
    term.loadAddon(search);
    // Agents measure emoji such as ✅ as two cells; the default Unicode 6 widths break their table borders.
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = "11";
    term.open(host);

    const searchBar = createSearchBar(term, search, isAppShortcut);
    pane.append(searchBar);
    const rt: Runtime = { term, fit, search, searchBar, pane, host, head, running: false, closing: false };
    setupLinks(rt, s);

    let lastInputError = -Infinity;
    const writeInput = (data: string) => {
      if (!rt.running) return;
      void invoke("pty_write", { id: s.id, data }).catch((error: unknown) => {
        if (!rt.running || rt.closing) return;
        // Holding a key against a stalled process must not flood the UI.
        const now = performance.now();
        if (now - lastInputError >= 3000) {
          lastInputError = now;
          toast(errorText(error));
        }
      });
    };

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const mod = e.ctrlKey || e.metaKey;
      if (isAppShortcut(e) && $("#overlay").hidden) return handleGlobalKey(e);
      // Ctrl+C kopíruje, keď je niečo označené; inak ide do procesu ako prerušenie.
      if (mod && e.key.toLowerCase() === "c" && term.hasSelection()) {
        // Agenti lámu dlhé vety sami; v shelli môžu byť riadky zarovnané zámerne (stĺpce, tabuľky).
        const columns = s.provider === "shell" ? undefined : term.cols;
        void navigator.clipboard.writeText(copiedText(term.getSelection(), term.getSelectionPosition()?.start.x, columns));
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
      writeInput(data);
    });
    term.onResize(({ cols, rows }) => {
      if (rt.running) void invoke("pty_resize", { id: s.id, cols, rows }).catch(() => {});
    });
    term.onBell(() => {
      // Claude a Codex so známou konverzáciou hlásia stav inak; zvonček by notifikáciu zdvojil.
      const tracked = (s.provider === "claude" || s.provider === "antigravity") || (s.provider === "codex" && isUuid(s.agentSessionId));
      if (!tracked && !isWatched(s.id)) {
        unread.add(s.id);
        renderSidebar();
        void notify(s.id, "needs-you");
      }
    });
    term.textarea?.addEventListener("focus", () => {
      if (getState().ui.activeSessionId !== s.id) select(s.id, false);
    });
    head.addEventListener("click", event => {
      if (!(event.target instanceof Element && event.target.closest("button"))) select(s.id);
    });

    runtimes.set(s.id, rt);
    return rt;
  };
}
