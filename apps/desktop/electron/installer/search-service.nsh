; Included by electron-builder's nsis.include. Installation remains per-user;
; only the official search helper requests UAC for a protected SYSTEM service.
; Cancelling that optional elevation never aborts the desktop application setup.
!macro customInstall
  ${IfNot} ${Silent}
    DetailPrint "Installing the recommended spark233 NTFS search service (Windows administrator confirmation)..."
    nsExec::ExecToStack '"$INSTDIR\resources\plugins\installer\search\native\spark233.Search.exe" --install-service'
    Pop $0
    Pop $1
    ${If} $0 != "0"
      DetailPrint "Search service was not installed (result $0). Retry from the file search command in spark233."
    ${EndIf}
  ${Else}
    DetailPrint "Silent setup skips interactive UAC for the search service; users can install it from spark233."
  ${EndIf}
!macroend

!macro customUnInstall
  ; Electron-builder also invokes its uninstaller during an app update. The
  ; new install coordinates the service version switch; do not delete it here.
  ${IfNot} ${isUpdated}
    ${IfNot} ${Silent}
      IfFileExists "$INSTDIR\resources\plugins\installer\search\native\spark233.Search.exe" 0 spark233_service_remove_missing
      DetailPrint "Removing the spark233 search service (Windows administrator confirmation if installed)..."
      nsExec::ExecToStack '"$INSTDIR\resources\plugins\installer\search\native\spark233.Search.exe" --uninstall-service'
      Pop $0
      Pop $1
      ${If} $0 != "0"
        DetailPrint "Search service was retained (result $0). The desktop app can still be removed."
        MessageBox MB_OK|MB_ICONINFORMATION "The spark233 search service could not be removed or administrator confirmation was declined. Its protected files and index data have been retained. Reinstall spark233 to retry service removal later."
      ${EndIf}
      Goto spark233_service_remove_done
      spark233_service_remove_missing:
        DetailPrint "The search service removal helper is missing. No machine service was changed."
      spark233_service_remove_done:
    ${Else}
      DetailPrint "Silent uninstall skips interactive search-service elevation. A previously installed machine service is retained."
    ${EndIf}
  ${EndIf}
!macroend
