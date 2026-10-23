import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { errorText, setLang, t } from "./i18n.ts";

test("každý kód chyby z Rustu má preklad", () => {
  const dir = new URL("../src-tauri/src/", import.meta.url);
  const codes = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".rs"))) {
    const src = readFileSync(new URL(file, dir), "utf8");
    for (const m of src.matchAll(/"((?:editor|pty|project|file)\.[A-Za-z]+)(?::|")/g)) codes.add(m[1]);
  }
  assert.ok(codes.size >= 10, `našlo sa len ${codes.size} kódov`);
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
