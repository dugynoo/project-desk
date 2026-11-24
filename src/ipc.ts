/**
 * Every native command and event in one place, typed. Names and argument names are checked
 * against the Rust side by ipc.test.ts (`generate_handler!`, command parameters, `emit`).
 * Arguments are camelCase here; Tauri maps them to the Rust snake_case parameters.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, AgentStats, ChatProvider, EditorInfo } from "./model.ts";
import type { FileDrag } from "./file-drop.ts";
import type { RemoteStatus } from "./remote/protocol.ts";

export interface AppInfo { platform: string; hooksEnabled: boolean; stateFile: string; updates: boolean; automaticUpdates: boolean }
export interface LoadedState { json: string | null; recovered: boolean; restored: boolean }
export interface Backup { name: string; kind: "daily" | "shrink"; savedAt: number; projects: number; sessions: number; bytes: number }
export interface SpawnArgs {
  id: string; outputId: string; cwd: string; provider: string; background: boolean;
  claudeCommand: string; command: string | null; shell: string | null; cols: number; rows: number;
}
export interface OutputChunk { data: string; ack?: number }
/** A `Channel<OutputChunk>` in the app; tests pass a plain object. */
export interface OutputSink { onmessage: (chunk: OutputChunk) => void }
export interface Prepared { sessionId: string; status: string }
export interface EditorChoice { id: string; customPath: string; customArgs: string }
export interface TextDocument { path: string; text: string }
export type CliStatus = "available" | "missing" | "failed" | "timeout" | "unsupported" | "busy";
export interface CliCheck { status: CliStatus; version: string }
export interface Conversation { id: string; modifiedAt: number; title: string | null }
export interface AgentPoll { stats: AgentStats; status: string | null; events: string[]; backgroundTasks?: number }
export interface AvailableRelease { version: string; body: string; url: string }
export interface ChatSource { provider: ChatProvider; agentId: string }

type None = Record<string, never>;

/** Command name → camelCase arguments and the deserialized result. */
export interface Commands {
  app_info: { args: None; result: AppInfo };
  check_release: { args: None; result: AvailableRelease | null };
  load_state: { args: None; result: LoadedState };
  save_state: { args: { json: string }; result: void };
  list_backups: { args: None; result: Backup[] };
  restore_backup: { args: { name: string }; result: void };
  shutdown_pending: { args: None; result: string[] };
  shutdown_ready: { args: { id: string; saved: boolean }; result: void };
  shutdown_defer: { args: { id: string }; result: boolean };
  pty_spawn: { args: { args: SpawnArgs; onOutput: OutputSink }; result: Prepared | null };
  pty_output_ack: { args: { outputId: string; through: number }; result: void };
  pty_output_cancel: { args: { outputId: string }; result: void };
  pty_write: { args: { id: string; data: string }; result: void };
  pty_resize: { args: { id: string; cols: number; rows: number }; result: void };
  pty_kill: { args: { id: string }; result: void };
  open_in_editor: { args: { editor: EditorChoice; path: string; line: number | null }; result: void };
  text_open: { args: { path: string }; result: TextDocument };
  text_save: { args: { path: string; expected: string; text: string }; result: void };
  open_file_default: { args: { path: string }; result: void };
  prepare_update: { args: { on: boolean }; result: void };
  reveal_file: { args: { path: string }; result: void };
  open_folder: { args: { path: string }; result: void };
  project_exists: { args: { path: string; existing: string[] }; result: boolean };
  project_branch: { args: { path: string }; result: string | null };
  list_editors: { args: None; result: EditorInfo[] };
  check_cli: { args: { commands: [string, string, string]; shell: string }; result: CliCheck[] };
  codex_no_daemon: { args: { command: string; shell: string }; result: boolean };
  resolve_file: { args: { cwd: string; candidate: string }; result: string | null };
  find_codex_session: { args: { cwd: string; sinceMs: number; exclude: string[] }; result: string | null };
  recover_codex_session: { args: { cwd: string; createdMs: number; exclude: string[] }; result: string | null };
  list_conversations: { args: { provider: string; cwd: string }; result: Conversation[] };
  agent_poll: { args: { provider: string; agentId: string; generation: number }; result: AgentPoll | null };
  agent_retain: { args: { activeIds: string[] }; result: void };
  remote_configure: { args: { enabled: boolean; port: number; address: string }; result: RemoteStatus };
  remote_status: { args: None; result: RemoteStatus };
  remote_new_token: { args: None; result: RemoteStatus };
  remote_publish: { args: { snapshot: unknown; chatSources: Record<string, ChatSource> }; result: void };
  /** HTTP status from the push service; 404/410 mean the subscription is gone. */
  remote_push: { args: { endpoint: string; authorization: string; body: string; urgent: boolean }; result: number };
  copy_text: { args: { text: string }; result: void };
}

export type Command = keyof Commands;
type ArgsOf<K extends Command> = Commands[K]["args"] extends None ? [args?: None] : [args: Commands[K]["args"]];

/** Typed `invoke`. Errors stay `code` / `code: detail` strings for `errorText`. */
export function call<K extends Command>(command: K, ...args: ArgsOf<K>): Promise<Commands[K]["result"]> {
  return invoke<Commands[K]["result"]>(command, args[0]);
}
export type Call = typeof call;

/** Event name → payload, as emitted by Rust. */
export interface Events {
  "pty-exit": { id: string; code: number | null; systemShutdown?: boolean };
  "agent-event": AgentEvent;
  "terminal-file-drag": FileDrag;
  "prepare-shutdown": string;
  "shutdown-cancelled": null;
  "remote-watching": { ids: string[] };
  "remote-action": { id: string; action: string };
  "remote-size": { id: string };
  "remote-size-released": { id: string };
  "remote-create": { id: string; project: string; provider: "claude" | "codex" };
  "remote-push-subscribe": { endpoint: string; p256dh: string; auth: string };
  "remote-push-unsubscribe": { endpoint: string };
  "remote-revoked": null;
}

export function on<K extends keyof Events>(event: K, handler: (payload: Events[K]) => void): Promise<UnlistenFn> {
  return listen<Events[K]>(event, e => handler(e.payload));
}
