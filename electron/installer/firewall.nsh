; firewall.nsh - NSIS macros included by electron-builder (build.nsis.include).
; Adds an inbound firewall rule for the phone HTTPS port (3443) so a phone on
; the same network can reach the app even on "Public" network profiles.
; Requires the installer to run elevated (build.nsis.requestedExecutionLevel).

!macro customInstall
  ; Remove any previous version of the rule first (keeps installs idempotent).
  ExecWait '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="MIZAN Phone HTTPS"'
  ExecWait '"$SYSDIR\netsh.exe" advfirewall firewall add rule name="MIZAN Phone HTTPS" dir=in action=allow protocol=TCP localport=3443 profile=any'
!macroend

!macro customUnInstall
  ExecWait '"$SYSDIR\netsh.exe" advfirewall firewall delete rule name="MIZAN Phone HTTPS"'
!macroend
