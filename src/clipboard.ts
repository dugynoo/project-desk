import { invoke } from "@tauri-apps/api/core";

const linux = typeof navigator !== "undefined" && /Linux/.test(navigator.userAgent);

/**
 * Text do schránky. Na Linuxe cez `wl-copy`/`xclip` v Ruste: schránka WebKitGTK na Waylande
 * patrí oknu a vloženie inde môže zamrznúť, keď Desk stratí fokus. Inak, alebo bez nástroja, webview.
 */
export async function writeClipboard(text: string): Promise<void> {
  if (linux) {
    try {
      await invoke("copy_text", { text });
      return;
    } catch {
      // Chýba wl-copy/xclip: skúsi to webview.
    }
  }
  await navigator.clipboard.writeText(text);
}
