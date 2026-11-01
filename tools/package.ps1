$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -Raw -LiteralPath (Join-Path $projectRoot 'manifest.json') | ConvertFrom-Json
$archive = Join-Path $projectRoot "mark-my-tabs-$($manifest.version).zip"
$files = @('manifest.json', 'background.js', '_locales', 'icons', 'common', 'manager', 'popup', 'save') | ForEach-Object { Join-Path $projectRoot $_ }
Compress-Archive -LiteralPath $files -DestinationPath $archive -Force
Write-Output "Ready: $archive"
