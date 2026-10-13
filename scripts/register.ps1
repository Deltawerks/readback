# Generates .mcp.json and hooks-snippet.json for THIS install location, so the
# paths are correct on any machine (no hardcoded drive letters).
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$mcp = Join-Path $root "src\mcp-server.js"
$hook = Join-Path $root "hook\stop-hook.js"
# Node by its full path, as the Codex registration does: Claude Desktop does not
# always start with this shell's PATH (nvm, fnm, a per-user install), and a hook
# registered as plain "node" then never runs, with no error anywhere.
$node = (Get-Command node.exe -ErrorAction Stop).Source

# Escape backslashes for embedding in JSON.
$mcpEsc = $mcp -replace '\\', '\\'
$hookEsc = $hook -replace '\\', '\\'
$nodeEsc = $node -replace '\\', '\\'

$mcpJson = @"
{
  "mcpServers": {
    "readback": {
      "command": "$nodeEsc",
      "args": ["$mcpEsc"]
    }
  }
}
"@
# UTF-8 without BOM. A BOM makes the JSON invalid for strict parsers.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $root ".mcp.json"), $mcpJson, $utf8NoBom)

$hookJson = @"
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "$nodeEsc", "args": ["$hookEsc"], "timeout": 15 } ] }
    ]
  }
}
"@
[System.IO.File]::WriteAllText((Join-Path $root "hooks-snippet.json"), $hookJson, $utf8NoBom)

Write-Host "Wrote .mcp.json and hooks-snippet.json for:"
Write-Host "  $root"
Write-Host "  using Node at $node (run this again if you move or upgrade Node)"
Write-Host ""
Write-Host "1) MCP server: in this folder Claude Code asks you to approve .mcp.json first. For it everywhere, run:"
Write-Host "     claude mcp add readback -s user -- `"$node`" `"$mcp`""
Write-Host "     -s user = user scope: available in every project. Leave it off and you get"
Write-Host "     local scope, which is only the folder you ran it in, while the hook keeps"
Write-Host "     speaking everywhere else."
Write-Host ""
Write-Host "2) Auto-speak hook: merge hooks-snippet.json into your Claude Code settings.json"
Write-Host "     (~/.claude/settings.json for every project), then restart Claude Code."
