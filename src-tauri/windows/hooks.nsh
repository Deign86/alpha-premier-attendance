; NSIS hook to bundle WebView2Loader.dll when building with the GNU toolchain.
; Under x86_64-pc-windows-gnu, webview2-com-sys links dynamically to WebView2Loader.dll.
; Under x86_64-pc-windows-msvc, WebView2Loader is linked statically, so the file is not present.
; Using /nonfatal ensures the installer builds successfully on both MSVC and GNU toolchains.

!macro NSIS_HOOK_POSTINSTALL
  File /nonfatal "${MAINBINARYSRCPATH}\..\WebView2Loader.dll"
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  Delete "$INSTDIR\WebView2Loader.dll"
!macroend
