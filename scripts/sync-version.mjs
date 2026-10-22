// Spúšťa ho `npm version` (skript "version"): prenesie verziu z package.json do Cargo.toml a Cargo.lock,
// aby commit vydania mal všade rovnaké číslo.
import { readFileSync, writeFileSync } from "node:fs";

const version = JSON.parse(readFileSync("package.json", "utf8")).version;

function replaceOnce(file, pattern, replacement) {
  const text = readFileSync(file, "utf8");
  if (!pattern.test(text)) throw new Error(`${file}: version not found`);
  writeFileSync(file, text.replace(pattern, replacement));
}

// Prvé `version =` v Cargo.toml patrí sekcii [package].
replaceOnce("src-tauri/Cargo.toml", /^version = ".*"$/m, `version = "${version}"`);
replaceOnce("src-tauri/Cargo.lock", /(\[\[package\]\]\r?\nname = "project-desk"\r?\nversion = )".*"/, `$1"${version}"`);
console.log(`Cargo version → ${version}`);
