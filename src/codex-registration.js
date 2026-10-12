import path from 'node:path';

const shQuote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const psQuote = (s) => "'" + s.replaceAll("'", "''") + "'";

// Produce configuration only. Never overwrite Codex's config, other hooks,
// ReadBack's settings, or either provider's key during registration.
export function codexRegistration(root, nodePath = process.execPath) {
  const hook = path.join(root, 'hook', 'codex-stop-hook.js');
  const mcp = path.join(root, 'src', 'mcp-server.js');
  // EncodedCommand protects spaces, Unicode and shell metacharacters in Windows
  // install paths. The decoded script runs exactly the two paths shown below.
  const script = `& ${psQuote(nodePath)} ${psQuote(hook)}`;
  const windowsCommand = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' +
    Buffer.from(script, 'utf16le').toString('base64');
  const hooks = {
    hooks: {
      Stop: [{ hooks: [{
        type: 'command',
        command: `${shQuote(nodePath)} ${shQuote(hook)}`,
        commandWindows: windowsCommand,
        timeout: 15,
      }] }],
    },
  };
  const mcpToml = `[mcp_servers.readback]\ncommand = ${JSON.stringify(nodePath)}\nargs = [${JSON.stringify(mcp)}]\n`;
  return { hooks, mcpToml, hook, mcp };
}
