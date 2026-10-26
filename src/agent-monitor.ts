import {
  createDiscovery, codexPollEvents, codexStatusAfter, isUuid, observeSession, statusAfter,
  type AgentEvent, type AgentStats, type PersistedState, type Session, type SessionObservation, type Status,
} from "./model.ts";

/** Only the lifecycle metadata needed by the monitor; no terminal or DOM dependency. */
export interface MonitoredRuntime {
  running: boolean;
  closing: boolean;
  observation?: SessionObservation;
}

interface Dependencies {
  getState: () => PersistedState;
  runtimes: ReadonlyMap<string, MonitoredRuntime>;
  isClosing: () => boolean;
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  save: () => void;
  statusOf: (id: string) => Status;
  setStatus: (id: string, status: Status, silent?: boolean) => void;
  renderStatusSoon: () => void;
}

/** One monitor per app. The caller owns scheduling and native event subscriptions. */
export function createAgentMonitor({ getState, runtimes, isClosing, invoke, save, statusOf, setStatus, renderStatusSoon }: Dependencies) {
  const session = (id: string) => getState().sessions.find(s => s.id === id);
  const project = (id: string) => getState().projects.find(p => p.id === id);
  const agentStats = new Map<string, { agentId: string; stats: AgentStats }>();
  const statsOf = (s: Session) => {
    const entry = agentStats.get(s.id);
    return entry && entry.agentId === s.agentSessionId ? entry.stats : undefined;
  };

  // Codex si ID konverzácie vytvorí sám (najneskôr pri prvom prompte). Na macOS a Linuxe ho
  // oznámi SessionStart hook z vlastného procesu, aj po /resume. Inak, alebo keď Codex hook
  // nespustí, ho dohľadávame v session súboroch. Tam len pri úplne novej relácii: tá, čo sa
  // otvorila cez výber v `codex resume`, by si inak mohla privlastniť cudziu konverzáciu z toho istého projektu.
  const codexLookup = createDiscovery();

  async function lookupCodexSessions() {
    await codexLookup.run(async (id, current) => {
      const s = session(id);
      const p = s && project(s.projectId);
      if (!s || !p || !s.lastStartAt || !runtimes.get(id)?.running || isUuid(s.agentSessionId)) {
        codexLookup.delete(id);
        return;
      }
      const exclude = getState().sessions.filter((x) => x.id !== id && x.agentSessionId).map((x) => x.agentSessionId!);
      const runtime = runtimes.get(id);
      const startedAt = s.lastStartAt;
      const found = await invoke<string | null>("find_codex_session", { cwd: p.path, sinceMs: s.lastStartAt, exclude }).catch(() => null);
      if (!current() || isClosing() || session(id) !== s || project(s.projectId) !== p
        || runtimes.get(id) !== runtime || !runtime?.running || runtime.closing || s.lastStartAt !== startedAt) return;
      if (isUuid(found) && !isUuid(s.agentSessionId) && !getState().sessions.some((x) => x.id !== id && x.agentSessionId === found)) {
        s.agentSessionId = found;
        codexLookup.delete(id);
        save();
      }
    });
  }

  // Tokeny a kontext pre Claude aj Codex, pri Codexe aj stav (Codex nemá hooky bez zásahu do jeho konfigurácie).
  let polling = false;
  let retainedAgents = "";
  async function pollAgents() {
    if (polling) return;
    polling = true;
    let changed = false;
    const polledIds = new Set<string>();
    try {
      for (const s of [...getState().sessions]) {
        const agentId = s.agentSessionId;
        if (s.provider === "shell" || s.provider === "antigravity" || !isUuid(agentId) || !runtimes.get(s.id)?.running) continue;
        const runtime = runtimes.get(s.id)!;
        const startedAt = s.lastStartAt;
        polledIds.add(agentId);
        const r = await invoke<{ stats: AgentStats; status: string | null; events: string[] } | null>("agent_poll", { provider: s.provider, agentId, generation: startedAt ?? 0 }).catch(() => null);
        if (!r || session(s.id) !== s || s.agentSessionId !== agentId || runtimes.get(s.id) !== runtime
          || !runtime.running || runtime.closing || s.lastStartAt !== startedAt) continue;
        const before = statsOf(s)?.contextTokens;
        agentStats.set(s.id, { agentId, stats: r.stats });
        if (before !== r.stats.contextTokens) changed = true;
        const observedEvent = r.events.at(-1) ?? r.status;
        if (s.provider === "codex" && observedEvent && codexStatusAfter(observedEvent)) {
          runtime.observation = observeSession(runtime.observation, observedEvent, r.events.length === 0, Date.now());
        }
        if (s.provider === "codex") {
          // A complete turn may arrive between polls; retain its start/completion sequence.
          for (const event of codexPollEvents(r)) {
            const status = codexStatusAfter(event);
            if (status) setStatus(s.id, status, r.events.length === 0);
          }
        }
      }
    } finally {
      // Reconcile after in-flight reads so closed sessions cannot leave watches.
      const activeIds = [...new Set(getState().sessions.filter(s =>
        (s.provider === "claude" || s.provider === "codex") && isUuid(s.agentSessionId)
        && runtimes.get(s.id)?.running && !runtimes.get(s.id)?.closing,
      ).map(s => s.agentSessionId!))].sort();
      const key = JSON.stringify(activeIds);
      if (key !== retainedAgents || [...polledIds].some(id => !activeIds.includes(id))) {
        await invoke("agent_retain", { activeIds }).then(() => { retainedAgents = key; }).catch(() => {});
      }
      polling = false;
    }
    if (changed) {
      renderStatusSoon();
    }
  }

  function onAgentEvent(ev: AgentEvent) {
    const s = session(ev.deskSessionId);
    if (!s || s.provider !== (ev.provider ?? "claude") || !runtimes.get(s.id)?.running) return;
    let changed = false;
    if (isUuid(ev.agentSessionId) && ev.agentSessionId !== s.agentSessionId) {
      runtimes.get(s.id)!.observation = undefined;
      s.agentSessionId = ev.agentSessionId;
      // /resume switches to an existing conversation; a new or cleared one has nothing to resume yet.
      s.hasConversation = ev.event !== "SessionStart" || ev.source === "resume";
      changed = true;
    }
    if (s.provider === "codex") {
      // The hook only names the conversation (it fires as the first prompt starts);
      // status keeps coming from the session file, which polling now follows.
      if (isUuid(s.agentSessionId)) codexLookup.delete(s.id);
      if (changed) save();
      return;
    }
    if ((ev.event === "UserPromptSubmit" || ev.event === "PreInvocation" || ev.event === "Stop") && !s.hasConversation) {
      s.hasConversation = true;
      changed = true;
    }
    if (changed) save();
    if (!runtimes.get(s.id)?.running) return;
    const status = statusAfter(statusOf(s.id), ev);
    if (status || (ev.event === "Notification" && ev.notificationType === "idle_prompt")) {
      const rt = runtimes.get(s.id)!;
      rt.observation = observeSession(rt.observation, ev.event, false, Date.now());
    }
    if (status) setStatus(s.id, status, ev.event === "SessionStart");
  }

  return {
    statsOf, pollAgents, lookupCodexSessions, onAgentEvent,
    discover: (id: string, path: string) => codexLookup.add(id, path),
    cancelDiscovery: (id: string) => codexLookup.delete(id),
    forget(id: string) {
      agentStats.delete(id);
      codexLookup.delete(id);
    },
  };
}
