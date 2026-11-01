[CmdletBinding()]
param(
    [string]$OutputRoot = (Join-Path $PSScriptRoot '../../local-build/spark233/native-capture'),
    [string]$SourceRoot
)
$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
Get-Command node -ErrorAction Stop | Out-Null
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$sources = if ($SourceRoot) { [IO.Path]::GetFullPath($SourceRoot) } else { Join-Path $OutputRoot 'sources' }
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
    # Reuse the installed tar package: Windows tar.exe decodes non-ASCII Git
    # archive names using the host locale, breaking pinned Chinese resource paths.
    Push-Location $repo
    try {
        & node -e "require('tar').x({file:process.argv[1],cwd:process.argv[2],strict:true}).catch(error=>{console.error(error);process.exitCode=1})" (Join-Path $adapted "$($source.name).tar") $target
        if ($LASTEXITCODE) { throw 'tar extraction failed' }
    } finally { Pop-Location }
}

function Edit-Exact([string]$File, [string]$Before, [string]$After) {
    $text = [IO.File]::ReadAllText($File)
    if (-not $text.Contains($Before)) { throw "Upstream adaptation anchor changed: $File" }
    [IO.File]::WriteAllText($File, $text.Replace($Before, $After))
}

$capture = Join-Path $adapted 'ScreenCapture/Src'
$reader = Join-Path $adapted 'ImageReader/ImageReader'
# rc.exe resolves resource filenames through the machine ANSI code page even
# with /c65001. Keep the embedded resource ID and JSON bytes, use an ASCII alias.
Copy-Item -LiteralPath (Join-Path $adapted 'ScreenCapture/Lang/简体中文.zh-CN.json') -Destination (Join-Path $adapted 'ScreenCapture/Lang/zh-CN.json')
Edit-Exact (Join-Path $capture 'Res/Resource.rc') '../../Lang/简体中文.zh-CN.json' '../../Lang/zh-CN.json'

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
Edit-Exact $mainTool '#include "../Lang.h"' "#include `"../Lang.h`"`n#include `"../SessionResult.h`""
Edit-Exact $mainTool 'tip->bind(btn, Lang::get(std::format(L"tool.{}", id)));' @'
auto label = Lang::get(std::format(L"tool.{}", id));
            if (id == L"pin" && Spark233Session::enabled() &&
                Spark233Session::argument(L"--spark233-pin-host") == L"true") label += L" (Ctrl+P)";
            tip->bind(btn, label);
'@
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
    if (Spark233Session::enabled() && !hostPinFallback && Spark233Session::argument(L"--spark233-pin-host") == L"true") {
        if (hostPinPending) return;
        try {
            if (editingText) editingText->finishEdit();
            std::vector<BYTE> composed, original;
            D2D1_SIZE_U size{}, originalSize{};
            if (!getImagePixels(composed, size) || !getImagePixels(original, originalSize, false))
                throw std::runtime_error("Cannot read the editable pin image");
            if (size.width != originalSize.width || size.height != originalSize.height)
                throw std::runtime_error("Pin source image dimensions changed");
            const auto directory = Spark233Session::directory();
            const auto writeImage = [&](const wchar_t* filename, const std::vector<BYTE>& pixels) {
                const auto target = directory / filename;
                const auto partial = std::filesystem::path(target.wstring() + L".partial");
                Spark233Session::writePng(partial, size.width, size.height, pixels.data());
                if (!MoveFileExW(partial.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
                    throw std::runtime_error("Cannot commit the pin image");
            };
            const auto document = Spark233PinDocument::save(*this);
            writeImage(L"pin.png", composed);
            writeImage(L"pin-source.png", original);
            Spark233PinDocument::publish(directory / L"pin-document.json", document);
            if (hostPinAttempt >= 1000000) throw std::runtime_error("Pin attempt limit reached");
            ++hostPinAttempt;
            auto result = Spark233Session::envelope(L"pin");
            result.SetNamedValue(L"action", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"pin"));
            result.SetNamedValue(L"image", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"pin.png"));
            result.SetNamedValue(L"source", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"pin-source.png"));
            result.SetNamedValue(L"document", winrt::Windows::Data::Json::JsonValue::CreateStringValue(L"pin-document.json"));
            Spark233PinDocument::number(result, L"attempt", hostPinAttempt);
            Spark233PinDocument::number(result, L"width", size.width);
            Spark233PinDocument::number(result, L"height", size.height);
            Spark233PinDocument::number(result, L"scale", scale);
            RECT actual{};
            if (!GetWindowRect(hwnd, &actual)) throw std::runtime_error("Cannot read pin window bounds");
            Spark233PinDocument::number(result, L"x", actual.left);
            Spark233PinDocument::number(result, L"y", actual.top);
            winrt::Windows::Data::Json::JsonObject bounds;
            Spark233PinDocument::number(bounds, L"x", actual.left);
            Spark233PinDocument::number(bounds, L"y", actual.top);
            Spark233PinDocument::number(bounds, L"width", actual.right - actual.left);
            Spark233PinDocument::number(bounds, L"height", actual.bottom - actual.top);
            result.SetNamedValue(L"bounds", bounds);
            const auto ownerText = Spark233Session::argument(L"--spark233-pin-owner-pid");
            if (ownerText.empty()) throw std::runtime_error("Missing pin host identity");
            if (!ownerText.empty()) {
                if (ownerText.find_first_not_of(L"0123456789") != std::wstring::npos)
                    throw std::runtime_error("Invalid pin host identity");
                const auto owner = wcstoul(ownerText.c_str(), nullptr, 10);
                if (!owner || owner == GetCurrentProcessId()) throw std::runtime_error("Invalid pin host identity");
                hostPinOwner = OpenProcess(SYNCHRONIZE, FALSE, owner);
                if (!hostPinOwner) {
                    hostPinFallback = true;
                    throw std::runtime_error("Pin host no longer exists");
                }
            }
            Spark233PinDocument::publish(directory / L"pin.json", result);
            hostPinPending = true;
            shapeHover = nullptr;
            toolMain->cancelSelect();
            toolMain->hide();
            toolSub->hideTools();
            setTimer(100, hostPinTimer);
            Spark233Session::trace("pin-awaiting-host");
            refresh();
        } catch (...) {
            if (hostPinOwner) { CloseHandle(hostPinOwner); hostPinOwner = nullptr; }
            Spark233Session::trace("pin-publish-failed");
            MessageBoxW(hwnd, L"Cannot hand this editable pin to the desktop. The editor and annotations have been retained.", L"spark233", MB_OK | MB_ICONERROR);
        }
        return;
    }
    if (editingText) editingText->finishEdit();
    shapeHover = nullptr;
    toolMain->cancelSelect();
    toolMain->hide();
    toolSub->hideTools();
    refresh();
}

void WinPin::onDown(POINT pos, BOOL isRight)
'@

# Persist the original bitmap plus the existing editable History objects before
# handing a read-only pin to the host. No upstream shape is flattened or replaced.
Copy-Item (Join-Path $PSScriptRoot 'PinDocument.h') (Join-Path $capture 'PinDocument.h')
foreach ($shapeName in @('ShapeRect', 'ShapeEllipse', 'ShapeArrow', 'ShapeLine', 'ShapeNumber', 'ShapeText', 'ShapeMosaic', 'ShapeEraser')) {
    $shapeHeader = Join-Path $capture "Shape/$shapeName.h"
    $shapeAnchor = "class $shapeName : public ShapeBase`r`n{"
    Edit-Exact $shapeHeader $shapeAnchor ($shapeAnchor + "`r`n    friend struct Spark233PinDocument;")
}
Edit-Exact $pinWindow '#include "WinPin.h"' "#include `"WinPin.h`"`n#include `"../SessionResult.h`"`n#include `"../PinDocument.h`""
Edit-Exact $pinWindow "void WinPin::onCreated()`r`n{" @'
void WinPin::onCreated()
{
    if (Spark233Session::enabled()) {
        const bool english = Spark233Session::argument(L"--spark233-locale") == L"en-US";
        SetWindowTextW(hwnd, english ? L"spark233 Screenshot annotations" : L"spark233 截图标注");
        SetWindowTextW(toolMain->hwnd, english ? L"spark233 Screenshot toolbar" : L"spark233 截图工具栏");
        if (Spark233Session::argument(L"--spark233-pin-host") == L"true") {
            // The host closes this temporary editing work surface after pin
            // handoff. Keep it reachable through Alt+Tab while annotations are
            // active; permanent pins remain in the host's taskbar-free layer.
            const LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, (style & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW);
            SetWindowPos(hwnd, nullptr, 0, 0, 0, 0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
        }
    }
'@
Edit-Exact $pinHeader 'void pin();' @'
void pin();
    static void editPinnedDocument();
'@
Edit-Exact $pinHeader 'bool dpiChanged{ false };' @'
bool dpiChanged{ false };
    bool hostPinPending{ false };
    bool hostPinFallback{ false };
    HANDLE hostPinOwner{ nullptr };
    unsigned hostPinAttempt{ 0 };
    static constexpr UINT hostPinTimer{ 0x53A1 };
'@
Edit-Exact $pinWindow "WinPin::~WinPin()`r`n{" "WinPin::~WinPin()`r`n{`r`n    if (hostPinOwner) CloseHandle(hostPinOwner);"
Edit-Exact $pinHeader 'bool getImagePixels(std::vector<BYTE>& pixels, D2D1_SIZE_U& size);' 'bool getImagePixels(std::vector<BYTE>& pixels, D2D1_SIZE_U& size, bool annotations = true);'
Edit-Exact $pinWindow 'bool WinPin::getImagePixels(std::vector<BYTE>& pixels, D2D1_SIZE_U& size)' 'bool WinPin::getImagePixels(std::vector<BYTE>& pixels, D2D1_SIZE_U& size, bool annotations)'
$pinText = [IO.File]::ReadAllText($pinWindow)
$pixelsStart = $pinText.IndexOf('bool WinPin::getImagePixels')
if ($pixelsStart -lt 0 -or -not $pinText.Substring($pixelsStart).Contains('if (!shape->isUndo)')) { throw 'Upstream pin pixel export anchor changed' }
[IO.File]::WriteAllText($pinWindow, $pinText.Substring(0, $pixelsStart) + $pinText.Substring($pixelsStart).Replace('if (!shape->isUndo)', 'if (annotations && !shape->isUndo)'))

foreach ($signature in @('void WinPin::onDown(POINT pos, BOOL isRight)', 'void WinPin::onMove(POINT pos)', 'void WinPin::onUp(POINT pos, BOOL isRight)', 'void WinPin::onKey(UINT key)')) {
    Edit-Exact $pinWindow ($signature + "`r`n{") ($signature + "`r`n{`r`n    if (hostPinPending) return;")
}
Edit-Exact $pinWindow "if (ctrl && key == 'Z')" @'
if (ctrl && key == 'P' && Spark233Session::enabled() &&
        Spark233Session::argument(L"--spark233-pin-host") == L"true") {
        pin();
    }
    else if (ctrl && key == 'Z')
'@
Edit-Exact $pinWindow 'onMouseWheel.add([this](POINT pos, float space) {' @'
onMouseWheel.add([this](POINT pos, float space) {
        if (hostPinPending) return;
'@
Edit-Exact $pinWindow "void WinPin::onTimerCB(UINT id)`r`n{" @'
void WinPin::onTimerCB(UINT id)
{
    if (id == hostPinTimer && hostPinPending) {
        const auto session = winrt::to_string(Spark233Session::argument(L"--spark233-session"));
        const auto identity = session + ":" + std::to_string(GetCurrentProcessId()) + ":" + std::to_string(hostPinAttempt) + ":";
        std::ifstream file(Spark233Session::directory() / L"pin.ack", std::ios::binary);
        std::string acknowledgement;
        if (file) std::getline(file, acknowledgement);
        if (!acknowledgement.empty() && acknowledgement.back() == '\r') acknowledgement.pop_back();
        const bool ownerExited = hostPinOwner && WaitForSingleObject(hostPinOwner, 0) == WAIT_OBJECT_0;
        if (acknowledgement == identity + "accepted") {
            hostPinPending = false;
            killTimer(hostPinTimer);
            if (hostPinOwner) { CloseHandle(hostPinOwner); hostPinOwner = nullptr; }
            Spark233Session::trace("pin-host-accepted");
            close();
        } else if (acknowledgement == identity + "rejected" || ownerExited) {
            hostPinPending = false;
            killTimer(hostPinTimer);
            if (hostPinOwner) { CloseHandle(hostPinOwner); hostPinOwner = nullptr; }
            if (ownerExited) hostPinFallback = true;
            layoutTools();
            toolMain->show();
            refresh();
            Spark233Session::trace(ownerExited ? "pin-owner-exited-editor-restored" : "pin-host-rejected-editor-restored");
        }
        return;
    }
'@

Edit-Exact $pinWindow 'void WinPin::initFromData(int x, int y, int w, int h, std::vector<BYTE>& data)' @'
void WinPin::editPinnedDocument()
{
    const auto directory = Spark233Session::directory();
    UINT width = 0, height = 0;
    auto pixels = Spark233PinDocument::decode(directory / L"edit-source.png", width, height);
    const auto document = Spark233PinDocument::read(directory / L"edit-document.json");
    const auto boundsFile = directory / L"edit-bounds.json";
    int left = 100, top = 100;
    float viewScale = Spark233PinDocument::number(document, L"scale");
    if (std::filesystem::exists(boundsFile)) {
        const auto bounds = Spark233PinDocument::read(boundsFile);
        left = static_cast<int>(Spark233PinDocument::number(bounds, L"x"));
        top = static_cast<int>(Spark233PinDocument::number(bounds, L"y"));
        viewScale = std::clamp(std::min(Spark233PinDocument::positive(bounds, L"width") / width,
            Spark233PinDocument::positive(bounds, L"height") / height), 0.1f, 8.f);
    }
    auto ptr = new WinPin(left, top, width, height, &pixels);
    std::unique_ptr<WinPin> owned{ptr};
    ptr->createNativeWindow(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, WS_MAXIMIZEBOX | WS_MINIMIZEBOX | WS_POPUP);
    Spark233PinDocument::restore(*ptr, document);
    const auto maxScale = std::max(1.f, std::min(8.f, 16000.f / std::max(width, height)));
    ptr->scale = std::clamp(viewScale, 0.1f, maxScale);
    ptr->applyWinSize();
    ptr->setPosition(left, top);
    ptr->layoutTools();
    ptr->refresh();
    winPins.push_back(std::move(owned));
    Spark233Session::trace("pin-document-opened");
}

void WinPin::initFromData(int x, int y, int w, int h, std::vector<BYTE>& data)
'@

Edit-Exact (Join-Path $capture 'App.cpp') '#include "App.h"' "#include `"App.h`"`n#include `"SessionResult.h`""
Edit-Exact (Join-Path $capture 'App.cpp') '    app.reset(ptr);' @'
    app.reset(ptr);
    // WinPin consults App::get() while creating its native windows.
    // Restore only after the application singleton has been assigned.
    if (Spark233Session::enabled() && Ling::App::get()->args[L"--spark233-edit-pin"] == L"true")
        WinPin::editPinnedDocument();
'@
Edit-Exact (Join-Path $capture 'App.cpp') '    if (app->args[L"--auto-quit"] == L"true") {' @'
    if (Spark233Session::enabled() && app->args[L"--spark233-edit-pin"] == L"true") {
        return;
    }
    if (app->args[L"--auto-quit"] == L"true") {
'@
Edit-Exact (Join-Path $capture 'main.cpp') '    App::init();' @'
    try { App::init(); }
    catch (...) {
        // Do not enter a fresh capture when an editable document is corrupt.
        // Returning before the message loop also avoids dispatch to partial UI.
        Spark233Session::trace(Spark233Session::argument(L"--spark233-edit-pin") == L"true" ?
            "pin-document-open-failed" : "capture-initialization-failed");
        return 1;
    }
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
