// Správy medzi mobilom a loopback serverom; zrkadlí src-tauri/src/remote/protocol.rs.
import type { RemoteSnapshot } from "../model.ts";

/** Subprotokol WebSocketu; druhý záznam je `auth.<token>`. */
export const PROTOCOL = "pd.v1";

export type ClientMsg =
  | { type: "subscribe"; id: string; cols: number; rows: number }
  | { type: "unsubscribe"; id: string }
  | { type: "input"; id: string; data: string }
  | { type: "resize"; id: string; cols: number; rows: number };

export type ServerMsg =
  | { type: "snapshot"; snapshot: RemoteSnapshot }
  | { type: "history"; id: string; data: string }
  | { type: "output"; id: string; data: string }
  | { type: "error"; id: string | null; code: string };

/** Stav z `remote_status` / `remote_configure` / `remote_new_token` pre nastavenia na desktope. */
export interface RemoteStatus {
  running: boolean;
  port: number;
  host: string | null;
  serving: boolean;
  pairingUrl: string | null;
  serveCommand: string;
}

export type RemoteKeyId = "esc" | "tab" | "up" | "down" | "ctrlC" | "shiftEnter" | "enter";

/** Klávesy, bez ktorých sa agent na mobile ovládať nedá; popisky sú `remote.keys.<id>`. */
export const REMOTE_KEYS: { id: RemoteKeyId; seq: string }[] = [
  { id: "esc", seq: "\x1b" },
  { id: "tab", seq: "\t" },
  { id: "up", seq: "\x1b[A" },
  { id: "down", seq: "\x1b[B" },
  { id: "ctrlC", seq: "\x03" },
  { id: "shiftEnter", seq: "\x1b\r" },
  { id: "enter", seq: "\r" },
];

/** `null` pre neplatný JSON alebo neznámy typ. */
export function parseServerMsg(_raw: string): ServerMsg | null {
  throw new Error("not implemented");
}

/** 1000 × 2^attempt ms, najviac 10 000. */
export function reconnectDelay(_attempt: number): number {
  throw new Error("not implemented");
}
