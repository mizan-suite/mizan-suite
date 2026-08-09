@echo off
rem MIZAN License Dashboard - show this PC's Machine ID (no install needed)
rem Send the two lines below to your software provider.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$g=(Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid).MachineGuid; $h=[System.BitConverter]::ToString([System.Security.Cryptography.SHA256]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($g.ToLower()))).Replace('-','').ToLower(); Write-Host ''; Write-Host 'Machine ID:  ' $h; Write-Host 'PC name:     ' $env:COMPUTERNAME; Write-Host ''"
echo.
pause
