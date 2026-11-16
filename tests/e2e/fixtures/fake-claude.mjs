// Stand-in for the Claude CLI so install, repair and sign-in flows can be
// tested without changing the real Claude configuration on this computer.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CLAUDE_STATE;
const state = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {};
const plugins = state.plugins ?? {};
const authed = state.authed ?? [];
const save = () => writeFileSync(stateFile, JSON.stringify({ plugins, authed }));
const command = args.slice(0, 2).join(' ');

if (args[0] === '--version') {
  console.log('9.9.9 (Fake Claude)');
} else if (command === 'auth status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'tester@example.test', orgName: 'Test Org' }));
} else if (command === 'plugin list') {
  console.log(JSON.stringify(Object.entries(plugins).map(([id, enabled]) => ({ id, version: '1.0.0', scope: 'user', enabled }))));
} else if (command === 'mcp list') {
  const lines = ['Checking MCP server health…', '', 'fake-server: https://mcp.example.test/mcp - ✓ Connected'];
  lines.push(`needs-login: https://auth.example.test/mcp (HTTP) - ${authed.includes('needs-login') ? '✓ Connected' : '! Needs authentication'}`);
  console.log(lines.join('\n'));
} else if (command === 'mcp login') {
  // The real CLI opens the browser here. The stand-in marks the server as signed in.
  authed.push(args[2]);
  save();
  console.log(`Authenticated ${args[2]}`);
} else if (command === 'plugin install') {
  const id = args[2];
  if (id.startsWith('zapier')) {
    console.error('Error: this plugin declares a command that must be confirmed in a terminal');
    process.exit(1);
  }
  // A real install takes a moment. The pause lets the progress stages be seen.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  // "sleepy" installs arrive switched off, so the enable stage has work to do.
  plugins[id] = !id.startsWith('sleepy');
  save();
  console.log(`Installed ${id}`);
} else if (command === 'plugin enable') {
  plugins[args[2]] = true;
  save();
  console.log(`Enabled ${args[2]}`);
} else {
  console.error(`fake-claude: unsupported command ${args.join(' ')}`);
  process.exit(2);
}
