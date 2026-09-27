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

$runSuffix = ([guid]::NewGuid().ToString("N")).Substring(0, 8)
$runDate = (Get-Date).ToUniversalTime().ToString("yyyyMMdd")
$runId = "local-synthetic-restore-$runDate-$runSuffix"
$containerName = "remeselnicky-r4-029-db-$runSuffix"
$networkName = "remeselnicky-r4-029-net-$runSuffix"
$sourceDatabase = "portal_rehearsal_source"
$targetDatabase = "portal_restore_verify_${runDate}_$runSuffix"
$recoveryRole = "recovery_owner"
$syntheticUserId = "00000000-0000-4000-8000-000000000029"
$workspace = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$migrationFiles = Get-ChildItem `
  -LiteralPath (Join-Path $workspace "packages\db\migrations") `
  -Filter "*.sql" `
  -File
$migrationVersions = @(
  $migrationFiles | ForEach-Object {
    if ($_.BaseName -notmatch "^(\d{4})_") {
      throw "Migration file has an invalid version prefix: $($_.Name)"
    }
    [int]$Matches[1]
  }
)
if ($migrationVersions.Count -eq 0) {
  throw "No database migrations were found."
}
$latestMigrationVersion = ($migrationVersions | Measure-Object -Maximum).Maximum
$temporaryRoot = [IO.Path]::GetTempPath().TrimEnd("\", "/")
$workDirectory = Join-Path $temporaryRoot "portal-r4-029-$runSuffix"
$passwordFile = Join-Path $workDirectory "postgres-password.txt"
$environmentFile = Join-Path $workDirectory "verifier.env"
$archiveFile = Join-Path $workDirectory "source.dump"
$evidencePath = [IO.Path]::GetFullPath($EvidenceDirectory)
$oldDatabaseUrl = $env:DATABASE_URL
$containerCreated = $false
$networkCreated = $false

New-Item -ItemType Directory -Path $workDirectory -ErrorAction Stop | Out-Null
New-Item -ItemType Directory -Path $evidencePath -Force -ErrorAction Stop | Out-Null
$password = [guid]::NewGuid().ToString("N")
Set-Content -LiteralPath $passwordFile -Value $password -NoNewline -Encoding utf8

try {
  docker network create $networkName | Out-Null
  Assert-NativeSuccess "Docker network creation"
  $networkCreated = $true

  docker run --detach --name $containerName `
    --network $networkName `
    --tmpfs "/var/lib/postgresql/data:rw,noexec,nosuid,size=1g" `
    --publish "127.0.0.1::5432" `
    --mount "type=bind,source=$passwordFile,target=/run/secrets/postgres_password,readonly" `
    --env "POSTGRES_PASSWORD_FILE=/run/secrets/postgres_password" `
    --env "POSTGRES_USER=$recoveryRole" `
    --env "POSTGRES_DB=$sourceDatabase" `
    postgis/postgis:17-3.5-alpine | Out-Null
  Assert-NativeSuccess "Disposable PostGIS container creation"
  $containerCreated = $true

  $databaseReady = $false
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    docker exec $containerName pg_isready --username $recoveryRole --dbname $sourceDatabase | Out-Null
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
    --username $recoveryRole `
    --dbname $sourceDatabase `
    --set "ON_ERROR_STOP=1" `
    --command "ALTER ROLE $recoveryRole SET portal.environment = 'staging';" | Out-Null
  Assert-NativeSuccess "Recovery environment marker configuration"

  $encodedPassword = [uri]::EscapeDataString($password)
  $env:DATABASE_URL = "postgresql://${recoveryRole}:${encodedPassword}@127.0.0.1:${hostPort}/${sourceDatabase}?sslmode=disable"
  pnpm --filter @portal/db migrate | Out-Null
  Assert-NativeSuccess "Current schema migration"

  docker exec $containerName psql `
    --username $recoveryRole `
    --dbname $sourceDatabase `
    --set "ON_ERROR_STOP=1" `
    --command "INSERT INTO users (id) VALUES ('$syntheticUserId');" | Out-Null
  Assert-NativeSuccess "Synthetic restore marker insertion"

  docker exec $containerName pg_dump `
    --format custom `
    --file /tmp/source.dump `
    --username $recoveryRole `
    --dbname $sourceDatabase
  Assert-NativeSuccess "Synthetic custom-format backup"
  docker cp "${containerName}:/tmp/source.dump" $archiveFile | Out-Null
  Assert-NativeSuccess "Synthetic backup extraction"

  @(
    "RECOVERY_EXPECTED_ENVIRONMENT=staging"
    "RECOVERY_DATA_CLASS=synthetic"
    "RECOVERY_RUN_ID=$runId"
    "RECOVERY_ACKNOWLEDGEMENT=CREATE_NEW_ISOLATED_DATABASE_ONLY"
    "RECOVERY_SOURCE_ARCHIVE=/recovery/source.dump"
    "RECOVERY_EVIDENCE_DIRECTORY=/evidence"
    "RECOVERY_EXPECTED_MIGRATION_VERSION=$latestMigrationVersion"
    "RECOVERY_TARGET_DATABASE=$targetDatabase"
    "RECOVERY_ADMIN_DATABASE_URL=postgresql://${recoveryRole}:${encodedPassword}@${containerName}:5432/${sourceDatabase}?sslmode=disable"
    "RECOVERY_TARGET_DATABASE_URL=postgresql://${recoveryRole}:${encodedPassword}@${containerName}:5432/${targetDatabase}?sslmode=disable"
  ) | Set-Content -LiteralPath $environmentFile -Encoding utf8

  docker run --rm `
    --network $networkName `
    --env-file $environmentFile `
    --mount "type=bind,source=$workspace,target=/workspace,readonly" `
    --mount "type=bind,source=$archiveFile,target=/recovery/source.dump,readonly" `
    --mount "type=bind,source=$evidencePath,target=/evidence" `
    postgis/postgis:17-3.5-alpine `
    sh -lc "apk add --no-cache nodejs >/dev/null && node /workspace/infra/postgres/recovery/verify-restore.mjs" | Out-Null
  Assert-NativeSuccess "Canonical restore verifier"

  $restoredSyntheticUsers = docker exec $containerName psql `
    --username $recoveryRole `
    --dbname $targetDatabase `
    --no-align `
    --tuples-only `
    --set "ON_ERROR_STOP=1" `
    --command "SELECT COUNT(*) FROM users WHERE id = '$syntheticUserId';"
  Assert-NativeSuccess "Restored synthetic marker verification"
  if ($restoredSyntheticUsers.Trim() -ne "1") {
    throw "The restored synthetic marker is missing or duplicated."
  }

  $env:DATABASE_URL = "postgresql://${recoveryRole}:${encodedPassword}@127.0.0.1:${hostPort}/${targetDatabase}?sslmode=disable"
  $invariantScript = @'
import { createDatabase } from "./packages/db/dist/index.js";
const database = createDatabase({ connectionString: process.env.DATABASE_URL });
try {
  const results = await database.operationalInvariants.check();
  process.stdout.write(JSON.stringify(results));
} finally {
  await database.close();
}
'@
  $invariantOutput = node --input-type=module --eval $invariantScript
  Assert-NativeSuccess "Restored operational invariant verification"
  $invariants = $invariantOutput | ConvertFrom-Json
  $violations = @($invariants | Where-Object { $_.violationCount -ne 0 })
  if ($invariants.Count -ne 7 -or $violations.Count -ne 0) {
    throw "The restored database failed operational invariant verification."
  }

  $evidenceFile = Join-Path $evidencePath "$runId.json"
  $evidence = Get-Content -LiteralPath $evidenceFile -Raw | ConvertFrom-Json
  [ordered]@{
    schemaVersion = 1
    runId = $runId
    status = "passed"
    environment = "local-isolated-staging-equivalent"
    dataClass = "synthetic"
    archiveSha256 = $evidence.archiveSha256
    latestMigration = $evidence.checks.latestMigration
    postgis = $evidence.checks.postgis
    restoredSyntheticMarkerCount = 1
    operationalInvariantCount = $invariants.Count
    operationalInvariantViolations = 0
    canonicalEvidenceFile = $evidenceFile
    existingStagingTouched = $false
  } | ConvertTo-Json -Depth 4
}
finally {
  $env:DATABASE_URL = $oldDatabaseUrl
  if ($containerCreated) {
    docker rm --force $containerName | Out-Null
  }
  if ($networkCreated) {
    docker network rm $networkName | Out-Null
  }
  $resolvedWork = [IO.Path]::GetFullPath($workDirectory)
  if (
    $resolvedWork.StartsWith("$temporaryRoot\", [StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path $resolvedWork -Leaf) -match "^portal-r4-029-[0-9a-f]{8}$"
  ) {
    Remove-Item -LiteralPath $resolvedWork -Recurse -Force
  }
}
