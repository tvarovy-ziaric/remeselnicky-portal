[CmdletBinding()]
param(
  [Parameter(Mandatory)]
  [ValidateSet("init","start","stop","status","logs","restart","update","rollback","backup","restore-clone","tunnel-start","tunnel-stop","quick-start","quick-stop","config")]
  [string]$Action,
  [string]$AppHostname = "alpha.invalid",
  [string]$ObjectHostname = "objects-alpha.invalid",
  [string]$BackupId
)

$ErrorActionPreference = "Stop"
$env:COMPOSE_PROGRESS = "plain"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$compose = Join-Path $repo "compose.alpha.yaml"
$environment = Join-Path $repo ".env.alpha"
$state = Join-Path $repo ".alpha"
$backupRoot = Join-Path $repo "backups\alpha"

function Invoke-Compose([string[]]$Arguments, [switch]$AllowFailure) {
  & docker compose --env-file $environment --file $compose @Arguments
  if (-not $AllowFailure -and $LASTEXITCODE -ne 0) {
    throw "Docker Compose command failed."
  }
}

function Build-Images([string[]]$Services) {
  foreach ($service in $Services) {
    Invoke-Compose @("build", $service)
  }
}

function Build-IfMissing([string]$Service, [string]$Image) {
  & docker image inspect $Image *> $null
  if ($LASTEXITCODE -ne 0) {
    Invoke-Compose @("build", $Service)
  }
}

function Assert-Initialized {
  if (-not (Test-Path -LiteralPath $environment) -or -not (Test-Path -LiteralPath (Join-Path $state "secrets\session_secret"))) {
    throw "Run Alpha.ps1 -Action init first."
  }
}

function Get-Release {
  $line = Get-Content -LiteralPath $environment | Where-Object { $_ -like "ALPHA_RELEASE_REVISION=*" } | Select-Object -First 1
  if ($null -eq $line) { throw "ALPHA_RELEASE_REVISION is missing." }
  return $line.Substring("ALPHA_RELEASE_REVISION=".Length)
}

function Set-Release([string]$Revision) {
  $lines = Get-Content -LiteralPath $environment
  $updated = $lines | ForEach-Object { if ($_ -like "ALPHA_RELEASE_REVISION=*") { "ALPHA_RELEASE_REVISION=$Revision" } else { $_ } }
  [IO.File]::WriteAllLines($environment, $updated, [Text.UTF8Encoding]::new($false))
}

function Assert-BackupId([string]$Id) {
  if ($Id.Length -gt 100 -or $Id -notmatch '^[A-Za-z0-9][A-Za-z0-9_-]*$') {
    throw "BackupId must be 1-100 ASCII letters, digits, hyphens or underscores and start with a letter or digit."
  }
}

function Get-RestoreSuffix([string]$Id) {
  $digest = [Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Id))
  return [Convert]::ToHexString($digest).ToLowerInvariant().Substring(0, 20)
}

function Wait-QuickHostname([string]$Service) {
  for ($attempt = 0; $attempt -lt 45; $attempt++) {
    $logs = (& docker compose --env-file $environment --file $compose logs --no-color --tail 80 $Service 2>&1 | Out-String)
    $matches = [regex]::Matches($logs, 'https://([a-z0-9-]+\.trycloudflare\.com)')
    if ($matches.Count -gt 0) {
      return $matches[$matches.Count - 1].Groups[1].Value
    }
    Start-Sleep -Seconds 2
  }
  throw "Cloudflare did not issue a Quick Tunnel hostname for $Service."
}

function Set-AlphaHostnames([string]$AppHost, [string]$ObjectHost) {
  $lines = Get-Content -LiteralPath $environment
  if (($lines | Where-Object { $_ -like 'ALPHA_APP_HOSTNAME=*' }).Count -ne 1 -or
      ($lines | Where-Object { $_ -like 'ALPHA_OBJECT_HOSTNAME=*' }).Count -ne 1) {
    throw "Alpha hostname configuration is incomplete."
  }
  $updated = $lines | ForEach-Object {
    if ($_ -like 'ALPHA_APP_HOSTNAME=*') { "ALPHA_APP_HOSTNAME=$AppHost" }
    elseif ($_ -like 'ALPHA_OBJECT_HOSTNAME=*') { "ALPHA_OBJECT_HOSTNAME=$ObjectHost" }
    else { $_ }
  }
  [IO.File]::WriteAllLines($environment, $updated, [Text.UTF8Encoding]::new($false))
}

switch ($Action) {
  "init" {
    & (Join-Path $PSScriptRoot "Initialize-Alpha.ps1") -AppHostname $AppHostname -ObjectHostname $ObjectHostname
    break
  }
  "config" {
    Assert-Initialized
    Invoke-Compose @("config", "--quiet")
    Write-Host "Compose configuration is structurally valid."
    break
  }
  "start" {
    Assert-Initialized
    Invoke-Compose @("config", "--quiet")
    Build-IfMissing "postgres" "remeselnicky-alpha-postgres:latest"
    Build-IfMissing "minio" "remeselnicky-alpha-minio:RELEASE.2025-10-15T17-29-55Z"
    Build-IfMissing "minio-init" "remeselnicky-alpha-mc:RELEASE.2025-08-13T08-35-41Z"
    Build-Images -Services @("api", "worker", "web")
    Invoke-Compose @("up", "--detach", "--no-build")
    Invoke-Compose @("ps")
    break
  }
  "stop" {
    Assert-Initialized
    Invoke-Compose @("--profile", "quick", "stop", "quick-app", "quick-object") -AllowFailure
    Invoke-Compose @("--profile", "tunnel", "stop", "cloudflared") -AllowFailure
    Invoke-Compose @("stop")
    break
  }
  "status" {
    Assert-Initialized
    Invoke-Compose @("--profile", "quick", "--profile", "tunnel", "ps", "--all")
    break
  }
  "logs" {
    Assert-Initialized
    $output = & docker compose --env-file $environment --file $compose logs --no-color --tail 300 2>&1
    $output | ForEach-Object {
      $_ -replace '(?i)(authorization|password|secret|token)([=: ]+)[^ ]+', '$1$2[REDACTED]' `
         -replace '(?i)(X-Amz-(?:Credential|Signature|Security-Token))=[^& ]+', '$1=[REDACTED]'
    }
    break
  }
  "restart" {
    Assert-Initialized
    Invoke-Compose @("restart", "api", "worker", "web", "reverse-proxy")
    break
  }
  "update" {
    Assert-Initialized
    $previous = Get-Release
    $baseRevision = (& git -C $repo rev-parse --short=12 HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw "Cannot determine current Git revision." }
    $worktreeChanges = (& git -C $repo status --porcelain | Out-String)
    if ($LASTEXITCODE -ne 0) { throw "Cannot determine worktree status." }
    $worktreeMarker = if ([string]::IsNullOrWhiteSpace($worktreeChanges)) { "" } else { "-worktree" }
    $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
    $nonce = [guid]::NewGuid().ToString("N").Substring(0, 8)
    $next = "$baseRevision$worktreeMarker-$stamp-$nonce"
    [IO.File]::WriteAllText((Join-Path $state "previous-release"), $previous, [Text.UTF8Encoding]::new($false))
    Set-Release $next
    try {
      Build-Images -Services @("api", "worker", "web")
      Invoke-Compose @("up", "--detach", "--no-build")
      # Nginx resolves upstream service addresses at startup; Compose may replace
      # web/API containers without recreating the proxy, leaving stale addresses.
      Invoke-Compose @("restart", "reverse-proxy")
    } catch {
      Set-Release $previous
      throw
    }
    break
  }
  "rollback" {
    Assert-Initialized
    $previousPath = Join-Path $state "previous-release"
    if (-not (Test-Path -LiteralPath $previousPath)) { throw "No previous alpha image revision is recorded." }
    $previous = (Get-Content -LiteralPath $previousPath -Raw).Trim()
    foreach ($image in @("api","worker","web")) {
      & docker image inspect "remeselnicky-alpha-$image`:$previous" *> $null
      if ($LASTEXITCODE -ne 0) { throw "Rollback image remeselnicky-alpha-$image`:$previous is unavailable." }
    }
    Set-Release $previous
    Invoke-Compose @("up", "--detach", "--no-build")
    break
  }
  "tunnel-start" {
    Assert-Initialized
    $token = (Get-Content -LiteralPath (Join-Path $state "secrets\cloudflare_tunnel_token") -Raw).Trim()
    if ([string]::IsNullOrWhiteSpace($token)) { throw "Run Set-CloudflareSecrets.ps1 after creating the named tunnel." }
    $envText = Get-Content -LiteralPath $environment -Raw
    if ($envText -match '\.invalid(?:\r?\n|$)') { throw "Replace placeholder hostnames before enabling the public tunnel." }
    Invoke-Compose @("--profile", "tunnel", "up", "--detach", "cloudflared")
    break
  }
  "tunnel-stop" {
    Assert-Initialized
    Invoke-Compose @("--profile", "tunnel", "stop", "cloudflared") -AllowFailure
    break
  }
  "quick-start" {
    Assert-Initialized
    & (Join-Path $PSScriptRoot "Ensure-QuickGate.ps1")
    Invoke-Compose @("config", "--quiet")
    Invoke-Compose @("up", "--detach", "--no-build", "reverse-proxy")
    $previousEnvironment = [IO.File]::ReadAllText($environment)
    try {
      Invoke-Compose @("--profile", "quick", "up", "--detach", "--no-deps", "--force-recreate", "quick-app", "quick-object")
      $appHost = Wait-QuickHostname "quick-app"
      $objectHost = Wait-QuickHostname "quick-object"
      if ($appHost -eq $objectHost) { throw "Cloudflare returned duplicate Quick Tunnel hostnames." }
      Set-AlphaHostnames $appHost $objectHost
      Invoke-Compose @("up", "--detach", "--no-build", "--no-deps", "--force-recreate", "api", "worker", "reverse-proxy")
      Write-Host "Temporary app: https://$appHost"
      Write-Host "Temporary signed-object origin: https://$objectHost"
      Write-Host "The app requires username alpha and the password in .alpha/secrets/quick_gate_password. Quick Tunnel URLs change on restart."
    } catch {
      [IO.File]::WriteAllText($environment, $previousEnvironment, [Text.UTF8Encoding]::new($false))
      Invoke-Compose @("--profile", "quick", "stop", "quick-app", "quick-object") -AllowFailure
      Invoke-Compose @("up", "--detach", "--no-build", "--no-deps", "--force-recreate", "api", "worker", "reverse-proxy") -AllowFailure
      throw
    }
    break
  }
  "quick-stop" {
    Assert-Initialized
    Invoke-Compose @("--profile", "quick", "stop", "quick-app", "quick-object") -AllowFailure
    break
  }
  "backup" {
    Assert-Initialized
    if ([string]::IsNullOrWhiteSpace($BackupId)) { $BackupId = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ") }
    Assert-BackupId $BackupId
    $directory = Join-Path $backupRoot $BackupId
    if (Test-Path -LiteralPath $directory) { throw "BackupId already exists; choose a new ID to avoid overwriting a backup." }
    New-Item -ItemType Directory -Path $directory | Out-Null
    Invoke-Compose @("exec", "-T", "postgres", "pg_dump", "--username", "portal_alpha_owner", "--dbname", "portal_alpha", "--format", "custom", "--file", "/tmp/portal-alpha.dump")
    $postgresContainer = (& docker compose --env-file $environment --file $compose ps --quiet postgres).Trim()
    & docker cp "$postgresContainer`:/tmp/portal-alpha.dump" (Join-Path $directory "portal-alpha.dump")
    if ($LASTEXITCODE -ne 0) { throw "Database backup copy failed." }
    Invoke-Compose @("--profile", "ops", "run", "--rm", "-e", "ALPHA_STORAGE_ACTION=backup", "-e", "ALPHA_BACKUP_ID=$BackupId", "storage-maintenance")
    Write-Host "Backup created at $directory. Copy it off this notebook before relying on it."
    break
  }
  "restore-clone" {
    Assert-Initialized
    if ([string]::IsNullOrWhiteSpace($BackupId)) { throw "BackupId is required for restore-clone." }
    Assert-BackupId $BackupId
    $dump = Join-Path $backupRoot "$BackupId\portal-alpha.dump"
    if (-not (Test-Path -LiteralPath $dump)) { throw "Backup dump is unavailable." }
    $cloneSuffix = Get-RestoreSuffix $BackupId
    $clone = "portal_alpha_restore_$cloneSuffix"
    $postgresContainer = (& docker compose --env-file $environment --file $compose ps --quiet postgres).Trim()
    & docker cp $dump "$postgresContainer`:/tmp/portal-alpha-restore.dump"
    if ($LASTEXITCODE -ne 0) { throw "Database restore copy failed." }
    Invoke-Compose @("exec", "-T", "postgres", "createdb", "--username", "portal_alpha_owner", "--template", "template0", $clone)
    Invoke-Compose @("exec", "-T", "postgres", "pg_restore", "--username", "portal_alpha_owner", "--dbname", $clone, "/tmp/portal-alpha-restore.dump")
    Invoke-Compose @("--profile", "ops", "run", "--rm", "-e", "ALPHA_STORAGE_ACTION=restore-clone", "-e", "ALPHA_BACKUP_ID=$BackupId", "-e", "ALPHA_RESTORE_SUFFIX=$cloneSuffix", "storage-maintenance")
    Write-Host "Restore verified into isolated database $clone and clone buckets; active alpha data was not overwritten."
    break
  }
}
