[CmdletBinding()]
param([switch]$RefreshHash)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$secrets = Join-Path $repo ".alpha\secrets"
New-Item -ItemType Directory -Force -Path $secrets | Out-Null

$passwordPath = Join-Path $secrets "quick_gate_password"
$htpasswdPath = Join-Path $secrets "quick_gate_htpasswd"
if (-not (Test-Path -LiteralPath $passwordPath)) {
  $buffer = [byte[]]::new(24)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  [IO.File]::WriteAllText($passwordPath, [Convert]::ToHexString($buffer).ToLowerInvariant(), [Text.UTF8Encoding]::new($false))
}

$password = (Get-Content -LiteralPath $passwordPath -Raw).Trim()
if ($password -cnotmatch '^[0-9a-f]{48}$') {
  throw "The existing quick-gate password is invalid; do not replace it automatically."
}
if ($RefreshHash -or -not (Test-Path -LiteralPath $htpasswdPath)) {
  $openssl = Get-Command openssl -ErrorAction SilentlyContinue
  if ($null -eq $openssl) {
    $opensslPath = "C:\Program Files\Git\usr\bin\openssl.exe"
    if (-not (Test-Path -LiteralPath $opensslPath)) { throw "OpenSSL is required to hash the quick-gate password." }
  } else {
    $opensslPath = $openssl.Source
  }
  $hash = (& $opensslPath passwd -6 -in $passwordPath).Trim()
  if ($LASTEXITCODE -ne 0 -or $hash -notmatch '^\$6\$') { throw "Failed to hash the quick-gate password." }
  [IO.File]::WriteAllText($htpasswdPath, "alpha:$hash`n", [Text.UTF8Encoding]::new($false))
}
