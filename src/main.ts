import { createTerminalFactory, attachWebgl, type Runtime } from "./terminal-runtime.ts";
import { createTerminalLifecycle, type OutputChunk } from "./terminal-lifecycle.ts";
import { createAgentMonitor } from "./agent-monitor.ts";
import { createSystemNotifications } from "./system-notifications.ts";
import { openSearch } from "./terminal-search.ts";
import { fileOpenTarget, type EditorInfo } from "./model.ts";
import { createSidebar } from "./sidebar.ts";
import { showPalette, actionLabel, bindingLabel, type PaletteAction } from "./actions.ts";
import { normalizeFontSize, DEFAULT_SETTINGS as FONT_DEFAULTS, ACTION_IDS, bindingFor, shortcutAction, type ActionId } from "./model.ts";
import { createSettings } from "./settings.ts";
import { createFileDropHandler, type FileDrag } from "./file-drop.ts";
import { createNotificationCenter } from "./notifications.ts";
import { createPaneLayout } from "./panes.ts";
import { showSavedLayouts } from "./saved-layouts.ts";
import { createUpdates } from "./updates.ts";
import { $, el, onNextFrame, iconButton } from "./dom.ts";
import { createSaveQueue, createShutdownHandler } from "./persistence.ts";
import { createDialogs } from "./dialogs.ts";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { WebLinksAddon } from "@xterm/addon-web-links";

import {
  attentionEventKind,
  recordAttention,
  readAttention,
  sessionDiagnostics,
  type PaneLayout,
  restoreSession,
  shouldAutoResume,
  busyAgents,
  assignPaneSlot,
  importConversation,
  nextAttention,
  ATTENTION,
  type AgentEvent,
  byRecent,
  clampSidebar,
  findFileRefs,
  folderName,
  formatTokens,
  isUuid,
  matches,
  orderedProjects,
  parseState,
  pasteSequence,
  type PersistedState,
  type Project,
  type PromptTemplate,
  PROVIDER_LABEL,
  relativePath,
  type Provider,
  type Session,
  sessionByNumber,
  sessionsOf,
  type Status,
  templatesFor,
} from "./model.ts";
import { errorText, type Key, locale, setLang, t, translateDocument } from "./i18n.ts";

interface AppInfo {
  platform: string;
  hooksEnabled: boolean;
  stateFile: string;
  updates: boolean;
  automaticUpdates: boolean;
}

const PROVIDER_ICON: Record<Provider, string> = { claude: "✳", codex: "‹›", antigravity: "△", shell: "▣" };

let info: AppInfo = { platform: "windows", hooksEnabled: false, stateFile: "", updates: false, automaticUpdates: false };
let state: PersistedState = parseState(null).state;
const runtimes = new Map<string, Runtime>();
const statuses = new Map<string, Status>();
const unread = new Set<string>();
let windowFocused = true;

// ---------- perzistencia ----------

const saves = createSaveQueue(
  () => JSON.stringify(state, null, 2),
  (json) => invoke("save_state", { json }),
  (e) => toast(t("app.saveFailed", { detail: String(e) })),
);
const save = saves.schedule;
let closingWindow = false;

// ---------- pomocníci ----------

const project = (id: string) => state.projects.find((p) => p.id === id);
const session = (id: string | undefined) => (id ? state.sessions.find((s) => s.id === id) : undefined);
const statusOf = (id: string): Status => statuses.get(id) ?? (session(id)?.stopped ? "exited" : "sleeping");
const contextLabel = (s: Session) => {
  const ctx = statsOf(s)?.contextTokens;
  return ctx ? t("app.context", { n: formatTokens(ctx) }) : "";
};
const statusLabel = (s: Status) => t(`status.${s}` as Key);

/** Správa v rohu; `info` = nie je to chyba. */
function toast(msg: string, info = false) {
  const t = el("div", info ? "toast info" : "toast", msg);
  document.body.append(t);
  window.setTimeout(() => t.remove(), 6000);
}

const renderStatusSoon = onNextFrame(() => {
  renderSidebar();
  renderPaneHeads();
});

const agentMonitor = createAgentMonitor({
  getState: () => state, runtimes, isClosing: () => closingWindow,
  invoke, save, statusOf, setStatus, renderStatusSoon,
});
const { statsOf, lookupCodexSessions, pollAgents, onAgentEvent } = agentMonitor;

function setStatus(id: string, next: Status, silent = false) {
  const prev = statusOf(id);
  if (prev === next) return;
  statuses.set(id, next);
  const kind = attentionEventKind(prev, next, silent);
  const s = session(id);
  if (next === "working" && s?.interrupted) {
    s.interrupted = false;
    save();
  }
  // Skrytá relácia, ktorá na teba čaká, sa vráti do zoznamu.
  if (next === "needs-you" && s?.hidden) {
    s.hidden = false;
    save();
  }
  if (kind && s) {
    recordAttention(state, s, kind, crypto.randomUUID(), Date.now(), isWatched(id));
    save();
  }
  if (!silent && ATTENTION.has(next) && !isWatched(id)) {
    unread.add(id);
    notify(id, next);
  }
  renderStatusSoon();
}

/** Používateľ práve reláciu vidí (je v zobrazení a okno má fokus). */
function isWatched(id: string) {
  return windowFocused && visibleIds().includes(id);
}

const notify = createSystemNotifications({
  enabled: () => state.settings.notifications, session, project, statusLabel,
});

const createRuntime = createTerminalFactory({
  getState: () => state, runtimes, setupLinks, isAppShortcut, handleGlobalKey,
  isWatched, unread, renderSidebar, notify, select,
});
const terminalLifecycle = createTerminalLifecycle({
  getState: () => state, getInfo: () => info, runtimes, statuses, unread, agentMonitor,
  isClosing: () => closingWindow, editingId: () => sidebar.editingId(), createRuntime, invoke,
  createOutput: () => new Channel<OutputChunk>(), schedule: (callback, delay) => window.setTimeout(callback, delay),
  save, flush: () => saves.flush(), statusOf, setStatus, isWatched, layout, renderSidebar, renderPaneHeads, toast,
  confirmBox: (...args) => confirmBox(...args),
});
const { start, onExit, closeSession, pauseSession, canPause, forgetRuntime } = terminalLifecycle;

// ---------- zobrazenie (jedna relácia alebo mriežka) ----------

let zoomedId: string | undefined;
const fitSoon = onNextFrame(fitVisible);
const paneLayout = createPaneLayout($("#stage"), fitSoon, save);

function visibleIds(): string[] {
  if (zoomedId && state.ui.grid && runtimes.has(zoomedId)) return [zoomedId];
  zoomedId = undefined;
  const active = state.ui.activeSessionId;
  if (!state.ui.grid) return active && runtimes.has(active) ? [active] : [];
  return state.ui.paneSlots.map(id => id && session(id) ? id : "");
}

function layout() {
  const ids = visibleIds();
  const stage = $("#stage");
  stage.className = state.ui.grid && (ids.length > 1 || zoomedId) ? "multi-pane" : "";
  stage.querySelectorAll(".pane-placeholder").forEach(node => node.remove());
  const cells = paneLayout.apply(state.ui.paneLayout, ids.length, state.ui.paneSizes);
  $("#empty").style.display = ids.length ? "none" : "";
  if (state.ui.grid && !zoomedId) ids.forEach((id, index) => {
    if (id && runtimes.has(id)) return;
    const placeholder = el("div", "pane-placeholder");
    const choose = el("button", "", t("panes.choose"));
    choose.onclick = () => choosePaneSession(index);
    placeholder.append(choose);
    const cell = cells[index];
    placeholder.style.gridColumn = `${cell.column} / span ${cell.span}`;
    placeholder.style.gridRow = String(cell.row);
    stage.append(placeholder);
  });
  for (const [id, rt] of runtimes) {
    const show = ids.includes(id);
    rt.pane.classList.toggle("visible", show);
    rt.pane.style.order = String(ids.indexOf(id));
    const cell = cells[ids.indexOf(id)];
    rt.pane.style.gridColumn = cell ? `${cell.column} / span ${cell.span}` : "";
    rt.pane.style.gridRow = cell ? String(cell.row) : "";
    rt.pane.classList.toggle("focused", id === state.ui.activeSessionId);
    // WebGL kontext len pre viditeľné terminály: šetrí GPU pamäť a obchádza limit kontextov.
    if (show && !rt.webgl) attachWebgl(rt);
    if (!show && rt.webgl) {
      rt.webgl.dispose();
      rt.webgl = undefined;
    }
  }
  fitSoon();
  $("#btn-grid").classList.toggle("on", state.ui.grid);
  renderPaneHeads();
}

function togglePaneZoom(id: string) {
  if (!state.ui.grid) return;
  if (zoomedId) { restorePaneLayout(); return; }
  zoomedId = id;
  layout();
  renderSidebar();
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
    rt.head.replaceChildren(el("span", "pane-title", `${PROVIDER_ICON[s.provider]} ${s.title} · ${p?.name ?? ""} · ${statusLabel(statusOf(id))}${contextLabel(s)}`));
    if (state.ui.grid && !zoomedId) {
      const index = state.ui.paneSlots.indexOf(id);
      const title = rt.head.querySelector<HTMLElement>(".pane-title")!;
      const choose = el("button", "pane-title pane-picker", `${title.textContent} ▾`);
      choose.title = t("panes.choose");
      choose.onclick = () => choosePaneSession(index);
      title.replaceWith(choose);
      if (index >= 0) rt.head.append(iconButton("−", t("panes.remove"), () => {
        state.ui.paneSlots[index] = null;
        restorePaneLayout();
      }));
    }
    if (state.ui.grid) rt.head.append(iconButton(zoomedId === id ? "⊟" : "⤢", t(zoomedId === id ? "panes.restore" : "panes.maximize"), () => togglePaneZoom(id)));
    if (canPause(s)) rt.head.append(iconButton("⏸", t("session.pause"), () => void pauseSession(s)));
    if (!rt.running) rt.head.append(iconButton("↻", t("session.restart"), () => void start(s)));
    rt.head.classList.toggle("stopped", s.stopped === true);
  }
}

// ---------- terminály ----------

/** Ctrl+klik na URL otvorí prehliadač, na cestu k súboru editor alebo predvolenú aplikáciu. Pravý klik ukáže menu. */
function setupLinks(rt: Runtime, s: Session) {
  const hover = (key: Key, link: NonNullable<Runtime["hoverLink"]>) => {
    rt.host.title = t(key);
    rt.hoverLink = link;
  };
  const leave = () => {
    rt.host.title = "";
    rt.hoverLink = undefined;
  };
  const wantsOpen = (e: MouseEvent) => e.ctrlKey || e.metaKey;
  rt.term.loadAddon(
    new WebLinksAddon(
      (e, uri) => {
        if (wantsOpen(e)) openLink(uri);
      },
      { hover: (_e, uri) => hover("link.urlHint", { url: uri }), leave },
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
                if (wantsOpen(e)) openFile(file, r.line);
              },
              hover: () => hover("link.fileHint", { file, line: r.line }),
              leave,
            },
          ];
        });
        callback(links.length ? links : undefined);
      });
    },
  });
  rt.host.addEventListener("contextmenu", (e) => {
    const link = rt.hoverLink;
    if (!link) return;
    e.preventDefault();
    e.stopPropagation();
    if ("url" in link) {
      popupMenu(e.clientX, e.clientY, [
        [t("menu.openLink"), () => openLink(link.url)],
        [t("menu.copyLink"), () => void navigator.clipboard.writeText(link.url)],
      ]);
      return;
    }
    const rel = relativePath(project(s.projectId)?.path ?? "", link.file);
    const items: MenuItem[] = [
      [t("textEditor.title"), () => void openTextEditor(link.file, link.line)],
      [externalEditorLabel(), () => openEditor(link.file, link.line)],
      [t("menu.openDefault"), () => void openDefault(link.file)],
      [t(REVEAL_LABEL[info.platform] ?? "menu.revealLinux"), () => void revealFile(link.file)],
      [t("menu.copyPath"), () => void navigator.clipboard.writeText(link.file)],
    ];
    if (rel) items.push([t("menu.copyRelative"), () => void navigator.clipboard.writeText(rel)]);
    popupMenu(e.clientX, e.clientY, items);
  });
}

function openLink(url: string) {
  void openUrl(url).catch((err) => toast(t("link.openFailed", { detail: String(err) })));
}

/** Ctrl+klik na súbor: prípony z nastavení idú do predvolenej aplikácie, ostatné do editora. */
let textEditor: ReturnType<typeof import("./text-editor.ts")["createTextEditor"]> | undefined;
let loadingEditor: Promise<void> | undefined;
let installedEditors: EditorInfo[] = [];
function externalEditorLabel() {
  const settings = state.settings;
  const name = settings.editorId === "custom" ? settings.customEditorPath.split(/[\\/]/).at(-1)
    : installedEditors.find(editor => editor.id === settings.editorId)?.label
      ?? (!settings.editorId ? installedEditors[0]?.label : undefined);
  return name ? t("editor.openNamed", { name }) : t("editor.external");
}
void invoke<EditorInfo[]>("list_editors").then(editors => {
  installedEditors = editors; textEditor?.configure();
}).catch(() => {});
let editorZoomedId: string | undefined;
function editorVisibilityChanged(visible: boolean) {
  if (visible) {
    // Pane slots, sizes and layout stay untouched; undo only the editor's own zoom.
    const active = state.ui.activeSessionId;
    if (state.ui.grid && !zoomedId && active && runtimes.has(active)) {
      editorZoomedId = zoomedId = active;
      layout();
    }
  } else {
    const restore = editorZoomedId && state.ui.grid && zoomedId === editorZoomedId;
    editorZoomedId = undefined;
    if (restore) restorePaneLayout();
  }
}
async function openTextEditor(file?: string, line?: number) {
  try {
    if (!file) {
      const selected = await openDialog({ directory: false, multiple: false });
      if (!selected || typeof selected !== "string") return;
      file = selected;
    }
    loadingEditor ??= import("./text-editor.ts").then(module => {
      textEditor = module.createTextEditor(
        () => confirmBox(t("textEditor.discard"), t("textEditor.discardBody"), t("textEditor.discardOk")),
        path => openEditor(path),
        editorVisibilityChanged,
        () => state.settings,
        externalEditorLabel,
      );
    }).catch(e => { loadingEditor = undefined; throw e; });
    await loadingEditor;
    await textEditor!.open(file, line);
  } catch (e) { toast(errorText(e)); }
}
const busy = () => busyAgents(state.sessions, statusOf, id => runtimes.get(id)?.running === true);
let quitConfirmation: Promise<boolean> | undefined;
/** Concurrent quit requests (window, menu, AppKit) share one dialog. */
function confirmQuit(): Promise<boolean> {
  const sessions = busy();
  if (!sessions.length) return Promise.resolve(true);
  return quitConfirmation ??= confirmBox(t("quit.title"), t("quit.body", { titles: sessions.map(s => s.title).join(", ") }), t("quit.ok"))
    .finally(() => { quitConfirmation = undefined; });
}
/** Remember interrupted steps so the restarted sessions can say so. */
function markInterrupted() {
  for (const s of busy()) s.interrupted = true;
}
async function flushForRestart() {
  if (textEditor?.pending()) throw new Error(t("textEditor.saveFirst"));
  markInterrupted();
  await saves.flush();
}

function openFile(file: string, line?: number) {
  const target = fileOpenTarget(file, state.settings);
  const openPreferred = () => state.settings.fileEditor === "external" ? openEditor(file, line) : void openTextEditor(file, line);
  if (target !== "system") return openPreferred();
  // Spustiteľný súbor backend odmietne; vtedy ho otvoríme aspoň v editore.
  void openDefault(file, false).then((ok) => {
    if (!ok) openPreferred();
  });
}

/** false = spustiteľný súbor, ktorý sa predvolenou aplikáciou neotvára (s `explain` to aj povie). */
async function openDefault(file: string, explain = true): Promise<boolean> {
  try {
    await invoke("open_file_default", { path: file });
    return true;
  } catch (e) {
    if (e === "file.runnable" && !explain) return false;
    toast(errorText(e));
    return e !== "file.runnable";
  }
}

async function revealFile(file: string) {
  await invoke("reveal_file", { path: file }).catch((e) => toast(errorText(e)));
}

const REVEAL_LABEL: Record<string, Key> = { windows: "menu.revealWindows", macos: "menu.revealMac" };

type MenuItem = [label: string, run: () => void];

/** Malé kontextové menu na pozícii myši. Zavrie ho klik mimo, Escape alebo strata fokusu okna. */
function popupMenu(x: number, y: number, items: MenuItem[]) {
  document.querySelector(".ctxmenu")?.remove();
  const menu = el("div", "ctxmenu");
  const close = () => {
    menu.remove();
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
    window.removeEventListener("blur", close);
  };
  const outside = (e: MouseEvent) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const esc = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    close();
  };
  for (const [label, run] of items) {
    const b = el("button", "", label);
    b.onclick = () => {
      close();
      run();
    };
    menu.append(b);
  }
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - r.height - 4))}px`;
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", esc, true);
  window.addEventListener("blur", close);
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

// ---------- akcie ----------

function select(id: string, focus = true) {
  const s = session(id);
  if (!s) return;
  if (state.ui.grid) zoomedId = state.ui.paneSlots.includes(id) ? (zoomedId === id ? id : undefined) : id;
  sidebar.revealSession(id);
  state.ui.activeSessionId = id;
  const selectedProject = project(s.projectId);
  if (selectedProject) refreshBranches(true, [selectedProject.path]);
  s.lastUsedAt = Date.now();
  unread.delete(id);
  readAttention(state, id);
  save();

  if (!runtimes.has(id) || (!runtimes.get(id)?.running && !s.stopped)) {
    if (s.stopped) { createRuntime(s); layout(); renderPaneHeads(); }
    else void start(s);
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
    background: provider === "claude" && state.settings.claudeBackground && info.platform === "windows",
    title: `${PROVIDER_LABEL[provider]} ${n}`,
    createdAt: now,
    lastUsedAt: now,
  };
  state.sessions.push(s);
  p.collapsed = false;
  // Terminál sa spustí hneď a názov sa zatiaľ dá prepísať priamo v zozname.
  sidebar.startRename(s, false);
  select(s.id);
}

let addingProject = false;
async function addProject() {
  if (addingProject) return;
  addingProject = true;
  try {
    const picked = await openDialog({ directory: true, multiple: false, title: t("project.pick") });
    if (typeof picked !== "string") return;
    const exists = await invoke<boolean>("project_exists", { path: picked, existing: state.projects.map(p => p.path) });
    if (exists) return toast(t("project.exists"));
    state.projects.push({ id: crypto.randomUUID(), name: folderName(picked), path: picked });
    save();
    renderSidebar();
  } catch (e) {
    toast(errorText(e));
  } finally {
    addingProject = false;
  }
}

async function removeProject(p: Project) {
  const all = sessionsOf(state, p.id);
  if (all.some(s => terminalLifecycle.isStarting(s.id))) { toast(t("background.starting")); return; }
  const live = all.filter((s) => s.background || runtimes.get(s.id)?.running);
  const body = live.length ? t("project.removeLive", { n: live.length }) : t("project.removeBody");
  if (!(await confirmBox(t("project.removeTitle", { name: p.name }), body, t("project.removeOk")))) return;
  for (const s of live) {
    try { await invoke("pty_kill", { id: s.id }); }
    catch (e) { toast(errorText(e)); return; }
  }
  for (const s of all) forgetRuntime(s.id);
  state.closedSessions = state.closedSessions.filter((s) => s.projectId !== p.id);
  state.ui.pinnedSessionIds = state.ui.pinnedSessionIds.filter((id) => !all.some((s) => s.id === id));
  state.ui.paneSlots = state.ui.paneSlots.map(id => all.some(s => s.id === id) ? null : id);
  state.sessions = state.sessions.filter((s) => s.projectId !== p.id);
  state.templates = state.templates.filter((t) => t.projectId !== p.id);
  state.projects = state.projects.filter((x) => x.id !== p.id);
  save();
  layout();
  renderSidebar();
}

function openEditor(path: string, line?: number) {
  const { editorId: id, customEditorPath: customPath, customEditorArgs: customArgs } = state.settings;
  invoke("open_in_editor", { editor: { id, customPath, customArgs }, path, line: line ?? null }).catch((e) =>
    toast(errorText(e)),
  );
}

function toggleGrid() {
  zoomedId = undefined;
  state.ui.grid = !state.ui.grid;
  if (state.ui.grid) {
    if (state.ui.paneSlots.every(id => !id) && state.ui.activeSessionId) state.ui.paneSlots[0] = state.ui.activeSessionId;
    restorePaneLayout();
    return;
  }
  save();
  layout();
  renderSidebar();
}


function restorePaneLayout() {
  zoomedId = undefined;
  if (!state.ui.activeSessionId || !state.ui.paneSlots.includes(state.ui.activeSessionId)) {
    state.ui.activeSessionId = state.ui.paneSlots.find(id => id && session(id)) ?? undefined;
  }
  for (const id of state.ui.paneSlots) {
    const s = session(id ?? undefined);
    if (s && !runtimes.has(s.id)) createRuntime(s);
  }
  save();
  layout();
  renderSidebar();
  if (state.ui.activeSessionId) runtimes.get(state.ui.activeSessionId)?.term.focus();
}

function choosePaneSession(index: number) {
  if (index < 0) return;
  modal((box, close) => {
    box.append(el("h3", "", t("panes.choose")));
    const search = el("input");
    search.placeholder = t("panes.search");
    search.setAttribute("aria-label", t("panes.search"));
    const list = el("div", "switch-list pane-session-list");
    const draw = () => {
      list.replaceChildren();
      for (const p of orderedProjects(state.projects)) {
        const sessions = state.sessions.filter(s => s.projectId === p.id && `${p.name} ${s.title} ${s.provider}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase()));
        if (!sessions.length) continue;
        list.append(el("h4", "", p.name));
        for (const s of sessions) {
          const button = el("button", "", `${state.ui.paneSlots.includes(s.id) ? "✓ " : ""}${PROVIDER_ICON[s.provider]} ${s.title} · ${statusLabel(statusOf(s.id))}`);
          button.onclick = () => {
            state.ui.paneSlots = assignPaneSlot(state.ui.paneSlots, index, s.id);
            zoomedId = undefined;
            close();
            select(s.id);
          };
          list.append(button);
        }
      }
      if (!list.childElementCount) list.append(el("p", "hint", t("panes.noSessions")));
    };
    search.oninput = draw;
    box.append(search, list);
    draw();
    search.focus();
  }, () => {});
}

function jumpAttention() {
  const id = nextAttention(state.sessions, statuses, state.ui.activeSessionId);
  const s = session(id);
  const p = s && project(s.projectId);
  if (p) p.collapsed = false;
  if (id) select(id);
}

function showLayoutControls() {
  modal((box, close) => {
    box.append(el("h3", "", t("sidebar.layout")));
    const toggle = el("button", "", t("sidebar.panels"));
    toggle.setAttribute("aria-pressed", String(state.ui.grid));
    toggle.onclick = () => { toggleGrid(); close(); showLayoutControls(); };
    const presets = el("button", "", t("layouts.title"));
    presets.id = "btn-layouts";
    presets.onclick = () => showSavedLayouts(state, modal, save, restorePaneLayout);
    box.append(toggle, presets);
    const root = el("div", "layout-controls");
    box.append(root);
    if (state.ui.grid) {
      const modes = el("select", "pane-mode");
      modes.setAttribute("aria-label", t("panes.layout"));
      modes.title = t("panes.layout");
      for (const mode of ["grid", "columns", "rows"] as const) {
        const option = el("option", "", t(`panes.${mode}`));
        option.value = mode;
        modes.append(option);
      }
      modes.value = state.ui.paneLayout;
      modes.onchange = () => {
        state.ui.paneLayout = modes.value as PaneLayout;
        restorePaneLayout();
      };
      const count = el("select", "pane-count");
      count.setAttribute("aria-label", t("panes.count"));
      for (const n of [2, 3, 4, 5, 6, 7, 8]) {
        const option = el("option", "", t(n >= 5 ? "panes.numberMany" : "panes.number", { n }));
        option.value = String(n);
        count.append(option);
      }
      count.value = String(state.ui.paneSlots.length);
      count.onchange = () => {
        state.ui.paneSlots = Array.from({ length: Number(count.value) }, (_, i) => state.ui.paneSlots[i] ?? null);
        restorePaneLayout();
      };
      modes.id = "layout-mode"; count.id = "layout-count";
      const modeLabel = el("label", "", t("panes.layout")); modeLabel.htmlFor = modes.id;
      const countLabel = el("label", "", t("panes.count")); countLabel.htmlFor = count.id;
      root.append(modeLabel, modes, countLabel, count);
      if (zoomedId) {
        const back = el("button", "", t("panes.back"));
        back.onclick = restorePaneLayout;
        root.append(back);
      }
    }
    const actions = el("div", "actions");
    const done = el("button", "primary", t("common.close")); done.onclick = close;
    actions.append(done); box.append(actions); toggle.focus();
  }, () => {});
}

function showClosedSessions() {
  modal((box, close) => {
    box.append(el("h3", "", t("session.history", { n: state.closedSessions.length })));
    const list = el("div", "switch-list");
    for (const s of state.closedSessions) {
      const row = el("button", "history-row", `${s.title} · ${project(s.projectId)?.name ?? ""}`);
      row.title = t("session.restart");
      row.onclick = () => {
        const restored = restoreSession(state, s.id);
        if (!restored) return;
        close();
        save();
        select(restored.id);
        void start(restored);
      };
      list.append(row);
    }
    if (!state.closedSessions.length) list.append(el("p", "", t("common.noResults")));
    const cancel = el("button", "", t("common.close"));
    cancel.onclick = close;
    box.append(list, cancel);
    cancel.focus();
  }, () => {});
}

// ---------- sidebar ----------

const sidebar = createSidebar({
  getState: () => state, runtimes, unread, providerIcons: PROVIDER_ICON,
  loadBranch: path => invoke<string | null>("project_branch", { path }),
  statusOf, statusLabel, contextLabel, save, renderPaneHeads, select, createSession,
  start, closeSession, pauseSession, canPause, removeProject, openEditor, showImport, showInfo, jumpAttention,
  showClosedSessions, showNotifications: () => notificationCenter.show(),
  refreshNotifications: () => notificationCenter.refresh(),
});
function renderSidebar() { sidebar.render(); }
function refreshBranches(revisit = false, paths?: string[]) { sidebar.refreshBranches(revisit, paths); }

// ---------- modálne okná ----------

const { modal, confirmBox } = createDialogs(() => runtimes.get(state.ui.activeSessionId ?? "")?.term.focus());
const notificationCenter = createNotificationCenter({
  state: () => state,
  modal,
  changed: () => {
    for (const n of state.notifications) {
      if (n.read && !state.notifications.some(other => other.sessionId === n.sessionId && !other.read)) unread.delete(n.sessionId);
    }
    save();
    renderSidebar();
  },
  select: (id) => {
    const s = session(id);
    const p = s && project(s.projectId);
    if (p) p.collapsed = false;
    select(id);
  },
});

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
  const rt = runtimes.get(s.id);
  const diagnostic = sessionDiagnostics(s, rt?.running ?? false, info.hooksEnabled, rt?.observation);
  rows.push([t("diag.process"), t(rt?.running ? "diag.running" : "diag.stopped")]);
  if (s.exitCode != null && !rt?.running) rows.push([t("diag.exitCode"), String(s.exitCode)]);
  if (s.provider !== "shell") rows.push([t("diag.link"), t(diagnostic.linked ? "diag.assigned" : "diag.unassigned")]);
  rows.push(
    [t("diag.method"), t(`diag.${diagnostic.method}`)],
    [t("diag.detail"), t(`diag.reason.${diagnostic.reason}`)],
  );
  if (s.provider !== "shell") {
    const observation = rt?.observation;
    rows.push([t("diag.lastEvent"), observation
      ? `${observation.event} · ${t(observation.snapshot ? "diag.snapshot" : "diag.received", { time: new Date(observation.receivedAt).toLocaleString(locale()) })}`
      : t("diag.noEvent")]);
  }
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

function showImport(p: Project, target?: Session) {
  let alive = true;
  let generation = 0;
  modal((box, close) => {
    box.append(el("h3", "", t(target ? "import.link" : "import.open")));
    const provider = el("select");
    for (const value of ["claude", "codex", "antigravity"] as const) {
      const option = el("option", "", PROVIDER_LABEL[value]); option.value = value; provider.append(option);
    }
    provider.value = target?.provider ?? (state.settings.defaultProvider === "shell" ? "claude" : state.settings.defaultProvider);
    provider.disabled = !!target;
    provider.setAttribute("aria-label", t("import.provider"));
    const agentId = el("input");
    agentId.type = "text";
    agentId.placeholder = t("import.id"); agentId.setAttribute("aria-label", t("import.id"));
    agentId.value = target?.agentSessionId ?? "";
    const name = el("input");
    let suggestedName = "";
    name.type = "text";
    name.placeholder = t("import.name"); name.setAttribute("aria-label", t("import.name"));
    name.hidden = !!target;
    const note = el("p", "note", t(target ? "import.linkNote" : "import.note"));
    const hint = el("p", "hint");
    const list = el("div", "switch-list pane-session-list");
    const error = el("p", "note"); error.setAttribute("role", "alert");
    const actions = el("div", "actions");
    const cancel = el("button", "", t("common.cancel")); cancel.onclick = close;
    const apply = el("button", "primary", t(target ? "import.link" : "import.add"));
    const validate = () => { apply.disabled = !isUuid(agentId.value.trim()); error.textContent = ""; };
    agentId.oninput = validate;
    apply.onclick = () => {
      if (project(p.id) !== p || (target && session(target.id) !== target)) { close(); return; }
      const result = importConversation(state, p.id, provider.value as Provider, agentId.value, name.value, crypto.randomUUID(), Date.now(), target?.id);
      if (typeof result === "string") { error.textContent = t(`import.${result}`); return; }
      agentMonitor.forget(result.id);
      const rt = runtimes.get(result.id);
      if (rt) rt.observation = undefined;
      statuses.set(result.id, rt?.running ? "untracked" : "exited");
      p.collapsed = false;
      save();
      close();
      if (target) { renderSidebar(); renderPaneHeads(); void pollAgents(); }
      else select(result.id);
    };
    const load = async () => {
      const request = ++generation;
      const selected = provider.value;
      list.replaceChildren(el("p", "hint", t("import.loading")));
      hint.textContent = t(selected === "antigravity" ? "import.agy" : "import.files");
      try {
        const choices = await invoke<{ id: string; modifiedAt: number; title: string | null }[]>("list_conversations", { provider: selected, cwd: p.path });
        if (!alive || generation !== request) return;
        list.replaceChildren();
        for (const choice of choices) {
          const existing = state.sessions.find(s => s.provider === selected && s.agentSessionId?.toLowerCase() === choice.id.toLowerCase() && s.id !== target?.id);
          const title = existing?.title || choice.title || t("import.untitled");
          const button = el("button", "conversation-choice");
          button.append(el("strong", "", title), el("span", "hint", `${choice.id} · ${new Date(choice.modifiedAt).toLocaleString(locale())}${existing ? ` · ${t("import.added")}` : ""}`));
          button.disabled = !!existing;
          button.onclick = () => {
            agentId.value = choice.id;
            if (!name.value.trim() || name.value === suggestedName) name.value = choice.title ?? "";
            suggestedName = choice.title ?? "";
            validate(); agentId.focus();
          };
          list.append(button);
        }
        if (!choices.length) list.append(el("p", "hint", t("import.empty")));
      } catch {
        if (alive && generation === request) list.replaceChildren(el("p", "hint", t("import.failed")));
      }
    };
    provider.onchange = () => { agentId.value = ""; validate(); void load(); };
    actions.append(cancel, apply);
    const idLabel = el("label", "", t("import.id")); idLabel.append(agentId);
    const nameLabel = el("label", "", t("import.name")); nameLabel.append(name); nameLabel.hidden = !!target;
    box.append(provider, note, hint, list, idLabel, nameLabel, error, actions);
    validate(); void load(); agentId.focus();
  }, () => { alive = false; });
}

function showInfo(s: Session) {
  let timer: number | undefined;
  modal(
    (box, close) => {
      const grid = el("dl", "info");
      const recovery = el("div", "note");
      const repair = el("button");
      const draw = () => {
        grid.replaceChildren(...infoRows(s).flatMap(([k, v]) => [el("dt", "", k), el("dd", "", v)]));
        const rt = runtimes.get(s.id);
        const action = sessionDiagnostics(s, rt?.running ?? false, info.hooksEnabled, rt?.observation).recovery;
        recovery.hidden = !action;
        recovery.textContent = action ? t(`diag.help.${action}`) : "";
        repair.hidden = !action || action === "link" || action === "restartApp";
        repair.textContent = action === "resume" ? t("session.restart") : t("diag.openTerminal");
        repair.onclick = () => {
          close();
          select(s.id);
          if (action === "resume" && !runtimes.get(s.id)?.running) void start(s);
        };
      };
      draw();
      timer = window.setInterval(draw, 2000);
      const note = s.provider === "claude" ? t("info.noteClaude") : s.provider === "codex" ? t("info.noteCodex") : s.provider === "antigravity" ? t("info.noteAntigravity") : "";
      const actions = el("div", "actions");
      actions.append(repair);
      if (s.provider !== "shell") {
        const link = el("button", "", t("import.link"));
        link.onclick = () => { const p = project(s.projectId); close(); if (p) showImport(p, s); };
        actions.append(link);
      }
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
      box.append(recovery);
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

/** Prepne jazyk bez reštartu: statické texty, zoznam, hlavičky terminálov a vyhľadávania. */
function applyLanguage() {
  setLang(state.settings.language);
  translateDocument();
  renderSidebar();
  renderPaneHeads();
}

// ---------- aktualizácie ----------

const { checkUpdate, installUpdate } = createUpdates(confirmBox, toast, flushForRestart, () => info.automaticUpdates);
const showSettings = createSettings(
  () => state.settings,
  (draft, langChanged) => { state.settings = draft; applyFontSize(); save(); if (langChanged) applyLanguage(); else renderSidebar(); textEditor?.configure(); refreshShortcutHints(); },
  modal, toast, checkUpdate, installUpdate,
);
const openSettings = () => showSettings(info);


// ---------- klávesy, resizer, štart ----------

function applyFontSize() {
  for (const rt of runtimes.values()) {
    if (rt.term.options.fontSize !== state.settings.fontSize) rt.term.options.fontSize = state.settings.fontSize;
  }
  fitSoon();
}
function changeFontSize(value: number) {
  const size = normalizeFontSize(value);
  if (size === state.settings.fontSize) return;
  state.settings.fontSize = size;
  applyFontSize();
  save();
}
function appActions(): PaletteAction[] {
  const active = session(state.ui.activeSessionId ?? "");
  const p = active ? project(active.projectId) : undefined;
  const rt = runtimes.get(state.ui.activeSessionId ?? "");
  const run: Partial<Record<ActionId, () => void>> = {
    fontIncrease: () => changeFontSize(state.settings.fontSize + 1),
    fontDecrease: () => changeFontSize(state.settings.fontSize - 1),
    fontReset: () => changeFontSize(FONT_DEFAULTS.fontSize),
    palette: openPalette, switch: quickSwitch, grid: toggleGrid, templates: openTemplates,
    attention: jumpAttention, search: () => { if (rt) openSearch(rt); },
    zoom: () => { if (active) togglePaneZoom(zoomedId ?? active.id); },
    settings: openSettings, shortcuts: () => showSettings(info, true),
    layouts: () => showSavedLayouts(state, modal, save, restorePaneLayout),
    notifications: notificationCenter.show, history: showClosedSessions,
    editor: () => { if (p) openEditor(p.path); }, addProject: () => void addProject(),
  };
  for (const provider of ["claude", "codex", "antigravity", "shell"] as const)
    run[provider] = () => { if (p) void createSession(p, provider); };
  return ACTION_IDS.map(id => {
    if (id.startsWith("session")) {
      const s = sessionByNumber(state, Number(id.slice(7)));
      return { id, enabled: !!s, run: () => {
        if (!s) return;
        const target = project(s.projectId); if (target) target.collapsed = false;
        select(s.id);
      } };
    }
    const needsProject = ["editor", "claude", "codex", "antigravity", "shell"].includes(id);
    return { id, enabled: needsProject ? !!p : id === "search" ? !!rt : id === "zoom" ? !!active : true, run: run[id]! };
  });
}
function openPalette() {
  const active = session(state.ui.activeSessionId ?? "");
  const p = active ? project(active.projectId) : undefined;
  showPalette(modal, appActions().filter(a => a.id !== "palette"), state.settings.shortcuts, info.platform === "macos",
    p ? t("actions.context", { name: p.name }) : t("actions.noProject"));
}
function isAppShortcut(e: KeyboardEvent): boolean {
  return shortcutAction(e, state.settings.shortcuts) !== undefined;
}
function handleGlobalKey(e: KeyboardEvent): boolean {
  const id = shortcutAction(e, state.settings.shortcuts);
  if (!id) return true;
  e.preventDefault(); e.stopPropagation();
  if (!e.repeat) {
    const action = appActions().find(a => a.id === id);
    if (action?.enabled) action.run();
  }
  return false;
}
function refreshShortcutHints() {
  for (const [selector, id] of Object.entries({ "#btn-palette": "palette", "#btn-switch": "switch", "#btn-templates": "templates" })) {
    const button = document.querySelector<HTMLElement>(selector);
    const binding = bindingLabel(bindingFor(id as ActionId, state.settings.shortcuts), info.platform === "macos");
    if (button) { button.title = actionLabel(id as ActionId) + (binding ? ` (${binding})` : ""); button.setAttribute("aria-label", button.title); }
  }
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
  const stored = await invoke<{ json: string | null; recovered: boolean }>("load_state");
  const loaded = parseState(stored.json);
  state = loaded.state;
  setLang(state.settings.language);
  translateDocument();
  if (stored.recovered) toast(t("app.recovered"), true);
  if (loaded.dropped) toast(t("app.corrupted", { n: loaded.dropped }));

  setupResizer();
  $("#btn-add-project").onclick = () => void addProject();
  $("#btn-palette").onclick = openPalette;
  refreshShortcutHints();
  $("#btn-switch").onclick = quickSwitch;
  $("#btn-grid").onclick = showLayoutControls;
  $("#btn-settings").onclick = openSettings;
  $("#btn-text-editor").onclick = () => void openTextEditor();
  $("#btn-templates").onclick = openTemplates;
  $("#btn-update").onclick = () => void installUpdate();
  document.addEventListener("keydown", (e) => {
    if (isAppShortcut(e) && $("#overlay").hidden) handleGlobalKey(e);
  });

  new ResizeObserver(fitSoon).observe($("#stage"));

  await listen<{ id: string; code: number | null; systemShutdown?: boolean }>("pty-exit", (e) => onExit(e.payload.id, e.payload.code, e.payload.systemShutdown));
  await listen<AgentEvent>("agent-event", (e) => onAgentEvent(e.payload));
  const fileDrop = createFileDropHandler({
    targets: () => runtimes.values(),
    blocked: () => closingWindow || !$("#overlay").hidden,
    platform: () => info.platform,
    hint: ready => t(ready ? "drop.ready" : "drop.holdShift"),
    invalid: () => toast(t("drop.invalid")),
  });
  await listen<FileDrag>("terminal-file-drag", e => fileDrop(e.payload));

  const prepareShutdown = createShutdownHandler(flushForRestart,
    (id, saved) => invoke("shutdown_ready", { id, saved }),
    () => { closingWindow = true; },
    e => toast(t("app.saveFailed", { detail: String(e) })),
    async id => !busy().length || !await invoke<boolean>("shutdown_defer", { id }) || confirmQuit());
  await listen<string>("prepare-shutdown", e => void prepareShutdown(e.payload));
  await listen("shutdown-cancelled", () => { closingWindow = false; });
  const pendingShutdownsAtStartup = await invoke<string[]>("shutdown_pending");
  await Promise.all(pendingShutdownsAtStartup.map(prepareShutdown));

  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closingWindow) return;
    closingWindow = true;
    if (textEditor && !await textEditor.mayClose()) { closingWindow = false; return; }
    if (!await confirmQuit()) { closingWindow = false; return; }
    markInterrupted();
    try { await saves.flush(); await win.destroy(); }
    catch (e) { closingWindow = false; toast(t("app.saveFailed", { detail: String(e) })); }
  });
  await win.onFocusChanged(({ payload }) => {
    windowFocused = payload;
    if (payload) {
      refreshBranches(true);
      let changed = false;
      for (const id of visibleIds()) {
        unread.delete(id);
        if (readAttention(state, id)) changed = true;
      }
      if (changed) save();
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
      if (session(s.id) && shouldAutoResume(s, state.settings.autoResume) && !runtimes.has(s.id)) await start(s);
    }
  }
  if (state.ui.grid) {
    restorePaneLayout();
  }
  const active = session(state.ui.activeSessionId);
  if (active?.stopped && !runtimes.has(active.id)) { createRuntime(active); layout(); renderPaneHeads(); }
}

void main().catch((error) => {
  const empty = $("#empty");
  empty.replaceChildren(el("p", "", t("app.loadFailed")), el("p", "hint", String(error)));
});
