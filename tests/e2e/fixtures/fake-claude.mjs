// Stand-in for the Claude CLI so install and account flows can be tested
// without changing the real Claude configuration on this computer.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_CLAUDE_STATE;
const installed = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : [];
const command = args.slice(0, 2).join(' ');

if (args[0] === '--version') {
  console.log('9.9.9 (Fake Claude)');
} else if (command === 'auth status') {
  console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'tester@example.test', orgName: 'Test Org' }));
} else if (command === 'plugin list') {
  console.log(JSON.stringify(installed.map((id) => ({ id, version: '1.0.0', scope: 'user', enabled: true }))));
} else if (command === 'mcp list') {
  console.log('Checking MCP server health…\n\nfake-server: https://mcp.example.test/mcp - ✓ Connected');
} else if (command === 'plugin install') {
  const id = args[2];
  if (id.startsWith('zapier')) {
    console.error('Error: this plugin declares a command that must be confirmed in a terminal');
    process.exit(1);
  }
  writeFileSync(stateFile, JSON.stringify([...installed, id]));
  console.log(`Installed ${id}`);
} else {
  console.error(`fake-claude: unsupported command ${args.join(' ')}`);
  process.exit(2);
}
