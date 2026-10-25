import { test } from "node:test";
import assert from "node:assert/strict";
import { cliChecks } from "./cli-check.ts";
import { t } from "./i18n.ts";

class Element {
  children: Element[] = [];
  textContent = "";
  value = "";
  disabled = false;
  onclick: (() => Promise<void>) | null = null;
  oninput: (() => void) | null = null;
  append(...children: Element[]) { this.children.push(...children); }
}

test("CLI checks run only on demand, reject duplicate clicks and ignore edited or closed settings", async ctx => {
  const calls: unknown[] = [];
  let resolve!: (value: unknown) => void;
  for (const [key, value] of Object.entries({
    document: { createElement: () => new Element() },
    window: { __TAURI_INTERNALS__: { invoke: (_: string, args: unknown) => {
      calls.push(args);
      return new Promise(r => { resolve = r; });
    } } },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    ctx.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const box = new Element(), shell = new Element(), inputs = [new Element(), new Element(), new Element()];
  inputs[0].value = "claude --flag";
  const controller = new AbortController();
  cliChecks(box as unknown as HTMLElement, inputs as unknown as HTMLInputElement[], shell as unknown as HTMLInputElement, controller.signal);
  const rows = box.children[0].children, button = rows.at(-1)!;
  assert.deepEqual(calls, [{ commands: ["claude --flag", "codex", "agy"], shell: "" }]);
  await button.onclick!();
  assert.equal(calls.length, 1);
  inputs[0].oninput!();
  resolve([{ status: "available", version: "old 1.0" }]);
  await new Promise(r => setImmediate(r));
  assert.equal(rows[0].textContent, `Claude: ${t("cli.changed")}`);
  assert.equal(button.disabled, false);
  const retry = button.onclick!();
  resolve([{ status: "available", version: "1.2.3" }, { status: "missing", version: "" }, { status: "timeout", version: "" }]);
  await retry;
  assert.equal(rows[0].textContent, `Claude: ${t("cli.available", { version: "1.2.3" })}`);
  assert.equal(rows[1].textContent, `Codex: ${t("cli.missing")}`);
  assert.equal(rows[2].textContent, `Antigravity: ${t("cli.timeout")}`);
  const closing = button.onclick!();
  controller.abort();
  const before = rows[0].textContent;
  resolve([]);
  await closing;
  assert.equal(rows[0].textContent, before);
  await button.onclick!();
  assert.equal(calls.length, 3);
});
