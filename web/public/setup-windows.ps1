<#
.SYNOPSIS
  Astrotool – installs optional helper tools on Windows 10/11 (via winget).

.DESCRIPTION
  Astrotool itself runs in the browser and needs nothing installed.
  This script installs only what is missing:
    - FFmpeg        (convert AVI/MP4/MOV to SER; used by the upcoming Windows app)
  With -Dev additionally:
    - Node.js LTS   (run/build Astrotool from source)
    - Git           (fetch the source code)
    and runs "npm install" in the web folder if the script is started inside the repository.

  winget shows the licence terms of each package; by running this script you accept them.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1
  powershell -ExecutionPolicy Bypass -File .\setup-windows.ps1 -Dev
#>
[CmdletBinding()]
param(
  [switch]$Dev,
  [switch]$WhatIf
)

$ErrorActionPreference = 'Stop'

function Write-Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    OK  $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "    !!  $text" -ForegroundColor Yellow }

function Test-Command($name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Install-Tool {
  param([string]$Name, [string]$WingetId, [string]$Command)
  if (Test-Command $Command) {
    Write-Ok "$Name already installed ($((Get-Command $Command).Source))"
    return
  }
  if ($WhatIf) { Write-Warn "would install $Name ($WingetId)"; return }
  Write-Host "    installing $Name ($WingetId) …"
  winget install --id $WingetId --exact --source winget --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -ne 0) { throw "winget could not install $Name (exit code $LASTEXITCODE)" }
  Write-Ok "$Name installed – open a new terminal so that PATH is updated"
}

Write-Host "Astrotool setup" -ForegroundColor White

Write-Step "Checking winget"
if (-not (Test-Command 'winget')) {
  Write-Warn "winget is missing. Install 'App Installer' from the Microsoft Store: https://apps.microsoft.com/detail/9NBLGGH4NNS1"
  exit 1
}
Write-Ok "winget $(winget --version)"

Write-Step "Optional tools"
Install-Tool -Name 'FFmpeg' -WingetId 'Gyan.FFmpeg' -Command 'ffmpeg'

if ($Dev) {
  Write-Step "Developer tools"
  Install-Tool -Name 'Node.js LTS' -WingetId 'OpenJS.NodeJS.LTS' -Command 'node'
  Install-Tool -Name 'Git' -WingetId 'Git.Git' -Command 'git'

  # Astrotool-Quellcode suchen: neben dem Skript (web\public), im Repo-Wurzelordner oder im aktuellen Ordner
  $candidates = @(
    (Join-Path $PSScriptRoot '..'), (Join-Path $PSScriptRoot 'web'), (Join-Path $PSScriptRoot 'astrotool\web'),
    (Join-Path (Get-Location) 'web'), (Join-Path (Get-Location) 'astrotool\web'), (Get-Location).Path
  )
  $web = $candidates | Where-Object { Test-Path (Join-Path $_ 'package.json') } |
    Where-Object { (Get-Content (Join-Path $_ 'package.json') -Raw) -match '"astrotool-web"' } | Select-Object -First 1
  if ($web) { $web = (Resolve-Path $web).Path }
  if ($web -and (Test-Command 'npm')) {
    Write-Step "Installing Astrotool dependencies (npm install)"
    if ($WhatIf) { Write-Warn "would run npm install in $web" }
    else {
      Push-Location $web
      try { npm install --no-fund --no-audit } finally { Pop-Location }
      Write-Ok "done – start with:  cd `"$web`"; npm run dev"
    }
  } else {
    Write-Warn "Astrotool source not found next to this script. Clone it with: git clone https://github.com/aisuisse/astrotool.git"
  }
}

Write-Step "Finished"
