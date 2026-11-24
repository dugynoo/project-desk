import { call, on } from "./ipc.ts";
import { errorText } from "./i18n.ts";
import { remoteChatSources, remoteSnapshot, upsertPushSubscription, type PersistedState, type Project, type Session, type Status } from "./model.ts";
import type { RemoteStatus } from "./remote/protocol.ts";
import { reclaimSize, type Runtime } from "./terminal-runtime.ts";
import { createVapidKeys, encryptPayload, toBase64, vapidAuthorization } from "./web-push.ts";

interface Dependencies {
  getState(): PersistedState;
  runtimes: ReadonlyMap<string, Runtime>;
  statusOf(id: string): Status;
  canPause(s: Session): boolean;
  pauseSession(s: Session, confirm: boolean): Promise<unknown>;
  start(s: Session, focus: boolean): Promise<unknown>;
  /** New session from the phone; it starts without taking the desktop's view. */
  createSession(p: Project, provider: "claude" | "codex", id: string): void;
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
    snapshot.pushKey = state.push?.vapid.publicKey;
    void call("remote_publish", { snapshot, chatSources: remoteChatSources(state) }).catch(() => {});
  }

  /** Podpisový kľúč pre notifikácie vznikne pri prvom zapnutí; mobil ho dostane v snímku. */
  let creatingKeys: Promise<void> | undefined;
  function ensurePushKeys(): Promise<void> {
    if (getState().push) return Promise.resolve();
    creatingKeys ??= createVapidKeys()
      .then(vapid => { getState().push ??= { vapid, subscriptions: [] }; deps.save(); })
      .catch(() => {})
      .finally(() => { creatingKeys = undefined; });
    return creatingKeys;
  }

  function forgetPush(endpoint?: string) {
    const push = getState().push;
    if (!push) return;
    const left = endpoint === undefined ? [] : push.subscriptions.filter(s => s.endpoint !== endpoint);
    if (left.length === push.subscriptions.length) return;
    push.subscriptions = left;
    deps.save();
  }

  /** Notifikácia na spárované mobily (obsah šifruje desktop, push služba ho neprečíta). */
  async function pushToPhones(message: { title: string; body: string; id: string }, urgent: boolean) {
    const state = getState();
    const push = state.push;
    if (!state.settings.remoteAccess || !push?.subscriptions.length) return;
    const payload = new TextEncoder().encode(JSON.stringify(message));
    await Promise.all(push.subscriptions.map(async sub => {
      try {
        const [authorization, body] = await Promise.all([vapidAuthorization(sub.endpoint, push.vapid), encryptPayload(payload, sub)]);
        const status = await call("remote_push", { endpoint: sub.endpoint, authorization, body: toBase64(body), urgent });
        // Mobil odber zrušil alebo vypršal.
        if (status === 404 || status === 410) forgetPush(sub.endpoint);
      } catch {
        // Bez siete sa notifikácia stratí; bodka v zozname ostane.
      }
    }));
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
      .then(async (status) => {
        if (remoteAccess) { await ensurePushKeys(); publish(); } else clearWatching();
        return status;
      })
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
    await on("remote-create", payload => {
      const p = getState().projects.find(x => x.id === payload.project);
      // Opakovaná správa (znovupripojenie) nesmie vytvoriť druhú session.
      if (!p || session(payload.id)) return;
      deps.createSession(p, payload.provider, payload.id);
    });
    await on("remote-push-subscribe", sub => {
      const push = getState().push;
      if (!push) return;
      push.subscriptions = upsertPushSubscription(push.subscriptions, sub);
      deps.save();
    });
    await on("remote-push-unsubscribe", payload => forgetPush(payload.endpoint));
    // Nový párovací kód odpojil mobily; notifikácie im už nepôjdu.
    await on("remote-revoked", () => forgetPush());
  }

  return { publish, clearWatching, configure, listen, pushToPhones, isWatching: (id: string) => watching.has(id) };
}
