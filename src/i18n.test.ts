import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { errorText, setLang, t } from "./i18n.ts";

test("každý kód chyby z Rustu má preklad", () => {
  const dir = new URL("../src-tauri/src/", import.meta.url);
  const codes = new Set<string>();
  const code = /"((?:editor|pty|project|file|folder|background|remote|antigravity|clipboard|update|state|app)\.[A-Za-z]+)(?::|")/g;
  // Rovnaký tvar majú aj názvy súborov (remote.html, remote.json), tie nie sú kódy chýb.
  const fileName = /\.(html|json|jsonl|AppImage|webmanifest)$/;
  for (const file of readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".rs"))) {
    const src = readFileSync(new URL(file.replaceAll("\\", "/"), dir), "utf8");
    for (const m of src.matchAll(code)) if (!fileName.test(m[1])) codes.add(m[1]);
  }
  assert.ok(codes.size >= 30, `našlo sa len ${codes.size} kódov`);
  for (const code of codes) assert.notEqual(errorText(code), code, `chýba preklad err.${code}`);
});

test("preklad s premennými a návrat k angličtine pri neznámom jazyku", () => {
  setLang("cs");
  assert.equal(t("tpl.only", { name: "web" }), "Jen web");
  setLang("xx");
  assert.equal(t("tpl.only", { name: "web" }), "Only web");
});

test("kód chyby z backendu sa preloží, iný text ostane", () => {
  setLang("sk");
  assert.equal(errorText("editor.missing"), "Vybraný editor sa nenašiel. Vyber iný v ⚙ Nastaveniach.");
  assert.equal(errorText("pty.openFailed: access denied"), "Nepodarilo sa otvoriť PTY: access denied");
  assert.equal(errorText("niečo iné: x"), "niečo iné: x");
  assert.equal(errorText("foo.bar"), "foo.bar");
  setLang("en");
});
