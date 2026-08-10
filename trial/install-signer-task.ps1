# trial/install-signer-task.ps1
# Registers a Windows scheduled task that runs the trial signer every few
# minutes on this PC, WITHOUT opening a console window each time.
#
# It writes the secrets you pass to trial/signer.env.json (gitignored), so they
# never end up in the scheduled task definition itself. If you already ran this
# before, the existing secrets in signer.env.json are reused - just pass the
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
$EnvFile = Join-Path $PSScriptRoot "signer.env.json"
$VbsFile = Join-Path $PSScriptRoot "run-signer-hidden.vbs"

# Load existing env file (if any) and use it as the base.
$envObj = @{}
if (Test-Path -LiteralPath $EnvFile) {
  $obj = Get-Content -LiteralPath $EnvFile -Raw | ConvertFrom-Json
  $obj.PSObject.Properties | ForEach-Object { $envObj[$_.Name] = $_.Value }
}
if ($ServerUrl) { $envObj.MIZAN_SERVER = $ServerUrl }
if ($SignerToken) { $envObj.MIZAN_SIGNER_TOKEN = $SignerToken }
if ($ResendApiKey) { $envObj.RESEND_API_KEY = $ResendApiKey }
if ($NotifyEmail) { $envObj.NOTIFY_EMAIL = $NotifyEmail }

if (-not $envObj.MIZAN_SIGNER_TOKEN) { throw "No -SignerToken and none stored in signer.env.json." }
if (-not $envObj.RESEND_API_KEY) { throw "No -ResendApiKey and none stored in signer.env.json." }
if (-not $envObj.MIZAN_SERVER) { $envObj.MIZAN_SERVER = "http://localhost:3000" }
if (-not $envObj.NOTIFY_EMAIL) { $envObj.NOTIFY_EMAIL = "mizansuite@gmail.com" }

($envObj | ConvertTo-Json) | Set-Content -LiteralPath $EnvFile -Encoding UTF8
Write-Host "Wrote $EnvFile"

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
