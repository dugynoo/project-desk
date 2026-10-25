import { invoke } from "@tauri-apps/api/core";
import { el } from "./dom.ts";
import { t } from "./i18n.ts";

type Check = { status: "available" | "missing" | "failed" | "timeout" | "unsupported" | "busy"; version: string };

/** Checks only on opening or explicit request; edits invalidate the displayed result. */
export function cliChecks(box: HTMLElement, inputs: HTMLInputElement[], shell: HTMLInputElement, signal: AbortSignal) {
  const section = el("div", "cli-checks");
  const button = el("button", "", t("cli.check"));
  const rows = ["Claude", "Codex", "Antigravity"].map(name => {
    const row = el("div", "note");
    section.append(row);
    return { name, row };
  });
  section.append(el("div", "note", t("cli.note")), button);
  box.append(section);
  let pending = false;
  const values = () => [...inputs.map((input, i) => input.value.trim() || ["claude", "codex", "agy"][i]), shell.value.trim()];
  const show = (key: "cli.checking" | "cli.changed" | "cli.failed") => {
    for (const { name, row } of rows) row.textContent = `${name}: ${t(key)}`;
  };
  let revision = 0;
  for (const input of [...inputs, shell]) input.oninput = () => { revision++; show("cli.changed"); };
  const check = async () => {
    if (pending || signal.aborted) return;
    pending = true;
    button.disabled = true;
    const snapshot = values(), started = revision;
    show("cli.checking");
    try {
      const results = await invoke<Check[]>("check_cli", { commands: snapshot.slice(0, 3), shell: snapshot[3] });
      if (signal.aborted || started !== revision) return;
      rows.forEach(({ name, row }, i) => {
        const result = results[i];
        row.textContent = `${name}: ${result?.status === "available" ? t("cli.available", { version: result.version }) : t(`cli.${result?.status ?? "failed"}`)}`;
      });
    } catch {
      if (!signal.aborted && started === revision) show("cli.failed");
    } finally {
      pending = false;
      if (!signal.aborted) button.disabled = false;
    }
  };
  button.onclick = check;
  void check();
}
