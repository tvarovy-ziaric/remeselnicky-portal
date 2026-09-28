param([string[]]$PlaywrightArgs = @())

$ErrorActionPreference = "Stop"

function Assert-NativeSuccess {
  param([string]$Action)

  if ($LASTEXITCODE -ne 0) {
    throw "$Action failed with exit code $LASTEXITCODE."
  }
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$alphaDirectory = Join-Path $repo ".alpha"
$fixturePath = Join-Path $alphaDirectory "r3-e2e-fixture.json"
$backupDirectory = Join-Path $alphaDirectory "r4-security-fixture-backups"
$runSuffix = ([guid]::NewGuid().ToString("N")).Substring(0, 8)
$backupPath = Join-Path $backupDirectory "r3-e2e-fixture-$runSuffix.json"

if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) {
  throw "The existing synthetic fixture is unavailable."
}
New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
Move-Item -LiteralPath $fixturePath -Destination $backupPath

Push-Location $repo
try {
  node apps/e2e/scripts/provision-r3-quick.mjs
  Assert-NativeSuccess "Fresh synthetic security fixture provisioning"

  & (Join-Path $PSScriptRoot "run-r3-quick.ps1") -PlaywrightArgs @(
    "tests/r3-competitor-isolation.spec.ts"
    "tests/r3-private-media.spec.ts"
    "tests/r4-quote-acceptance.spec.ts"
    "--project=chromium"
    $PlaywrightArgs
  )
  Assert-NativeSuccess "Focused public authorization, media and acceptance suite"

  & (Join-Path $PSScriptRoot "run-r4-canonical.ps1") -PlaywrightArgs $PlaywrightArgs
  Assert-NativeSuccess "Canonical sealed-review suite"

  [ordered]@{
    status = "PASS"
    dataClass = "synthetic"
    fixtureBackup = $backupPath
    previousFixtureDeleted = $false
    providerStagingEvidence = "NOT_EVALUATED"
    realUserLaunchDecision = "NO-GO"
  } | ConvertTo-Json
}
catch {
  if (
    -not (Test-Path -LiteralPath $fixturePath -PathType Leaf) -and
    (Test-Path -LiteralPath $backupPath -PathType Leaf)
  ) {
    Move-Item -LiteralPath $backupPath -Destination $fixturePath
  }
  throw
}
finally {
  Pop-Location
}
