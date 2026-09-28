param(
  [Parameter(Mandatory = $true)]
  [string]$EvidenceDirectory
)

$ErrorActionPreference = "Stop"

function Assert-NativeSuccess {
  param([string]$Action)

  if ($LASTEXITCODE -ne 0) {
    throw "$Action failed with exit code $LASTEXITCODE."
  }
}

function Invoke-VitestWithoutSkips {
  param(
    [string]$Label,
    [string]$Package,
    [string]$Script = "test"
  )

  # Windows PowerShell 5.1 promotes a native process' stderr records according
  # to ErrorActionPreference. pnpm writes its script banner to stderr even for
  # a successful run, so capture both streams and make the native exit code the
  # authority instead of treating informational stderr as a terminating error.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = @(
      & corepack pnpm --filter $Package $Script --reporter=json 2>&1 |
        ForEach-Object { $_.ToString() }
    )
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    $output | Write-Output
    throw "$Label failed with exit code $exitCode."
  }
  $jsonLine = @(
    $output | Where-Object { $_.TrimStart().StartsWith("{") }
  ) | Select-Object -Last 1
  if (-not $jsonLine) {
    throw "$Label did not emit a Vitest JSON result."
  }
  $result = $jsonLine | ConvertFrom-Json
  if (
    $result.success -ne $true -or
    $result.numFailedTests -ne 0 -or
    $result.numPendingTests -ne 0 -or
    $result.numTodoTests -ne 0 -or
    $result.numPassedTests -ne $result.numTotalTests
  ) {
    throw "$Label did not finish with every discovered test passing and zero skipped/todo tests."
  }
  Write-Host "${Label}: $($result.numPassedTests)/$($result.numTotalTests) passed; 0 skipped."
  return [pscustomobject][ordered]@{
    label = $Label
    package = $Package
    script = $Script
    passed = [int]$result.numPassedTests
    total = [int]$result.numTotalTests
    skipped = 0
    todo = 0
  }
}

$runSuffix = ([guid]::NewGuid().ToString("N")).Substring(0, 8)
$runStartedAt = (Get-Date).ToUniversalTime()
$runId = "r4-031-security-$($runStartedAt.ToString('yyyyMMddTHHmmssZ'))-$runSuffix"
$containerName = "remeselnicky-r4-031-db-$runSuffix"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$temporaryRoot = [IO.Path]::GetTempPath().TrimEnd("\", "/")
$workDirectory = Join-Path $temporaryRoot "portal-r4-031-$runSuffix"
$passwordFile = Join-Path $workDirectory "postgres-password.txt"
$evidencePath = [IO.Path]::GetFullPath($EvidenceDirectory)
$oldTestDatabaseUrl = $env:TEST_DATABASE_URL
$containerCreated = $false
$testResults = @()

New-Item -ItemType Directory -Path $workDirectory -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $evidencePath -Force -ErrorAction Stop | Out-Null
$password = [guid]::NewGuid().ToString("N")
Set-Content -LiteralPath $passwordFile -Value $password -NoNewline -Encoding utf8

try {
  docker info --format "{{.ServerVersion}}" | Out-Null
  Assert-NativeSuccess "Docker daemon preflight"
  docker image inspect "postgis/postgis:17-3.5-alpine" | Out-Null
  Assert-NativeSuccess "Pinned local PostGIS image preflight"

  docker run --detach --name $containerName `
    --pull never `
    --tmpfs "/var/lib/postgresql/data:rw,noexec,nosuid,size=2g" `
    --publish "127.0.0.1::5432" `
    --mount "type=bind,source=$passwordFile,target=/run/secrets/postgres_password,readonly" `
    --env "POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password" `
    --env "POSTGRES_USER=portal_owner" `
    --env "POSTGRES_DB=portal_test" `
    postgis/postgis:17-3.5-alpine | Out-Null
  Assert-NativeSuccess "Disposable PostGIS container creation"
  $containerCreated = $true

  $databaseReady = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    docker exec $containerName pg_isready --username portal_owner --dbname portal_test | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $databaseReady = $true
      break
    }
    Start-Sleep -Seconds 1
  }
  if (-not $databaseReady) {
    throw "Disposable PostGIS did not become ready within 60 seconds."
  }

  $portOutput = docker port $containerName "5432/tcp"
  Assert-NativeSuccess "Published PostgreSQL port lookup"
  $hostPort = ($portOutput.Trim() -split ":")[-1]
  if ($hostPort -notmatch "^\d+$") {
    throw "Docker returned an invalid PostgreSQL host port."
  }

  docker exec $containerName psql `
    --username portal_owner `
    --dbname portal_test `
    --set "ON_ERROR_STOP=1" `
    --command "ALTER ROLE portal_owner SET portal.environment = 'test';" | Out-Null
  Assert-NativeSuccess "Test environment marker configuration"

  $encodedPassword = [uri]::EscapeDataString($password)
  $env:TEST_DATABASE_URL = "postgresql://portal_owner:${encodedPassword}@127.0.0.1:${hostPort}/portal_test?sslmode=disable"

  & corepack pnpm --filter "@portal/db..." build
  Assert-NativeSuccess "Database integration dependency build"

  $testResults += Invoke-VitestWithoutSkips `
    -Label "Authorization negative suite" `
    -Package "@portal/authorization"
  $testResults += Invoke-VitestWithoutSkips `
    -Label "Admin capability and MFA suite" `
    -Package "@portal/admin-auth"
  $testResults += Invoke-VitestWithoutSkips `
    -Label "Hostile upload and private delivery suite" `
    -Package "@portal/media"
  $testResults += Invoke-VitestWithoutSkips `
    -Label "Privacy-minimal notification suite" `
    -Package "@portal/notifications"
  $testResults += Invoke-VitestWithoutSkips `
    -Label "Notification and hostile-media worker suite" `
    -Package "@portal/worker"
  $testResults += Invoke-VitestWithoutSkips `
    -Label "API object, field, action, CSRF and CORS suite" `
    -Package "@portal/api"
  $testResults += Invoke-VitestWithoutSkips `
    -Label "Web free-text and private projection suite" `
    -Package "@portal/web"
  $testResults += Invoke-VitestWithoutSkips `
    -Label "Isolated database harness suite" `
    -Package "@portal/testing" `
    -Script "test:integration"
  $testResults += Invoke-VitestWithoutSkips `
    -Label "Committed race and migration suite" `
    -Package "@portal/db" `
    -Script "test:integration"

  $commit = (& git -C $workspace rev-parse HEAD).Trim()
  Assert-NativeSuccess "Git revision lookup"
  $worktreeChanges = @(& git -C $workspace status --short --untracked-files=all)
  Assert-NativeSuccess "Git worktree status lookup"
  if ($worktreeChanges.Count -ne 0) {
    throw "Release evidence requires a clean worktree so the tested source is exactly the recorded commit."
  }

  $evidenceFile = Join-Path $evidencePath "$runId.json"
  [ordered]@{
    schemaVersion = 1
    runId = $runId
    ticket = "R4-031"
    status = "PASS"
    environment = "local-isolated-staging-equivalent"
    dataClass = "synthetic"
    commit = $commit
    startedAt = $runStartedAt.ToString("o")
    completedAt = (Get-Date).ToUniversalTime().ToString("o")
    database = [ordered]@{
      image = "postgis/postgis:17-3.5-alpine"
      storage = "tmpfs"
      publishedInterface = "127.0.0.1"
      existingStagingTouched = $false
    }
    tests = $testResults
    totalPassed = [int](($testResults | Measure-Object -Property passed -Sum).Sum)
    totalSkipped = 0
    externalProviderEvidence = "NOT_EVALUATED"
    realUserLaunchDecision = "NO-GO"
  } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $evidenceFile -Encoding utf8

  [ordered]@{
    runId = $runId
    status = "PASS"
    commit = $commit
    totalPassed = [int](($testResults | Measure-Object -Property passed -Sum).Sum)
    totalSkipped = 0
    evidenceFile = $evidenceFile
    existingStagingTouched = $false
    realUserLaunchDecision = "NO-GO"
  } | ConvertTo-Json -Depth 4
}
finally {
  $env:TEST_DATABASE_URL = $oldTestDatabaseUrl
  if ($containerCreated) {
    docker rm --force $containerName | Out-Null
  }
  $resolvedWork = [IO.Path]::GetFullPath($workDirectory)
  if (
    $resolvedWork.StartsWith("$temporaryRoot\", [StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path $resolvedWork -Leaf) -match "^portal-r4-031-[0-9a-f]{8}$"
  ) {
    Remove-Item -LiteralPath $resolvedWork -Recurse -Force
  }
}
