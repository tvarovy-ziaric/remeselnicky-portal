[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Install-Prerequisites.ps1 must run in an elevated PowerShell window."
}

Write-Host "Enabling WSL and Virtual Machine Platform..."
& dism.exe /online /enable-feature /featurename:Microsoft-Windows-Subsystem-Linux /all /norestart
if ($LASTEXITCODE -notin @(0,3010)) { throw "Failed to enable WSL (exit $LASTEXITCODE)." }
& dism.exe /online /enable-feature /featurename:VirtualMachinePlatform /all /norestart
if ($LASTEXITCODE -notin @(0,3010)) { throw "Failed to enable Virtual Machine Platform (exit $LASTEXITCODE)." }

Write-Host "Installing/updating the WSL runtime without a Linux distribution..."
& wsl.exe --update --web-download
if ($LASTEXITCODE -ne 0) {
  Write-Warning "WSL runtime update may require a reboot before it can complete."
}

Write-Host "Installing Docker Desktop from the Windows package source..."
& winget.exe install --exact --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements --silent
if ($LASTEXITCODE -ne 0) { throw "Docker Desktop installation failed (exit $LASTEXITCODE)." }

Write-Host "Prerequisite installation completed. Reboot Windows before starting Docker Desktop."
