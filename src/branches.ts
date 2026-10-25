/** Event-driven cache: one probe at a time, no idle timer, stale results ignored. */
export function createBranches(query: (path: string) => Promise<string | null>, changed: () => void, now = Date.now) {
  const values = new Map<string, { value: string | null; at: number }>();
  const queue = new Set<string>();
  let enabled = false, generation = 0, running = false, active = '';
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (enabled && queue.size) {
        const path = queue.values().next().value!;
        queue.delete(path); active = path;
        const version = generation;
        const value = await query(path).catch(() => null);
        if (enabled && version === generation) {
          const previous = values.get(path);
          values.set(path, { value, at: now() });
          if (previous?.value !== value) changed();
        }
        active = '';
      }
    } finally { running = false; active = ''; }
  }
  return {
    configure(on: boolean, paths: string[]) {
      if (enabled !== on) { generation++; enabled = on; active = ""; values.clear(); queue.clear(); }
      const retained = new Set(paths);
      for (const path of values.keys()) if (!retained.has(path)) values.delete(path);
      for (const path of queue) if (!retained.has(path)) queue.delete(path);
    },
    get(path: string) { return enabled ? values.get(path)?.value : undefined; },
    refresh(paths: string[], revisit = false) {
      if (!enabled) return;
      for (const path of paths) {
        const cached = values.get(path);
        if (path !== active && (!cached || (revisit && now() - cached.at >= 3000))) queue.add(path);
      }
      void drain();
    },
  };
}
