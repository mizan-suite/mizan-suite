param(
  [Parameter(Mandatory = $true)][string]$Action,
  [Parameter(Mandatory = $true)][string]$Path,
  [string]$Destination
)
# trial/dpapi.ps1 - Encrypts/decrypts a file with Windows DPAPI, scoped to the
# current user account. Plaintext is NEVER written to disk by this helper.
# Usage:
#   powershell -File trial/dpapi.ps1 -Action encrypt -Path signer.env.json
#   powershell -File trial/dpapi.ps1 -Action encrypt -Path tmp.json -Destination signer.env.json.enc
#   powershell -File trial/dpapi.ps1 -Action decrypt -Path signer.env.json.enc
# Decrypt writes the plaintext to stdout ONLY (callers capture it in memory).
Add-Type -AssemblyName System.Security

function Encrypt-File([string]$src, [string]$dst) {
  $bytes = [System.IO.File]::ReadAllBytes($src)
  $prot = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  [System.IO.File]::WriteAllBytes($dst, $prot)
  Write-Host "Encrypted $src -> $dst"
}

function Decrypt-ToStdout([string]$src) {
  $bytes = [System.IO.File]::ReadAllBytes($src)
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
  $stdout = [Console]::OpenStandardOutput()
  $stdout.Write($plain, 0, $plain.Length)
  $stdout.Flush()
  $stdout.Close()
}

if ($Action -eq 'encrypt') {
  $dst = if ($Destination) { $Destination } elseif ($Path -match '\.enc$') { $Path } else { "$Path.enc" }
  Encrypt-File $Path $dst
} elseif ($Action -eq 'decrypt') {
  Decrypt-ToStdout $Path
} else {
  Write-Error "Unknown -Action '$Action' (use encrypt|decrypt)"
  exit 1
}
