// Embedded as a constant node -e command. Keep shell expansions and double quotes out.
const event = process.argv[1];
const env = process.env;
const reply = () => process.stdout.write(JSON.stringify({ decision: 'allow' }));
if (!env.PROJECT_DESK_HOOK_PORT || !env.PROJECT_DESK_HOOK_TOKEN || !env.PROJECT_DESK_SESSION_ID) {
  reply();
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    input += chunk;
    if (input.length > 1048576) process.exit(0);
  });
  process.stdin.on('end', () => {
    try {
      const v = JSON.parse(input);
      const body = JSON.stringify({ provider: 'antigravity', hook_event_name: event,
        session_id: v.conversationId, tool_name: v.toolCall?.name, fully_idle: v.fullyIdle });
      const req = require('node:http').request({ hostname: '127.0.0.1',
        port: Number(env.PROJECT_DESK_HOOK_PORT), path: '/hook', method: 'POST',
        headers: { 'X-Project-Desk-Token': env.PROJECT_DESK_HOOK_TOKEN,
          'X-Project-Desk-Session': env.PROJECT_DESK_SESSION_ID,
          'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => res.resume());
      req.on('error', () => {});
      req.setTimeout(1000, () => req.destroy());
      req.end(body);
    } catch {}
    reply();
  });
}
