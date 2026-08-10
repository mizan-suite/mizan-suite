# Mizan Suite disaster-recovery backup
# Copies master + trial private keys, the issued-license ledger, and the
# pharmacy database into an AES-256 encrypted archive on the backup drive.
#
# Usage:  powershell -ExecutionPolicy Bypass -File backup-to-h.ps1
#
# Restore on a new PC:
#   openssl enc -d -aes-256-cbc -pbkdf2 -in <archive>.tar.enc -out backup.tar
#   tar -xf backup.tar

param(
  # For headless/automated runs only. If omitted, the script reads
  # backup.env.json (gitignored) or prompts securely.
  [string]$Password = ''
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$backupDir = 'H:\MizanSuiteBackup'
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$tarPath = Join-Path $env:TEMP "mizan-backup-$stamp.tar"
$encPath = Join-Path $backupDir "mizan-backup-$stamp.tar.enc"

if (-not (Test-Path $backupDir)) {
  New-Item -ItemType Directory -Path $backupDir | Out-Null
}

# Optional: keep only the N most recent archives so the drive doesn't fill up.
$KEEP = 10
Get-ChildItem -Path $backupDir -Filter 'mizan-backup-*.tar.enc' -ErrorAction SilentlyContinue |
  Sort-Object Name -Descending | Select-Object -Skip $KEEP | Remove-Item -Force

$openssl = 'C:\Program Files\Git\usr\bin\openssl.exe'
if (-not (Test-Path $openssl)) {
  throw "openssl not found at $openssl"
}

# Collect the files that must survive a hard drive / PC failure.
$items = @()
$items += @{
  Source = Join-Path $root 'license-tools\private.key'
  Target = 'license-tools/private.key'
}
$items += @{
  Source = Join-Path $root 'license-tools\trial-private.key'
  Target = 'license-tools/trial-private.key'
}
$items += @{
  Source = Join-Path $root 'license-tools\licenses.json'
  Target = 'license-tools/licenses.json'
}
$items += @{
  Source = Join-Path $root 'license-tools\public.key'
  Target = 'license-tools/public.key'
}
$items += @{
  Source = Join-Path $root 'license-tools\trial-public.key'
  Target = 'license-tools/trial-public.key'
}
$items += @{
  Source = Join-Path $root 'mizan.db'
  Target = 'mizan.db'
}

$missing = $items | Where-Object { -not (Test-Path $_.Source) }
if ($missing) {
  Write-Host 'Skipping missing files:'
  $missing | ForEach-Object { Write-Host "  $($_.Source)" }
  $items = $items | Where-Object { Test-Path $_.Source }
}
if (-not $items) {
  throw 'No source files found - nothing to back up.'
}

# Build a flat staging folder with the archive's internal layout.
$stage = Join-Path $env:TEMP "mizan-stage-$stamp"
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($item in $items) {
  $dest = Join-Path $stage ($item.Target -replace '/', '\')
  New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
  Copy-Item -LiteralPath $item.Source -Destination $dest -Force
}

try {
  & tar -C $stage -cf $tarPath (Get-ChildItem $stage | ForEach-Object { $_.Name })
  if (-not $?) { throw 'tar failed' }

  if ($Password) {
    $pass = $Password
  } else {
    $pass = ''
    $envFile = Join-Path $PSScriptRoot 'backup.env.json'
    if (Test-Path $envFile) {
      $raw = Get-Content -LiteralPath $envFile -Raw
      if ($raw) {
        try {
          $parsed = $raw | ConvertFrom-Json
          $pass = [string]$parsed.BACKUP_PASSWORD
        } catch {
          Write-Host 'backup.env.json could not be parsed - ignoring.' -ForegroundColor Yellow
          $pass = ''
        }
      }
    }
    if (-not $pass) {
      $password = Read-Host -AsSecureString 'Backup password (keep it safe - required to restore)'
      $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($password)
      try {
        $pass = [System.Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
      } finally {
        [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
      }
    }
  }
  if (-not $pass) { throw 'No password given - aborting.' }

  & $openssl enc -aes-256-cbc -pbkdf2 -salt -pass "pass:$pass" -in $tarPath -out $encPath
  if (-not $?) { throw 'openssl encryption failed' }

  $size = [math]::Round((Get-Item $encPath).Length / 1KB, 1)
  Write-Host "Backup written: $encPath ($size KB)"
  Write-Host 'Keep this archive somewhere safe. The password is required to restore.'
} finally {
  Remove-Item -LiteralPath $tarPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
}
