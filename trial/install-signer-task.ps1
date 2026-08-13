# trial/install-signer-task.ps1
# Registers a Windows scheduled task that runs the trial signer every few
# minutes on this PC, WITHOUT opening a console window each time.
#
# It writes the secrets you pass to trial/signer.env.json.enc (DPAPI-encrypted,
# gitignored, decryptable only by this Windows account), so they never end up in
# the scheduled task definition or in plaintext on disk. If you already ran this
# before, the existing secrets in signer.env.json.enc are reused - just pass the
# value you want to change (usually -ServerUrl).
#
# Usage (PowerShell, from the project root):
#   .\trial\install-signer-task.ps1 -ServerUrl "https://mizan-suite.onrender.com"
#
# Full first-time usage:
#   .\trial\install-signer-task.ps1 -SignerToken "SECRET" `
#       -ResendApiKey "re_xxx" `
#       -ServerUrl "https://mizan-suite.onrender.com" `
#       -NotifyEmail "mizansuite@gmail.com"
#
# To uninstall:  Unregister-ScheduledTask -TaskName "MizanTrialSigner" -Confirm:$false

param(
  [string]$ServerUrl,
  [string]$SignerToken,
  [string]$ResendApiKey,
  [string]$NotifyEmail,
  [int]$EveryMinutes = 5
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$SignerJs = Join-Path $PSScriptRoot "signer.js"
$EnvEnc = Join-Path $PSScriptRoot "signer.env.json.enc"
$VbsFile = Join-Path $PSScriptRoot "run-signer-hidden.vbs"
$Dpapi = Join-Path $PSScriptRoot "dpapi.ps1"

# Load existing secrets (decrypt the DPAPI file if present) and use as the base.
$envObj = @{}
$tmpPlain = Join-Path $env:TEMP ("signer-env-" + [guid]::NewGuid().ToString("N") + ".json")
if (Test-Path -LiteralPath $EnvEnc) {
  try {
    $dec = & powershell -NoProfile -ExecutionPolicy Bypass -File $Dpapi -Action decrypt -Path $EnvEnc 2>$null
    $obj = $dec | ConvertFrom-Json
    $obj.PSObject.Properties | ForEach-Object { $envObj[$_.Name] = $_.Value }
  } catch { throw "Could not decrypt existing $EnvEnc - re-pass -SignerToken/-ResendApiKey." }
}
if ($ServerUrl) { $envObj.MIZAN_SERVER = $ServerUrl }
if ($SignerToken) { $envObj.MIZAN_SIGNER_TOKEN = $SignerToken }
if ($ResendApiKey) { $envObj.RESEND_API_KEY = $ResendApiKey }
if ($NotifyEmail) { $envObj.NOTIFY_EMAIL = $NotifyEmail }

if (-not $envObj.MIZAN_SIGNER_TOKEN) { throw "No -SignerToken and none stored in signer.env.json.enc." }
if (-not $envObj.RESEND_API_KEY) { throw "No -ResendApiKey and none stored in signer.env.json.enc." }
if (-not $envObj.MIZAN_SERVER) { $envObj.MIZAN_SERVER = "http://localhost:3000" }
if (-not $envObj.NOTIFY_EMAIL) { $envObj.NOTIFY_EMAIL = "mizansuite@gmail.com" }

# Write secrets to a temp plaintext file, DPAPI-encrypt it, then delete temp.
($envObj | ConvertTo-Json) | Set-Content -LiteralPath $tmpPlain -Encoding UTF8
& powershell -NoProfile -ExecutionPolicy Bypass -File $Dpapi -Action encrypt -Path $tmpPlain -Destination $EnvEnc 2>$null
if (-not $?) { throw "DPAPI encryption failed - secrets NOT saved." }
Remove-Item -LiteralPath $tmpPlain -Force -ErrorAction SilentlyContinue
Write-Host "Wrote $EnvEnc (DPAPI-encrypted)"

# Hidden launcher: wscript runs node with no console window.
$nodeExe = (Get-Command node).Source
$cmd = '"' + $nodeExe + '" "' + $SignerJs + '" --once'
$vbsQuoted = $cmd.Replace('"', '""')
$vbs = 'Set ws = CreateObject("Wscript.Shell")' + [Environment]::NewLine +
       'ws.Run "' + $vbsQuoted + '", 0, True'
Set-Content -LiteralPath $VbsFile -Value $vbs -Encoding ASCII
Write-Host "Wrote $VbsFile"
Write-Host "Hidden launcher command: $cmd"

# Register the task to run the hidden VBS launcher.
$action = New-ScheduledTaskAction -Execute "wscript.exe" `
  -Argument "`"$VbsFile`"" `
  -WorkingDirectory $PSScriptRoot

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

Register-ScheduledTask -TaskName "MizanTrialSigner" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered task 'MizanTrialSigner' (every $EveryMinutes minutes, hidden)."
Write-Host "Uninstall anytime with:  Unregister-ScheduledTask -TaskName 'MizanTrialSigner' -Confirm:`$false"
