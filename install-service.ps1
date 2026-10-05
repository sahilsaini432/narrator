# Installs Narrator as a Windows service (via NSSM) that starts at boot and restarts on crash.
#   .\install-service.ps1             -> localhost only (use with `tailscale serve`)
#   .\install-service.ps1 -Lan        -> also reachable from other devices on your Wi-Fi
#   .\install-service.ps1 -Remove     -> stop and uninstall the service
# Needs Administrator; it relaunches itself elevated if needed.
param(
    [switch]$Lan,
    [switch]$Remove,
    [int]$Port = 8000,
    [string]$Nssm = 'E:\nssm-2.24\win64\nssm.exe'
)

$ErrorActionPreference = 'Stop'
$name = 'Narrator'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Port', $Port, '-Nssm', "`"$Nssm`"")
    if ($Lan) { $argList += '-Lan' }
    if ($Remove) { $argList += '-Remove' }
    Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList $argList -Verb RunAs -Wait
    exit
}

try {
    if (-not (Test-Path $Nssm)) { throw "nssm.exe not found at $Nssm (use -Nssm <path>)" }

    if ($Remove) {
        & $Nssm stop $name 2>$null
        & $Nssm remove $name confirm
        return
    }

    $root = $PSScriptRoot
    $py = Join-Path $root '.venv\Scripts\python.exe'
    if (-not (Test-Path $py)) { throw 'Python environment missing. Run .\start.ps1 once first.' }
    if (-not (Test-Path (Join-Path $root 'web\dist\index.html'))) { throw 'Web app not built. Run .\start.ps1 once first.' }

    $logs = Join-Path $root 'data\logs'
    New-Item -ItemType Directory -Force $logs | Out-Null
    $bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }

    if (Get-Service $name -ErrorAction SilentlyContinue) {
        & $Nssm stop $name 2>$null
        & $Nssm remove $name confirm
    }

    & $Nssm install $name $py '-m' 'uvicorn' 'app:app' '--host' $bind '--port' $Port
    & $Nssm set $name AppDirectory (Join-Path $root 'server')
    & $Nssm set $name DisplayName 'Narrator'
    & $Nssm set $name Description 'Narrator: PDF/EPUB text-to-speech server'
    & $Nssm set $name Start SERVICE_AUTO_START
    & $Nssm set $name AppExit Default Restart
    & $Nssm set $name AppRestartDelay 5000
    & $Nssm set $name AppStdout (Join-Path $logs 'service.log')
    & $Nssm set $name AppStderr (Join-Path $logs 'service.log')
    & $Nssm set $name AppRotateFiles 1
    & $Nssm set $name AppRotateBytes 5242880
    & $Nssm start $name

    Write-Host ''
    Write-Host "Service '$name' installed and started on http://${bind}:$Port"
    Write-Host "Logs: $logs\service.log"
}
catch {
    Write-Host "ERROR: $_" -ForegroundColor Red
}
finally {
    Read-Host 'Press Enter to close'
}
