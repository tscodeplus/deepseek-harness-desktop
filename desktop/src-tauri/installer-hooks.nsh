; NSIS hooks for the DeepSeek Harness Desktop installer/uninstaller.
; Referenced from tauri.conf.json > bundle > windows > nsis > installerHooks
; and !included at the top of tauri's installer.nsi.
;
; User-data protection: the stock uninstaller shows a "Delete app data"
; checkbox that (when checked) recursively removes $APPDATA\<bundleid> and
; $LOCALAPPDATA\<bundleid>. All real user data (dsh profiles, storages,
; .credentials.yaml, desktop-config.json) lives OUTSIDE the install dir under
; %APPDATA%\DeepSeek Harness (the shell passes it as DSHD_HOME/DSH_HOME), but
; force the checkbox state to 0 in NSIS_HOOK_PREUNINSTALL so no selection can
; ever wipe app data during uninstall — "keep user data" is the only behavior.

!define NSIS_HOOK_PREUNINSTALL "NSIS_HOOK_PREUNINSTALL_"
!macro NSIS_HOOK_PREUNINSTALL_
  StrCpy $DeleteAppDataCheckboxState 0
!macroend
