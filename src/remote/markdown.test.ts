import { test } from "node:test";
import assert from "node:assert/strict";
import { parseInline, parseMarkdown } from "./markdown.ts";

test("inline code, bold, italic and links", () => {
  assert.deepEqual(parseInline("a `x*y` **b** *c* [d](https://e.sk) f"), [
    { t: "text", v: "a " },
    { t: "code", v: "x*y" },
    { t: "text", v: " " },
    { t: "b", c: [{ t: "text", v: "b" }] },
    { t: "text", v: " " },
    { t: "i", c: [{ t: "text", v: "c" }] },
    { t: "text", v: " " },
    { t: "a", href: "https://e.sk", c: [{ t: "text", v: "d" }] },
    { t: "text", v: " f" },
  ]);
});

test("only http(s) links become links; snake_case and lone stars stay text", () => {
  assert.deepEqual(parseInline("[x](javascript:alert(1))"), [{ t: "text", v: "[x](javascript:alert(1))" }]);
  assert.deepEqual(parseInline("my_var_name a * b"), [{ t: "text", v: "my_var_name a * b" }]);
  assert.deepEqual(parseInline("see https://a.sk/x."), [
    { t: "text", v: "see " },
    { t: "a", href: "https://a.sk/x", c: [{ t: "text", v: "https://a.sk/x" }] },
    { t: "text", v: "." },
  ]);
});

test("blocks: heading, list, code, quote, table, paragraph", () => {
  const md = [
    "# Nadpis",
    "",
    "Odsek",
    "druhý riadok",
    "",
    "- jeden",
    "- dva",
    "  pokračovanie",
    "",
    "3. tri",
    "4. štyri",
    "",
    "```ts",
    "const a = 1;",
    "",
    "```",
    "> citát",
    "",
    "| A | B |",
    "|---|:-:|",
    "| 1 | 2 |",
    "",
    "---",
  ].join("\n");
  const text = (v: string) => [{ t: "text", v }];
  assert.deepEqual(parseMarkdown(md), [
    { t: "h", level: 1, c: text("Nadpis") },
    { t: "p", c: text("Odsek\ndruhý riadok") },
    { t: "list", ordered: false, start: 1, items: [text("jeden"), text("dva pokračovanie")] },
    { t: "list", ordered: true, start: 3, items: [text("tri"), text("štyri")] },
    { t: "code", lang: "ts", v: "const a = 1;\n" },
    { t: "quote", c: [{ t: "p", c: text("citát") }] },
    { t: "table", head: [text("A"), text("B")], rows: [[text("1"), text("2")]] },
    { t: "hr" },
  ]);
});

test("unclosed fence runs to the end", () => {
  assert.deepEqual(parseMarkdown("```\na\nb"), [{ t: "code", lang: "", v: "a\nb" }]);
});
