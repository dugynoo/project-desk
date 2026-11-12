import { defineConfig } from "vite";

// Tauri očakáva pevný port a nechce, aby Vite čistil terminál.
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  // Druhý vstup: mobilná stránka, ktorú servuje vzdialený prístup.
  build: {
    target: "es2022", outDir: "dist", emptyOutDir: true,
    rollupOptions: { input: { main: "index.html", remote: "remote.html" } },
  },
});
