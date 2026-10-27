// Manual live check against a running game. Not part of `npm test`.
// Usage: node test/live.js <tool> '<json args>'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const session = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.mv-ai-bridge', 'session.json'), 'utf8'));
const transport = new StreamableHTTPClientTransport(new URL(session.url), {
  requestInit: { headers: { Authorization: `Bearer ${session.token}` } },
});
const client = new Client({ name: 'mv-ai-bridge-live', version: '0.0.0' });
await client.connect(transport);

const name = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const started = Date.now();
const res = await client.callTool({ name, arguments: args });
console.log(`--- ${name} ${JSON.stringify(args)} (${Date.now() - started} ms) isError=${res.isError}`);
console.log(JSON.stringify(res.structuredContent, null, 2));
await client.close();
