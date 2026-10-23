import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { $ } from "./dom.ts";
import { t } from "./i18n.ts";
import type { createDialogs } from "./dialogs.ts";

export function createUpdates(
  confirmBox: ReturnType<typeof createDialogs>["confirmBox"],
  toast: (message: string, info?: boolean) => void,
  flush: () => Promise<void>,
) {
  let pendingUpdate: Update | undefined;

  /**
   * Hľadá novú verziu v GitHub Releases. Automatická kontrola bez siete alebo bez vydania ticho nič;
   * ručná (`manual`, z Nastavení) povie, keď nič nenašla. Vráti true, ak je k dispozícii nová verzia.
   */
  async function checkUpdate(manual = false): Promise<boolean> {
    if (pendingUpdate) return true;
    let update: Update | null;
    try {
      update = await check();
    } catch (e) {
      if (manual) toast(t("update.checkFailed", { detail: String(e) }));
      return false;
    }
    if (!update) {
      if (manual) toast(t("update.upToDate", { version: await getVersion() }), true);
      return false;
    }
    pendingUpdate = update;
    const btn = $<HTMLButtonElement>("#btn-update");
    btn.textContent = t("update.button", { version: update.version });
    btn.hidden = false;
    return true;
  }

  /** Zoznam zmien z release notes: len riadky „- …“, ktoré release workflow vytvorí z commitov. */
  function changesOf(body: string | undefined): string {
    return (body ?? "").split(/\r?\n/).filter((l) => l.startsWith("- ")).join("\n");
  }

  async function installUpdate() {
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
      void invoke("prepare_update", { on: false }).catch(() => {});
      btn.disabled = false;
      btn.textContent = t("update.button", { version: update.version });
      toast(t("update.failed", { detail: String(e) }));
    }
  }

  return { checkUpdate, installUpdate };
}
