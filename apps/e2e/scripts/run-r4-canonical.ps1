param([string[]]$PlaywrightArgs = @())
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$fixturePath = Join-Path $repo '.alpha/r3-e2e-fixture.json'
$fixture = Get-Content -LiteralPath $fixturePath -Raw | ConvertFrom-Json
$alphaEnv = Get-Content -LiteralPath (Join-Path $repo '.env.alpha') -Raw
$hostname = [regex]::Match($alphaEnv, '(?m)^ALPHA_APP_HOSTNAME=([a-z0-9-]+\.trycloudflare\.com)\r?$').Groups[1].Value
if (-not $hostname -or $fixture.baseURL -ne "https://$hostname") { throw 'Quick Tunnel origin mismatch' }
$sinkPort = [regex]::Match($alphaEnv, '(?m)^ALPHA_SYNTHETIC_VERIFICATION_PORT=([0-9]+)\r?$').Groups[1].Value
if (-not $sinkPort -or [int]$sinkPort -lt 1 -or [int]$sinkPort -gt 65535) { throw 'Synthetic verification sink port is invalid' }

$gatePasswordPath = Join-Path $repo '.alpha/secrets/quick_gate_password'
$accountPasswordPath = Join-Path $repo '.alpha/secrets/synthetic_seed_password'
$registrationKeyPath = Join-Path $repo '.alpha/secrets/synthetic_registration_signing_key'
$claimKeyPath = Join-Path $repo '.alpha/secrets/synthetic_verification_claim_key'
$providerStatePath = Join-Path $repo '.alpha/r3-e2e-auth-103.json'
$competitorStatePath = Join-Path $repo '.alpha/r3-e2e-auth-102.json'
foreach ($path in @($gatePasswordPath, $accountPasswordPath, $registrationKeyPath, $claimKeyPath, $providerStatePath, $competitorStatePath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Canonical synthetic E2E prerequisite is unavailable' }
}

$env:STAGING_E2E_CANONICAL_ENABLED = 'true'
$env:STAGING_E2E_BASE_URL = $fixture.baseURL
$env:STAGING_E2E_BASIC_AUTH_USERNAME = 'alpha'
$env:STAGING_E2E_BASIC_AUTH_PASSWORD = (Get-Content -LiteralPath $gatePasswordPath -Raw).Trim()
$env:STAGING_E2E_PROVIDER_B_EMAIL = 'synthetic.account.103@portal.invalid'
$env:STAGING_E2E_PROVIDER_B_PASSWORD = (Get-Content -LiteralPath $accountPasswordPath -Raw).Trim()
$env:STAGING_E2E_PROVIDER_B_AUTH_STATE = $providerStatePath
$env:STAGING_E2E_PROVIDER_A_AUTH_STATE = $competitorStatePath
$env:STAGING_E2E_SYNTHETIC_REGISTRATION_KEY_FILE = $registrationKeyPath
$env:STAGING_E2E_SYNTHETIC_CLAIM_KEY_FILE = $claimKeyPath
$env:STAGING_E2E_SYNTHETIC_SINK_ORIGIN = "http://127.0.0.1:$sinkPort"

Push-Location $repo
try {
  corepack pnpm --filter @portal/e2e test tests/r4-canonical-loop.spec.ts --project=chromium @PlaywrightArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
