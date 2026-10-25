import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { $ } from "./dom.ts";
import { errorText, t } from "./i18n.ts";
import type { createDialogs } from "./dialogs.ts";

export function createUpdates(
  confirmBox: ReturnType<typeof createDialogs>["confirmBox"],
  toast: (message: string, info?: boolean) => void,
  flush: () => Promise<void>,
  automatic: () => boolean,
) {
  let pendingUpdate: Update | undefined;
  let externalUpdate: { version: string; body: string; url: string } | undefined;
  let checking: Promise<boolean> | undefined;
  let manualRequested = false;
  let installing = false;

  function showAvailable(version: string) {
    const btn = $<HTMLButtonElement>("#btn-update");
    btn.textContent = t(automatic() ? "update.button" : "update.available", { version });
    btn.hidden = false;
  }

  /**
   * Hľadá novú verziu v GitHub Releases. Automatická kontrola bez siete alebo bez vydania ticho nič;
   * ručná (`manual`, z Nastavení) povie, keď nič nenašla. Vráti true, ak je k dispozícii nová verzia.
   */
  async function checkUpdate(manual = false): Promise<boolean> {
    // Keep the confirmed resource stable through download, install and rollback.
    if (installing) return false;
    // Coalesce the startup timer and manual checks (including release API requests).
    if (checking) {
      manualRequested ||= manual;
      return checking;
    }
    manualRequested = manual;
    checking = performCheck();
    try { return await checking; } finally { checking = undefined; }
  }

  async function performCheck(): Promise<boolean> {
    if (!automatic()) {
      try {
        const release = await invoke<typeof externalUpdate | null>("check_release");
        externalUpdate = release ?? undefined;
        if (release) showAvailable(release.version);
        else {
          $("#btn-update").hidden = true;
          if (manualRequested) toast(t("update.upToDate", { version: await getVersion() }), true);
        }
        return !!release;
      } catch (e) {
        if (manualRequested) toast(errorText(e));
        return false;
      }
    }
    let update: Update | null;
    try {
      update = await check();
    } catch (e) {
      if (manualRequested) toast(t("update.checkFailed", { detail: String(e) }));
      return false;
    }
    const previous = pendingUpdate;
    pendingUpdate = update ?? undefined;
    if (previous) await previous.close().catch(console.error);
    if (!update) {
      $("#btn-update").hidden = true;
      if (manualRequested) toast(t("update.upToDate", { version: await getVersion() }), true);
      return false;
    }
    showAvailable(update.version);
    return true;
  }

  /** Display the complete notes as plain text; never interpret release HTML. */
  function changesOf(body: string | undefined): string {
    return (body ?? "").trim();
  }

  async function installUpdate() {
    if (installing) return;
    installing = true;
    const btn = $<HTMLButtonElement>("#btn-update");
    btn.disabled = true;
    try {
      // A click during a refresh must use its result, not a resource it replaces.
      if (checking) await checking;
      await performInstall();
    } finally {
      installing = false;
      btn.disabled = false;
    }
  }

  async function performInstall() {
    if (!automatic()) {
      const release = externalUpdate;
      if (!release) return;
      const ok = await confirmBox(t("update.available", { version: release.version }), t("update.externalBody"), t("update.openRelease"), changesOf(release.body));
      if (ok) {
        try { await openUrl(release.url); }
        catch (e) { toast(t("update.failed", { detail: String(e) })); }
      }
      return;
    }
    const update = pendingUpdate;
    if (!update) return;
    const ok = await confirmBox(t("update.title", { version: update.version }), t("update.body"), t("update.ok"), changesOf(update.body));
    if (!ok) return;
    const btn = $<HTMLButtonElement>("#btn-update");
    btn.disabled = true;
    let total = 0;
    let done = 0;
    try {
      await update.download((e) => {
        if (e.event === "Started") total = e.data.contentLength ?? 0;
        else if (e.event === "Progress") done += e.data.chunkLength;
        const percent = total ? `${Math.min(100, Math.round((done / total) * 100))} %` : "";
        btn.textContent = t("update.downloading", { percent });
      });
      // Na Windows updater spustí inštalátor a hneď ukončí appku; bez tohto by inštalátor
      // zabil Job Object spolu s ňou. Púšťame až teraz, nech terminály počas sťahovania ostanú v jobe.
      await flush();
      await invoke("prepare_update", { on: true });
      await update.install();
      // Na Windows inštalátor appku zavrie sám; inde ju treba spustiť nanovo.
      await relaunch();
    } catch (e) {
      await invoke("prepare_update", { on: false }).catch(console.error);
      btn.disabled = false;
      btn.textContent = t("update.button", { version: update.version });
      toast(t("update.failed", { detail: String(e) }));
    }
  }

  return { checkUpdate, installUpdate };
}
