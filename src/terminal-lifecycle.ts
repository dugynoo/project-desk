import { agentCommand, archiveSession, codexHooksFit, backgroundStatus, isUuid, recordSessionExit,
  statusAfterSpawn, statusAfterStartupTimeout, type PersistedState, type Session, type Status } from "./model.ts";
import { errorText, t } from "./i18n.ts";
import type { MonitoredRuntime, createAgentMonitor } from "./agent-monitor.ts";

export interface OutputChunk { data: string; ack?: number }
/** Minimal resources needed for process lifetime; also usable without a DOM in tests. */
export interface LifecycleRuntime extends MonitoredRuntime {
  outputId?: string;
  term: {
    cols: number; rows: number;
    write(data: string, done?: () => void): void;
    writeln(data: string): void;
    focus(): void;
    dispose(): void;
  };
  fit: { fit(): void };
  webgl?: { dispose(): void };
  colsTimer?: ReturnType<typeof setTimeout>;
  pane: { remove(): void };
  /** Exit requested by Pause: keep the session listed and stopped, not archived. */
  pausing?: boolean;
}

interface Dependencies<R extends LifecycleRuntime> {
  getState: () => PersistedState;
  getInfo: () => { platform: string; hooksEnabled: boolean };
  runtimes: Map<string, R>;
  statuses: Map<string, Status>;
  unread: Set<string>;
  agentMonitor: Pick<ReturnType<typeof createAgentMonitor>, "cancelDiscovery" | "discover" | "forget">;
  isClosing: () => boolean;
  editingId: () => string | undefined;
  createRuntime: (session: Session) => R;
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  createOutput: () => { onmessage: (chunk: OutputChunk) => void };
  schedule: (callback: () => void, delay: number) => unknown;
  save: () => void;
  flush: () => Promise<void>;
  statusOf: (id: string) => Status;
  setStatus: (id: string, status: Status, silent?: boolean) => void;
  isWatched: (id: string) => boolean;
  layout: () => void;
  renderSidebar: () => void;
  renderPaneHeads: () => void;
  toast: (message: string) => void;
  confirmBox: (title: string, message: string, action: string) => Promise<boolean>;
}

/** Owns start/exit/close ordering and output channels, without installing global listeners. */
export function createTerminalLifecycle<R extends LifecycleRuntime>({ getState, getInfo, runtimes,
  statuses, unread, agentMonitor, isClosing, editingId, createRuntime, invoke, createOutput,
  schedule, save, flush, statusOf, setStatus, isWatched, layout, renderSidebar, renderPaneHeads,
  toast, confirmBox }: Dependencies<R>) {
  const session = (id: string) => getState().sessions.find(s => s.id === id);
  const project = (id: string) => getState().projects.find(p => p.id === id);
  function disposeRuntime(id: string) {
    const rt = runtimes.get(id);
    if (!rt) return;
    if (rt.outputId) void invoke("pty_output_cancel", { outputId: rt.outputId }).catch(console.error);
    clearTimeout(rt.colsTimer);
    rt.webgl?.dispose();
    rt.term.dispose();
    rt.pane.remove();
    runtimes.delete(id);
  }

  const pendingStarts = new Set<string>();

  async function start(s: Session) {
    const p = project(s.projectId);
    if (!p || pendingStarts.has(s.id) || runtimes.get(s.id)?.running || isClosing()) return;
    if (s.provider === "codex" && s.started && !isUuid(s.agentSessionId)) {
      pendingStarts.add(s.id);
      try {
        const exclude = getState().sessions.filter((x) => x.id !== s.id && x.agentSessionId).map((x) => x.agentSessionId!);
        const found = await invoke<string | null>("recover_codex_session", { cwd: p.path, createdMs: s.createdAt, exclude }).catch(() => null);
        if (session(s.id) !== s || isClosing()) return;
        // Another asynchronous recovery may already have claimed this ID.
        if (isUuid(found) && !getState().sessions.some((x) => x.id !== s.id && x.agentSessionId === found)) {
          s.agentSessionId = found;
          save();
        }
      } finally {
        pendingStarts.delete(s.id);
      }
    }
    // Bez prvého promptu nie je čo obnoviť; nové ID zabráni kolízii s nedokončenou reláciou.
    if (s.provider === "claude" && !s.background && (!s.hasConversation || !isUuid(s.agentSessionId))) {
      s.agentSessionId = crypto.randomUUID();
      s.hasConversation = false;
    }
    const { platform, hooksEnabled } = getInfo();
    // Without the hook, session-file discovery still finds the Codex conversation.
    const hooks = hooksEnabled && (s.provider !== "codex" || codexHooksFit(platform, p.path));
    const command = agentCommand(s, getState().settings, platform, hooks);
    s.resumeAfterShutdown = false;
    s.exitCode = undefined;
    s.lastStartAt = Date.now();
    agentMonitor.cancelDiscovery(s.id);
    if (s.provider === "codex" && !s.started) {
      const path = p.path.replace(/\\/g, "/").replace(/\/+$/, "");
      agentMonitor.discover(s.id, getInfo().platform === "windows" ? path.toLowerCase() : path);
    }
    const rt = runtimes.get(s.id) ?? createRuntime(s);
    rt.observation = undefined;
    statuses.set(s.id, "starting");
    layout();
    try {
      rt.fit.fit();
    } catch {
      // použijú sa predvolené rozmery
    }

    if (rt.outputId) void invoke("pty_output_cancel", { outputId: rt.outputId }).catch(console.error);
    const outputId = crypto.randomUUID();
    rt.outputId = outputId;
    const output = createOutput();
    output.onmessage = (chunk) => {
      if (rt.outputId !== outputId || runtimes.get(s.id) !== rt) return;
      rt.term.write(chunk.data, chunk.ack === undefined ? undefined : () => {
        void invoke("pty_output_ack", { outputId, through: chunk.ack }).catch(console.error);
      });
    };
    rt.running = true;
    rt.closing = false;
    pendingStarts.add(s.id);
    try {
      // Persist ownership intent before starting a worker that can outlive this app.
      if (s.background) await flush();
      const prepared = await invoke<{ sessionId: string; status: string } | null>("pty_spawn", {
        args: {
          id: s.id,
          outputId,
          cwd: p.path,
          provider: s.provider,
          background: s.background === true,
          claudeCommand: getState().settings.claudeCommand,
          command: command ?? null,
          shell: getState().settings.shell || null,
          cols: rt.term.cols,
          rows: rt.term.rows,
        },
        onOutput: output,
      });
      if (prepared) {
        s.agentSessionId = prepared.sessionId;
        if (statusOf(s.id) === "starting") statuses.set(s.id, backgroundStatus(prepared.status));
      }
    } catch (e) {
      rt.running = false;
      s.stopped = true;
      statuses.set(s.id, "exited");
      rt.term.writeln(`\r\n${errorText(e)}`);
      agentMonitor.cancelDiscovery(s.id);
      save();
      toast(errorText(e));
      layout();
      renderSidebar();
      renderPaneHeads();
      return;
    } finally { pendingStarts.delete(s.id); }
    if (!rt.running || !session(s.id)) return;
    const initialStatus = statusAfterSpawn(statusOf(s.id), s, getInfo().hooksEnabled);
    s.started = true;
    s.stopped = false;
    s.exitCode = undefined;
    statuses.set(s.id, initialStatus);
    const startedAt = s.lastStartAt;
    schedule(() => {
      if (runtimes.get(s.id) !== rt || !rt.running || s.lastStartAt !== startedAt) return;
      setStatus(s.id, statusAfterStartupTimeout(statusOf(s.id)), true);
    }, 15_000);
    save();
    renderSidebar();
    renderPaneHeads();
    if (s.id === getState().ui.activeSessionId && editingId() !== s.id) rt.term.focus();
  }

  function forgetRuntime(id: string) {
    disposeRuntime(id);
    statuses.delete(id);
    unread.delete(id);
    agentMonitor.forget(id);
  }

  function onExit(id: string, code: number | null, systemShutdown = false) {
    agentMonitor.cancelDiscovery(id);
    const rt = runtimes.get(id);
    const s = session(id);
    if (!s) { forgetRuntime(id); return; }
    const paused = rt?.pausing === true;
    if (rt) { rt.running = false; rt.pausing = false; }
    recordSessionExit(getState(), id, code, rt?.closing ?? false, systemShutdown);
    if (paused) s.exitCode = undefined;
    if (s.background && !rt?.closing) {
      s.stopped = false; // Attachment exited; the worker may still be running.
      statuses.set(id, "sleeping");
      rt?.term.writeln(`\r\n${t("background.detached")}`);
      save(); layout(); renderSidebar(); renderPaneHeads();
      return;
    }
    if (rt?.closing) {
      forgetRuntime(id);
    } else {
      statuses.set(id, "exited");
      rt?.term.writeln(`\r\n${paused ? t("session.pausedNotice") : t("session.exitCode", { code: code ?? "?" })}`);
      if (!paused && !isWatched(id)) unread.add(id);
    }
    save();
    // Persist shutdown recovery without waiting for the debounce or window-close event.
    if (systemShutdown) void flush().catch(e => console.error("Shutdown state save failed", e));
    layout();
    renderSidebar();
    renderPaneHeads();
  }

  async function closeSession(s: Session) {
    if (pendingStarts.has(s.id)) { toast(t("background.starting")); return; }
    const rt = runtimes.get(s.id);
    if (s.background && !rt?.running) {
      if (!(await confirmBox(t("close.title"), t("close.body", { title: s.title }), t("common.close")))) return;
      try { await invoke("pty_kill", { id: s.id }); } catch (e) { toast(errorText(e)); return; }
    }
    if (rt?.running) {
      const ok = await confirmBox(t("close.title"), t("close.body", { title: s.title }), t("common.close"));
      if (!ok) return;
      // It may have exited while the confirmation dialog was open.
      if (rt.running) {
        rt.closing = true;
        await invoke("pty_kill", { id: s.id }).catch((e) => { rt.closing = false; toast(errorText(e)); });
        return; // onExit uprace
      }
    }
    archiveSession(getState(), s.id);
    forgetRuntime(s.id);
    save();
    layout();
    renderSidebar();
  }

  /** Agents resume their conversation on Start again; shells and detachable workers have nothing to pause. */
  function canPause(s: Session) {
    return s.provider !== "shell" && !s.background && !pendingStarts.has(s.id) && runtimes.get(s.id)?.running === true;
  }

  async function pauseSession(s: Session) {
    if (!canPause(s)) return;
    if (statusOf(s.id) === "working"
      && !(await confirmBox(t("pause.title"), t("pause.body", { title: s.title }), t("session.pause")))) return;
    const rt = runtimes.get(s.id);
    if (!rt?.running || rt.closing) return;
    rt.pausing = true;
    await invoke("pty_kill", { id: s.id }).catch((e) => { rt.pausing = false; toast(errorText(e)); });
  }

  return { start, onExit, closeSession, pauseSession, canPause, forgetRuntime, isStarting: (id: string) => pendingStarts.has(id) };
}
