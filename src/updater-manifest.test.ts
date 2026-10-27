import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error -- plain ESM script without type declarations
import { updaterManifest } from "../scripts/updater-manifest.mjs";

const NAMES = [
  "Project.Desk_1.2.3_x64-setup.exe", "Project.Desk_1.2.3_aarch64.app.tar.gz", "Project.Desk_1.2.3_aarch64.dmg",
  "Project.Desk_1.2.3_x64.app.tar.gz", "Project.Desk_1.2.3_amd64.AppImage", "Project.Desk_1.2.3_amd64.deb",
  "Project.Desk-1.2.3-1.x86_64.rpm", "project-desk-bin-1.2.3-aur.tar.gz", "latest.json",
];
const release = (names: string[]) => ({
  version: "1.2.3", notes: "- Fix", pubDate: "2026-01-01T00:00:00.000Z", repo: "owner/repo",
  assets: names.map((name, id) => ({ id, name })), signature: (name: string) => `sig:${name}`,
});

test("updater manifest covers every platform with the keys tauri-action wrote", () => {
  const names = [...NAMES, ...NAMES.filter(n => !/dmg|aur|json/.test(n)).map(n => `${n}.sig`)];
  const manifest = updaterManifest(release(names));
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ["darwin-aarch64", "darwin-aarch64-app", "darwin-x86_64",
    "darwin-x86_64-app", "linux-x86_64", "linux-x86_64-appimage", "linux-x86_64-deb", "linux-x86_64-rpm",
    "windows-x86_64", "windows-x86_64-nsis"]);
  assert.deepEqual(manifest.platforms["windows-x86_64"], { signature: "sig:Project.Desk_1.2.3_x64-setup.exe.sig",
    url: "https://api.github.com/repos/owner/repo/releases/assets/0" });
  assert.equal(manifest.platforms["darwin-x86_64"].url, manifest.platforms["darwin-x86_64-app"].url);
  assert.equal(manifest.platforms["linux-x86_64-rpm"].signature, "sig:Project.Desk-1.2.3-1.x86_64.rpm.sig");
  assert.deepEqual([manifest.version, manifest.notes, manifest.pub_date], ["1.2.3", "- Fix", "2026-01-01T00:00:00.000Z"]);
});

test("updater manifest refuses a missing build or signature instead of publishing partial updates", () => {
  const signed = (names: string[]) => [...names, ...names.map(n => `${n}.sig`)];
  assert.throws(() => updaterManifest(release(signed(NAMES.filter(n => !n.endsWith("x64-setup.exe"))))), /x64-setup\.exe/);
  assert.throws(() => updaterManifest(release(NAMES)), /has no signature/);
});
