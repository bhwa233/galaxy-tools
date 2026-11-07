; Included by electron-builder's nsis.include. Installation remains per-user.
; File search now uses Everything; versions up to 0.1.x could install the
; Pulse-based "spark233Index" SYSTEM service. When it is still registered, ask
; once for Windows administrator approval to stop and delete it and remove its
; index data. Declining or failing never aborts setup or blocks file search.
!macro spark233RemoveLegacySearchService
  ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\spark233Index" "ImagePath"
  ${If} $0 != ""
    ${IfNot} ${Silent}
      IfFileExists "$INSTDIR\resources\installer\remove-legacy-search-service.ps1" 0 spark233_legacy_search_missing
      DetailPrint "Removing the retired spark233 search index service (Windows administrator confirmation)..."
      ExecShellWait "runas" "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe" '-NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\installer\remove-legacy-search-service.ps1"' SW_HIDE
      ReadRegStr $0 HKLM "SYSTEM\CurrentControlSet\Services\spark233Index" "ImagePath"
      ${If} $0 != ""
        DetailPrint "The retired search service was kept (declined or failed). File search uses Everything and is unaffected."
      ${EndIf}
      Goto spark233_legacy_search_done
      spark233_legacy_search_missing:
        DetailPrint "The legacy search cleanup script is missing; no machine service was changed."
      spark233_legacy_search_done:
    ${Else}
      DetailPrint "Silent setup skips the elevation needed to remove the retired search service."
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  !insertmacro spark233RemoveLegacySearchService
!macroend

!macro customUnInstall
  ; Electron-builder also runs the old uninstaller during an update; the new
  ; install performs the cleanup, so only a real uninstall repeats it here.
  ${IfNot} ${isUpdated}
    !insertmacro spark233RemoveLegacySearchService
  ${EndIf}
!macroend
