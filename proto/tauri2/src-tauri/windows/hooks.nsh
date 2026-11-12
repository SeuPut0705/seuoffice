; Takeover of an electron-builder per-user install by this NSIS installer (proto/README.md,
; "묶을 때"). Tauri's template calls the NSIS_HOOK_* macros below from its install and uninstall
; sections; nothing else of the template is changed.
;
;   * the Electron install is found through its uninstall key (HKCU\...\Uninstall\<guid>, the one
;     whose DisplayName starts with the product name, "SeuOffice 0.12.37") and this install goes into the same folder
;   * the Electron uninstaller runs first, silent and in place, the way electron-builder upgrades
;     itself (it unregisters the file types and the PATH entry and keeps %APPDATA%\seuoffice); what it
;     leaves of the Electron files is deleted by name
;   * the uninstall key keeps its Electron-time name, so the app list shows one SeuOffice, pointing at
;     this installer's uninstall.exe; Tauri's own key (Uninstall\<product name>) is folded into it
;   * .docx opens through seuoffice.WordDocument (the winProgId rule of electron-builder.cjs; the
;     association itself comes from bundle.fileAssociations) and the Default apps capabilities list it
;   * electron-updater starts this installer as `Setup.exe --updated /S --force-run`: NSIS takes /S,
;     --updated is ignored, --force-run starts the app after a silent install

!define SEU_UNINSTALL_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"
!define SEU_CAPABILITIES_KEY "Software\seuoffice\Capabilities"

; "" on a machine without the Electron build
Var SeuLegacyKey
Var SeuLegacyDir
; "1" while the key still belongs to the Electron installer, "" once an earlier run of this installer rewrote it
Var SeuLegacyIsElectron

; Push a value, call, Pop the same value without its surrounding double quotes.
Function SeuUnquote
  Exch $0
  Push $1
  StrCpy $1 $0 1
  StrCmp $1 "$\"" 0 +2
    StrCpy $0 $0 "" 1
  StrCpy $1 $0 1 -1
  StrCmp $1 "$\"" 0 +2
    StrCpy $0 $0 -1
  Pop $1
  Exch $0
FunctionEnd

; This file is included before the template defines PRODUCTNAME, UNINSTKEY and the rest, so
; everything that reads them is a macro: it expands inside the template's sections.

!macro SeuCopyString NAME
  ReadRegStr $1 HKCU "${UNINSTKEY}" "${NAME}"
  WriteRegStr HKCU $0 "${NAME}" $1
!macroend

!macro SeuCopyDword NAME
  ReadRegDWORD $1 HKCU "${UNINSTKEY}" "${NAME}"
  WriteRegDWORD HKCU $0 "${NAME}" $1
!macroend

; Sets SeuLegacyKey, SeuLegacyDir and SeuLegacyIsElectron. Clobbers $0-$3.
!macro SeuFindLegacy
  StrCpy $SeuLegacyKey ""
  StrCpy $SeuLegacyDir ""
  StrCpy $SeuLegacyIsElectron ""
  StrCpy $0 0
  seu_next:
    EnumRegKey $1 HKCU "${SEU_UNINSTALL_ROOT}" $0
    StrCmp $1 "" seu_done
    IntOp $0 $0 + 1
    ; Tauri's own key of an earlier standalone install is not the Electron one
    StrCmp $1 "${PRODUCTNAME}" seu_next
    ; electron-builder names the entry "<product name> <version>"
    ReadRegStr $2 HKCU "${SEU_UNINSTALL_ROOT}\$1" "DisplayName"
    StrLen $3 "${PRODUCTNAME}"
    StrCpy $2 $2 $3
    StrCmp $2 "${PRODUCTNAME}" 0 seu_next
    StrCpy $SeuLegacyKey $1
    ReadRegStr $2 HKCU "${SEU_UNINSTALL_ROOT}\$1" "MainBinaryName"
    ${If} $2 == ""
      StrCpy $SeuLegacyIsElectron "1"
    ${EndIf}
    ; the folder: the uninstall key, else Software\<key>, else the folder of the uninstaller
    ReadRegStr $2 HKCU "${SEU_UNINSTALL_ROOT}\$1" "InstallLocation"
    ${If} $2 == ""
      ReadRegStr $2 HKCU "Software\$1" "InstallLocation"
    ${EndIf}
    ${If} $2 == ""
      ReadRegStr $2 HKCU "${SEU_UNINSTALL_ROOT}\$1" "UninstallString"
      StrCpy $2 $2 "" 1
      ${StrLoc} $3 $2 "$\"" ">"
      ${If} $3 != ""
        StrCpy $2 $2 $3
        ${GetParent} $2 $2
      ${Else}
        StrCpy $2 ""
      ${EndIf}
    ${EndIf}
    Push $2
    Call SeuUnquote
    Pop $2
    ${If} ${FileExists} "$2\*.*"
      StrCpy $SeuLegacyDir $2
    ${EndIf}
  seu_done:
!macroend

; The Electron uninstaller, silent and in place the way electron-builder upgrades itself, then
; whatever it left. Clobbers $0-$1.
!macro SeuRemoveElectron
  StrCpy $0 "$INSTDIR\Uninstall ${PRODUCTNAME}.exe"
  ${If} ${FileExists} $0
    DetailPrint "Running the Electron uninstaller"
    ExecWait '"$0" /S /KEEP_APP_DATA /currentuser --updated _?=$INSTDIR' $1
    DetailPrint "The Electron uninstaller exited with $1"
  ${EndIf}
  ; this install has none of these
  Delete $0
  Delete "$INSTDIR\*.dll"
  Delete "$INSTDIR\*.pak"
  Delete "$INSTDIR\*.bin"
  Delete "$INSTDIR\*.dat"
  Delete "$INSTDIR\*.json"
  Delete "$INSTDIR\LICENSE*"
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
!macroend

; Tauri wrote Uninstall\<product name>; the entry is rewritten under the Electron-time key instead.
; Clobbers $0-$1.
!macro SeuAdoptLegacyKey
  StrCpy $0 "${SEU_UNINSTALL_ROOT}\$SeuLegacyKey"
  WriteRegStr HKCU $0 "DisplayName" "${PRODUCTNAME} ${VERSION}"
  !insertmacro SeuCopyString "DisplayIcon"
  !insertmacro SeuCopyString "DisplayVersion"
  !insertmacro SeuCopyString "Publisher"
  !insertmacro SeuCopyString "InstallLocation"
  !insertmacro SeuCopyString "UninstallString"
  !insertmacro SeuCopyString "MainBinaryName"
  !insertmacro SeuCopyDword "NoModify"
  !insertmacro SeuCopyDword "NoRepair"
  !insertmacro SeuCopyDword "EstimatedSize"
  WriteRegStr HKCU $0 "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
  DeleteRegKey HKCU "${UNINSTKEY}"
  WriteRegStr HKCU "${MANUPRODUCTKEY}" "UninstallKey" $SeuLegacyKey
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro SeuFindLegacy
  ${If} $SeuLegacyDir != ""
    ${If} $INSTDIR != $SeuLegacyDir
      DetailPrint "Taking over the install in $SeuLegacyDir"
      StrCpy $R9 $INSTDIR
      StrCpy $INSTDIR $SeuLegacyDir
      SetOutPath $INSTDIR
      ; the empty default folder that SetOutPath created before this hook ran
      RMDir $R9
    ${EndIf}
    ${If} $SeuLegacyIsElectron == "1"
      !insertmacro SeuRemoveElectron
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  ${If} $SeuLegacyKey != ""
    !insertmacro SeuAdoptLegacyKey
  ${EndIf}
  WriteRegStr HKCU "Software\RegisteredApplications" "${PRODUCTNAME}" "${SEU_CAPABILITIES_KEY}"
  WriteRegStr HKCU "${SEU_CAPABILITIES_KEY}" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr HKCU "${SEU_CAPABILITIES_KEY}" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  WriteRegStr HKCU "${SEU_CAPABILITIES_KEY}\FileAssociations" ".docx" "seuoffice.WordDocument"
  ; SHCNE_ASSOCCHANGED: Explorer re-reads the file types
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ; the prototype has no other window onto what a silent install did
  FileOpen $R1 "$TEMP\seuoffice-proto-installer.log" w
  FileWrite $R1 "cmdline=[$CMDLINE] instdir=[$INSTDIR] legacyKey=[$SeuLegacyKey]$\r$\n"
  ${If} ${Silent}
    FileWrite $R1 "silent$\r$\n"
  ${EndIf}
  FileClose $R1
  ${If} ${Silent}
    ; GetOptions does not take a flag with a leading "--", so the command line is searched by hand
    ${StrLoc} $R0 " $CMDLINE " " --force-run " ">"
    ${If} $R0 != ""
      Exec '"$INSTDIR\${MAINBINARYNAME}.exe" --updated'
      FileOpen $R1 "$TEMP\seuoffice-proto-installer.log" a
      FileSeek $R1 0 END
      FileWrite $R1 "started $INSTDIR\${MAINBINARYNAME}.exe$\r$\n"
      FileClose $R1
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ReadRegStr $SeuLegacyKey HKCU "${MANUPRODUCTKEY}" "UninstallKey"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $SeuLegacyKey != ""
    DeleteRegKey HKCU "${SEU_UNINSTALL_ROOT}\$SeuLegacyKey"
  ${EndIf}
  DeleteRegValue HKCU "${MANUPRODUCTKEY}" "UninstallKey"
  DeleteRegValue HKCU "Software\RegisteredApplications" "${PRODUCTNAME}"
  DeleteRegKey HKCU "${SEU_CAPABILITIES_KEY}"
  DeleteRegKey /ifempty HKCU "Software\seuoffice"
!macroend
