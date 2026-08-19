; NSIS hooks for the DeepSeek Harness Desktop installer/uninstaller.
; Referenced from tauri.conf.json > bundle > windows > nsis > installerHooks
; and included at the top of tauri's installer.nsi.
;
; Engine reset policy: the engine (~/.dsh/engine, ~184MB) is a regenerable
; seed closure — the installer ships a copy and the sidecar re-seeds on first
; launch. It is removed on EVERY install AND uninstall so a leftover engine
; can never pin ~184MB on disk and a re-install always makes the bundled seed
; authoritative again (a re-install previously kept a stale, user-updated
; engine). User data (profiles/storages/credentials under ~/.dsh) is
; untouched here.
;
; Uninstall behavior: the stock uninstaller always shows a "Delete app data"
; checkbox (default unchecked) that clears %APPDATA%/<bundleid> when checked.
; All real user data lives at the upstream dsh home ~/.dsh (passed to dsh as
; DSH_HOME), which the stock checkbox does NOT remove. When the user
; explicitly checks the box, also remove ~/.dsh so "delete user data"
; actually removes the data. Unchecked (the default) → kept.

; Runs at the END of the install section — fresh install, update-mode
; re-install AND Modify/Repair all take this path. The template's
; CheckIfAppIsRunning runs earlier in the section and prompts/kills a running
; app, so ~/.dsh/engine is not file-locked here (a lock would make RmDir
; silently fail and the stale engine would survive — the bug this fixes).
;
; IMPORTANT: the macro name must be exactly NSIS_HOOK_POSTINSTALL. The
; generated template guards the call site with `!ifmacrodef
; NSIS_HOOK_POSTINSTALL`, which only detects `!macro` definitions — NOT
; `!define` constants. The previous `!define NSIS_HOOK_POSTINSTALL "…_"`
; + `!macro …_` indirection was silently dead: !ifmacrodef evaluated
; false, so the hook never compiled into the installer at all (verified
; with makensis /V4 on a probe script; a stale engine survived re-install
; because the hook was absent, not because RmDir failed).
!macro NSIS_HOOK_POSTINSTALL
  ReadEnvStr $0 "USERPROFILE"
  StrCmp $0 "" dshd_inst_done
  RmDir /r "$0\.dsh\engine"
  dshd_inst_done:
!macroend

; Same naming rule as NSIS_HOOK_POSTINSTALL above: the template's
; `!ifmacrodef NSIS_HOOK_PREUNINSTALL` only matches a `!macro` definition.
!macro NSIS_HOOK_PREUNINSTALL
  ; The engine (dsh runtime closure at ~/.dsh/engine) is regenerable — the
  ; installer ships a seed copy and the sidecar re-seeds on first run. Always
  ; remove it on uninstall (and on update-mode re-install, which also runs
  ; this macro), so a leftover engine can never pin ~184MB on disk. User data
  ; (profiles/storages/credentials under ~/.dsh) is untouched here.
  ReadEnvStr $0 "USERPROFILE"
  StrCmp $0 "" dshd_engine_done
  RmDir /r "$0\.dsh\engine"
  dshd_engine_done:
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
