; Keeps the seuoffice command line (resources\cli, holding seuoffice.cmd and the
; extension-less seuoffice for Git Bash) on the installing user's PATH for the
; lifetime of the install. The value is read and written unexpanded
; (REG_EXPAND_SZ) so entries such as %USERPROFILE%\bin survive, and Explorer
; is told about the change so terminals opened afterwards see it.
; electron-builder compiles the script twice (the second pass, with
; BUILD_UNINSTALLER, only produces the uninstaller); an unreferenced function
; in either pass is a warning makensis treats as an error, hence the guards.
!include "WinMessages.nsh"
!include "StrFunc.nsh"

!define SEUOFFICE_PATH_MAX 7900

; Scope templates to our ProgIDs (electron-builder uses win.fileAssociations.name).
; A shared .ext\ShellNew would overwrite Office/WPS templates. OOXML files
; must be copied from valid packages, never created with NullFile.
!macro SeuOfficeRegisterShellNew EXT PROGID
  WriteRegStr SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName" "$INSTDIR\resources\shell-new\blank.${EXT}"
!macroend

!macro SeuOfficeUnregisterShellNew EXT PROGID
  ; Only remove our own registration, including when uninstalling for an update.
  ReadRegStr $0 SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew" "FileName"
  ${If} $0 == "$INSTDIR\resources\shell-new\blank.${EXT}"
    DeleteRegKey SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}\ShellNew"
    DeleteRegKey /ifempty SHELL_CONTEXT "Software\Classes\.${EXT}\${PROGID}"
  ${EndIf}
!macroend

; .odt is only offered in Explorer's "Open with": a product-own ProgId plus a
; value under .odt\OpenWithProgids. A win.fileAssociations entry would also
; write .odt's default value (APP_ASSOCIATE) and take over the user's ODT
; program, so ODT is registered here instead. ODT opens in the Word tab, so the
; ProgId borrows the Word icon the installer already places for .docx.
!define SEUOFFICE_ODT_PROGID "seuoffice.OpenDocumentText"

!macro SeuOfficeRegisterOpenWithOdt
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_ODT_PROGID}" "" "OpenDocument Text"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_ODT_PROGID}\DefaultIcon" "" "$INSTDIR\resources\docx.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_ODT_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.odt\OpenWithProgids" "${SEUOFFICE_ODT_PROGID}"
!macroend

!macro SeuOfficeUnregisterOpenWithOdt
  ; Only our value and our ProgId: the .odt key, its default value and other
  ; programs' OpenWithProgids entries belong to whoever wrote them.
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.odt\OpenWithProgids" "${SEUOFFICE_ODT_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${SEUOFFICE_ODT_PROGID}"
!macroend

; .ods is offered in Explorer's "Open with" for the same reason: it opens as a
; converted .xlsx copy that saves as .xlsx (decision 0119), so taking over the
; user's ODS program would hide that the original is not what gets written
; back. The spreadsheet opens in the Sheets tab, so the ProgId borrows the
; spreadsheet icon the installer already places for .xlsx.
!define SEUOFFICE_ODS_PROGID "seuoffice.OpenDocumentSpreadsheet"

!macro SeuOfficeRegisterOpenWithOds
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_ODS_PROGID}" "" "OpenDocument Spreadsheet"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_ODS_PROGID}\DefaultIcon" "" "$INSTDIR\resources\xlsx.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_ODS_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.ods\OpenWithProgids" "${SEUOFFICE_ODS_PROGID}"
!macroend

!macro SeuOfficeUnregisterOpenWithOds
  ; Only our value and our ProgId: the .ods key, its default value and other
  ; programs' OpenWithProgids entries belong to whoever wrote them.
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.ods\OpenWithProgids" "${SEUOFFICE_ODS_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${SEUOFFICE_ODS_PROGID}"
!macroend

; .hwp, .hwpx, .xmind, .epub and .vsdx are offered in Explorer's "Open with" and
; never made the default, for the same reason as .odt above: a
; win.fileAssociations entry would also write the extension's default value and
; take it over (from Hancom Office for the Hangul formats, from whatever opens
; the mind map, reads the book or draws the Visio drawing today). Each gets a
; product-own ProgId whose DefaultIcon is the per-type document icon
; (resources\hwp.ico / resources\mindmap.ico / resources\epub.ico /
; resources\diagram.ico, placed by the win.extraResources entries in
; electron-builder.cjs), so choosing this app in "Open with" shows the Hangul,
; mind-map, book or diagram icon instead of the bare app icon. The ProgIds match
; the name-to-ProgId rule electron-builder.cjs uses for its Windows list
; (see tests/product-identity.test.ts).
!define SEUOFFICE_HWP_PROGID "seuoffice.HWPDocument"
!define SEUOFFICE_HWPX_PROGID "seuoffice.HWPXDocument"
!define SEUOFFICE_MINDMAP_PROGID "seuoffice.MindMap"
!define SEUOFFICE_EPUB_PROGID "seuoffice.EPUBBook"
; a Visio drawing opens as a new diagram (it is never written), with the diagram icon
!define SEUOFFICE_VSDX_PROGID "seuoffice.VSDXDrawing"

!macro SeuOfficeRegisterOpenWithHwp
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_HWP_PROGID}" "" "HWP Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_HWP_PROGID}\DefaultIcon" "" "$INSTDIR\resources\hwp.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_HWP_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.hwp\OpenWithProgids" "${SEUOFFICE_HWP_PROGID}"
!macroend

!macro SeuOfficeUnregisterOpenWithHwp
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.hwp\OpenWithProgids" "${SEUOFFICE_HWP_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${SEUOFFICE_HWP_PROGID}"
!macroend

!macro SeuOfficeRegisterOpenWithHwpx
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_HWPX_PROGID}" "" "HWPX Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_HWPX_PROGID}\DefaultIcon" "" "$INSTDIR\resources\hwp.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_HWPX_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.hwpx\OpenWithProgids" "${SEUOFFICE_HWPX_PROGID}"
!macroend

!macro SeuOfficeUnregisterOpenWithHwpx
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.hwpx\OpenWithProgids" "${SEUOFFICE_HWPX_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${SEUOFFICE_HWPX_PROGID}"
!macroend

!macro SeuOfficeRegisterOpenWithMindmap
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_MINDMAP_PROGID}" "" "Mind Map"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_MINDMAP_PROGID}\DefaultIcon" "" "$INSTDIR\resources\mindmap.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_MINDMAP_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.xmind\OpenWithProgids" "${SEUOFFICE_MINDMAP_PROGID}"
!macroend

!macro SeuOfficeUnregisterOpenWithMindmap
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.xmind\OpenWithProgids" "${SEUOFFICE_MINDMAP_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${SEUOFFICE_MINDMAP_PROGID}"
!macroend

!macro SeuOfficeRegisterOpenWithEpub
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_EPUB_PROGID}" "" "EPUB Book"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_EPUB_PROGID}\DefaultIcon" "" "$INSTDIR\resources\epub.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_EPUB_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.epub\OpenWithProgids" "${SEUOFFICE_EPUB_PROGID}"
!macroend

!macro SeuOfficeUnregisterOpenWithEpub
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.epub\OpenWithProgids" "${SEUOFFICE_EPUB_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${SEUOFFICE_EPUB_PROGID}"
!macroend

!macro SeuOfficeRegisterOpenWithVsdx
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_VSDX_PROGID}" "" "VSDX Drawing"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_VSDX_PROGID}\DefaultIcon" "" "$INSTDIR\resources\diagram.ico"
  WriteRegStr SHELL_CONTEXT "Software\Classes\${SEUOFFICE_VSDX_PROGID}\shell\open\command" "" '"$appExe" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.vsdx\OpenWithProgids" "${SEUOFFICE_VSDX_PROGID}"
!macroend

!macro SeuOfficeUnregisterOpenWithVsdx
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.vsdx\OpenWithProgids" "${SEUOFFICE_VSDX_PROGID}"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\${SEUOFFICE_VSDX_PROGID}"
!macroend

; Windows' "Default apps" page picks an app by its registered capabilities and
; records the ProgId the app declared for the type. Without this entry Windows
; only knows the bare seuoffice.exe application and records
; Applications\seuoffice.exe, whose icon is the app logo: a .hwp chosen that way
; shows the logo instead of hwp.ico, while a .hwpx chosen from our Open-With
; ProgId shows the document icon. Registering capabilities does not change any
; default by itself; it makes the user's choice land on the per-type ProgId
; (whose DefaultIcon is the document icon). The .hwp/.hwpx/.xmind/.epub/.vsdx/.odt ProgIds
; are the product-own Open-With ones defined above; the rest are the ProgIds
; electron-builder writes for the Windows file associations.
!define SEUOFFICE_CAPABILITIES_KEY "Software\seuoffice\Capabilities"

!macro SeuOfficeRegisterApplicationCapabilities
  WriteRegStr SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_NAME}" "${SEUOFFICE_CAPABILITIES_KEY}"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}" "ApplicationName" "${PRODUCT_NAME}"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}" "ApplicationIcon" "$appExe,0"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".docx" "seuoffice.WordDocument"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".xlsx" "seuoffice.ExcelWorkbook"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".xlsm" "seuoffice.ExcelMacroEnabledWorkbook"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".xls" "seuoffice.Excel972003Workbook"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".pptx" "seuoffice.PowerPointPresentation"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".csv" "seuoffice.CSVDocument"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".tsv" "seuoffice.TSVDocument"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".pdf" "seuoffice.PDFDocument"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".md" "seuoffice.MarkdownDocument"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".markdown" "seuoffice.MarkdownDocument"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".html" "seuoffice.HTMLDocument"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".htm" "seuoffice.HTMLDocument"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".hwp" "${SEUOFFICE_HWP_PROGID}"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".hwpx" "${SEUOFFICE_HWPX_PROGID}"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".xmind" "${SEUOFFICE_MINDMAP_PROGID}"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".epub" "${SEUOFFICE_EPUB_PROGID}"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".drawio" "seuoffice.Diagram"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".dio" "seuoffice.Diagram"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".vsdx" "${SEUOFFICE_VSDX_PROGID}"
  WriteRegStr SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}\FileAssociations" ".odt" "${SEUOFFICE_ODT_PROGID}"
!macroend

!macro SeuOfficeUnregisterApplicationCapabilities
  ; only our registration and our key; a future sibling under Software\seuoffice
  ; keeps that parent alive
  DeleteRegValue SHELL_CONTEXT "Software\RegisteredApplications" "${PRODUCT_NAME}"
  DeleteRegKey SHELL_CONTEXT "${SEUOFFICE_CAPABILITIES_KEY}"
  DeleteRegKey /ifempty SHELL_CONTEXT "Software\seuoffice"
!macroend

; An update the app starts in this installer's own window ("Restart & Install",
; decision 0077) shows the progress page only. It keeps the install it updates:
; the mode .onInit read from the registry, which is the same choice a silent
; update makes, so "who should this be installed for" is not asked again (an
; "all users" install still gets its administrator prompt from that page's
; elevation). A first install still asks.
!macro customInstallMode
  ${if} ${isUpdated}
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endIf}
  ${endIf}
!macroend

; The stock finish page (electron-builder's assistedInstaller.nsh: StartApp
; plus the "Run" checkbox), with one change: an update asked to reopen the app
; (--updated --force-run) reopens it and ends here instead of waiting on the
; finish page. electron-builder starts the app itself only after a silent
; update, so without this the app would not come back after a visible one.
!macro customFinishPage
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function SeuOfficeFinishPagePre
    ${if} ${isUpdated}
    ${andIf} ${isForceRun}
      ; otherwise the app window opens behind this one
      HideWindow
      Call StartApp
      Abort
    ${endIf}
  FunctionEnd

  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_PAGE_CUSTOMFUNCTION_PRE SeuOfficeFinishPagePre
  !insertmacro MUI_PAGE_FINISH
!macroend

!macro customInstall
  Push "$INSTDIR\resources\cli"
  Call SeuOfficeAddToUserPath
  !insertmacro SeuOfficeRegisterShellNew "docx" "seuoffice.WordDocument"
  !insertmacro SeuOfficeRegisterShellNew "xlsx" "seuoffice.ExcelWorkbook"
  !insertmacro SeuOfficeRegisterShellNew "pptx" "seuoffice.PowerPointPresentation"
  !insertmacro SeuOfficeRegisterOpenWithOdt
  !insertmacro SeuOfficeRegisterOpenWithOds
  !insertmacro SeuOfficeRegisterOpenWithHwp
  !insertmacro SeuOfficeRegisterOpenWithHwpx
  !insertmacro SeuOfficeRegisterOpenWithMindmap
  !insertmacro SeuOfficeRegisterOpenWithEpub
  !insertmacro SeuOfficeRegisterOpenWithVsdx
  !insertmacro SeuOfficeRegisterApplicationCapabilities
  !insertmacro UPDATEFILEASSOC
!macroend

!macro customUnInstall
  ; An update (the old version's uninstaller, run with --updated) keeps the
  ; install folder, so the CLI's PATH entry stays: removing it here and adding
  ; it back in the installer broadcast the change to every window twice, each
  ; broadcast waiting up to 5 s per window that does not answer.
  ${ifNot} ${isUpdated}
    Push "$INSTDIR\resources\cli"
    Call un.SeuOfficeRemoveFromUserPath
  ${endIf}
  Push $0
  !insertmacro SeuOfficeUnregisterShellNew "docx" "seuoffice.WordDocument"
  !insertmacro SeuOfficeUnregisterShellNew "xlsx" "seuoffice.ExcelWorkbook"
  !insertmacro SeuOfficeUnregisterShellNew "pptx" "seuoffice.PowerPointPresentation"
  !insertmacro SeuOfficeUnregisterOpenWithOdt
  !insertmacro SeuOfficeUnregisterOpenWithOds
  !insertmacro SeuOfficeUnregisterOpenWithHwp
  !insertmacro SeuOfficeUnregisterOpenWithHwpx
  !insertmacro SeuOfficeUnregisterOpenWithMindmap
  !insertmacro SeuOfficeUnregisterOpenWithEpub
  !insertmacro SeuOfficeUnregisterOpenWithVsdx
  !insertmacro SeuOfficeUnregisterApplicationCapabilities
  Pop $0
  ; the installer that runs next tells Explorer once, after registering again
  ${ifNot} ${isUpdated}
    !insertmacro UPDATEFILEASSOC
  ${endIf}
!macroend

!ifndef BUILD_UNINSTALLER
${StrStr}

Function SeuOfficeAddToUserPath
  Exch $0 ; directory
  Push $1
  Push $2
  Push $3
  ReadRegStr $1 HKCU "Environment" "Path"
  StrLen $2 $1
  ; leave an already oversized PATH alone rather than truncate it
  IntCmp $2 ${SEUOFFICE_PATH_MAX} done 0 done
  ${StrStr} $3 ";$1;" ";$0;"
  StrCmp $3 "" 0 done
  StrCmp $1 "" 0 +3
    StrCpy $1 "$0"
    Goto write
  StrCpy $1 "$1;$0"
write:
  WriteRegExpandStr HKCU "Environment" "Path" $1
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
done:
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif

!ifdef BUILD_UNINSTALLER
${UnStrStr}
${UnStrRep}

Function un.SeuOfficeRemoveFromUserPath
  Exch $0 ; directory
  Push $1
  Push $2
  ReadRegStr $1 HKCU "Environment" "Path"
  StrCmp $1 "" done
  ${UnStrStr} $2 ";$1;" ";$0;"
  StrCmp $2 "" done
  StrCpy $1 ";$1;"
  ${UnStrRep} $1 $1 ";$0;" ";"
  ; strip the sentinels added above
  StrCpy $1 $1 -1
  StrCpy $1 $1 "" 1
  WriteRegExpandStr HKCU "Environment" "Path" $1
  SendMessage ${HWND_BROADCAST} ${WM_WININICHANGE} 0 "STR:Environment" /TIMEOUT=5000
done:
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif
