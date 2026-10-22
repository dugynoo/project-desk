import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";

import {
  agentCommand,
  type AgentStats,
  ATTENTION,
  type AgentEvent,
  byRecent,
  clampSidebar,
  codexStatusAfter,
  CUSTOM_EDITOR,
  type EditorInfo,
  findFileRefs,
  folderName,
  formatTokens,
  isUuid,
  matches,
  moveProject,
  orderedProjects,
  parseState,
  pasteSequence,
  type PersistedState,
  type Project,
  type PromptTemplate,
  PROVIDER_LABEL,
  type Provider,
  type Session,
  type Settings,
  sessionByNumber,
  sessionsOf,
  type Status,
  statusAfter,
  templatesFor,
} from "./model.ts";
import { errorText, type Key, LANGUAGES, locale, setLang, t, translateDocument } from "./i18n.ts";

interface AppInfo {
  platform: string;
  hooksEnabled: boolean;
  stateFile: string;
  updates: boolean;
}

interface Runtime {
  term: Terminal;
  fit: FitAddon;
  webgl?: WebglAddon;
  search: SearchAddon;
  searchBar: HTMLElement;
  pane: HTMLElement;
  host: HTMLElement;
  head: HTMLElement;
  running: boolean;
  closing: boolean;
}

const PROVIDER_ICON: Record<Provider, string> = { claude: "✳", codex: "‹›", shell: "▣" };
const MAX_GRID = 4;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

let info: AppInfo = { platform: "windows", hooksEnabled: false, stateFile: "", updates: false };
let state: PersistedState = parseState(null).state;
const runtimes = new Map<string, Runtime>();
const statuses = new Map<string, Status>();
const unread = new Set<string>();
/** Štatistiky z session súboru agenta; platia iba pre konverzáciu `agentId` (po /clear sa začína odznova). */
const agentStats = new Map<string, { agentId: string; stats: AgentStats }>();
let windowFocused = true;

// ---------- perzistencia ----------

let saveTimer: number | undefined;
function save() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    invoke("save_state", { json: JSON.stringify(state, null, 2) }).catch((e) =>
      toast(t("app.saveFailed", { detail: String(e) })),
    );
  }, 250);
}

// ---------- pomocníci ----------

const project = (id: string) => state.projects.find((p) => p.id === id);
const session = (id: string | undefined) => (id ? state.sessions.find((s) => s.id === id) : undefined);
const statusOf = (id: string): Status => statuses.get(id) ?? "sleeping";
const statsOf = (s: Session) => {
  const entry = agentStats.get(s.id);
  return entry && entry.agentId === s.agentSessionId ? entry.stats : undefined;
};
const contextLabel = (s: Session) => {
  const ctx = statsOf(s)?.contextTokens;
  return ctx ? t("app.context", { n: formatTokens(ctx) }) : "";
};
const statusLabel = (s: Status) => t(`status.${s}` as Key);

function toast(msg: string) {
  const t = el("div", "toast", msg);
  document.body.append(t);
  window.setTimeout(() => t.remove(), 6000);
}

function setStatus(id: string, next: Status) {
  const prev = statusOf(id);
  if (prev === next) return;
  statuses.set(id, next);
  if (ATTENTION.has(next) && !isWatched(id)) {
    unread.add(id);
    notify(id, next);
  }
  renderSidebar();
  renderPaneHeads();
}

/** Používateľ práve reláciu vidí (je v zobrazení a okno má fokus). */
function isWatched(id: string) {
  return windowFocused && visibleIds().includes(id);
}

async function notify(id: string, status: Status) {
  const s = session(id);
  if (!s || !state.settings.notifications) return;
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (!ok) return;
    const p = project(s.projectId);
    sendNotification({ title: `${statusLabel(status)} · ${s.title}`, body: `${p?.name ?? ""} · ${PROVIDER_LABEL[s.provider]}` });
  } catch {
    // Notifikácie sú bonus; keď nejdú, ostane bodka v zozname.
  }
}

// ---------- zobrazenie (jedna relácia alebo mriežka) ----------

function visibleIds(): string[] {
  const active = state.ui.activeSessionId;
  if (!state.ui.grid) return active && runtimes.has(active) ? [active] : [];
  const running = byRecent(state.sessions.filter((s) => runtimes.has(s.id))).map((s) => s.id);
  if (active && runtimes.has(active) && !running.slice(0, MAX_GRID).includes(active)) {
    running.splice(MAX_GRID - 1, 0, active);
  }
  return running.slice(0, MAX_GRID).sort((a, b) => session(a)!.createdAt - session(b)!.createdAt);
}

function layout() {
  const ids = visibleIds();
  const stage = $("#stage");
  stage.className = state.ui.grid && ids.length > 1 ? `grid-${ids.length}` : "";
  $("#empty").style.display = ids.length ? "none" : "";
  for (const [id, rt] of runtimes) {
    const show = ids.includes(id);
    rt.pane.classList.toggle("visible", show);
    rt.pane.style.order = String(ids.indexOf(id));
    rt.pane.classList.toggle("focused", id === state.ui.activeSessionId);
    // WebGL kontext len pre viditeľné terminály: šetrí GPU pamäť a obchádza limit kontextov.
    if (show && !rt.webgl) attachWebgl(rt);
    if (!show && rt.webgl) {
      rt.webgl.dispose();
      rt.webgl = undefined;
    }
  }
  requestAnimationFrame(fitVisible);
  $("#btn-grid").classList.toggle("on", state.ui.grid);
}

function attachWebgl(rt: Runtime) {
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

function fitVisible() {
  for (const id of visibleIds()) {
    const rt = runtimes.get(id);
    if (!rt) continue;
    try {
      rt.fit.fit();
    } catch {
      // kontajner ešte nemá rozmery
    }
  }
}

function renderPaneHeads() {
  for (const [id, rt] of runtimes) {
    const s = session(id);
    if (!s) continue;
    const p = project(s.projectId);
    rt.head.textContent = `${PROVIDER_ICON[s.provider]} ${s.title} · ${p?.name ?? ""} · ${statusLabel(statusOf(id))}${contextLabel(s)}`;
  }
}

// ---------- terminály ----------

function createRuntime(s: Session): Runtime {
  const pane = el("div", "pane");
  const head = el("div", "pane-head");
  const host = el("div", "term");
  pane.append(head, host);
  $("#stage").append(pane);

  const term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: { background: "#111317", foreground: "#e6e8ee", cursor: "#7cc4ff", selectionBackground: "#2d3a52" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const search = new SearchAddon();
  term.loadAddon(search);
  term.open(host);

  const searchBar = createSearchBar(term, search);
  pane.append(searchBar);
  const rt: Runtime = { term, fit, search, searchBar, pane, host, head, running: false, closing: false };
  setupLinks(rt, s);

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    const mod = e.ctrlKey || e.metaKey;
    if (isAppShortcut(e)) return handleGlobalKey(e);
    // Ctrl+C kopíruje, keď je niečo označené; inak ide do procesu ako prerušenie.
    if (mod && e.key.toLowerCase() === "c" && term.hasSelection()) {
      void navigator.clipboard.writeText(term.getSelection());
      term.clearSelection();
      e.preventDefault();
      return false;
    }
    // Ctrl+V nechá prehliadač vyvolať paste, ktorý xterm spracuje (vrátane bracketed paste).
    if (mod && e.key.toLowerCase() === "v") return false;
    // Shift+Enter = nový riadok v Claude Code (rovnako ako Alt+Enter).
    if (e.key === "Enter" && e.shiftKey && !mod) {
      void invoke("pty_write", { id: s.id, data: "\x1b\r" });
      e.preventDefault();
      return false;
    }
    return true;
  });

  term.onData((data) => {
    if (rt.running) void invoke("pty_write", { id: s.id, data }).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    if (rt.running) void invoke("pty_resize", { id: s.id, cols, rows }).catch(() => {});
  });
  term.onBell(() => {
    // Claude a Codex so známou konverzáciou hlásia stav inak; zvonček by notifikáciu zdvojil.
    const tracked = s.provider === "claude" || (s.provider === "codex" && isUuid(s.agentSessionId));
    if (!tracked && !isWatched(s.id)) {
      unread.add(s.id);
      renderSidebar();
      void notify(s.id, "needs-you");
    }
  });
  term.textarea?.addEventListener("focus", () => {
    if (state.ui.activeSessionId !== s.id) select(s.id, false);
  });
  head.addEventListener("click", () => select(s.id));

  runtimes.set(s.id, rt);
  return rt;
}

const SEARCH_OPTIONS = {
  decorations: {
    matchBackground: "#3a4a63",
    matchOverviewRuler: "#7cc4ff",
    activeMatchBackground: "#b8860b",
    activeMatchColorOverviewRuler: "#ffb454",
  },
};

/** Hľadanie v histórii terminálu (Ctrl+Shift+F). */
function createSearchBar(term: Terminal, search: SearchAddon): HTMLElement {
  const bar = el("div", "search-bar");
  bar.hidden = true;
  const input = el("input");
  input.type = "text";
  // data-i18n-* nech sa texty preložia aj v už otvorených termináloch po zmene jazyka.
  input.dataset.i18nPlaceholder = "search.placeholder";
  input.placeholder = t("search.placeholder");
  input.spellcheck = false;
  const count = el("span", "count");
  const close = () => {
    bar.hidden = true;
    search.clearDecorations();
    term.focus();
  };
  const find = (back: boolean, incremental = false) => {
    if (!input.value) return;
    if (back) search.findPrevious(input.value, SEARCH_OPTIONS);
    else search.findNext(input.value, { ...SEARCH_OPTIONS, incremental });
  };
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    count.textContent = !input.value ? "" : resultCount ? `${resultIndex + 1}/${resultCount}` : t("search.none");
  });
  input.addEventListener("input", () => {
    if (input.value) find(false, true);
    else {
      search.clearDecorations();
      count.textContent = "";
    }
  });
  input.addEventListener("keydown", (e) => {
    if (isAppShortcut(e)) return;
    e.stopPropagation();
    if (e.key === "Enter") find(e.shiftKey);
    else if (e.key === "Escape") close();
  });
  const button = (label: string, key: Key, onClick: () => void) => {
    const b = iconButton(label, t(key), onClick);
    b.dataset.i18nTitle = key;
    return b;
  };
  bar.append(
    input,
    count,
    button("↑", "search.prev", () => find(true)),
    button("↓", "search.next", () => find(false)),
    button("✕", "search.close", close),
  );
  return bar;
}

function openSearch(rt: Runtime) {
  const input = rt.searchBar.querySelector("input")!;
  if (rt.term.hasSelection() && !rt.term.getSelection().includes("\n")) input.value = rt.term.getSelection();
  rt.searchBar.hidden = false;
  input.focus();
  input.select();
  if (input.value) rt.search.findNext(input.value, { ...SEARCH_OPTIONS, incremental: true });
}

/** Ctrl+klik na URL otvorí prehliadač, na cestu k súboru editor (aj na riadku). */
function setupLinks(rt: Runtime, s: Session) {
  const hint = (key: Key) => () => (rt.host.title = t(key));
  const leave = () => (rt.host.title = "");
  const wantsOpen = (e: MouseEvent) => e.ctrlKey || e.metaKey;
  rt.term.loadAddon(
    new WebLinksAddon(
      (e, uri) => {
        if (wantsOpen(e)) void openUrl(uri).catch((err) => toast(t("link.openFailed", { detail: String(err) })));
      },
      { hover: hint("link.urlHint"), leave },
    ),
  );
  rt.term.registerLinkProvider({
    provideLinks(y, callback) {
      const p = project(s.projectId);
      const text = rt.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const refs = p ? findFileRefs(text) : [];
      if (!refs.length) return callback(undefined);
      void Promise.all(refs.map((r) => resolveFile(p!.path, r.path))).then((resolved) => {
        const links = refs.flatMap((r, i) => {
          const file = resolved[i];
          if (!file) return [];
          return [
            {
              range: { start: { x: r.index + 1, y }, end: { x: r.index + r.length, y } },
              text: text.slice(r.index, r.index + r.length),
              activate: (e: MouseEvent) => {
                if (wantsOpen(e)) openEditor(file, r.line);
              },
              hover: hint("link.fileHint"),
              leave,
            },
          ];
        });
        callback(links.length ? links : undefined);
      });
    },
  });
}

const resolved = new Map<string, string | null>();
async function resolveFile(cwd: string, candidate: string): Promise<string | null> {
  const key = `${cwd}\n${candidate}`;
  if (resolved.has(key)) return resolved.get(key)!;
  const file = await invoke<string | null>("resolve_file", { cwd, candidate }).catch(() => null);
  if (resolved.size > 2000) resolved.clear();
  // Neexistujúce cesty si pamätáme len chvíľu, súbor môže agent práve vytvoriť.
  resolved.set(key, file);
  if (!file) window.setTimeout(() => resolved.delete(key), 10_000);
  return file;
}

function disposeRuntime(id: string) {
  const rt = runtimes.get(id);
  if (!rt) return;
  rt.webgl?.dispose();
  rt.term.dispose();
  rt.pane.remove();
  runtimes.delete(id);
}

async function start(s: Session) {
  const p = project(s.projectId);
  if (!p) return;
  // Bez prvého promptu nie je čo obnoviť; nové ID zabráni kolízii s nedokončenou reláciou.
  if (s.provider === "claude" && (!s.hasConversation || !isUuid(s.agentSessionId))) {
    s.agentSessionId = crypto.randomUUID();
    s.hasConversation = false;
  }
  const command = agentCommand(s, state.settings, info.platform, info.hooksEnabled);
  s.lastStartAt = Date.now();
  if (s.provider === "codex" && !s.started) codexLookup.add(s.id);
  const rt = runtimes.get(s.id) ?? createRuntime(s);
  statuses.set(s.id, "starting");
  layout();
  try {
    rt.fit.fit();
  } catch {
    // použijú sa predvolené rozmery
  }

  const output = new Channel<string>();
  output.onmessage = (chunk) => rt.term.write(chunk);
  rt.running = true;
  try {
    await invoke("pty_spawn", {
      args: {
        id: s.id,
        cwd: p.path,
        command: command ?? null,
        shell: state.settings.shell || null,
        cols: rt.term.cols,
        rows: rt.term.rows,
      },
      onOutput: output,
    });
  } catch (e) {
    rt.running = false;
    disposeRuntime(s.id);
    statuses.delete(s.id);
    toast(errorText(e));
    layout();
    renderSidebar();
    return;
  }
  s.started = true;
  statuses.set(s.id, s.provider === "claude" && info.hooksEnabled ? "starting" : "running");
  save();
  renderSidebar();
  renderPaneHeads();
  if (s.id === state.ui.activeSessionId && editing?.id !== s.id) rt.term.focus();
}

// Codex si ID konverzácie vytvorí sám (najneskôr pri prvom prompte), preto ho dohľadávame
// v jeho session súboroch. Len pri úplne novej relácii: tá, čo sa otvorila cez výber
// v `codex resume`, by si inak mohla privlastniť cudziu konverzáciu z toho istého projektu.
const codexLookup = new Set<string>();

async function lookupCodexSessions() {
  for (const id of [...codexLookup]) {
    const s = session(id);
    const p = s && project(s.projectId);
    if (!s || !p || !s.lastStartAt || !runtimes.get(id)?.running || isUuid(s.agentSessionId)) {
      codexLookup.delete(id);
      continue;
    }
    const exclude = state.sessions.filter((x) => x.id !== id && x.agentSessionId).map((x) => x.agentSessionId!);
    const found = await invoke<string | null>("find_codex_session", { cwd: p.path, sinceMs: s.lastStartAt, exclude }).catch(() => null);
    if (isUuid(found) && !isUuid(s.agentSessionId)) {
      s.agentSessionId = found;
      codexLookup.delete(id);
      save();
    }
  }
}

// Tokeny a kontext pre Claude aj Codex, pri Codexe aj stav (Codex nemá hooky bez zásahu do jeho konfigurácie).
let polling = false;
async function pollAgents() {
  if (polling) return;
  polling = true;
  let changed = false;
  try {
    for (const s of [...state.sessions]) {
      const agentId = s.agentSessionId;
      if (s.provider === "shell" || !isUuid(agentId) || !runtimes.get(s.id)?.running) continue;
      const r = await invoke<{ stats: AgentStats; events: string[] } | null>("agent_poll", { provider: s.provider, agentId }).catch(() => null);
      if (!r || s.agentSessionId !== agentId) continue;
      const before = statsOf(s)?.contextTokens;
      agentStats.set(s.id, { agentId, stats: r.stats });
      if (before !== r.stats.contextTokens) changed = true;
      const status = s.provider === "codex" ? codexStatusAfter(r.events.at(-1) ?? "") : undefined;
      if (status && runtimes.has(s.id)) setStatus(s.id, status);
    }
  } finally {
    polling = false;
  }
  if (changed) {
    renderSidebar();
    renderPaneHeads();
  }
}

function onExit(id: string) {
  const rt = runtimes.get(id);
  if (rt) rt.running = false;
  // Zavretý terminál = zmizne aj položka (rovnako ako v rozšírení).
  disposeRuntime(id);
  statuses.delete(id);
  unread.delete(id);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (state.ui.activeSessionId === id) state.ui.activeSessionId = byRecent(state.sessions.filter((s) => runtimes.has(s.id)))[0]?.id;
  save();
  layout();
  renderSidebar();
}

function onAgentEvent(ev: AgentEvent) {
  const s = session(ev.deskSessionId);
  if (!s || s.provider !== "claude") return;
  let changed = false;
  if (isUuid(ev.agentSessionId) && ev.agentSessionId !== s.agentSessionId) {
    s.agentSessionId = ev.agentSessionId;
    s.hasConversation = ev.event !== "SessionStart";
    changed = true;
  }
  if ((ev.event === "UserPromptSubmit" || ev.event === "Stop") && !s.hasConversation) {
    s.hasConversation = true;
    changed = true;
  }
  if (changed) save();
  if (!runtimes.has(s.id)) return;
  const status = statusAfter(statusOf(s.id), ev);
  if (status) setStatus(s.id, status);
}

// ---------- akcie ----------

function select(id: string, focus = true) {
  const s = session(id);
  if (!s) return;
  state.ui.activeSessionId = id;
  s.lastUsedAt = Date.now();
  unread.delete(id);
  save();
  if (!runtimes.has(id)) {
    void start(s);
    renderSidebar();
    return;
  }
  layout();
  renderSidebar();
  if (focus) runtimes.get(id)!.term.focus();
}

function createSession(p: Project, provider: Provider) {
  const n = sessionsOf(state, p.id).filter((s) => s.provider === provider).length + 1;
  const now = Date.now();
  const s: Session = {
    id: crypto.randomUUID(),
    projectId: p.id,
    provider,
    title: `${PROVIDER_LABEL[provider]} ${n}`,
    createdAt: now,
    lastUsedAt: now,
  };
  state.sessions.push(s);
  p.collapsed = false;
  // Terminál sa spustí hneď a názov sa zatiaľ dá prepísať priamo v zozname.
  editing = { id: s.id, draft: s.title, selectAll: true };
  select(s.id);
}

async function closeSession(s: Session) {
  const rt = runtimes.get(s.id);
  if (rt?.running) {
    const ok = await confirmBox(t("close.title"), t("close.body", { title: s.title }), t("common.close"));
    if (!ok) return;
    rt.closing = true;
    await invoke("pty_kill", { id: s.id }).catch((e) => toast(errorText(e)));
    return; // onExit uprace
  }
  state.sessions = state.sessions.filter((x) => x.id !== s.id);
  statuses.delete(s.id);
  save();
  renderSidebar();
}

// Premenovanie priamo v zozname. Sidebar sa prekresľuje aj pri zmene stavu,
// preto si rozpísaný text držíme mimo DOM.
let editing: { id: string; draft: string; selectAll: boolean } | undefined;
let rerendering = false;

function startRename(s: Session) {
  editing = { id: s.id, draft: s.title, selectAll: true };
  renderSidebar();
}

function finishRename(commit: boolean) {
  if (!editing) return;
  const s = session(editing.id);
  const title = editing.draft.trim();
  editing = undefined;
  if (s && commit && title) {
    s.title = title;
    save();
    renderPaneHeads();
  }
  renderSidebar();
  runtimes.get(state.ui.activeSessionId ?? "")?.term.focus();
}

function renameInput(): HTMLInputElement {
  const input = el("input", "title-edit");
  input.type = "text";
  input.value = editing!.draft;
  input.spellcheck = false;
  input.addEventListener("input", () => {
    if (editing) editing.draft = input.value;
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") finishRename(true);
    else if (e.key === "Escape") finishRename(false);
  });
  input.addEventListener("blur", () => {
    if (!rerendering) finishRename(true);
  });
  for (const ev of ["click", "dblclick", "mousedown"]) input.addEventListener(ev, (e) => e.stopPropagation());
  return input;
}

async function addProject() {
  const picked = await openDialog({ directory: true, multiple: false, title: t("project.pick") });
  if (typeof picked !== "string") return;
  if (state.projects.some((p) => p.path.toLowerCase() === picked.toLowerCase())) return toast(t("project.exists"));
  state.projects.push({ id: crypto.randomUUID(), name: folderName(picked), path: picked });
  save();
  renderSidebar();
}

async function removeProject(p: Project) {
  const all = sessionsOf(state, p.id);
  const live = all.filter((s) => runtimes.get(s.id)?.running);
  const body = live.length ? t("project.removeLive", { n: live.length }) : t("project.removeBody");
  if (!(await confirmBox(t("project.removeTitle", { name: p.name }), body, t("project.removeOk")))) return;
  for (const s of live) await invoke("pty_kill", { id: s.id }).catch(() => {});
  state.sessions = state.sessions.filter((s) => s.projectId !== p.id);
  state.templates = state.templates.filter((t) => t.projectId !== p.id);
  state.projects = state.projects.filter((x) => x.id !== p.id);
  save();
  renderSidebar();
}

function openEditor(path: string, line?: number) {
  const { editorId: id, customEditorPath: customPath, customEditorArgs: customArgs } = state.settings;
  invoke("open_in_editor", { editor: { id, customPath, customArgs }, path, line: line ?? null }).catch((e) =>
    toast(errorText(e)),
  );
}

function toggleGrid() {
  state.ui.grid = !state.ui.grid;
  save();
  layout();
}

// ---------- sidebar ----------

function iconButton(label: string, title: string, onClick: () => void) {
  const b = el("button", "icon", label);
  b.title = title;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

// Presúvanie projektov ťahaním. Počas ťahania sa zoznam neprekresľuje, inak by zmizol cieľ.
let projectDrag: { id: string; moved: boolean } | undefined;

function startProjectDrag(e: PointerEvent, p: Project, box: HTMLElement) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
  const startY = e.clientY;
  projectDrag = { id: p.id, moved: false };
  let target: { id: string; after: boolean } | undefined;
  const clearMarks = () => document.querySelectorAll(".project.drop-before, .project.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
  const move = (ev: PointerEvent) => {
    if (!projectDrag) return;
    if (!projectDrag.moved && Math.abs(ev.clientY - startY) < 5) return;
    projectDrag.moved = true;
    box.classList.add("dragging");
    clearMarks();
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".project");
    target = undefined;
    if (over?.dataset.id && over.dataset.id !== p.id) {
      const r = over.getBoundingClientRect();
      target = { id: over.dataset.id, after: ev.clientY > r.top + r.height / 2 };
      over.classList.add(target.after ? "drop-after" : "drop-before");
    }
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    clearMarks();
    box.classList.remove("dragging");
    if (!projectDrag?.moved) {
      projectDrag = undefined;
      return;
    }
    if (target) {
      state.projects = moveProject(state.projects, p.id, target.id, target.after);
      save();
    }
    // Click, ktorý príde hneď po pustení, ešte uvidí `moved` a projekt nezbalí.
    window.setTimeout(() => {
      projectDrag = undefined;
      renderSidebar();
    }, 0);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function renderSidebar() {
  if (projectDrag) return;
  const root = $("#projects");
  const prevInput = root.querySelector<HTMLInputElement>("input.title-edit");
  const caret = prevInput ? [prevInput.selectionStart ?? 0, prevInput.selectionEnd ?? 0] : undefined;
  rerendering = true;
  root.replaceChildren();
  rerendering = false;
  let editInput: HTMLInputElement | undefined;
  for (const p of orderedProjects(state.projects)) {
    const box = el("div", "project");
    box.dataset.id = p.id;
    const row = el("div", "project-row");
    row.title = t("project.rowTitle", { path: p.path });
    const actions = el("span", "row-actions");
    actions.append(
      iconButton(PROVIDER_ICON.claude, t("project.newClaude"), () => void createSession(p, "claude")),
      iconButton(PROVIDER_ICON.codex, t("project.newCodex"), () => void createSession(p, "codex")),
      iconButton(PROVIDER_ICON.shell, t("project.newShell"), () => void createSession(p, "shell")),
      iconButton("↗", t("project.openEditor"), () => openEditor(p.path)),
      iconButton(p.pinned ? "★" : "☆", t(p.pinned ? "project.unpin" : "project.pin"), () => {
        p.pinned = !p.pinned;
        save();
        renderSidebar();
      }),
      iconButton("✕", t("project.remove"), () => void removeProject(p)),
    );
    const name = el("span", "name", p.name);
    if (p.pinned) name.prepend(el("span", "pin", "★ "));
    row.append(el("span", "chev", p.collapsed ? "▸" : "▾"), name, actions);
    row.addEventListener("pointerdown", (e) => startProjectDrag(e, p, box));
    row.addEventListener("click", () => {
      if (projectDrag?.moved) return;
      p.collapsed = !p.collapsed;
      save();
      renderSidebar();
    });
    box.append(row);

    if (!p.collapsed) {
      for (const s of sessionsOf(state, p.id)) {
        const st = statusOf(s.id);
        const item = el("div", "session");
        item.classList.toggle("active", s.id === state.ui.activeSessionId);
        item.classList.toggle("unread", unread.has(s.id));
        const body = el("div", "body");
        if (editing?.id === s.id) {
          editInput = renameInput();
          const line = el("div", "title");
          line.append(document.createTextNode(`${PROVIDER_ICON[s.provider]}  `), editInput);
          body.append(line);
        } else {
          body.append(el("div", "title", `${PROVIDER_ICON[s.provider]}  ${s.title}`));
        }
        body.append(el("div", "sub", `${statusLabel(st)}${contextLabel(s)}`));
        const actions = el("span", "row-actions");
        actions.append(
          iconButton("ⓘ", t("session.info"), () => showInfo(s)),
          iconButton("✎", t("session.rename"), () => startRename(s)),
          iconButton(
            "✕",
            t(runtimes.get(s.id)?.running ? "session.closeTerminal" : "session.removeFromList"),
            () => void closeSession(s),
          ),
        );
        item.append(el("span", `dot ${st}`), body, actions);
        item.addEventListener("click", () => select(s.id));
        item.addEventListener("dblclick", () => startRename(s));
        item.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          showInfo(s);
        });
        box.append(item);
      }
    }
    root.append(box);
  }
  if (editInput && editing) {
    editInput.focus();
    if (editing.selectAll) {
      editInput.select();
      editing.selectAll = false;
    } else {
      const [from, to] = caret ?? [editInput.value.length, editInput.value.length];
      editInput.setSelectionRange(from, to);
    }
  }
}

// ---------- modálne okná ----------

function modal(build: (box: HTMLElement, close: () => void) => void, onClose: () => void) {
  const overlay = $("#overlay");
  const box = el("div", "modal");
  overlay.replaceChildren(box);
  overlay.hidden = false;
  let done = false;
  const close = () => {
    if (done) return;
    done = true;
    overlay.hidden = true;
    overlay.replaceChildren();
    document.removeEventListener("keydown", esc, true);
    onClose();
    runtimes.get(state.ui.activeSessionId ?? "")?.term.focus();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener("keydown", esc, true);
  overlay.onclick = (e) => {
    if (e.target === overlay) close();
  };
  build(box, close);
}

function confirmBox(heading: string, text: string, okLabel: string, notes = ""): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    modal(
      (box, close) => {
        const ok = el("button", "danger", okLabel);
        const cancel = el("button", "", t("common.cancel"));
        const actions = el("div", "actions");
        actions.append(cancel, ok);
        box.append(el("h3", "", heading), el("p", "", text));
        if (notes) box.append(el("div", "notes", notes));
        box.append(actions);
        ok.onclick = () => {
          result = true;
          close();
        };
        cancel.onclick = close;
        cancel.focus();
      },
      () => resolve(result),
    );
  });
}

function quickSwitch() {
  modal(
    (box, close) => {
      const input = el("input");
      input.type = "text";
      input.placeholder = t("switch.placeholder");
      const list = el("div", "switch-list");
      box.append(input, list);
      let items: Session[] = [];
      let sel = 0;
      const draw = () => {
        items = byRecent(state.sessions).filter((s) => matches(s, project(s.projectId), input.value));
        sel = Math.min(sel, Math.max(0, items.length - 1));
        list.replaceChildren(
          ...items.map((s, i) => {
            const row = el("div", `switch-item${i === sel ? " sel" : ""}`);
            row.append(
              el("span", `dot ${statusOf(s.id)}`),
              el("span", "", `${PROVIDER_ICON[s.provider]}  ${s.title}`),
              el("span", "meta", `${project(s.projectId)?.name ?? ""} · ${statusLabel(statusOf(s.id))}`),
            );
            row.onclick = () => {
              close();
              select(s.id);
            };
            return row;
          }),
        );
        if (!items.length) list.append(el("p", "", t("common.noResults")));
      };
      input.oninput = () => {
        sel = 0;
        draw();
      };
      input.onkeydown = (e) => {
        if (e.key === "ArrowDown") sel = Math.min(sel + 1, items.length - 1);
        else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
        else if (e.key === "Enter" && items[sel]) {
          const id = items[sel].id;
          close();
          select(id);
          return;
        } else return;
        e.preventDefault();
        draw();
      };
      draw();
      input.focus();
    },
    () => {},
  );
}

const dateTime = (ms: number | undefined) =>
  ms ? new Date(ms).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" }) : "–";

function infoRows(s: Session): [string, string][] {
  const p = project(s.projectId);
  const rows: [string, string][] = [
    [t("info.project"), `${p?.name ?? "–"} · ${p?.path ?? ""}`],
    [t("info.tool"), PROVIDER_LABEL[s.provider]],
    [t("info.status"), statusLabel(statusOf(s.id))],
  ];
  if (s.provider !== "shell") rows.push([t("info.conversation"), s.agentSessionId ?? t("info.notDetected")]);
  const st = statsOf(s);
  if (st) {
    if (st.model) rows.push([t("info.model"), st.model]);
    if (st.contextTokens) {
      const pct = st.contextWindow
        ? t("info.contextOf", {
            window: formatTokens(st.contextWindow),
            pct: Math.round((st.contextTokens / st.contextWindow) * 100),
          })
        : "";
      rows.push([t("info.context"), `${formatTokens(st.contextTokens)}${pct}`]);
    }
    rows.push(
      [
        t("info.input"),
        t("info.inputValue", {
          fresh: formatTokens(st.inputTokens),
          read: formatTokens(st.cacheReadTokens),
          write: formatTokens(st.cacheWriteTokens),
        }),
      ],
      [t("info.output"), formatTokens(st.outputTokens)],
    );
    if (st.limitUsedPercent != null) {
      const days = st.limitWindowMinutes ? Math.round(st.limitWindowMinutes / 1440) : 0;
      const used = t("info.limitValue", { pct: st.limitUsedPercent.toFixed(0) });
      rows.push([t("info.codexLimit"), `${used}${days ? t("info.limitDays", { days }) : ""}`]);
    }
  } else if (s.provider !== "shell") {
    rows.push([t("info.tokens"), t(runtimes.get(s.id)?.running ? "info.tokensNone" : "info.asleep")]);
  }
  rows.push([t("info.created"), dateTime(s.createdAt)], [t("info.lastUsed"), dateTime(s.lastUsedAt)]);
  return rows;
}

function showInfo(s: Session) {
  let timer: number | undefined;
  modal(
    (box, close) => {
      const grid = el("dl", "info");
      const draw = () => grid.replaceChildren(...infoRows(s).flatMap(([k, v]) => [el("dt", "", k), el("dd", "", v)]));
      draw();
      timer = window.setInterval(draw, 2000);
      const note = s.provider === "claude" ? t("info.noteClaude") : s.provider === "codex" ? t("info.noteCodex") : "";
      const actions = el("div", "actions");
      if (s.agentSessionId) {
        const copy = el("button", "", t("info.copyId"));
        copy.onclick = () =>
          void navigator.clipboard.writeText(s.agentSessionId!).then(() => (copy.textContent = t("info.copied")));
        actions.append(copy);
      }
      const ok = el("button", "primary", t("common.close"));
      ok.onclick = close;
      actions.append(ok);
      box.append(el("h3", "", `${PROVIDER_ICON[s.provider]}  ${s.title}`), grid);
      if (note) box.append(el("div", "note", note));
      box.append(actions);
      ok.focus();
    },
    () => window.clearInterval(timer),
  );
}

/** Vloží šablónu do aktívneho terminálu ako jeden paste; voliteľne ju hneď odošle. */
function insertTemplate(tpl: PromptTemplate) {
  const id = state.ui.activeSessionId;
  const rt = id ? runtimes.get(id) : undefined;
  if (!id || !rt?.running) return toast(t("tpl.needSession"));
  void invoke("pty_write", { id, data: pasteSequence(tpl.text) })
    .then(() => {
      if (tpl.send) window.setTimeout(() => void invoke("pty_write", { id, data: "\r" }), 150);
    })
    .catch((e) => toast(errorText(e)));
  rt.term.focus();
}

function openTemplates() {
  const active = session(state.ui.activeSessionId);
  const p = active ? project(active.projectId) : undefined;
  modal(
    (box, close) => {
      const input = el("input");
      input.type = "text";
      input.placeholder = t("tpl.search");
      const list = el("div", "switch-list");
      box.append(el("h3", "", p ? t("tpl.titleProject", { name: p.name }) : t("tpl.title")), input, list);
      let items: PromptTemplate[] = [];
      let sel = 0;
      const pick = (tpl: PromptTemplate) => {
        close();
        insertTemplate(tpl);
      };
      const edit = (tpl?: PromptTemplate) => {
        close();
        editTemplate(tpl, p);
      };
      const draw = () => {
        const q = input.value.trim().toLowerCase();
        items = templatesFor(state.templates, p?.id).filter(
          (tpl) => !q || `${tpl.name} ${tpl.text}`.toLowerCase().includes(q),
        );
        sel = Math.min(sel, Math.max(0, items.length - 1));
        list.replaceChildren(
          ...items.map((tpl, i) => {
            const row = el("div", `switch-item${i === sel ? " sel" : ""}`);
            const actions = el("span", "row-actions");
            actions.append(
              iconButton("✎", t("tpl.edit"), () => edit(tpl)),
              iconButton("✕", t("tpl.delete"), () => {
                state.templates = state.templates.filter((x) => x.id !== tpl.id);
                save();
                draw();
              }),
            );
            row.append(
              el("span", "", `${tpl.send ? "⏎ " : ""}${tpl.name}`),
              el("span", "meta", t(tpl.projectId ? "tpl.thisProject" : "tpl.allProjects")),
              actions,
            );
            row.title = tpl.text;
            row.onclick = () => pick(tpl);
            return row;
          }),
        );
        if (!items.length) list.append(el("p", "", t(state.templates.length ? "common.noResults" : "tpl.empty")));
      };
      input.oninput = () => {
        sel = 0;
        draw();
      };
      input.onkeydown = (e) => {
        if (e.key === "ArrowDown") sel = Math.min(sel + 1, items.length - 1);
        else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
        else if (e.key === "Enter" && items[sel]) return pick(items[sel]);
        else return;
        e.preventDefault();
        draw();
      };
      const add = el("button", "", t("tpl.new"));
      add.onclick = () => edit();
      const actions = el("div", "actions");
      actions.append(add);
      box.append(actions, el("div", "note", t("tpl.note")));
      draw();
      input.focus();
    },
    () => {},
  );
}

function editTemplate(tpl: PromptTemplate | undefined, p: Project | undefined) {
  modal(
    (box, close) => {
      box.append(el("h3", "", t(tpl ? "tpl.editTitle" : "tpl.newTitle")));
      const name = el("input");
      name.type = "text";
      name.value = tpl?.name ?? "";
      name.placeholder = t("tpl.namePlaceholder");
      const text = el("textarea");
      text.value = tpl?.text ?? "";
      text.rows = 8;
      text.placeholder = t("tpl.textPlaceholder");
      text.spellcheck = false;
      const scope = el("select");
      const projectId = tpl ? tpl.projectId : p?.id;
      const scopeProject = tpl?.projectId ? project(tpl.projectId) : p;
      if (scopeProject) {
        scope.append(
          new Option(t("tpl.only", { name: scopeProject.name }), scopeProject.id, false, projectId === scopeProject.id),
        );
      }
      scope.append(new Option(t("tpl.allScope"), "", false, !projectId));
      const sendLabel = el("label", "check");
      const send = el("input");
      send.type = "checkbox";
      send.checked = tpl?.send ?? false;
      sendLabel.append(send, document.createTextNode(t("tpl.send")));
      box.append(
        el("label", "", t("tpl.name")),
        name,
        el("label", "", t("tpl.text")),
        text,
        el("label", "", t("tpl.scope")),
        scope,
        sendLabel,
      );
      const ok = el("button", "primary", t("common.save"));
      const cancel = el("button", "", t("common.cancel"));
      const actions = el("div", "actions");
      actions.append(cancel, ok);
      box.append(actions);
      // Enter v textarea je nový riadok, Esc rieši modal.
      text.addEventListener("keydown", (e) => e.stopPropagation());
      cancel.onclick = () => {
        close();
        openTemplates();
      };
      ok.onclick = () => {
        if (!name.value.trim() || !text.value.trim()) return toast(t("tpl.invalid"));
        const next: PromptTemplate = {
          id: tpl?.id ?? crypto.randomUUID(),
          name: name.value.trim(),
          text: text.value.replace(/\s+$/, ""),
          send: send.checked,
          projectId: scope.value || undefined,
        };
        state.templates = tpl ? state.templates.map((x) => (x.id === tpl.id ? next : x)) : [...state.templates, next];
        save();
        close();
        openTemplates();
      };
      name.focus();
    },
    () => {},
  );
}

type EditorPick = Pick<Settings, "editorId" | "customEditorPath" | "customEditorArgs">;

/**
 * Výber editora: nainštalované editory (z registra / bundle ID / PATH) a „Iný program…“
 * s cestou k programu a argumentmi. Vráti funkciu, ktorá prečíta výber, alebo chybu.
 */
function editorPicker(box: HTMLElement, st: Settings): () => EditorPick | string {
  const select = el("select");
  select.append(new Option(t("editor.searching"), st.editorId));
  const note = el("div", "note");

  const custom = el("div", "custom-editor");
  const program = el("input");
  program.type = "text";
  program.value = st.customEditorPath;
  program.placeholder = info.platform === "windows" ? "C:\\Program Files\\…\\editor.exe" : "/Applications/Editor.app";
  const browse = el("button", "", t("editor.browse"));
  const programRow = el("div", "input-row");
  programRow.append(program, browse);
  const args = el("input");
  args.type = "text";
  args.value = st.customEditorArgs;
  custom.append(
    el("label", "", t("editor.program")),
    programRow,
    el("label", "", t("editor.args")),
    args,
    el("div", "note", t("editor.argsNote")),
  );
  box.append(el("label", "", t("editor.label")), select, note, custom);

  const sync = () => {
    custom.hidden = select.value !== CUSTOM_EDITOR;
  };
  select.onchange = sync;
  browse.onclick = async () => {
    const picked = await openDialog({
      multiple: false,
      title: t("editor.pickTitle"),
      filters: info.platform === "windows" ? [{ name: t("editor.programs"), extensions: ["exe", "com"] }] : undefined,
    });
    if (typeof picked === "string") program.value = picked;
  };
  sync();

  invoke<EditorInfo[]>("list_editors")
    .then((found) => {
      select.replaceChildren();
      for (const f of found) select.append(new Option(f.label, f.id));
      const known = st.editorId === "" || st.editorId === CUSTOM_EDITOR || found.some((f) => f.id === st.editorId);
      if (!known) select.append(new Option(t("editor.notFound", { id: st.editorId }), st.editorId));
      select.append(new Option(t("editor.other"), CUSTOM_EDITOR));
      select.value = st.editorId || found[0]?.id || CUSTOM_EDITOR;
      sync();
      note.textContent = t(found.length ? "editor.lineNote" : "editor.noneFound");
    })
    .catch((e) => (note.textContent = errorText(e)));

  return () => {
    if (select.value !== CUSTOM_EDITOR) {
      return { editorId: select.value, customEditorPath: st.customEditorPath, customEditorArgs: st.customEditorArgs };
    }
    const path = program.value.trim().replace(/^"(.*)"$/, "$1");
    if (!path) return t("err.editor.needProgram");
    return { editorId: CUSTOM_EDITOR, customEditorPath: path, customEditorArgs: args.value.trim() || "%TARGET_PATH%" };
  };
}


function openSettings() {
  const st = state.settings;
  modal(
    (box, close) => {
      const field = (label: string, value: string, placeholder = "") => {
        const input = el("input");
        input.type = "text";
        input.value = value;
        input.placeholder = placeholder;
        box.append(el("label", "", label), input);
        return input;
      };
      box.append(el("h3", "", t("settings.title")));
      const language = el("select");
      for (const l of LANGUAGES) language.append(new Option(l.label, l.id, false, l.id === st.language));
      box.append(el("label", "", t("settings.language")), language);
      const claude = field(t("settings.claude"), st.claudeCommand, "claude");
      const codex = field(t("settings.codex"), st.codexCommand, "codex");
      const codexResume = field(t("settings.codexResume"), st.codexResumeCommand, "codex resume");
      const shell = field(t("settings.shell"), st.shell, info.platform === "windows" ? "powershell.exe" : "$SHELL");
      const editor = editorPicker(box, st);
      const notifLabel = el("label", "check");
      const notif = el("input");
      notif.type = "checkbox";
      notif.checked = st.notifications;
      notifLabel.append(notif, document.createTextNode(t("settings.notifications")));
      const resumeLabel = el("label", "check");
      const resume = el("input");
      resume.type = "checkbox";
      resume.checked = st.autoResume;
      resumeLabel.append(resume, document.createTextNode(t("settings.autoResume")));
      box.append(notifLabel, resumeLabel);
      box.append(
        el(
          "div",
          "note",
          `${t(info.hooksEnabled ? "settings.hooksOn" : "settings.hooksOff")} ${t("settings.footer", { file: info.stateFile })}`,
        ),
      );
      const save_ = el("button", "primary", t("common.save"));
      const cancel = el("button", "", t("common.cancel"));
      const actions = el("div", "actions");
      actions.append(cancel, save_);
      box.append(actions);
      cancel.onclick = close;
      save_.onclick = () => {
        st.claudeCommand = claude.value.trim() || "claude";
        st.codexCommand = codex.value.trim() || "codex";
        st.codexResumeCommand = codexResume.value.trim() || "codex resume";
        st.shell = shell.value.trim();
        const pick = editor();
        if (typeof pick === "string") return toast(pick);
        Object.assign(st, pick);
        st.notifications = notif.checked;
        st.autoResume = resume.checked;
        const langChanged = st.language !== language.value;
        st.language = language.value;
        save();
        close();
        if (langChanged) applyLanguage();
      };
      claude.focus();
    },
    () => {},
  );
}

/** Prepne jazyk bez reštartu: statické texty, zoznam, hlavičky terminálov a vyhľadávania. */
function applyLanguage() {
  setLang(state.settings.language);
  translateDocument();
  renderSidebar();
  renderPaneHeads();
}

// ---------- aktualizácie ----------

let pendingUpdate: Update | undefined;

/** Hľadá novú verziu v GitHub Releases. Bez siete alebo bez vydania ticho nič. */
async function checkUpdate() {
  if (pendingUpdate) return;
  const update = await check().catch(() => null);
  if (!update) return;
  pendingUpdate = update;
  const btn = $<HTMLButtonElement>("#btn-update");
  btn.textContent = t("update.button", { version: update.version });
  btn.hidden = false;
}

/** Zoznam zmien z release notes: len riadky „- …“, ktoré release workflow vytvorí z commitov. */
function changesOf(body: string | undefined): string {
  return (body ?? "").split(/\r?\n/).filter((l) => l.startsWith("- ")).join("\n");
}

async function installUpdate() {
  const update = pendingUpdate;
  if (!update) return;
  const ok = await confirmBox(t("update.title", { version: update.version }), t("update.body"), t("update.ok"), changesOf(update.body));
  if (!ok) return;
  const btn = $<HTMLButtonElement>("#btn-update");
  btn.disabled = true;
  let total = 0;
  let done = 0;
  try {
    await update.downloadAndInstall((e) => {
      if (e.event === "Started") total = e.data.contentLength ?? 0;
      else if (e.event === "Progress") done += e.data.chunkLength;
      const percent = total ? `${Math.min(100, Math.round((done / total) * 100))} %` : "";
      btn.textContent = t("update.downloading", { percent });
    });
    // Na Windows inštalátor appku zavrie sám; inde ju treba spustiť nanovo.
    await relaunch();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = t("update.button", { version: update.version });
    toast(t("update.failed", { detail: String(e) }));
  }
}

// ---------- klávesy, resizer, štart ----------

/** Číslo z Ctrl+1–9. Podľa `code`, lebo na slovenskej klávesnici je v hornom rade `+ľščťžýáí`. */
function digitOf(e: KeyboardEvent): number | undefined {
  const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : undefined;
}

/** Ctrl+K, Ctrl+G, Ctrl+1–9, Ctrl+Shift+F a Ctrl+Shift+T patria aplikácii, nie procesu v termináli. */
function isAppShortcut(e: KeyboardEvent): boolean {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return false;
  const key = e.key.toLowerCase();
  return e.shiftKey ? key === "f" || key === "t" : key === "k" || key === "g" || digitOf(e) !== undefined;
}

function handleGlobalKey(e: KeyboardEvent): boolean {
  const key = e.key.toLowerCase();
  const n = digitOf(e);
  if (n !== undefined && !e.shiftKey) {
    e.preventDefault();
    const s = sessionByNumber(state, n);
    const p = s && state.projects.find((x) => x.id === s.projectId);
    if (p?.collapsed) p.collapsed = false;
    if (s) select(s.id);
    return false;
  }
  if (e.shiftKey) {
    e.preventDefault();
    if (key === "t") openTemplates();
    else if (key === "f") {
      const rt = runtimes.get(state.ui.activeSessionId ?? "");
      if (rt) openSearch(rt);
    }
    return false;
  }
  if (key === "k") {
    e.preventDefault();
    quickSwitch();
    return false;
  }
  if (key === "g") {
    e.preventDefault();
    toggleGrid();
    return false;
  }
  return true;
}

function setupResizer() {
  const resizer = $("#resizer");
  const sidebar = $("#sidebar");
  const apply = () => (sidebar.style.width = `${state.ui.sidebarWidth}px`);
  apply();
  resizer.addEventListener("pointerdown", (e) => {
    resizer.setPointerCapture(e.pointerId);
    resizer.classList.add("drag");
    const move = (ev: PointerEvent) => {
      state.ui.sidebarWidth = clampSidebar(ev.clientX);
      apply();
      fitVisible();
    };
    const up = () => {
      resizer.classList.remove("drag");
      resizer.removeEventListener("pointermove", move);
      resizer.removeEventListener("pointerup", up);
      save();
    };
    resizer.addEventListener("pointermove", move);
    resizer.addEventListener("pointerup", up);
  });
}

async function main() {
  info = await invoke<AppInfo>("app_info");
  const loaded = parseState(await invoke<string | null>("load_state"));
  state = loaded.state;
  setLang(state.settings.language);
  translateDocument();
  if (loaded.dropped) toast(t("app.corrupted", { n: loaded.dropped }));

  setupResizer();
  $("#btn-add-project").onclick = () => void addProject();
  $("#btn-switch").onclick = quickSwitch;
  $("#btn-grid").onclick = toggleGrid;
  $("#btn-settings").onclick = openSettings;
  $("#btn-templates").onclick = openTemplates;
  $("#btn-update").onclick = () => void installUpdate();
  document.addEventListener("keydown", (e) => {
    if (isAppShortcut(e) && $("#overlay").hidden) handleGlobalKey(e);
  });

  new ResizeObserver(() => requestAnimationFrame(fitVisible)).observe($("#stage"));

  await listen<{ id: string; code: number | null }>("pty-exit", (e) => onExit(e.payload.id));
  await listen<AgentEvent>("agent-event", (e) => onAgentEvent(e.payload));

  const win = getCurrentWindow();
  await win.onFocusChanged(({ payload }) => {
    windowFocused = payload;
    if (payload) {
      for (const id of visibleIds()) unread.delete(id);
      renderSidebar();
    }
  });

  renderSidebar();
  layout();
  window.setInterval(() => void lookupCodexSessions(), 3000);
  window.setInterval(() => void pollAgents(), 2000);
  if (info.updates) {
    window.setTimeout(() => void checkUpdate(), 10_000);
    window.setInterval(() => void checkUpdate(), 6 * 3600_000);
  }

  // Obnovenie po štarte: Claude cez `--resume <id>`, Codex cez `codex resume <id>`, shell nanovo.
  // Vypnuté = relácie spia, kým na ne používateľ neklikne.
  if (state.settings.autoResume) {
    const order = [...state.sessions].sort((a, b) => a.createdAt - b.createdAt);
    const active = session(state.ui.activeSessionId);
    for (const s of active ? [active, ...order.filter((x) => x !== active)] : order) {
      if (session(s.id) && !runtimes.has(s.id)) await start(s);
    }
  }
}

void main();
