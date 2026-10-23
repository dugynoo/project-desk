import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";

const script = readFileSync(new URL("../src-tauri/src/antigravity-relay.cjs", import.meta.url), "utf8")
  .split(/\r?\n/).filter(line => !line.trimStart().startsWith("//")).join(" ");

function relay(event: string, payload: unknown, env: Record<string, string>) {
  return new Promise<string>((resolve, reject) => {
    // Exercise the literal command written to hooks.json through the platform shell.
    const child = spawn(`node -e "${script}" ${event}`, { shell: true, windowsHide: true,
      env: { ...process.env, PROJECT_DESK_HOOK_PORT: "", PROJECT_DESK_HOOK_TOKEN: "",
        PROJECT_DESK_SESSION_ID: "", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

test("Antigravity relay forwards metadata only through loopback with session headers", async () => {
  const received: { body: unknown; token: unknown; session: unknown }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ body: JSON.parse(body), token: req.headers["x-project-desk-token"], session: req.headers["x-project-desk-session"] });
    res.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const output = await relay("PreToolUse", { conversationId: "conversation", toolCall: { name: "ask_question", args: { secret: "private prompt" } }, transcriptPath: "/private" },
      { PROJECT_DESK_HOOK_PORT: String(address.port), PROJECT_DESK_HOOK_TOKEN: "test-token", PROJECT_DESK_SESSION_ID: "desk-session" });
    assert.deepEqual(JSON.parse(output), { decision: "allow" });
    assert.deepEqual(received, [{ body: { provider: "antigravity", hook_event_name: "PreToolUse", session_id: "conversation", tool_name: "ask_question" }, token: "test-token", session: "desk-session" }]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("Antigravity relay is inactive outside Desk and does not block on unavailable server", async () => {
  assert.deepEqual(JSON.parse(await relay("Stop", {}, {})), { decision: "allow" });
  assert.deepEqual(JSON.parse(await relay("Stop", {}, { PROJECT_DESK_HOOK_PORT: "1", PROJECT_DESK_HOOK_TOKEN: "test", PROJECT_DESK_SESSION_ID: "test" })), { decision: "allow" });
});
