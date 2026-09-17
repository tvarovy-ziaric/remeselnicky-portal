param([string[]]$PlaywrightArgs = @())
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$fixture = Get-Content -LiteralPath (Join-Path $repo '.alpha/r3-e2e-fixture.json') -Raw | ConvertFrom-Json
$alphaEnv = Get-Content -LiteralPath (Join-Path $repo '.env.alpha') -Raw
$hostname = [regex]::Match($alphaEnv, '(?m)^ALPHA_APP_HOSTNAME=([a-z0-9-]+\.trycloudflare\.com)\r?$').Groups[1].Value
if (-not $hostname -or $fixture.baseURL -ne "https://$hostname") { throw 'Quick Tunnel origin mismatch' }
$accountPassword = (Get-Content -LiteralPath (Join-Path $repo '.alpha/secrets/synthetic_seed_password') -Raw).Trim()
$gatePassword = (Get-Content -LiteralPath (Join-Path $repo '.alpha/secrets/quick_gate_password') -Raw).Trim()
$env:STAGING_E2E_ENABLED = 'true'
$env:STAGING_E2E_BASE_URL = $fixture.baseURL
$env:STAGING_E2E_BASIC_AUTH_USERNAME = 'alpha'
$env:STAGING_E2E_BASIC_AUTH_PASSWORD = $gatePassword
$env:STAGING_E2E_LOCAL_COMPOSE_CONTROL = 'true'
$env:STAGING_E2E_CUSTOMER_EMAIL = 'synthetic.account.101@portal.invalid'
$env:STAGING_E2E_CUSTOMER_PASSWORD = $accountPassword
$env:STAGING_E2E_CUSTOMER_B_EMAIL = 'synthetic.account.104@portal.invalid'
$env:STAGING_E2E_CUSTOMER_B_PASSWORD = $accountPassword
$env:STAGING_E2E_PROVIDER_A_EMAIL = 'synthetic.account.102@portal.invalid'
$env:STAGING_E2E_PROVIDER_A_PASSWORD = $accountPassword
$env:STAGING_E2E_PROVIDER_B_EMAIL = 'synthetic.account.103@portal.invalid'
$env:STAGING_E2E_PROVIDER_B_PASSWORD = $accountPassword
$env:STAGING_E2E_REQUEST_A_ID = $fixture.requestA
$env:STAGING_E2E_REQUEST_B_ID = $fixture.requestB
$env:STAGING_E2E_INVITATION_A_ID = $fixture.invitationA
$env:STAGING_E2E_INVITATION_B_ID = $fixture.invitationB
$env:STAGING_E2E_CONVERSATION_A_ID = $fixture.conversationA
$env:STAGING_E2E_CONVERSATION_B_ID = $fixture.conversationB
$env:STAGING_E2E_MEDIA_A_ID = $fixture.mediaA
$env:STAGING_E2E_MEDIA_B_ID = $fixture.mediaB
$env:STAGING_E2E_QUOTE_A_ID = $fixture.quoteA
$env:STAGING_E2E_QUOTE_B_ID = $fixture.quoteB
$env:STAGING_E2E_PROVIDER_A_CANARY = $fixture.canaryA
$env:STAGING_E2E_PROVIDER_B_CANARY = $fixture.canaryB
$env:STAGING_E2E_CUSTOMER_AUTH_STATE = Join-Path $repo '.alpha/r3-e2e-auth-101.json'
$env:STAGING_E2E_CUSTOMER_B_AUTH_STATE = Join-Path $repo '.alpha/r3-e2e-auth-104.json'
$env:STAGING_E2E_PROVIDER_A_AUTH_STATE = Join-Path $repo '.alpha/r3-e2e-auth-102.json'
$env:STAGING_E2E_PROVIDER_B_AUTH_STATE = Join-Path $repo '.alpha/r3-e2e-auth-103.json'
$firefoxExecutable = 'C:\pw-browsers\firefox-1543\firefox\firefox.exe'
if (Test-Path -LiteralPath $firefoxExecutable -PathType Leaf) {
  $env:STAGING_E2E_FIREFOX_EXECUTABLE = $firefoxExecutable
}
foreach ($statePath in @($env:STAGING_E2E_CUSTOMER_AUTH_STATE, $env:STAGING_E2E_CUSTOMER_B_AUTH_STATE, $env:STAGING_E2E_PROVIDER_A_AUTH_STATE, $env:STAGING_E2E_PROVIDER_B_AUTH_STATE)) {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) { throw 'Synthetic browser auth state is unavailable; run the fixture provisioner first' }
}
Push-Location $repo
try {
  pnpm --filter @portal/e2e exec playwright test @PlaywrightArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
  Pop-Location
}
