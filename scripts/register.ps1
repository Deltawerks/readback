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
# UTF-8 without BOM — a BOM makes the JSON invalid for strict parsers.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $root ".mcp.json"), $mcpJson, $utf8NoBom)

$hookJson = @"
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node", "args": ["$hookEsc"], "timeout": 15 } ] }
    ]
  }
}
"@
[System.IO.File]::WriteAllText((Join-Path $root "hooks-snippet.json"), $hookJson, $utf8NoBom)

Write-Host "Wrote .mcp.json and hooks-snippet.json for:"
Write-Host "  $root"
Write-Host ""
Write-Host "1) MCP server auto-loads when you work in this folder. For it everywhere, run:"
Write-Host "     claude mcp add readback -- node `"$mcp`""
Write-Host ""
Write-Host "2) Auto-speak hook: merge hooks-snippet.json into your Claude Code settings.json"
Write-Host "     (~/.claude/settings.json for every project), then restart Claude Code."
