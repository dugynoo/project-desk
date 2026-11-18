import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Types cannot be read at runtime, so the check compares source text: ipc.ts against the
// registered Rust commands, their parameters and the emitted events.
const rustDir = new URL("../src-tauri/src/", import.meta.url);
const rust = readdirSync(rustDir, { recursive: true, encoding: "utf8" })
  .filter(f => f.endsWith(".rs"))
  .map(f => readFileSync(new URL(f.replaceAll("\\", "/"), rustDir), "utf8"));
const ipc = readFileSync(new URL("./ipc.ts", import.meta.url), "utf8");
const camel = (name: string) => name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
// Injected by Tauri, not sent by the frontend.
const injected = /^(?:tauri::)?(?:AppHandle|State<|Window|WebviewWindow)/;

function registered(): string[] {
  const lib = rust.find(src => src.includes("generate_handler!["))!;
  const list = lib.slice(lib.indexOf("generate_handler![") + 18, lib.indexOf("])", lib.indexOf("generate_handler![")));
  return list.split(",").map(s => s.trim().split("::").at(-1)!).filter(Boolean).sort();
}

/** Parameters split at commas outside generics (`HashMap<String, T>`). */
function topLevel(params: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < params.length; i++) {
    const c = params[i];
    if (c === "<" || c === "(" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) { out.push(params.slice(start, i)); start = i + 1; }
  }
  out.push(params.slice(start));
  return out.map(p => p.trim()).filter(p => p.includes(":"));
}

function rustParams(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const command = /#\[tauri::command(?:\([^)]*\))?\]\s*(?:pub(?:\([^)]*\))? )?(?:async )?fn (\w+)(?:<[^>]*>)?\(([\s\S]*?)\)\s*(?:->|\{)/g;
  for (const src of rust) {
    for (const [, name, params] of src.matchAll(command)) {
      const names = topLevel(params!)
        .map(p => [p.slice(0, p.indexOf(":")).trim(), p.slice(p.indexOf(":") + 1).trim()] as const)
        .filter(([, type]) => !injected.test(type))
        .map(([param]) => camel(param));
      out.set(name!, names.sort());
    }
  }
  return out;
}

function tsCommands(): Map<string, string[]> {
  const body = ipc.slice(ipc.indexOf("export interface Commands {"), ipc.indexOf("\n}", ipc.indexOf("export interface Commands {")));
  const out = new Map<string, string[]>();
  for (const [, name, args] of body.matchAll(/^ {2}(\w+): \{ args: (None|\{[^}]*\});/gm)) {
    out.set(name!, args === "None" ? [] : [...args!.matchAll(/(\w+)\??:/g)].map(m => m[1]!).sort());
  }
  return out;
}

test("ipc.ts lists exactly the registered Rust commands", () => {
  const commands = registered();
  assert.ok(commands.length >= 35, `found only ${commands.length} commands`);
  assert.deepEqual([...tsCommands().keys()].sort(), commands);
});

test("command arguments match the Rust parameters in camelCase", () => {
  const params = rustParams(), ts = tsCommands();
  for (const name of registered()) {
    assert.ok(params.has(name), `no #[tauri::command] fn ${name}`);
    assert.deepEqual(ts.get(name), params.get(name), `arguments of ${name}`);
  }
});

test("ipc.ts lists exactly the events Rust emits", () => {
  const emitted = new Set<string>();
  for (const src of rust) for (const [, name] of src.matchAll(/\.emit(?:_to)?\(\s*"([a-z-]+)"/g)) emitted.add(name!);
  const body = ipc.slice(ipc.indexOf("export interface Events {"), ipc.indexOf("\n}", ipc.indexOf("export interface Events {")));
  const declared = [...body.matchAll(/^ {2}"([a-z-]+)":/gm)].map(m => m[1]!);
  assert.ok(emitted.size >= 9, `found only ${emitted.size} events`);
  assert.deepEqual(declared.sort(), [...emitted].sort());
});

test("only ipc.ts talks to the Tauri invoke and listen APIs", () => {
  const dir = new URL("./", import.meta.url);
  for (const file of readdirSync(dir).filter(f => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "ipc.ts")) {
    const src = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(src, /import \{[^}]*\b(?:invoke|listen)\b[^}]*\} from "@tauri-apps\/api\/(?:core|event)"/, file);
  }
});
