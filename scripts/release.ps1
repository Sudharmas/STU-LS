param(
  [ValidateSet("windows", "mac", "linux")]
  [string]$Target = "windows"
)

$ErrorActionPreference = "Stop"

Set-Location "$PSScriptRoot\.."

Write-Host "Running checks and tests..."
npm run check:desktop
npm run test:desktop

if ($Target -eq "windows") {
  Write-Host "Building Windows installer..."
  npm run release:windows
} elseif ($Target -eq "mac") {
  Write-Host "Building macOS installer..."
  npm run release:mac
} elseif ($Target -eq "linux") {
  Write-Host "Building Linux packages..."
  npm run release:linux
}

Write-Host "Release packaging completed for target: $Target"
