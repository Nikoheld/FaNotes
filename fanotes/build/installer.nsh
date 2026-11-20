; electron-builder includes build/installer.nsh in the FaNotes NSIS installer.
;
; Uninstalling FaNotes removes the per-user Scheduled Task that runs
; `FaNotes.exe --background-update`. The name matches windowsTaskName() in
; electron/update-scheduler.cjs. An update (`--updated`) runs the previous
; uninstaller too; the task stays then, and the new version refreshes it on
; its next start.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    ReadEnvStr $0 USERNAME
    nsExec::Exec 'schtasks.exe /Delete /TN "FaNotes Background Update ($0)" /F'
    Pop $0
  ${endIf}
!macroend
