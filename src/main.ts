import { createTerminalFactory, attachWebgl, fitTerminal, reclaimSize, type Runtime } from "./terminal-runtime.ts";
import { createTerminalLifecycle, type OutputChunk } from "./terminal-lifecycle.ts";
import { createAgentMonitor } from "./agent-monitor.ts";
import { createAgentUpdates } from "./agent-updates.ts";
import { createSystemNotifications } from "./system-notifications.ts";
import { openSearch, setSearchTheme } from "./terminal-search.ts";
import { removeProjectState, applyPanePreset, savePanePreset, paneDropSide, dropOnPane } from "./model.ts";
import { createSidebar } from "./sidebar.ts";
import { showPalette, actionLabel, bindingLabel, type PaletteAction } from "./actions.ts";
import { applyUiTheme, terminalTheme } from "./theme.ts";
import { normalizeFontSize, normalizeScrollback, DEFAULT_SETTINGS as FONT_DEFAULTS, ACTION_IDS, bindingFor, shortcutAction, type ActionId } from "./model.ts";
import { createSettings } from "./settings.ts";
import type { RemoteStatus } from "./remote/protocol.ts";
import { createFileDropHandler } from "./file-drop.ts";
import { createTemplates } from "./templates.ts";
import { createFileLinks } from "./file-links.ts";
import { createRemoteBridge } from "./remote-bridge.ts";
import { createSessionDialogs } from "./session-dialogs.ts";
import { createNotificationCenter } from "./notifications.ts";
import { createPaneLayout } from "./panes.ts";
import { showSavedLayouts } from "./saved-layouts.ts";
import { createUpdates } from "./updates.ts";
import { $, el, onNextFrame, iconButton, createPressGuard } from "./dom.ts";
import { createSaveQueue, createShutdownHandler } from "./persistence.ts";
import { createDialogs } from "./dialogs.ts";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

import { Channel } from "@tauri-apps/api/core";
import { call, on, type AppInfo } from "./ipc.ts";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

import {
  attentionEventKind,
  recordAttention,
  readAttention,
  type PaneLayout,
  restoreSession,
  shouldAutoResume,
  busyAgents,
  assignPaneSlot,
  nextAttention,
  ATTENTION,
  clampSidebar,
  folderName,
  formatTokens,
  orderedProjects,
  parseState,
  type PersistedState,
  type Project,
  PROVIDER_LABEL,
  type Provider,
  type Session,
  sessionByNumber,
  interruptedAgents,
  sessionsOf,
  type Status,
} from "./model.ts";
import { errorText, type Key, setLang, t, translateDocument } from "./i18n.ts";

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
  (json) => call("save_state", { json }),
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
/** S ID relácie pridá pri čakaní na pozadí aj počet bežiacich úloh. */
const statusLabel = (s: Status, id?: string) => {
  const label = t(`status.${s}` as Key);
  const tasks = s === "background-task" && id ? agentMonitor.backgroundTasksOf(id) : 0;
  return tasks ? `${label} (${tasks})` : label;
};

/** Správa v rohu; `info` = nie je to chyba. */
function toast(msg: string, info = false) {
  const t = el("div", info ? "toast info" : "toast", msg);
  document.body.append(t);
  window.setTimeout(() => t.remove(), 6000);
}

// Status updates must not replace a button between press and release, or its click is lost.
const pressGuard = createPressGuard(target => target instanceof Element && !!target.closest("#sidebar, #sidebar-rail, .pane-head"));

const renderSoon = onNextFrame(() => {
  renderSidebar();
  renderPaneHeads();
});
/** Mobil dostane stav hneď: requestAnimationFrame pri minimalizovanom okne nemusí bežať. */
function renderStatusSoon() {
  remote.publish();
  renderSoon();
}

const remote = createRemoteBridge({
  getState: () => state, runtimes, statusOf, toast, save,
  canPause: s => canPause(s), pauseSession: (s, confirm) => pauseSession(s, confirm), start: (s, focus) => start(s, focus),
  markSessionRead: id => markSessionRead(id), renderSidebar: () => renderSidebar(),
});

const agentMonitor = createAgentMonitor({
  getState: () => state, runtimes, isClosing: () => closingWindow,
  invoke: call, save, statusOf, setStatus, renderStatusSoon,
});
const { statsOf, lookupCodexSessions, pollAgents, onAgentEvent } = agentMonitor;
// Po aktualizácii Claude Code/Codexu reštartuje nečinné relácie (konverzácie pokračujú).
const agentUpdates = createAgentUpdates({
  getState: () => state, runtimes, statusOf, unread, isWatched, isClosing: () => closingWindow, invoke: call,
  restart: (s, version) => void terminalLifecycle.restartSession(s, t("agentUpdate.restarting", { version })),
  announce: (agent, version) => toast(t("agentUpdate.found", { agent: PROVIDER_LABEL[agent], version }), true),
});

function setStatus(id: string, next: Status, silent = false) {
  const prev = statusOf(id);
  if (prev === next) return;
  statuses.set(id, next);
  agentUpdates.statusChanged(id, next);
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
  return (windowFocused && visibleIds().includes(id)) || remote.isWatching(id);
}

const notify = createSystemNotifications({
  enabled: () => state.settings.notifications, session, project, statusLabel,
});

const { setupLinks, openEditor, openTextEditor, openFolder, openFolderLabel, configureEditor, editorPending, editorMayClose } = createFileLinks({
  getState: () => state, platform: () => info.platform, toast,
  confirmBox: (...args) => confirmBox(...args), editorVisibilityChanged,
});

const createRuntime = createTerminalFactory({
  toast,
  getState: () => state, runtimes, setupLinks, isAppShortcut, handleGlobalKey,
  isWatched, unread, renderSidebar, notify, select, onTyped: id => agentUpdates.input(id),
});
const terminalLifecycle = createTerminalLifecycle({
  getState: () => state, getInfo: () => info, runtimes, statuses, unread, agentMonitor,
  isClosing: () => closingWindow, editingId: () => sidebar.editingId(), createRuntime, invoke: call,
  createOutput: () => new Channel<OutputChunk>(), schedule: (callback, delay) => window.setTimeout(callback, delay),
  save, flush: () => saves.flush(), statusOf, setStatus, isWatched, layout, renderSidebar, renderPaneHeads, toast,
  confirmBox: (...args) => confirmBox(...args), onSpawned: s => agentUpdates.spawned(s),
});
const { start, onExit, closeSession, pauseSession, canPause, forgetRuntime } = terminalLifecycle;

// ---------- zobrazenie (jedna relácia alebo mriežka) ----------

let zoomedId: string | undefined;
/** Najviac toľko terminálov drží WebGL kontext (viditeľné majú prednosť). */
const WEBGL_BUDGET = 10;
let webglRecent: string[] = [];
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
    // Kurzor bliká len v aktívnom viditeľnom termináli; ostatné nebudia procesor.
    const blink = show && id === state.ui.activeSessionId;
    if (rt.term.options.cursorBlink !== blink) rt.term.options.cursorBlink = blink;
    if (show) {
      if (!rt.webgl) attachWebgl(rt);
      webglRecent = [id, ...webglRecent.filter(x => x !== id)];
    }
  }
  // WebGL majú viditeľné a naposledy zobrazené terminály, spolu najviac WEBGL_BUDGET:
  // prepnutie späť je bez nového kontextu a limit prehliadača (~16) sa neprekročí.
  webglRecent = webglRecent.filter(id => runtimes.has(id));
  const shown = ids.filter((id): id is string => !!id && runtimes.has(id));
  const keep = new Set([...new Set([...shown, ...webglRecent])].slice(0, Math.max(WEBGL_BUDGET, shown.length)));
  for (const [id, rt] of runtimes) {
    if (rt.webgl && !keep.has(id)) { rt.webgl.dispose(); rt.webgl = undefined; }
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
      fitTerminal(rt);
    } catch {
      // kontajner ešte nemá rozmery
    }
  }
}

function renderPaneHeads() {
  if (pressGuard.defer(renderPaneHeads)) return;
  for (const [id, rt] of runtimes) {
    const s = session(id);
    if (!s) continue;
    const p = project(s.projectId);
    rt.head.replaceChildren(el("span", "pane-title", `${PROVIDER_ICON[s.provider]} ${s.title} · ${p?.name ?? ""} · ${statusLabel(statusOf(id), id)}${contextLabel(s)}`));
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
const busy = () => busyAgents(state.sessions, statusOf, id => runtimes.get(id)?.running === true);
let quitConfirmation: Promise<boolean> | undefined;
/** Concurrent quit requests (window, menu, AppKit) share one dialog. */
function confirmQuit(): Promise<boolean> {
  const sessions = busy();
  if (!sessions.length) return Promise.resolve(true);
  // Stacked: a quit cancelled from here must leave an open dialog (Settings) as it was.
  return quitConfirmation ??= confirmBox(t("quit.title"), t("quit.body", { titles: sessions.map(s => s.title).join(", ") }), t("quit.ok"), "", { stack: true })
    .finally(() => { quitConfirmation = undefined; });
}
/** Remember interrupted steps so the restarted sessions can say so. */
function markInterrupted() {
  for (const s of interruptedAgents(state.sessions, statusOf, id => runtimes.get(id)?.running === true)) s.interrupted = true;
}
async function flushForRestart() {
  if (editorPending()) throw new Error(t("textEditor.saveFirst"));
  markInterrupted();
  await saves.flush();
}

// ---------- akcie ----------

/** Zruší neprečítaný stav relácie; vráti true, ak sa zmenil uložený stav.
 *  Ručné označenie ruší len explicitné otvorenie, nie návrat fokusu do okna. */
function markSessionRead(id: string, includeManual = true): boolean {
  unread.delete(id);
  const s = session(id);
  const manual = includeManual && s?.markedUnread === true;
  if (manual) s!.markedUnread = undefined;
  return readAttention(state, id) || manual;
}

function select(id: string, focus = true) {
  const s = session(id);
  if (!s) return;
  if (state.ui.grid) zoomedId = state.ui.paneSlots.includes(id) ? (zoomedId === id ? id : undefined) : id;
  sidebar.revealSession(id);
  state.ui.activeSessionId = id;
  const selectedProject = project(s.projectId);
  if (selectedProject) refreshBranches(true, [selectedProject.path]);
  s.lastUsedAt = Date.now();
  markSessionRead(id);
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
    const exists = await call("project_exists", { path: picked, existing: state.projects.map(p => p.path) });
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
    try { await call("pty_kill", { id: s.id }); }
    catch (e) { toast(errorText(e)); return; }
  }
  for (const s of all) forgetRuntime(s.id);
  removeProjectState(state, p.id);
  // Show the fallback session's stopped terminal instead of an empty stage; never auto-start it.
  const active = session(state.ui.activeSessionId);
  if (active?.stopped && !runtimes.has(active.id)) createRuntime(active);
  save();
  layout();
  renderSidebar();
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
  // Volá sa až pri ťahaní, keď je `paneDrop` už definovaný.
  paneDrop: { hover: (id, x, y) => paneDrop.hover(id, x, y), drop: (id, x, y) => paneDrop.drop(id, x, y), clear: () => paneDrop.clear() },
  openView, saveView, manageViews: () => showSavedLayouts(state, modal, save, restorePaneLayout),
  loadBranch: path => call("project_branch", { path }),
  statusOf, statusLabel, contextLabel, save, renderPaneHeads, select, createSession,
  start, closeSession, pauseSession, canPause, removeProject, openEditor, openFolderLabel, openFolder,
  showImport: p => showImport(p), showInfo: s => showInfo(s), markRead: (id) => { if (markSessionRead(id)) save(); renderSidebar(); }, jumpAttention, showClosedSessions, rendered: () => remote.publish(), deferRender: render => pressGuard.defer(render), layoutChanged: () => fitVisible(), showNotifications: () => notificationCenter.show(),
  refreshNotifications: () => notificationCenter.refresh(),
});
function renderSidebar() { sidebar.render(); }
function refreshBranches(revisit: boolean | number = false, paths?: string[]) { sidebar.refreshBranches(revisit, paths); }

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

const { quickSwitch, showImport, showInfo } = createSessionDialogs({
  getState: () => state, getInfo: () => info, runtimes, statuses, modal, providerIcons: PROVIDER_ICON,
  statusOf, statusLabel, statsOf, select, start, save, renderSidebar, renderPaneHeads,
  forgetAgent: id => agentMonitor.forget(id), pollAgents: () => void pollAgents(),
});

const { openTemplates } = createTemplates({ getState: () => state, runtimes, modal, save, toast });

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
  (draft, langChanged) => {
    const remoteChanged = draft.remoteAccess !== state.settings.remoteAccess || draft.remotePort !== state.settings.remotePort || draft.remoteAddress !== state.settings.remoteAddress;
    state.settings = draft;
    let remoteStatus: Promise<RemoteStatus | null> | undefined;
    if (remoteChanged) { if (!draft.remoteAccess) remote.clearWatching(); remoteStatus = remote.configure(); }
    applyFontSize(); applyTheme(); applyScrollback(); save(); if (langChanged) applyLanguage(); else renderSidebar(); configureEditor(); refreshShortcutHints();
    return remoteStatus;
  },
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
function applyTheme() {
  const theme = state.settings.theme;
  applyUiTheme(theme);
  setSearchTheme(theme);
  const colors = terminalTheme(theme);
  for (const rt of runtimes.values()) rt.term.options.theme = colors;
}
function applyScrollback() {
  const lines = normalizeScrollback(state.settings.terminalScrollback);
  for (const rt of runtimes.values()) {
    if (rt.term.options.scrollback !== lines) rt.term.options.scrollback = lines;
  }
}
// ---------- pohľady a rozdelenie pretiahnutím ----------

/** Pohľad projektu: uloží aktuálne panely; s `id` prepíše existujúci. */
function saveView(p: Project, id?: string) {
  const name = id ? state.savedLayouts.find(l => l.id === id)?.name ?? "" : t("views.defaultName", { n: state.savedLayouts.filter(l => l.projectId === p.id).length + 1 });
  // Pohľad je rozloženie panelov; jedna relácia nie je čo ukladať.
  if (!state.ui.grid) { toast(t("views.needPanels")); return; }
  if (!savePanePreset(state, id ?? crypto.randomUUID(), name, p.id)) return;
  save(); renderSidebar();
  toast(t(id ? "views.updated" : "views.saved", { name }));
}
function openView(id: string) {
  if (!applyPanePreset(state, id)) return;
  zoomedId = undefined;
  restorePaneLayout();
}

let dropMark: HTMLElement | undefined;
/** Panel pod kurzorom a strana, na ktorú by relácia padla. */
function paneUnder(x: number, y: number) {
  const pane = document.elementFromPoint(x, y)?.closest<HTMLElement>("#stage .pane.visible");
  if (!pane) return undefined;
  const id = [...runtimes].find(([, rt]) => rt.pane === pane)?.[0];
  if (!id) return undefined;
  const r = pane.getBoundingClientRect();
  return { id, rect: r, side: paneDropSide((x - r.left) / r.width, (y - r.top) / r.height) };
}
function visiblePanes(): string[] {
  if (!state.ui.grid) return state.ui.activeSessionId ? [state.ui.activeSessionId] : [];
  return state.ui.paneSlots.filter((id): id is string => id !== null && runtimes.has(id));
}
const paneDrop = {
  hover(id: string, x: number, y: number): boolean {
    const under = paneUnder(x, y);
    if (!under || under.id === id) { paneDrop.clear(); return false; }
    dropMark ??= el("div", "pane-drop");
    const { rect: r, side } = under;
    const half = { left: [0, 0, .5, 1], right: [.5, 0, .5, 1], top: [0, 0, 1, .5], bottom: [0, .5, 1, .5], center: [0, 0, 1, 1] }[side];
    Object.assign(dropMark.style, { left: `${r.left + r.width * half[0]}px`, top: `${r.top + r.height * half[1]}px`,
      width: `${r.width * half[2]}px`, height: `${r.height * half[3]}px` });
    if (!dropMark.isConnected) document.body.append(dropMark);
    return true;
  },
  drop(id: string, x: number, y: number) {
    paneDrop.clear();
    const under = paneUnder(x, y);
    if (!under) return;
    const next = dropOnPane(visiblePanes(), state.ui.paneLayout, id, under.id, under.side);
    if (!next) { toast(t("views.tooMany")); return; }
    state.ui.grid = true;
    state.ui.paneLayout = next.paneLayout;
    state.ui.paneSlots = next.paneSlots;
    zoomedId = undefined;
    select(id);
  },
  clear() { dropMark?.remove(); },
};

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
    sidebar: () => sidebar.toggleAutoHide(),
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
  return shortcutAction(e, state.settings.shortcuts, info.platform === "macos") !== undefined;
}
function handleGlobalKey(e: KeyboardEvent): boolean {
  const id = shortcutAction(e, state.settings.shortcuts, info.platform === "macos");
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
    const binding = bindingLabel(bindingFor(id as ActionId, state.settings.shortcuts, info.platform === "macos"), info.platform === "macos");
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
  info = await call("app_info");
  const stored = await call("load_state");
  const loaded = parseState(stored.json);
  state = loaded.state;
  applyTheme();
  setLang(state.settings.language);
  translateDocument();
  if (stored.recovered) toast(t("app.recovered"), true);
  if (stored.restored) toast(t("app.restored"));
  if (loaded.dropped) toast(t("app.corrupted", { n: loaded.dropped }));

  setupResizer();
  sidebar.applyAutoHide();
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

  await on("pty-exit", e => onExit(e.id, e.code, e.systemShutdown));
  await on("agent-event", onAgentEvent);
  const fileDrop = createFileDropHandler({
    targets: () => runtimes.values(),
    blocked: () => closingWindow || !$("#overlay").hidden,
    platform: () => info.platform,
    hint: ready => t(ready ? "drop.ready" : "drop.holdShift"),
    invalid: () => toast(t("drop.invalid")),
  });
  await on("terminal-file-drag", fileDrop);

  const prepareShutdown = createShutdownHandler(flushForRestart,
    (id, saved) => call("shutdown_ready", { id, saved }),
    () => { closingWindow = true; },
    e => toast(t("app.saveFailed", { detail: String(e) })),
    async id => !busy().length || !await call("shutdown_defer", { id }) || confirmQuit());
  await on("prepare-shutdown", id => void prepareShutdown(id));
  await on("shutdown-cancelled", () => { closingWindow = false; });
  const pendingShutdownsAtStartup = await call("shutdown_pending");
  await Promise.all(pendingShutdownsAtStartup.map(prepareShutdown));

  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    event.preventDefault();
    if (closingWindow) return;
    closingWindow = true;
    if (!await editorMayClose()) { closingWindow = false; return; }
    if (!await confirmQuit()) { closingWindow = false; return; }
    markInterrupted();
    try { await saves.flush(); await win.destroy(); }
    catch (e) { closingWindow = false; toast(t("app.saveFailed", { detail: String(e) })); }
  });
  await remote.listen();
  await win.onFocusChanged(({ payload }) => {
    windowFocused = payload;
    if (payload) {
      // Alt-Tab spúšťa git pre každý projekt; stačí raz za 30 s.
      refreshBranches(30_000);
      let changed = false;
      for (const id of visibleIds()) {
        const rt = runtimes.get(id);
        if (rt) reclaimSize(rt, id);
        if (markSessionRead(id, false)) changed = true;
      }
      if (changed) save();
      renderSidebar();
    }
  });

  renderSidebar();
  layout();
  void remote.configure();
  window.setInterval(() => void lookupCodexSessions(), 3000);
  // Skryté okno bez pracujúceho agenta stačí kontrolovať raz za 10 s; hooky hlásia zmeny hneď.
  let lastPoll = 0;
  window.setInterval(() => {
    const idle = document.hidden && !state.sessions.some(s => statusOf(s.id) === "working");
    if (idle && Date.now() - lastPoll < 10_000) return;
    lastPoll = Date.now();
    void pollAgents();
  }, 2000);
  // Verzia na disku: raz za 15 min (prvá po obnovení relácií); nečinné relácie sa kontrolujú každú minútu.
  window.setTimeout(() => void agentUpdates.check(), 60_000);
  window.setInterval(() => void agentUpdates.check(), 15 * 60_000);
  window.setInterval(() => agentUpdates.restartIdle(), 60_000);
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
