; Installer hooks of the CEF build (Tauri's NSIS template includes this file
; and calls the NSIS_HOOK_* macros). Three jobs:
;
; 1. Take over the Electron build's per-user install, the way electron-updater
;    starts this installer after "Restart & Install":
;      SeuOffice-Setup-<v>.exe --updated /S --force-run
;    The Electron install is the HKCU Uninstall key whose DisplayName starts
;    with the product name and that is not Tauri's own (Uninstall\SeuOffice);
;    its folder is HKCU\Software\<that key>\InstallLocation. This installs into
;    the same folder, so the ProgIds' open commands, the Start menu and the CLI
;    keep their paths (decision 0029 (a), proto/cef/src-tauri/windows/hooks.nsh).
;
; 2. Keep the previous version until the new one has started (the migration
;    test's rollback, docs/seuoffice/3단계-넘어가기-시험.md 4.4). The previous
;    folder is renamed to <folder>.previous before anything is written; after
;    the install an update starts the new app and waits for its start mark
;    (userData\shell-started.txt with this version, written by
;    crates/shell/src/host/os.rs). No mark in time: the new files go, the
;    previous folder comes back and is started. An installer that is killed
;    leaves a RunOnce entry (a script in %LOCALAPPDATA%) that puts the
;    previous folder back at the next sign-in unless the install finished.
;    When the previous folder cannot be set aside whole (a file in it is
;    held open), the install stops before writing anything and the installed
;    version stays.
;
; 3. What the Electron build's build/installer.nsh registered besides the
;    associations Tauri writes: the per-type icons, Explorer's New menu for
;    docx/xlsx/pptx, the Open-With-only ProgIds, Default apps' capabilities,
;    and the seuoffice command on the user's PATH. Same names and values, so an
;    install over the Electron one changes nothing a user set.
;
; %APPDATA%\seuoffice (userData) is never touched here.

!define SEUOFFICE_UNINSTALL_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"
!define SEUOFFICE_CAPABILITIES_KEY "Software\seuoffice\Capabilities"
!define SEUOFFICE_RUNONCE "Software\Microsoft\Windows\CurrentVersion\RunOnce"
!define SEUOFFICE_RESTORE_VALUE "SeuOfficeRestorePrevious"
!define SEUOFFICE_COMPLETE_MARK ".seuoffice-install-complete"
!define SEUOFFICE_START_MARK "$APPDATA\seuoffice\shell-started.txt"
; how long an update waits for the new app's start mark, in half seconds
!define SEUOFFICE_START_WAIT 180
!define SEUOFFICE_PATH_MAX 7900
; RunOnce takes 260 characters at most: the entry runs this script
!define SEUOFFICE_RESTORE_SCRIPT "$LOCALAPPDATA\seuoffice-restore-previous.cmd"
; the updater's cache (app-update.yml's updaterCacheDirName): the next update
; copies the blocks it already has from the installer kept here
!define SEUOFFICE_UPDATER_CACHE "$LOCALAPPDATA\seuoffice-updater"

; Each file compressed on its own (zlib, NSIS's default), not one solid LZMA
; stream (Tauri's default): an unchanged file then keeps its bytes from one
; release to the next, so the block-map download copies it instead of
; fetching it again. windows.conf.json turns compression off ("none") for the
; template's head, where SetCompressor would have to be; it comes back here,
; before any file of the app.
SetCompress auto

!include TextFunc.nsh
!include WinMessages.nsh

Var SeuOfficeOldKey
Var SeuOfficePrevious

; ---- the Electron install and the previous version ----

!macro SeuOfficeFindElectronInstall
  StrCpy $SeuOfficeOldKey ""
  StrCpy $R9 ""
  StrCpy $0 0
  seuoffice_scan:
    EnumRegKey $1 HKCU "${SEUOFFICE_UNINSTALL_ROOT}" $0
    StrCmp $1 "" seuoffice_scan_done
    IntOp $0 $0 + 1
    StrCmp $1 "${PRODUCTNAME}" seuoffice_scan
    ReadRegStr $2 HKCU "${SEUOFFICE_UNINSTALL_ROOT}\$1" "DisplayName"
    StrLen $4 "${PRODUCTNAME}"
    StrCpy $2 $2 $4
    StrCmp $2 "${PRODUCTNAME}" 0 seuoffice_scan
    ReadRegStr $3 HKCU "Software\$1" "InstallLocation"
    StrCmp $3 "" 0 seuoffice_have_dir
    ; or where the uninstaller the entry names lives: "<folder>\Uninstall SeuOffice.exe" /currentuser
    ReadRegStr $3 HKCU "${SEUOFFICE_UNINSTALL_ROOT}\$1" "UninstallString"
    StrCpy $4 $3 1
    StrCmp $4 '"' 0 +2
      StrCpy $3 $3 "" 1
    ${StrLoc} $5 $3 "\Uninstall ${PRODUCTNAME}.exe" ">"
    StrCmp $5 "" seuoffice_scan
    StrCpy $3 $3 $5
    seuoffice_have_dir:
    StrCpy $4 $3 1
    StrCmp $4 '"' 0 +3
      StrCpy $3 $3 "" 1
      StrCpy $3 $3 -1
    StrCpy $SeuOfficeOldKey $1
    StrCpy $R9 $3
  seuoffice_scan_done:
!macroend

; Nothing new was written: the installed version stays, and is started again
; when an update had closed it, so the person is back where they were. Its
; updater then finds the version unchanged and reports the failed install.
!macro SeuOfficeKeepInstalled REASON
  DetailPrint "${REASON} The installed version stays."
  ${IfNot} ${Silent}
    MessageBox MB_ICONSTOP|MB_OK "${REASON}$\r$\n$\r$\nThe installed version of ${PRODUCTNAME} stays as it is. Close the program that uses it and try again."
  ${EndIf}
  ${If} $UpdateMode = 1
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "--updated"
  ${EndIf}
  ; Quit, not Abort: Abort in the install section leaves the window open on
  ; its "aborted" page, which an update started from the app would leave
  ; waiting for a click after the message above
  SetErrorLevel 5
  Quit
!macroend

!macro NSIS_HOOK_PREINSTALL
  ; electron-updater's flag; Tauri's own is /UPDATE
  ClearErrors
  ${GetOptions} $CMDLINE "--updated" $0
  ${IfNot} ${Errors}
    StrCpy $UpdateMode 1
  ${EndIf}

  !insertmacro SeuOfficeFindElectronInstall
  ${If} $R9 != ""
    DetailPrint "Taking over the Electron install in $R9"
    !insertmacro CheckIfAppIsRunning "$R9\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    StrCpy $INSTDIR $R9
  ${Else}
    !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ${EndIf}

  ; The version in the folder stays beside it until the new one has started.
  ; Fail closed: when it cannot be set aside whole, nothing new is written and
  ; the installed version stays as it is (a locked file, an antivirus scan).
  StrCpy $SeuOfficePrevious ""
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
    ; the installer's own working folder is inside $INSTDIR (SetOutPath): leave it
    SetOutPath $TEMP
    ; a .previous an earlier run left must go first, or the rename below fails
    RMDir /r "$INSTDIR.previous"
    ${If} ${FileExists} "$INSTDIR.previous\*.*"
      !insertmacro SeuOfficeKeepInstalled "$INSTDIR.previous is in use and could not be removed."
    ${EndIf}
    ; a killed install puts the previous folder back at the next sign-in;
    ; written first, so no moment exists without it
    FileOpen $6 "${SEUOFFICE_RESTORE_SCRIPT}" w
    FileWrite $6 '@echo off$\r$\n'
    FileWrite $6 'if exist "$INSTDIR\${SEUOFFICE_COMPLETE_MARK}" goto done$\r$\n'
    FileWrite $6 'if not exist "$INSTDIR.previous\${MAINBINARYNAME}.exe" goto done$\r$\n'
    FileWrite $6 'rmdir /s /q "$INSTDIR"$\r$\n'
    FileWrite $6 'move "$INSTDIR.previous" "$INSTDIR"$\r$\n'
    FileWrite $6 ':done$\r$\n'
    FileWrite $6 'del "%~f0"$\r$\n'
    FileClose $6
    WriteRegStr HKCU "${SEUOFFICE_RUNONCE}" "${SEUOFFICE_RESTORE_VALUE}" \
      '"$SYSDIR\cmd.exe" /c "${SEUOFFICE_RESTORE_SCRIPT}"'
    ClearErrors
    Rename "$INSTDIR" "$INSTDIR.previous"
    ${If} ${Errors}
    ${OrIfNot} ${FileExists} "$INSTDIR.previous\${MAINBINARYNAME}.exe"
      DeleteRegValue HKCU "${SEUOFFICE_RUNONCE}" "${SEUOFFICE_RESTORE_VALUE}"
      Delete "${SEUOFFICE_RESTORE_SCRIPT}"
      !insertmacro SeuOfficeKeepInstalled "A file of the installed version is in use."
    ${EndIf}
    StrCpy $SeuOfficePrevious "$INSTDIR.previous"
  ${EndIf}
  CreateDirectory "$INSTDIR"
  SetOutPath $INSTDIR
!macroend

; ---- what the Electron build's installer.nsh registered ----

!macro SeuOfficeIcon PROGID ICON
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\resources\${ICON}.ico"
!macroend

!macro SeuOfficeShellNew EXT PROGID
  ; under our ProgId only: a shared .ext\ShellNew would replace Office's template
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName" "$INSTDIR\resources\shell-new\blank.${EXT}"
!macroend

!macro SeuOfficeUnShellNew EXT PROGID
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName"
  ${If} $0 == "$INSTDIR\resources\shell-new\blank.${EXT}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}"
  ${EndIf}
!macroend

; Explorer's "Open with" only: never the extension's default program
!macro SeuOfficeOpenWith EXT PROGID DESCRIPTION ICON
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}" "" "${DESCRIPTION}"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\DefaultIcon" "" "$INSTDIR\resources\${ICON}.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${PROGID}\shell\open\command" "" '"$INSTDIR\${MAINBINARYNAME}.exe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
!macroend

!macro SeuOfficeUnOpenWith EXT PROGID
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.${EXT}\OpenWithProgids" "${PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${PROGID}"
!macroend

!macro SeuOfficeCapability EXT PROGID
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".${EXT}" "${PROGID}"
!macroend

!macro SeuOfficeRegister
  !insertmacro SeuOfficeIcon "seuoffice.WordDocument" "docx"
  !insertmacro SeuOfficeIcon "seuoffice.ExcelWorkbook" "xlsx"
  !insertmacro SeuOfficeIcon "seuoffice.ExcelMacroEnabledWorkbook" "xlsx"
  !insertmacro SeuOfficeIcon "seuoffice.Excel972003Workbook" "xlsx"
  !insertmacro SeuOfficeIcon "seuoffice.CSVDocument" "xlsx"
  !insertmacro SeuOfficeIcon "seuoffice.TSVDocument" "xlsx"
  !insertmacro SeuOfficeIcon "seuoffice.PowerPointPresentation" "pptx"
  !insertmacro SeuOfficeIcon "seuoffice.PDFDocument" "pdf"
  !insertmacro SeuOfficeIcon "seuoffice.MarkdownDocument" "md"
  !insertmacro SeuOfficeIcon "seuoffice.HTMLDocument" "html"
  !insertmacro SeuOfficeIcon "seuoffice.Diagram" "diagram"

  !insertmacro SeuOfficeShellNew "docx" "seuoffice.WordDocument"
  !insertmacro SeuOfficeShellNew "xlsx" "seuoffice.ExcelWorkbook"
  !insertmacro SeuOfficeShellNew "pptx" "seuoffice.PowerPointPresentation"

  !insertmacro SeuOfficeOpenWith "odt" "seuoffice.OpenDocumentText" "OpenDocument Text" "docx"
  !insertmacro SeuOfficeOpenWith "ods" "seuoffice.OpenDocumentSpreadsheet" "OpenDocument Spreadsheet" "xlsx"
  !insertmacro SeuOfficeOpenWith "hwp" "seuoffice.HWPDocument" "HWP Document" "hwp"
  !insertmacro SeuOfficeOpenWith "hwpx" "seuoffice.HWPXDocument" "HWPX Document" "hwp"
  !insertmacro SeuOfficeOpenWith "xmind" "seuoffice.MindMap" "Mind Map" "mindmap"
  !insertmacro SeuOfficeOpenWith "epub" "seuoffice.EPUBBook" "EPUB Book" "epub"
  !insertmacro SeuOfficeOpenWith "vsdx" "seuoffice.VSDXDrawing" "VSDX Drawing" "diagram"

  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCTNAME}" "${SEUOFFICE_CAPABILITIES_KEY}"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}" "ApplicationName" "${PRODUCTNAME}"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}" "ApplicationIcon" "$INSTDIR\${MAINBINARYNAME}.exe,0"
  !insertmacro SeuOfficeCapability "docx" "seuoffice.WordDocument"
  !insertmacro SeuOfficeCapability "xlsx" "seuoffice.ExcelWorkbook"
  !insertmacro SeuOfficeCapability "xlsm" "seuoffice.ExcelMacroEnabledWorkbook"
  !insertmacro SeuOfficeCapability "xls" "seuoffice.Excel972003Workbook"
  !insertmacro SeuOfficeCapability "pptx" "seuoffice.PowerPointPresentation"
  !insertmacro SeuOfficeCapability "csv" "seuoffice.CSVDocument"
  !insertmacro SeuOfficeCapability "tsv" "seuoffice.TSVDocument"
  !insertmacro SeuOfficeCapability "pdf" "seuoffice.PDFDocument"
  !insertmacro SeuOfficeCapability "md" "seuoffice.MarkdownDocument"
  !insertmacro SeuOfficeCapability "markdown" "seuoffice.MarkdownDocument"
  !insertmacro SeuOfficeCapability "html" "seuoffice.HTMLDocument"
  !insertmacro SeuOfficeCapability "htm" "seuoffice.HTMLDocument"
  !insertmacro SeuOfficeCapability "hwp" "seuoffice.HWPDocument"
  !insertmacro SeuOfficeCapability "hwpx" "seuoffice.HWPXDocument"
  !insertmacro SeuOfficeCapability "xmind" "seuoffice.MindMap"
  !insertmacro SeuOfficeCapability "epub" "seuoffice.EPUBBook"
  !insertmacro SeuOfficeCapability "drawio" "seuoffice.Diagram"
  !insertmacro SeuOfficeCapability "dio" "seuoffice.Diagram"
  !insertmacro SeuOfficeCapability "vsdx" "seuoffice.VSDXDrawing"
  !insertmacro SeuOfficeCapability "odt" "seuoffice.OpenDocumentText"
!macroend

; ---- the command line on the user's PATH ----
; Read and written unexpanded (REG_EXPAND_SZ), so %USERPROFILE%\bin entries
; survive; WordReplace searches ";PATH;" for ";dir;". Explorer is told, so a
; terminal opened afterwards sees it.

!macro SeuOfficeAddToPath DIR
  ReadRegStr $1 HKCU "Environment" "Path"
  StrLen $2 $1
  ${If} $2 < ${SEUOFFICE_PATH_MAX}
    ${WordReplace} ";$1;" ";${DIR};" ";" "+1" $3
    ${If} $3 == ";$1;"
      ${If} $1 == ""
        StrCpy $1 "${DIR}"
      ${Else}
        StrCpy $1 "$1;${DIR}"
      ${EndIf}
      WriteRegExpandStr HKCU "Environment" "Path" $1
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}
!macroend

!macro SeuOfficeRemoveFromPath DIR
  ReadRegStr $1 HKCU "Environment" "Path"
  ${If} $1 != ""
    ${WordReplace} ";$1;" ";${DIR};" ";" "+" $3
    ${If} $3 != ";$1;"
      StrCpy $3 $3 -1
      StrCpy $3 $3 "" 1
      WriteRegExpandStr HKCU "Environment" "Path" $3
      SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
    ${EndIf}
  ${EndIf}
!macroend

; ---- after the files ----

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro SeuOfficeRegister
  !insertmacro SeuOfficeAddToPath "$INSTDIR\resources\cli"
  ; Explorer reads the associations again once
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'

  ${If} $SeuOfficePrevious != ""
  ${AndIf} $UpdateMode = 1
    ; the new app must start before the previous version goes
    Delete "${SEUOFFICE_START_MARK}"
    nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "--updated"
    StrCpy $5 0
    seuoffice_wait:
      ClearErrors
      FileOpen $6 "${SEUOFFICE_START_MARK}" r
      ${IfNot} ${Errors}
        FileRead $6 $7
        FileClose $6
        ${TrimNewLines} $7 $7
        StrCmp $7 "${VERSION}" seuoffice_started
      ${EndIf}
      IntOp $5 $5 + 1
      IntCmp $5 ${SEUOFFICE_START_WAIT} seuoffice_failed
      Sleep 500
      Goto seuoffice_wait
    seuoffice_failed:
      DetailPrint "The new version did not start; putting the previous one back"
      nsExec::Exec '"$SYSDIR\taskkill.exe" /f /t /im "${MAINBINARYNAME}.exe"'
      SetOutPath $TEMP
      RMDir /r "$INSTDIR"
      Rename "$SeuOfficePrevious" "$INSTDIR"
      ; Tauri's entry goes, the Electron entry was left in place
      DeleteRegKey HKCU "${SEUOFFICE_UNINSTALL_ROOT}\${PRODUCTNAME}"
      DeleteRegValue HKCU "${SEUOFFICE_RUNONCE}" "${SEUOFFICE_RESTORE_VALUE}"
      Delete "${SEUOFFICE_RESTORE_SCRIPT}"
      ; the previous version starts and its updater sees the failed install
      nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "--updated"
      SetErrorLevel 3
      Quit
    seuoffice_started:
  ${EndIf}

  ; the install stands: the previous version and the Electron entry go
  FileOpen $6 "$INSTDIR\${SEUOFFICE_COMPLETE_MARK}" w
  FileClose $6
  DeleteRegValue HKCU "${SEUOFFICE_RUNONCE}" "${SEUOFFICE_RESTORE_VALUE}"
  Delete "${SEUOFFICE_RESTORE_SCRIPT}"
  ${If} $SeuOfficePrevious != ""
    RMDir /r "$SeuOfficePrevious"
  ${EndIf}
  ${If} $SeuOfficeOldKey != ""
    DeleteRegKey HKCU "${SEUOFFICE_UNINSTALL_ROOT}\$SeuOfficeOldKey"
    DeleteRegKey HKCU "Software\$SeuOfficeOldKey"
  ${EndIf}

  ; what the next update copies blocks from, as electron-builder's installer
  ; kept itself: this installer, and its block map when the updater
  ; downloaded one beside it (otherwise the updater fetches this version's)
  CreateDirectory "${SEUOFFICE_UPDATER_CACHE}"
  Delete "${SEUOFFICE_UPDATER_CACHE}\current.blockmap"
  CopyFiles /SILENT "$EXEPATH" "${SEUOFFICE_UPDATER_CACHE}\installer.exe"
  ${If} ${FileExists} "$EXEDIR\current.blockmap"
    CopyFiles /SILENT "$EXEDIR\current.blockmap" "${SEUOFFICE_UPDATER_CACHE}\current.blockmap"
  ${EndIf}

  ; electron-updater's --force-run, outside an update that started the app above
  ${If} $SeuOfficePrevious == ""
  ${OrIf} $UpdateMode <> 1
    ClearErrors
    ${GetOptions} $CMDLINE "--force-run" $0
    ${IfNot} ${Errors}
      ${If} $UpdateMode = 1
        nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" "--updated"
      ${Else}
        nsis_tauri_utils::RunAsUser "$INSTDIR\${MAINBINARYNAME}.exe" ""
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; an update keeps the folder: the PATH entry and the registrations stay
  ${If} $UpdateMode <> 1
    !insertmacro SeuOfficeRemoveFromPath "$INSTDIR\resources\cli"
    !insertmacro SeuOfficeUnShellNew "docx" "seuoffice.WordDocument"
    !insertmacro SeuOfficeUnShellNew "xlsx" "seuoffice.ExcelWorkbook"
    !insertmacro SeuOfficeUnShellNew "pptx" "seuoffice.PowerPointPresentation"
    !insertmacro SeuOfficeUnOpenWith "odt" "seuoffice.OpenDocumentText"
    !insertmacro SeuOfficeUnOpenWith "ods" "seuoffice.OpenDocumentSpreadsheet"
    !insertmacro SeuOfficeUnOpenWith "hwp" "seuoffice.HWPDocument"
    !insertmacro SeuOfficeUnOpenWith "hwpx" "seuoffice.HWPXDocument"
    !insertmacro SeuOfficeUnOpenWith "xmind" "seuoffice.MindMap"
    !insertmacro SeuOfficeUnOpenWith "epub" "seuoffice.EPUBBook"
    !insertmacro SeuOfficeUnOpenWith "vsdx" "seuoffice.VSDXDrawing"
    DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCTNAME}"
    DeleteRegKey SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\seuoffice"
    System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${EndIf}
!macroend
