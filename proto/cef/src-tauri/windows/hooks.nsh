; Installer hooks for the CEF shell prototype (proto/README.md, "Windows").
;
; The Tauri NSIS template includes this file near its top and calls the
; NSIS_HOOK_* macros from its Install and Uninstall sections. The job here is
; the move-over from the electron-builder per-user install of the same
; product, the way electron-updater drives it:
;
;   SeuOffice-Setup-0.13.0.exe --updated /S --force-run
;
; Tauri's template knows /P /NS /UPDATE /R; --updated and --force-run reach it
; as unknown words on $CMDLINE, which this file reads itself.
;
;  * the electron-builder install is the HKCU Uninstall key whose DisplayName
;    starts with the product name ("SeuOffice 0.12.37") and whose name is not
;    the one Tauri writes (Uninstall\SeuOffice); the folder of its
;    uninstaller (it records no InstallLocation) is where we install
;  * its own uninstaller removes the Electron files and the registrations it
;    wrote (/KEEP_APP_DATA: %APPDATA%\seuoffice is the userData folder and is
;    never touched here), then the old uninstall key is gone and Tauri writes
;    Uninstall\SeuOffice, so the Apps list shows SeuOffice once
;  * file associations come from tauri.conf.json (ProgIds seuoffice.WordDocument
;    and friends, the same ids apps/shell/electron-builder.cjs winProgId
;    makes); the Capabilities block below is the part of
;    apps/shell/build/installer.nsh that Default apps needs for them

!define SEUOFFICE_UNINSTALL_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"
!define SEUOFFICE_CAPABILITIES_KEY "Software\seuoffice\Capabilities"

Var ElectronKey
Var ElectronDir
Var ElectronOwnUninstaller

!macro NSIS_HOOK_PREINSTALL
  ; electron-updater's flags
  ClearErrors
  ${GetOptions} $CMDLINE "--updated" $0
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  ; find the electron-builder install
  StrCpy $ElectronKey ""
  StrCpy $ElectronDir ""
  StrCpy $0 0
  electron_scan:
    EnumRegKey $1 HKCU "${SEUOFFICE_UNINSTALL_ROOT}" $0
    StrCmp $1 "" electron_scan_done
    IntOp $0 $0 + 1
    StrCmp $1 "${PRODUCTNAME}" electron_scan
    ; electron-builder names the entry "<product> <version>"
    ReadRegStr $2 HKCU "${SEUOFFICE_UNINSTALL_ROOT}\$1" "DisplayName"
    StrLen $4 "${PRODUCTNAME}"
    StrCpy $2 $2 $4
    StrCmp $2 "${PRODUCTNAME}" 0 electron_scan
    ReadRegStr $3 HKCU "${SEUOFFICE_UNINSTALL_ROOT}\$1" "InstallLocation"
    StrCmp $3 "" 0 electron_have_dir
    ; electron-builder's entry has no InstallLocation: the folder is where its
    ; uninstaller, "<folder>\Uninstall SeuOffice.exe" /currentuser, lives
    ReadRegStr $3 HKCU "${SEUOFFICE_UNINSTALL_ROOT}\$1" "UninstallString"
    StrCpy $4 $3 1
    StrCmp $4 '"' 0 +2
      StrCpy $3 $3 "" 1
    ${StrLoc} $5 $3 "\Uninstall ${PRODUCTNAME}.exe" ">"
    StrCmp $5 "" electron_scan
    StrCpy $3 $3 $5
    electron_have_dir:
    ; a quoted value (Tauri's own key writes InstallLocation quoted)
    StrCpy $4 $3 1
    StrCmp $4 '"' 0 +3
      StrCpy $3 $3 "" 1
      StrCpy $3 $3 -1
    StrCpy $ElectronKey $1
    StrCpy $ElectronDir $3
    Goto electron_scan_done
  electron_scan_done:

  StrCmp $ElectronDir "" electron_done

  DetailPrint "Taking over the electron-builder install in $ElectronDir"
  ; the running Electron app holds SeuOffice.exe in that folder
  !insertmacro CheckIfAppIsRunning "$ElectronDir\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"

  StrCpy $ElectronOwnUninstaller "$ElectronDir\Uninstall ${PRODUCTNAME}.exe"
  ${If} ${FileExists} "$ElectronOwnUninstaller"
    ; what electron-builder's own installer runs when it replaces an install
    ${If} $UpdateMode = 1
      ExecWait '"$ElectronOwnUninstaller" /S /KEEP_APP_DATA --updated _?=$ElectronDir' $0
    ${Else}
      ExecWait '"$ElectronOwnUninstaller" /S /KEEP_APP_DATA _?=$ElectronDir' $0
    ${EndIf}
    DetailPrint "Electron uninstaller exit code $0"
    Delete "$ElectronOwnUninstaller"
    ; the folder is ours now: whatever the uninstaller left of the Electron payload goes
    RMDir /r "$ElectronDir"
  ${EndIf}
  ; the old key, if its uninstaller did not remove it
  DeleteRegKey HKCU "${SEUOFFICE_UNINSTALL_ROOT}\$ElectronKey"

  ; install where the Electron app was, not in the Tauri default
  StrCmp $INSTDIR $ElectronDir electron_redirected
    RMDir "$INSTDIR"
    StrCpy $INSTDIR $ElectronDir
  electron_redirected:
  CreateDirectory "$INSTDIR"
  SetOutPath $INSTDIR
  electron_done:
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ; Default apps: the ProgIds the file associations above registered
  WriteRegStr SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}" "${SEUOFFICE_CAPABILITIES_KEY}"
  WriteRegStr SHCTX "${SEUOFFICE_CAPABILITIES_KEY}" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHCTX "${SEUOFFICE_CAPABILITIES_KEY}" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr SHCTX "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".docx" "seuoffice.WordDocument"
  WriteRegStr SHCTX "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".xlsx" "seuoffice.ExcelWorkbook"
  WriteRegStr SHCTX "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".pptx" "seuoffice.PowerPointPresentation"

  ; --force-run: open the app after the install (electron-updater's silent update)
  ClearErrors
  ${GetOptions} $CMDLINE "--force-run" $0
  ${IfNot} ${Errors}
    ${If} $UpdateMode = 1
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "--updated"
    ${Else}
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegValue SHCTX "Software\RegisteredApplications" "${PRODUCTNAME}"
  DeleteRegKey SHCTX "${SEUOFFICE_CAPABILITIES_KEY}"
  DeleteRegKey /ifempty SHCTX "Software\seuoffice"
!macroend
