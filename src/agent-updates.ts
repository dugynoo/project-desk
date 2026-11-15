import { restartableForUpdate, type PersistedState, type Session, type Status } from "./model.ts";

/** Only what the update check needs from a terminal runtime. */
export interface UpdatableRuntime { running: boolean; closing: boolean; pausing?: boolean }
type Agent = "claude" | "codex";
interface Check { status: string; version: string }

interface Dependencies {
  getState: () => PersistedState;
  runtimes: ReadonlyMap<string, UpdatableRuntime>;
  statusOf: (id: string) => Status;
  unread: ReadonlySet<string>;
  isWatched: (id: string) => boolean;
  isClosing: () => boolean;
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  restart: (s: Session, version: string) => void;
  /** First time a newer version shows up while sessions still run the old one. */
  announce: (agent: Agent, version: string) => void;
}

const AGENTS: readonly Agent[] = ["claude", "codex"];
/** "2.1.324 (Claude Code)" / "codex-cli 0.168.0" -> "2.1.324" / "0.168.0" for messages. */
export const shortVersion = (v: string) => /\d+\.\d+\.\d+[\w.+-]*/.exec(v)?.[0] ?? v;
const isAgent = (provider: string): provider is Agent => (AGENTS as readonly string[]).includes(provider);

/**
 * Restarts idle sessions after Claude Code or Codex was updated on disk, so they run the new version.
 * The installed version comes from the `--version` probe; each session remembers the version that was
 * installed when it started. Nothing here installs updates.
 */
export function createAgentUpdates({ getState, runtimes, statusOf, unread, isWatched, isClosing, invoke, restart, announce }: Dependencies) {
  const installed = new Map<Agent, string>();
  /** Version a running session started with; missing = unknown until the next check sets a baseline. */
  const versions = new Map<string, string>();
  /** Input since the agent last started working: a restart would lose a half-typed prompt. */
  const typed = new Set<string>();
  const announced = new Set<string>();
  let checking = false;

  const enabled = () => getState().settings.restartOnAgentUpdate;
  const running = () => getState().sessions.filter(s => isAgent(s.provider) && !s.background && runtimes.get(s.id)?.running);

  function spawned(s: Session) {
    typed.delete(s.id);
    const version = isAgent(s.provider) && !checking ? installed.get(s.provider) : undefined;
    if (version) versions.set(s.id, version); else versions.delete(s.id);
  }

  function input(id: string) { typed.add(id); }

  function statusChanged(id: string, next: Status) {
    if (next === "working") typed.delete(id);
  }

  /** Restarts every outdated session that is safe to restart now; the rest wait for a later call. */
  function restartIdle() {
    if (!enabled() || isClosing()) return;
    for (const s of running()) {
      const agent = s.provider as Agent;
      const target = installed.get(agent), current = versions.get(s.id);
      const rt = runtimes.get(s.id);
      if (!target || !current || current === target || rt?.closing || rt?.pausing) continue;
      if (!restartableForUpdate(s, statusOf(s.id), { typed: typed.has(s.id), unread: unread.has(s.id), watched: isWatched(s.id) })) continue;
      versions.delete(s.id);
      restart(s, shortVersion(target));
    }
  }

  async function check() {
    if (!enabled() || checking || isClosing() || running().length === 0) return;
    const settings = getState().settings;
    checking = true;
    let results: Check[] = [];
    try {
      results = await invoke<Check[]>("check_cli", { commands: [settings.claudeCommand, settings.codexCommand, ""], shell: settings.shell });
    } catch {
      return;
    } finally {
      checking = false;
    }
    AGENTS.forEach((agent, i) => {
      const result = results[i];
      if (result?.status === "available" && result.version) installed.set(agent, result.version);
    });
    for (const s of running()) {
      const version = installed.get(s.provider as Agent);
      if (!version) continue;
      // Started before any check: it runs what was installed then, which is what we see now.
      if (!versions.has(s.id)) versions.set(s.id, version);
      else if (versions.get(s.id) !== version && !announced.has(`${s.provider}\n${version}`)) {
        announced.add(`${s.provider}\n${version}`);
        announce(s.provider as Agent, shortVersion(version));
      }
    }
    restartIdle();
  }

  return { spawned, input, statusChanged, check, restartIdle };
}
