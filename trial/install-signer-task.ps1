# trial/install-signer-task.ps1
# Registers a Windows scheduled task that runs the trial signer every few
# minutes on this PC, so trial keys get signed + emailed even if the terminal
# is closed.
#
# It writes the secrets you pass to trial/signer.env.json (gitignored), so they
# never end up in the scheduled task definition itself.
#
# Usage (PowerShell, from the project root):
#   .\trial\install-signer-task.ps1 -SignerToken "SECRET" `
#       -ResendApiKey "re_xxx" `
#       -ServerUrl "https://mizan-suite.onrender.com" `
#       -NotifyEmail "mizansuite@gmail.com"
#
# To uninstall:  Unregister-ScheduledTask -TaskName "MizanTrialSigner" -Confirm:$false

param(
  [string]$ServerUrl = "http://localhost:3000",
  [string]$SignerToken,
  [string]$ResendApiKey,
  [string]$NotifyEmail = "mizansuite@gmail.com",
  [int]$EveryMinutes = 5
)

$ErrorActionPreference = "Stop"

if (-not $SignerToken) { throw "Missing -SignerToken (must match MIZAN_SIGNER_TOKEN on your public server)." }
if (-not $ResendApiKey) { throw "Missing -ResendApiKey (free key from resend.com)." }

$Root = Split-Path -Parent $PSScriptRoot
$SignerJs = Join-Path $PSScriptRoot "signer.js"
$EnvFile = Join-Path $PSScriptRoot "signer.env.json"

# Load existing env file (if any) and overlay the new values.
$envObj = @{}
if (Test-Path -LiteralPath $EnvFile) {
  $envObj = Get-Content -LiteralPath $EnvFile -Raw | ConvertFrom-Json -AsHashtable
}
$envObj.MIZAN_SERVER = $ServerUrl
$envObj.MIZAN_SIGNER_TOKEN = $SignerToken
$envObj.RESEND_API_KEY = $ResendApiKey
$envObj.NOTIFY_EMAIL = $NotifyEmail
($envObj | ConvertTo-Json) | Set-Content -LiteralPath $EnvFile -Encoding UTF8
Write-Host "Wrote $EnvFile"

# Register the task. Runs `node trial/signer.js --once` every $EveryMinutes min.
$action = New-ScheduledTaskAction -Execute (Get-Command node).Source `
  -Argument "`"$SignerJs`" --once" `
  -WorkingDirectory $Root

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes) `
  -RepetitionDuration ([TimeSpan]::MaxValue)

$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 2)

Register-ScheduledTask -TaskName "MizanTrialSigner" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Registered task 'MizanTrialSigner' (every $EveryMinutes minutes, as current user)."
Write-Host "Uninstall anytime with:  Unregister-ScheduledTask -TaskName 'MizanTrialSigner' -Confirm:`$false"

# Run once immediately so you can see it work.
Write-Host "Running once now..."
& (Get-Command node).Source $SignerJs --once
