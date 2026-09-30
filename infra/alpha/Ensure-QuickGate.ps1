[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$secrets = Join-Path $repo ".alpha\secrets"
New-Item -ItemType Directory -Force -Path $secrets | Out-Null

$passwordPath = Join-Path $secrets "quick_gate_password"
if (-not (Test-Path -LiteralPath $passwordPath)) {
  $buffer = [byte[]]::new(24)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  [IO.File]::WriteAllText($passwordPath, [Convert]::ToHexString($buffer).ToLowerInvariant(), [Text.UTF8Encoding]::new($false))
}

$password = (Get-Content -LiteralPath $passwordPath -Raw).Trim()
if ($password -cnotmatch '^[0-9a-f]{48}$') {
  throw "The existing quick-gate password is invalid; do not replace it automatically."
}
