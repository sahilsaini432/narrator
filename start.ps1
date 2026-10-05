# Starts Narrator. First run sets everything up (venv, dependencies, web build).
#   .\start.ps1          -> listens on this PC only (use with `tailscale serve`)
#   .\start.ps1 -Lan     -> also reachable from other devices on your Wi-Fi (http, no HTTPS)
#   .\start.ps1 -Rebuild -> force a fresh build of the web app
param([switch]$Lan, [switch]$Rebuild, [int]$Port = 8000)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
Set-Location $root

$py = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
    Write-Host 'Creating Python environment...'
    # Python 3.12 has prebuilt wheels for every dependency; fall back to whatever `python` is.
    py -3.12 -m venv .venv 2>$null
    if (-not (Test-Path $py)) { python -m venv .venv }
    & $py -m pip install --quiet --upgrade pip
    & $py -m pip install --quiet -r server\requirements.txt
}

$dist = Join-Path $root 'web\dist\index.html'
if ($Rebuild -or -not (Test-Path $dist)) {
    Write-Host 'Building the web app...'
    Push-Location web
    if (-not (Test-Path node_modules)) { npm install }
    npm run build
    Pop-Location
}

$bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
Write-Host ''
Write-Host "Narrator: http://localhost:$Port"
if ($Lan) {
    $ip = (Get-NetIPAddress -AddressFamily IPv4 |
        Where-Object { $_.IPAddress -match '^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))' } |
        Select-Object -First 1).IPAddress
    if ($ip) { Write-Host "On your phone (same Wi-Fi): http://${ip}:$Port" }
}
Write-Host 'Press Ctrl+C to stop.'
Write-Host ''

Set-Location (Join-Path $root 'server')
& $py -m uvicorn app:app --host $bind --port $Port
