[CmdletBinding()]
param(
  [string]$AppHostname = "alpha.invalid",
  [string]$ObjectHostname = "objects-alpha.invalid"
)

$ErrorActionPreference = "Stop"
$repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$state = Join-Path $repo ".alpha"
$secrets = Join-Path $state "secrets"
$tls = Join-Path $state "tls"
$minioTls = Join-Path $tls "minio"
$minioCas = Join-Path $minioTls "CAs"

New-Item -ItemType Directory -Force -Path $secrets,$tls,$minioTls,$minioCas | Out-Null

function New-HexSecret([int]$Bytes) {
  $buffer = [byte[]]::new($Bytes)
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($buffer)
  return [Convert]::ToHexString($buffer).ToLowerInvariant()
}

function Write-NewSecret([string]$Name, [int]$Bytes) {
  $path = Join-Path $secrets $Name
  if (-not (Test-Path -LiteralPath $path)) {
    [IO.File]::WriteAllText($path, (New-HexSecret $Bytes), [Text.UTF8Encoding]::new($false))
  }
}

Write-NewSecret "postgres_owner_password" 32
Write-NewSecret "postgres_app_password" 32
Write-NewSecret "minio_access_key" 16
Write-NewSecret "minio_secret_key" 32
Write-NewSecret "session_secret" 48
Write-NewSecret "synthetic_seed_password" 24
& (Join-Path $PSScriptRoot "Ensure-QuickGate.ps1")
$tunnelTokenPath = Join-Path $secrets "cloudflare_tunnel_token"
if (-not (Test-Path -LiteralPath $tunnelTokenPath)) {
  [IO.File]::WriteAllText($tunnelTokenPath, "", [Text.UTF8Encoding]::new($false))
}

$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if ($null -eq $openssl) {
  $gitOpenSsl = "C:\Program Files\Git\usr\bin\openssl.exe"
  if (-not (Test-Path -LiteralPath $gitOpenSsl)) {
    throw "OpenSSL is required to create local service TLS certificates."
  }
  $opensslPath = $gitOpenSsl
} else {
  $opensslPath = $openssl.Source
}

$caKey = Join-Path $tls "ca.key"
$caCrt = Join-Path $tls "ca.crt"
if (-not (Test-Path -LiteralPath $caCrt)) {
  & $opensslPath req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes `
    -subj "/CN=Remeselnicky Alpha Local CA" -keyout $caKey -out $caCrt
  if ($LASTEXITCODE -ne 0) { throw "Failed to generate the alpha CA." }
}

function New-ServiceCertificate([string]$Name, [string]$DnsName, [string]$KeyPath, [string]$CertPath) {
  if (Test-Path -LiteralPath $CertPath) { return }
  $csr = Join-Path $tls "$Name.csr"
  $extensions = Join-Path $tls "$Name.ext"
  [IO.File]::WriteAllText($extensions, "subjectAltName=DNS:$DnsName`nextendedKeyUsage=serverAuth`n", [Text.UTF8Encoding]::new($false))
  & $opensslPath req -new -newkey rsa:3072 -nodes -subj "/CN=$DnsName" -keyout $KeyPath -out $csr
  if ($LASTEXITCODE -ne 0) { throw "Failed to generate $Name CSR." }
  & $opensslPath x509 -req -sha256 -days 825 -in $csr -CA $caCrt -CAkey $caKey -CAcreateserial -extfile $extensions -out $CertPath
  if ($LASTEXITCODE -ne 0) { throw "Failed to sign $Name certificate." }
  Remove-Item -LiteralPath $csr,$extensions -Force
}

New-ServiceCertificate "postgres" "postgres" (Join-Path $tls "postgres.key") (Join-Path $tls "postgres.crt")
New-ServiceCertificate "minio" "minio" (Join-Path $minioTls "private.key") (Join-Path $minioTls "public.crt")
Copy-Item -LiteralPath $caCrt -Destination (Join-Path $minioCas "alpha-ca.crt") -Force

$revision = (& git -C $repo rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw "Cannot determine the alpha release revision." }
$environment = @"
ALPHA_APP_HOSTNAME=$AppHostname
ALPHA_OBJECT_HOSTNAME=$ObjectHostname
ALPHA_DIAGNOSTIC_PORT=8080
ALPHA_RELEASE_REVISION=$revision
PORTAL_POSTGRES_DB=portal_alpha
PORTAL_POSTGRES_USER=portal_alpha_owner
PORTAL_APP_DB_USER=portal_alpha_app
OBJECT_STORAGE_PRIVATE_CONTAINER=portal-alpha-private
OBJECT_STORAGE_PUBLIC_DERIVATIVE_CONTAINER=portal-alpha-public
OBJECT_STORAGE_REGION=eu-central-1
"@
[IO.File]::WriteAllText((Join-Path $repo ".env.alpha"), $environment, [Text.UTF8Encoding]::new($false))

Write-Host "Alpha local state initialized. Secrets were written only under .alpha/."
Write-Host "Hostnames: $AppHostname and $ObjectHostname"
