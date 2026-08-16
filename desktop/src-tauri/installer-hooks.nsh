; NSIS hooks for the DeepSeek Harness Desktop installer/uninstaller.
; Referenced from tauri.conf.json > bundle > windows > nsis > installerHooks
; and included at the top of tauri's installer.nsi.
;
; Uninstall behavior: the stock uninstaller always shows a "Delete app data"
; checkbox (default unchecked) that clears %APPDATA%/<bundleid> when checked.
; All real user data lives at the upstream dsh home ~/.dsh (passed to dsh as
; DSH_HOME), which the stock checkbox does NOT remove. When the user
; explicitly checks the box, also remove ~/.dsh so "delete user data"
; actually removes the data. Unchecked (the default) → kept.

!define NSIS_HOOK_PREUNINSTALL "NSIS_HOOK_PREUNINSTALL_"
!macro NSIS_HOOK_PREUNINSTALL_
  ; $DeleteAppDataCheckboxState is set by un.ConfirmLeave (BM_GETCHECK).
  ; Skip on updates (the installer re-runs this section in update mode).
  StrCmp $UpdateMode 1 dshd_nodata
  StrCmp $DeleteAppDataCheckboxState 1 dshd_del dshd_nodata
  dshd_del:
    ReadEnvStr $0 "USERPROFILE"
    StrCmp $0 "" dshd_nodata
    RmDir /r "$0\.dsh"
  dshd_nodata:
!macroend
