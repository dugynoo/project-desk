import { call, on } from "./ipc.ts";
import { errorText } from "./i18n.ts";
import { remoteChatSources, remoteSnapshot, type PersistedState, type Session, type Status } from "./model.ts";
import type { RemoteStatus } from "./remote/protocol.ts";
import { reclaimSize, type Runtime } from "./terminal-runtime.ts";

interface Dependencies {
  getState(): PersistedState;
  runtimes: ReadonlyMap<string, Runtime>;
  statusOf(id: string): Status;
  canPause(s: Session): boolean;
  pauseSession(s: Session, confirm: boolean): Promise<unknown>;
  start(s: Session, focus: boolean): Promise<unknown>;
  /** true = the saved state changed. */
  markSessionRead(id: string): boolean;
  save(): void;
  renderSidebar(): void;
  toast(message: string): void;
}

/** Remote access from a phone: state snapshots, sessions the phone has open and its actions. */
export function createRemoteBridge(deps: Dependencies) {
  const { getState, runtimes, toast } = deps;
  const session = (id: string) => getState().sessions.find(s => s.id === id);
  /** Relácie, ktoré má práve otvorené mobil. */
  let watching = new Set<string>();

  // Snímok pre mobil: len keď je vzdialený prístup zapnutý, najviac raz za 250 ms.
  let lastPublish = -Infinity;
  let publishTimer: number | undefined;
  function publish() {
    const state = getState();
    if (!state.settings.remoteAccess) return;
    const wait = 250 - (performance.now() - lastPublish);
    if (wait > 0) {
      publishTimer ??= window.setTimeout(() => { publishTimer = undefined; publish(); }, wait);
      return;
    }
    lastPublish = performance.now();
    const snapshot = remoteSnapshot(state, deps.statusOf, id => runtimes.get(id)?.running === true, id => {
      const s = session(id);
      return s ? deps.canPause(s) : false;
    });
    void call("remote_publish", { snapshot, chatSources: remoteChatSources(state) }).catch(() => {});
  }

  /** Bez bežiaceho servera nemá nikto otvorenú reláciu, inak by zostali „videné“ a stlmili upozornenia. */
  function clearWatching() {
    if (!watching.size) return;
    for (const id of watching) {
      const rt = runtimes.get(id);
      if (rt) reclaimSize(rt, id);
    }
    watching = new Set();
    deps.renderSidebar();
  }

  /** Konfigurácia servera podľa nastavení; pri vypnutí nesmie ostať otvorený port. `null` = chyba (oznámená). */
  function configure(): Promise<RemoteStatus | null> {
    const { remoteAccess, remotePort, remoteAddress } = getState().settings;
    return call("remote_configure", { enabled: remoteAccess, port: remotePort, address: remoteAddress })
      .then((status) => { if (remoteAccess) publish(); else clearWatching(); return status; })
      .catch((e: unknown) => { clearWatching(); toast(errorText(e)); return null; });
  }

  async function listen() {
    await on("remote-watching", payload => {
      const next = new Set(payload.ids);
      // Mobil odišiel: desktop si vezme veľkosť späť bez čakania na písanie či fokus.
      for (const id of watching) {
        const rt = runtimes.get(id);
        if (!next.has(id) && rt) reclaimSize(rt, id);
      }
      let changed = false;
      for (const id of next) {
        if (watching.has(id)) continue;
        if (deps.markSessionRead(id)) changed = true;
      }
      watching = next;
      if (changed) deps.save();
      deps.renderSidebar();
    });
    // Mobil potvrdil pozastavenie sám; spustenie znova je to isté ako ↻ na desktope.
    await on("remote-action", payload => {
      const s = session(payload.id);
      if (!s) return;
      if (payload.action === "pause") void deps.pauseSession(s, false);
      else if (payload.action === "start" && !runtimes.get(s.id)?.running) void deps.start(s, false);
    });
    // Mobil zavrel terminál (napr. prepol na chat): desktop si veľkosť vezme hneď.
    await on("remote-size-released", payload => {
      const rt = runtimes.get(payload.id);
      if (rt) reclaimSize(rt, payload.id);
    });
    await on("remote-size", payload => {
      const rt = runtimes.get(payload.id);
      if (rt) rt.remoteSized = true;
    });
  }

  return { publish, clearWatching, configure, listen, isWatching: (id: string) => watching.has(id) };
}
