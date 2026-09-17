[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$directory = Join-Path $repo ".alpha\secrets"
New-Item -ItemType Directory -Force -Path $directory | Out-Null

function Read-Secret([string]$Prompt) {
  $secure = Read-Host $Prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}

$tunnel = Read-Secret "Paste the remeselnicky-alpha tunnel token"
$clientId = Read-Secret "Paste the Cloudflare Access service-token Client ID"
$clientSecret = Read-Secret "Paste the Cloudflare Access service-token Client Secret"
if ([string]::IsNullOrWhiteSpace($tunnel) -or [string]::IsNullOrWhiteSpace($clientId) -or [string]::IsNullOrWhiteSpace($clientSecret)) {
  throw "All three Cloudflare values are required."
}

[IO.File]::WriteAllText((Join-Path $directory "cloudflare_tunnel_token"), $tunnel, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $directory "cf_access_client_id"), $clientId, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $directory "cf_access_client_secret"), $clientSecret, [Text.UTF8Encoding]::new($false))
$tunnel = $clientId = $clientSecret = $null
Write-Host "Cloudflare secrets stored in ignored local files under .alpha/secrets."
