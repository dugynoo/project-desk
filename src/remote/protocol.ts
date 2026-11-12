// Správy medzi mobilom a loopback serverom; zrkadlí src-tauri/src/remote/protocol.rs.
import type { RemoteSnapshot } from "../model.ts";

/** Položka chatu zo session súboru (`src-tauri/src/remote/chat.rs`). */
export interface ChatItem {
  role: "user" | "assistant" | "tool";
  text: string;
  /** Názov nástroja pri `role: "tool"`. */
  name?: string;
}

/** Subprotokol WebSocketu; druhý záznam je `auth.<token>`. */
export const PROTOCOL = "pd.v1";

export type ClientMsg =
  | { type: "subscribe"; id: string; cols: number; rows: number }
  | { type: "unsubscribe"; id: string }
  | { type: "input"; id: string; data: string }
  | { type: "resize"; id: string; cols: number; rows: number }
  | { type: "pause"; id: string }
  | { type: "start"; id: string }
  | { type: "chatOpen"; id: string }
  | { type: "chatClose"; id: string };

export type ServerMsg =
  | { type: "snapshot"; snapshot: RemoteSnapshot }
  | { type: "history"; id: string; data: string }
  | { type: "output"; id: string; data: string }
  | { type: "error"; id: string | null; code: string }
  | { type: "chat"; id: string; reset: boolean; items: ChatItem[] };

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

const isStr = (v: unknown): v is string => typeof v === "string";

/** `null` pre neplatný JSON alebo neznámy typ. */
export function parseServerMsg(raw: string): ServerMsg | null {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof m !== "object" || m === null) return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case "snapshot": {
      const s = o.snapshot as Record<string, unknown> | null;
      if (typeof s !== "object" || s === null || !isStr(s.language) || !Array.isArray(s.projects) || !Array.isArray(s.sessions)) return null;
      return { type: "snapshot", snapshot: s as unknown as RemoteSnapshot };
    }
    case "history":
    case "output":
      return isStr(o.id) && isStr(o.data) ? { type: o.type, id: o.id, data: o.data } : null;
    case "error":
      return (o.id === null || isStr(o.id)) && isStr(o.code) ? { type: "error", id: o.id, code: o.code } : null;
    case "chat": {
      if (!isStr(o.id) || typeof o.reset !== "boolean" || !Array.isArray(o.items)) return null;
      const items = o.items.filter(isChatItem);
      return { type: "chat", id: o.id, reset: o.reset, items };
    }
    default:
      return null;
  }
}

function isChatItem(v: unknown): v is ChatItem {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (o.role === "user" || o.role === "assistant" || o.role === "tool") && isStr(o.text) && (o.name === undefined || isStr(o.name));
}

/** 1000 × 2^attempt ms, najviac 10 000. */
export function reconnectDelay(attempt: number): number {
  return Math.min(10000, 1000 * 2 ** Math.max(0, attempt));
}

/** Zatvárací kód servera pri zneplatnenom tokene (nový párovací kód). */
export const CLOSE_REVOKED = 4001;
/** Po toľkých neúspešných pripojeniach za sebou stránka overí, či server vôbec beží. */
export const FAILS_BEFORE_PROBE = 3;

/**
 * Čo robiť po zatvorení socketu: `repair` = token neplatí, `probe` = server nás opakovane odmieta
 * (zlý token, ak stránka sama odpovedá), inak ďalší pokus. `failures` = neúspechy za sebou vrátane tohto.
 */
export function closeAction(code: number, opened: boolean, failures: number): "repair" | "probe" | "retry" {
  if (code === CLOSE_REVOKED) return "repair";
  if (!opened && failures >= FAILS_BEFORE_PROBE) return "probe";
  return "retry";
}
