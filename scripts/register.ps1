# Generates .mcp.json and hooks-snippet.json for THIS install location, so the
# paths are correct on any machine (no hardcoded drive letters).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$mcp = Join-Path $root "src\mcp-server.js"
$hook = Join-Path $root "hook\stop-hook.js"

# Escape backslashes for embedding in JSON.
$mcpEsc = $mcp -replace '\\', '\\'
$hookEsc = $hook -replace '\\', '\\'

$mcpJson = @"
{
  "mcpServers": {
    "readback": {
      "command": "node",
      "args": ["$mcpEsc"]
    }
  }
}
"@
Set-Content -Path (Join-Path $root ".mcp.json") -Value $mcpJson -Encoding UTF8

$hookJson = @"
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node", "args": ["$hookEsc"], "timeout": 15 } ] }
    ]
  }
}
"@
Set-Content -Path (Join-Path $root "hooks-snippet.json") -Value $hookJson -Encoding UTF8

Write-Host "Wrote .mcp.json and hooks-snippet.json for:"
Write-Host "  $root"
Write-Host ""
Write-Host "1) MCP server auto-loads when you work in this folder. For it everywhere, run:"
Write-Host "     claude mcp add readback -- node `"$mcp`""
Write-Host ""
Write-Host "2) Auto-speak hook: merge hooks-snippet.json into your Claude Code settings.json"
Write-Host "     (~/.claude/settings.json for every project), then restart Claude Code."
