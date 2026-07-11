// אגנט הפרסום של @robit_digital — רץ ב-GitHub Actions
// קורא את schedule.json, מפרסם את הפוסט הבא שהגיע זמנו דרך Zapier MCP, ומעדכן סטטוס.
const fs = require('fs');

const MCP_URL = process.env.ZAPIER_MCP_URL;
if (!MCP_URL) { console.error('Missing ZAPIER_MCP_URL secret'); process.exit(1); }

const SCHEDULE_FILE = 'schedule.json';

// ── קריאה ל-Zapier MCP בפרוטוקול JSON-RPC (Streamable HTTP) ──
async function mcpRequest(body, sessionId) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['Mcp-Session-Id'] = sessionId;
  const res = await fetch(MCP_URL, { method: 'POST', headers, body: JSON.stringify(body) });
  const newSession = res.headers.get('mcp-session-id') || sessionId;
  const text = await res.text();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${text.slice(0, 500)}`);
  // התשובה יכולה להגיע כ-JSON רגיל או כ-SSE — מטפלים בשניהם
  let payload = null;
  if (text.trim().startsWith('{')) {
    payload = JSON.parse(text);
  } else {
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try { payload = JSON.parse(line.slice(5).trim()); } catch {}
      }
    }
  }
  return { payload, sessionId: newSession };
}

async function main() {
  const schedule = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  const today = new Date().toISOString().slice(0, 10);

  const due = schedule.posts
    .filter(p => p.status === 'pending' && p.date <= today)
    .sort((a, b) => a.date.localeCompare(b.date));

  if (due.length === 0) {
    console.log(`No pending posts due on ${today}. Nothing to do.`);
    return;
  }
  const post = due[0]; // פוסט אחד בלבד לכל ריצה
  console.log(`Publishing "${post.id}" (${post.date})…`);

  // handshake: initialize → initialized → tools/call
  const init = await mcpRequest({
    jsonrpc: '2.0', id: 0, method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'robit-ig-publisher', version: '1.0.0' },
    },
  });
  const session = init.sessionId;
  await mcpRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }, session).catch(() => {});

  const call = await mcpRequest({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'execute_zapier_write_action',
      arguments: {
        selected_api: 'InstagramBusinessCLIAPI',
        action: post.type === 'video' ? 'publish_video' : 'publish_media_v2',
        instructions: 'Publish to the robit_digital Instagram Business account (Instagram Account to Use: Robit, page id 17841440626288723). Media in order.',
        params: post.type === 'video'
          ? { video: post.media[0], caption: post.caption }
          : { media: post.media, caption: post.caption },
        output: 'Confirmation that the post was published and the post ID.',
      },
    },
  }, session);

  const result = call.payload?.result;
  const resultText = JSON.stringify(result ?? call.payload ?? {});
  console.log('MCP result:', resultText.slice(0, 800));

  if (call.payload?.error || result?.isError) {
    throw new Error(`Publish failed: ${resultText.slice(0, 500)}`);
  }
  const published = resultText.includes('"published":true') || resultText.includes('published\\":true');
  if (!published) {
    throw new Error(`Could not confirm publish success: ${resultText.slice(0, 500)}`);
  }

  const idMatch = resultText.match(/"post_id\\?":\\?"(\d+)/);
  post.status = 'posted';
  post.postedAt = new Date().toISOString();
  if (idMatch) post.postId = idMatch[1];

  fs.writeFileSync(SCHEDULE_FILE, JSON.stringify(schedule, null, 2) + '\n', 'utf8');
  console.log(`✅ Published "${post.id}"${idMatch ? ' (post ' + idMatch[1] + ')' : ''} and updated schedule.`);
}

main().catch(err => { console.error(err.message); process.exit(1); });
