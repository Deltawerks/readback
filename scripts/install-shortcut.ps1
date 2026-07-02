param(
  [string]$Name = "Readback",
  [switch]$StartMenu
)

$ErrorActionPreference = "Stop"
$projDir = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot "launch-panel.vbs"
$assetsDir = Join-Path $projDir "assets"
$icoPath = Join-Path $assetsDir "readback.ico"

if (-not (Test-Path $assetsDir)) { New-Item -ItemType Directory -Path $assetsDir | Out-Null }

# --- Generate a branded icon (dark tile + cyan speaker glyph). Falls back to a
#     system icon if drawing isn't available. ---
$iconLocation = "$env:SystemRoot\System32\imageres.dll,220"
try {
  Add-Type -AssemblyName System.Drawing
  $size = 256
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $bg = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#0b1220"))
  $g.FillRectangle($bg, 0, 0, $size, $size)
  $fg = New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml("#4db8ff"))
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $rect = New-Object System.Drawing.RectangleF 0, 0, $size, $size
  $drawn = $false
  try {
    $fnt = New-Object System.Drawing.Font "Segoe MDL2 Assets", 150
    $g.DrawString([char]0xE767, $fnt, $fg, $rect, $fmt)  # volume glyph
    $drawn = $true
  } catch { }
  if (-not $drawn) {
    # Fallback: a simple cyan play triangle.
    $pts = @(
      (New-Object System.Drawing.PointF 96, 78),
      (New-Object System.Drawing.PointF 96, 178),
      (New-Object System.Drawing.PointF 180, 128)
    )
    $g.FillPolygon($fg, $pts)
  }
  $g.Dispose()
  $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
  $fs = [System.IO.File]::Create($icoPath)
  $icon.Save($fs)
  $fs.Close()
  $bmp.Dispose()
  if (Test-Path $icoPath) { $iconLocation = "$icoPath,0" }
} catch {
  Write-Host "Icon generation skipped ($($_.Exception.Message)); using a system icon."
}

function New-VbxShortcut($lnkPath) {
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($lnkPath)
  $sc.TargetPath = "wscript.exe"
  $sc.Arguments = '"' + $vbs + '"'
  $sc.WorkingDirectory = $projDir
  $sc.WindowStyle = 7
  $sc.IconLocation = $iconLocation
  $sc.Description = "Open the Readback control panel"
  $sc.Save()
}

$desktop = [Environment]::GetFolderPath("Desktop")
$desktopLnk = Join-Path $desktop "$Name.lnk"
New-VbxShortcut $desktopLnk
Write-Host "Created desktop shortcut: $desktopLnk"

if ($StartMenu) {
  $programs = [Environment]::GetFolderPath("Programs")
  $startLnk = Join-Path $programs "$Name.lnk"
  New-VbxShortcut $startLnk
  Write-Host "Created Start Menu shortcut: $startLnk"
}

Write-Host "Done. Double-click '$Name' on your Desktop to open the panel."
