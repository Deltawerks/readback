#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexRegistration } from '../src/codex-registration.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const { hooks, mcpToml, hook } = codexRegistration(root);
writeFileSync(path.join(root, 'codex-hooks-snippet.json'), JSON.stringify(hooks, null, 2) + '\n');
writeFileSync(path.join(root, 'codex-mcp-snippet.toml'), mcpToml);
console.log(`ReadBack for Codex — configuration prepared for:\n${root}\n`);
console.log(`Auto-speak script: ${hook}`);
console.log('1. Merge codex-hooks-snippet.json into ~/.codex/hooks.json. Preserve existing hooks.');
console.log('2. Optionally merge codex-mcp-snippet.toml into ~/.codex/config.toml for in-chat voice controls.');
console.log('3. Review and trust the new hook in Codex, then start a fresh local chat.');
console.log('   If your desktop version has no hook review UI, use /hooks in the Codex CLI.');
console.log('The Windows command is an encoded PowerShell invocation of Node and the script above.');
console.log('Voice, mute, provider keys and the queue are shared with Claude. Nothing was enabled or installed.');
