[CmdletBinding()]
param([string]$OutputRoot = (Join-Path $PSScriptRoot '../../local-build/spark233/native-capture'))
$ErrorActionPreference = 'Stop'
$tarExecutable = Join-Path $env:SystemRoot 'System32/tar.exe'
if (-not (Test-Path -LiteralPath $tarExecutable -PathType Leaf)) { throw "Windows tar is missing: $tarExecutable" }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$sources = Join-Path $OutputRoot 'sources'
$adapted = Join-Path $OutputRoot 'adapted'
New-Item -ItemType Directory -Force $adapted | Out-Null
$lock = Get-Content (Join-Path $PSScriptRoot 'sources.lock.json') -Raw | ConvertFrom-Json
foreach ($source in $lock.sources) {
    $original = Join-Path $sources $source.name
    $revision = & git -C $original rev-parse HEAD
    if ($LASTEXITCODE -or $revision -ne $source.revision) { throw "Prepare pinned source first: $original" }
    $target = Join-Path $adapted $source.name
    if (Test-Path $target) { throw "Refusing to overwrite existing adapted source: $target" }
    New-Item -ItemType Directory -Force $target | Out-Null
    & git -C $original archive --format=tar -o (Join-Path $adapted "$($source.name).tar") HEAD
    if ($LASTEXITCODE) { throw 'git archive failed' }
    & $tarExecutable -xf (Join-Path $adapted "$($source.name).tar") -C $target
    if ($LASTEXITCODE) { throw 'tar extraction failed' }
}

function Edit-Exact([string]$File, [string]$Before, [string]$After) {
    $text = [IO.File]::ReadAllText($File)
    if (-not $text.Contains($Before)) { throw "Upstream adaptation anchor changed: $File" }
    [IO.File]::WriteAllText($File, $text.Replace($Before, $After))
}

$capture = Join-Path $adapted 'ScreenCapture/Src'
$reader = Join-Path $adapted 'ImageReader/ImageReader'
$header = Join-Path $PSScriptRoot '../../native/capture/SessionResult.h'
Copy-Item $header (Join-Path $capture 'SessionResult.h')
Copy-Item $header (Join-Path $reader 'SessionResult.h')
Edit-Exact (Join-Path $capture 'main.cpp') '#include "pch.h"' "#include `"pch.h`"`n#include `"SessionResult.h`""
Edit-Exact (Join-Path $capture 'main.cpp') '    App::init();' "    Spark233Session::trace(`"capture-main-start`" );`n    App::init();`n    Spark233Session::trace(`"capture-initialized`" );"
Edit-Exact (Join-Path $capture 'main.cpp') '    App::dispose();' "    Spark233Session::trace(`"capture-loop-exit`" );`n    App::dispose();"
Edit-Exact (Join-Path $capture 'Win/WinCap.cpp') '#include <include/Ling.h>' "#include <include/Ling.h>`n#include `"../SessionResult.h`""
Edit-Exact (Join-Path $capture 'Win/WinCap.cpp') '    App::get()->takeScreenShot(x, y, w, h, &screenImg);' "    Spark233Session::trace(`"capture-window-created`" );`n    App::get()->takeScreenShot(x, y, w, h, &screenImg);"
Edit-Exact (Join-Path $capture 'Win/WinCap.cpp') '    if (isClosed) return;' "    Spark233Session::trace(`"capture-window-closed`" );`n    if (isClosed) return;"
Edit-Exact (Join-Path $capture 'Win/WinCap.cpp') '    if (key == VK_ESCAPE) {' "    if (key == VK_ESCAPE) {`n        Spark233Session::trace(`"capture-escape`" );"
Edit-Exact (Join-Path $capture 'Win/WinCap.cpp') '    if (isRight) {' "    if (isRight) {`n        Spark233Session::trace(`"capture-right-click`" );"
Edit-Exact (Join-Path $capture 'Util.cpp') '#include "pch.h"' "#include `"pch.h`"`n#include `"SessionResult.h`""
Edit-Exact (Join-Path $capture 'Util.cpp') 'auto exePath = findImageReader();' @'
if (Spark233Session::enabled()) {
        // The host owns the OCR child; no detached native process. Publishing here
        // also records the selection under the OCR action.
        return Spark233Session::captureImage(w, h, data, L"ocr");
    }
    auto exePath = findImageReader();
'@
# Every completion path (copy, save, pin, long capture) funnels through these two
# helpers, so one injection point records the selection for all of them. The
# adapter claims the session image once; later completions reuse the record.
Edit-Exact (Join-Path $capture 'Util.cpp') 'if (w <= 0 || h <= 0 || !data) return;' @'
if (w <= 0 || h <= 0 || !data) return;
	Spark233Session::captureImage(w, h, data, L"copy");
'@
Edit-Exact (Join-Path $capture 'Util.cpp') 'return encodePng(stream.Get(), w, h, data);' @'
const auto wrote = encodePng(stream.Get(), w, h, data);
    // The OCR channel's own temporary file is not a user save: it keeps the
    // selection under its OCR action instead of claiming a second record.
    if (wrote && std::filesystem::path(path) != Spark233Session::selectionPath())
        Spark233Session::captureImage(w, h, data, L"save");
    return wrote;
'@
Edit-Exact (Join-Path $capture 'Setting.cpp') '#include "pch.h"' "#include `"pch.h`"`n#include `"SessionResult.h`""
Edit-Exact (Join-Path $capture 'Setting.cpp') 'PWSTR pathTmp;' @'
if (Spark233Session::enabled()) return Spark233Session::directory();
    PWSTR pathTmp;
'@
Edit-Exact (Join-Path $capture 'Setting.cpp') "std::filesystem::path Setting::initConfigPath()`r`n{" @'
std::filesystem::path Setting::initConfigPath()
{
    if (Spark233Session::enabled()) return Spark233Session::directory() / L"config.json";
'@

# Recording is outside the MVP. Reuse the upstream's already-vendored cgif encoder
# instead of adding its author's unrelated Rust/gifski build tree.
$gif = Join-Path $capture 'Win/VideoGif.hpp'
Edit-Exact $gif '#include "gifski.h"' '// spark233: upstream cgif implementation below is sufficient for the MVP build.'
$gifText = [IO.File]::ReadAllText($gif)
$begin = $gifText.IndexOf('    inline void createGif(GifParam* param)')
$end = $gifText.IndexOf('    inline void createGif2(GifParam* param)', $begin)
if ($begin -lt 0 -or $end -lt 0) { throw 'Upstream GIF adaptation anchor changed' }
[IO.File]::WriteAllText($gif, $gifText.Substring(0, $begin) + $gifText.Substring($end))
Edit-Exact (Join-Path $capture 'Win/CapVideo.cpp') 'VideoGif::createGif(gifParam.get());' 'VideoGif::createGif2(gifParam.get());'

Edit-Exact (Join-Path $reader 'ImgViewer.cpp') '#include "pch.h"' "#include `"pch.h`"`n#include `"SessionResult.h`""
Edit-Exact (Join-Path $reader 'ImgViewer.cpp') 'doc.loadResult(result);' @'
doc.loadResult(result);
    if (Spark233Session::enabled()) Spark233Session::recognition(result, w, h);
'@
Edit-Exact (Join-Path $reader 'WindowMain.cpp') '#include "pch.h"' "#include `"pch.h`"`n#include `"SessionResult.h`""
Edit-Exact (Join-Path $reader 'WindowMain.cpp') 'ins->loadImgFromArgs();' @'
ins->loadImgFromArgs();
    if (Spark233Session::enabled() && Spark233Session::argument(L"--spark233-batch") == L"true")
        Ling::App::get()->quit();
'@
Edit-Exact (Join-Path $reader 'WindowMain.cpp') '    show();' @'
    if (!Spark233Session::enabled() || Spark233Session::argument(L"--spark233-batch") != L"true") show();
'@

# Session-scoped cooperative cancellation. The host writes a request containing
# the random session identity and the actual child PID, never a global signal.
Edit-Exact (Join-Path $capture 'main.cpp') '    Spark233Session::trace("capture-main-start" );' @'
    Spark233Session::ControlGuard control;
    Spark233Session::trace("capture-main-start" );
'@
Edit-Exact (Join-Path $capture 'main.cpp') '    Spark233Session::trace("capture-loop-exit" );' @'
    Spark233Session::trace("capture-loop-exit" );
    control.acknowledge();
'@
Edit-Exact (Join-Path $reader 'main.cpp') '#include "pch.h"' "#include `"pch.h`"`n#include `"SessionResult.h`""
Edit-Exact (Join-Path $reader 'main.cpp') '    WindowMain::init();' @'
    Spark233Session::ControlGuard control;
    WindowMain::init();
'@
Edit-Exact (Join-Path $reader 'main.cpp') '    WindowMain::dispose();' @'
    control.acknowledge();
    WindowMain::dispose();
'@

# OCR is optional: hide its initial toolbar entry and recheck at the action
# boundary. A disabled plugin never falls back to the upstream download page.
$tool = Join-Path $capture 'Tool/ToolCap.cpp'
Edit-Exact $tool '#include "pch.h"' "#include `"pch.h`"`n#include `"../SessionResult.h`""
Edit-Exact $tool 'for (auto& id : btnIds) {' @'
for (auto& id : btnIds) {
        if (id == L"ocr" && !ocrVisible) continue;
'@
Edit-Exact (Join-Path $capture 'Tool/ToolCap.h') 'WinCap* win;' @'
WinCap* win;
    Ling::Button* ocrButton{ nullptr };
    bool ocrVisible{ true };
    static constexpr UINT ocrTimerId{ 0x5200 };
'@
# Reuse Ling's window-owned timer and node visibility, so a running selection
# follows host availability without rebuilding the annotation UI or its state.
Edit-Exact $tool 'dpi = win->dpi;' @'
dpi = win->dpi;
    ocrVisible = Spark233Session::ocrAllowed();
    onTimer.add([this](UINT id) {
        if (id != ocrTimerId || !ocrButton) return;
        const bool available = Spark233Session::ocrAllowed();
        if (available == ocrVisible) return;
        ocrVisible = available;
        tip->hide(ocrButton);
        if (available) ocrButton->show(); else ocrButton->hide();
        refreshSize();
        this->win->layoutTool(this);
        Spark233Session::trace(available ? "capture-ocr-button-restored" : "capture-ocr-button-hidden");
    });
    onDestroy.add([this]() { killTimer(ocrTimerId); });
'@
Edit-Exact $tool 'btn->setFontSize(13.f);' @'
btn->setFontSize(13.f);
        if (btnIds[i] == L"ocr") {
            ocrButton = btn;
            if (!ocrVisible) btn->hide();
        }
'@
Edit-Exact $tool "`tshow();" @'
    if (Spark233Session::enabled()) setTimer(250, ocrTimerId);
    show();
'@
Edit-Exact (Join-Path $capture 'Win/WinCap.cpp') "void WinCap::startOcr()`r`n{" @'
void WinCap::startOcr()
{
    if (!Spark233Session::ocrAllowed()) {
        const bool english = Spark233Session::argument(L"--spark233-locale") == L"en-US";
        MessageBoxW(hwnd, english ? L"The OCR plugin is disabled. Screenshots and annotations remain available." : L"OCR 插件已停用，基础截图和标注仍可使用。", L"spark233", MB_OK | MB_ICONINFORMATION);
        return;
    }
'@
# Expose the upstream pin glyph and translations in both screenshot toolbars.
# Pinning reuses WinPin and keeps the current image/history alive; it only ends
# text editing and hides the editing controls, as the existing right-click does.
$toolHeader = Join-Path $capture 'Tool/ToolCap.h'
Edit-Exact $toolHeader 'L"spliter",L"close"' 'L"spliter",L"pin",L"close"'
Edit-Exact $toolHeader 'L"",L"\ue62d"' 'L"",L"\ue6a2",L"\ue62d"'
Edit-Exact $toolHeader 'L"",L"tool.close"' 'L"",L"tool.pin",L"tool.close"'
Edit-Exact $tool 'Lang::get(btnTips[i])' 'Lang::get(btnIds[i] == L"pin" ? L"tool.pin" : btnTips[i])'
Edit-Exact $tool 'else if (btn->id == L"long")' @'
else if (btn->id == L"pin") {
        win->startPin(true);
    }
    else if (btn->id == L"long")
'@

$mainTool = Join-Path $capture 'Tool/ToolMain.cpp'
$mainHeader = Join-Path $capture 'Tool/ToolMain.h'
Edit-Exact $mainHeader 'L"|",L"close"' 'L"|",L"pin",L"close"'
Edit-Exact $mainHeader 'L"|",L"\ue62d"' 'L"|",L"\ue6a2",L"\ue62d"'
Edit-Exact $mainTool 'else if (btn->id == L"save")' @'
else if (btn->id == L"pin") {
        tip->hide();
        win->pin();
        return;
    }
    else if (btn->id == L"save")
'@

$capWindow = Join-Path $capture 'Win/WinCap.cpp'
Edit-Exact (Join-Path $capture 'Win/WinCap.h') 'void startPin();' 'void startPin(bool pinned = false);'
Edit-Exact $capWindow 'void WinCap::startPin()' 'void WinCap::startPin(bool pinned)'
Edit-Exact $capWindow 'int(maskRect.right - maskRect.left), int(maskRect.bottom - maskRect.top));' 'int(maskRect.right - maskRect.left), int(maskRect.bottom - maskRect.top), pinned);'

$pinWindow = Join-Path $capture 'Win/WinPin.cpp'
$pinHeader = Join-Path $capture 'Win/WinPin.h'
Edit-Exact $pinHeader 'static void init(int x, int y, int w, int h);' 'static void init(int x, int y, int w, int h, bool pinned = false);'
Edit-Exact $pinHeader 'void layoutTools();' "void layoutTools();`n    void pin();"
Edit-Exact $pinWindow 'void WinPin::init(int x, int y, int w, int h)' 'void WinPin::init(int x, int y, int w, int h, bool pinned)'
Edit-Exact $pinWindow 'ptr->createNativeWindow(WS_EX_TOPMOST| WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_POPUP);' @'
ptr->createNativeWindow(WS_EX_TOPMOST| WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_POPUP);
    if (pinned) ptr->pin();
'@
Edit-Exact $pinWindow 'void WinPin::onDown(POINT pos, BOOL isRight)' @'
void WinPin::pin()
{
    if (editingText) editingText->finishEdit();
    shapeHover = nullptr;
    toolMain->cancelSelect();
    toolMain->hide();
    toolSub->hideTools();
    refresh();
}

void WinPin::onDown(POINT pos, BOOL isRight)
'@

# Headless OCR keeps one TinyOCR engine for a bounded sequence of host tasks.
# The normal ImageReader UI and screenshot protocol retain their existing entry.
Copy-Item (Join-Path $PSScriptRoot '../../native/capture/OcrWorker.h') (Join-Path $reader 'OcrWorker.h')
Edit-Exact (Join-Path $reader 'main.cpp') '#include "SessionResult.h"' "#include `"SessionResult.h`"`n#include `"OcrWorker.h`""
Edit-Exact (Join-Path $reader 'main.cpp') '    Spark233Session::ControlGuard control;' @'
    if (Spark233Session::argument(L"--spark233-worker") == L"true") {
        try { return Spark233OcrWorker::run(); }
        catch (...) { return 1; }
    }
    Spark233Session::ControlGuard control;
'@
Write-Host "Adapted pinned sources: $adapted"
