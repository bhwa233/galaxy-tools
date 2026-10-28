#include "clipboard-common.h"
#include <winrt/Windows.Data.Json.h>
#include <winrt/Windows.Foundation.Collections.h>
#include <atomic>
#include <thread>
#include <algorithm>
#include <memory>
#include <cwctype>
#include <wincodec.h>
#include <mutex>

namespace {
using namespace winrt::Windows::Data::Json;
std::wstring sessionId;
std::filesystem::path spool;
HWND listenerWindow = nullptr;
std::atomic_bool finished{false};
bool configured = false, paused = true;
std::vector<std::wstring> excludedApps;
DWORD ownSequence = 0;
DWORD observedSequence = 0;
uint64_t snapshotIndex = 0;
DWORD hostPid = 0, targetPid = 0;
HWND pasteTarget = nullptr;
FILETIME targetCreated{};
constexpr UINT kInput = WM_APP + 37, kEof = WM_APP + 38,kImageResult=WM_APP+39;
std::mutex outputMutex;
std::thread imageWorker;
bool imageBusy = false;
struct ImageResult {std::wstring id;bool ok=false;std::string error;};

std::wstring Lower(std::wstring value) {
    std::transform(value.begin(), value.end(), value.begin(), [](wchar_t ch) { return static_cast<wchar_t>(towlower(ch)); }); return value;
}
JsonObject Event(const wchar_t* type) {
    JsonObject event;
    event.SetNamedValue(L"protocol", JsonValue::CreateNumberValue(1));
    event.SetNamedValue(L"sessionId", JsonValue::CreateStringValue(sessionId));
    event.SetNamedValue(L"type", JsonValue::CreateStringValue(type));
    return event;
}
void Send(const JsonObject& event) { const auto line=winrt::to_string(event.Stringify());std::scoped_lock lock(outputMutex);std::cout << line << std::endl; }
void Reply(const std::wstring& id, bool ok, const std::string& error = {}) {
    auto event = Event(L"response");
    event.SetNamedValue(L"id", JsonValue::CreateStringValue(id));
    event.SetNamedValue(L"ok", JsonValue::CreateBooleanValue(ok));
    if (!error.empty()) event.SetNamedValue(L"error", JsonValue::CreateStringValue(winrt::to_hstring(error)));
    Send(event);
}
std::vector<Format> CollectFormats(bool markers = false) {
    std::vector<Format> formats; size_t total = 0;
    for (UINT id = EnumClipboardFormats(0); id; id = EnumClipboardFormats(id)) {
        auto name = FormatName(id);
        if (!Allowed(id, name) && !(markers && (name == L"CanIncludeInClipboardHistory" || name == L"ExcludeClipboardContentFromMonitorProcessing"))) continue;
        auto bytes = Read(id); total += bytes.size();
        if (total > kMaximumBytes || formats.size() >= 10) throw std::runtime_error("clipboard snapshot exceeds 64 MiB");
        formats.push_back({id, std::move(name), std::move(bytes)});
    }
    return formats;
}
void Save(const std::filesystem::path& file, const std::vector<Format>& formats) {
    auto partial = file; partial += L".partial";
    std::ofstream out(partial, std::ios::binary | std::ios::trunc);
    U32(out, 0x31424353); U32(out, static_cast<uint32_t>(formats.size()));
    for (const auto& format : formats) {
        U32(out, format.id); U32(out, static_cast<uint32_t>(format.name.size())); U32(out, static_cast<uint32_t>(format.bytes.size()));
        out.write(reinterpret_cast<const char*>(format.name.data()), static_cast<std::streamsize>(format.name.size()*2));
        out.write(reinterpret_cast<const char*>(format.bytes.data()), static_cast<std::streamsize>(format.bytes.size()));
    }
    out.flush();
    if (!out) throw std::runtime_error("snapshot spool write failed");
    out.close();
    if (!MoveFileExW(partial.c_str(), file.c_str(), MOVEFILE_WRITE_THROUGH)) throw std::runtime_error("snapshot atomic publication failed");
}
JsonObject Source() {
    auto source = JsonObject{};
    const auto owner = GetClipboardOwner(); DWORD pid = 0;
    if (owner) GetWindowThreadProcessId(owner, &pid);
    std::wstring executable, title;
    if (pid) {
        auto process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (process) { wchar_t buffer[32768]; DWORD size = ARRAYSIZE(buffer); if (QueryFullProcessImageNameW(process,0,buffer,&size)) executable.assign(buffer,size); CloseHandle(process); }
    }
    if (owner) { wchar_t buffer[513]{}; const auto size = GetWindowTextW(owner,buffer,ARRAYSIZE(buffer)); if (size>0) title.assign(buffer,size); }
    source.SetNamedValue(L"pid",JsonValue::CreateNumberValue(pid));
    source.SetNamedValue(L"executable",JsonValue::CreateStringValue(executable));
    source.SetNamedValue(L"title",JsonValue::CreateStringValue(title));
    return source;
}
void CaptureChange() {
    if (!configured || paused || finished || GetClipboardSequenceNumber() == ownSequence) return;
    Clipboard clipboard;
    const auto sequence = GetClipboardSequenceNumber();
    if (sequence == ownSequence || sequence == observedSequence) return;
    observedSequence = sequence;
    if (Sensitive()) { auto suppressed=Event(L"suppressed"); suppressed.SetNamedValue(L"reason",JsonValue::CreateStringValue(L"sensitive"));Send(suppressed);return; }
    const auto origin = RegisterClipboardFormatW(L"spark233.Clipboard.Origin");
    if (IsClipboardFormatAvailable(origin)) return;
    const auto source = Source();
    const auto executable = Lower(std::wstring(source.GetNamedString(L"executable")));
    const auto name = Lower(std::filesystem::path(executable).filename().wstring());
    for (const auto& excluded : excludedApps) if (excluded == executable || excluded == name) return;
    const auto formats = CollectFormats();
    if (formats.empty()) return;
    const auto filename = L"snapshot-" + std::to_wstring(GetClipboardSequenceNumber()) + L"-" + std::to_wstring(++snapshotIndex) + L".scb";
    Save(spool / filename, formats);
    auto event = Event(L"snapshot");
    event.SetNamedValue(L"file",JsonValue::CreateStringValue(filename));
    event.SetNamedValue(L"sequence",JsonValue::CreateNumberValue(GetClipboardSequenceNumber()));
    event.SetNamedValue(L"source",source);
    Send(event);
}
std::vector<Format> Load(const std::filesystem::path& file) {
    if (std::filesystem::file_size(file) > kMaximumBytes + 8192) throw std::runtime_error("restore exceeds limit");
    std::ifstream in(file,std::ios::binary);
    if (U32(in) != 0x31424353) throw std::runtime_error("invalid restore header");
    const auto count=U32(in); if (!count || count>8) throw std::runtime_error("invalid restore format count");
    std::vector<Format> formats;size_t total=0;
    for(uint32_t i=0;i<count;++i){
        const auto id=U32(in), length=U32(in), bytes=U32(in);total+=bytes;
        if(length>255||total>kMaximumBytes)throw std::runtime_error("invalid restore lengths");
        Format format{id,std::wstring(length,L'\0'),std::vector<uint8_t>(bytes)};
        in.read(reinterpret_cast<char*>(format.name.data()),length*2);in.read(reinterpret_cast<char*>(format.bytes.data()),bytes);
        if(!in||!Allowed(id,format.name))throw std::runtime_error("unsupported restore format");
        formats.push_back(std::move(format));
    }
    if(in.peek()!=std::char_traits<char>::eof())throw std::runtime_error("trailing restore data");
    return formats;
}
struct PreparedFormats {
    std::vector<std::pair<UINT,HGLOBAL>> handles;
    explicit PreparedFormats(const std::vector<Format>& formats) {
        try { for(const auto& format:formats){
            const auto id=format.name.empty()?format.id:RegisterClipboardFormatW(format.name.c_str());
            if(!id)throw std::runtime_error("format registration failed");
            auto memory=GlobalAlloc(GMEM_MOVEABLE|GMEM_ZEROINIT,format.bytes.empty()?1:format.bytes.size());
            if(!memory)throw std::runtime_error("clipboard allocation failed before transaction");
            handles.emplace_back(id,memory);
            auto data=GlobalLock(memory);if(!data)throw std::runtime_error("clipboard allocation lock failed");
            if(!format.bytes.empty())memcpy(data,format.bytes.data(),format.bytes.size());GlobalUnlock(memory);
        }} catch(...) { clear();throw; }
    }
    ~PreparedFormats(){clear();}
    void clear(){for(auto& [id,memory]:handles)if(memory)GlobalFree(memory);handles.clear();}
    bool commit(){for(auto& [id,memory]:handles){if(!SetClipboardData(id,memory))return false;memory=nullptr;}return true;}
};
void Replay(const std::filesystem::path& file) {
    auto formats=Load(file);
    formats.push_back({0,L"spark233.Clipboard.Origin",WideBytes(sessionId+std::wstring(1,L'\0'))});
    PreparedFormats replacement(formats);
    Clipboard clipboard;
    PreparedFormats rollback(CollectFormats(true));
    if(!EmptyClipboard())throw std::runtime_error("clipboard transaction clear failed");
    if(!replacement.commit()){
        const bool restored=EmptyClipboard()&&rollback.commit();
        ownSequence=GetClipboardSequenceNumber();
        throw std::runtime_error(restored?"clipboard write failed; supported original formats restored":"clipboard write and rollback failed; history remains intact");
    }
    ownSequence=GetClipboardSequenceNumber();
}
FILETIME ProcessCreated(DWORD pid) {
    auto process=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,pid);
    if(!process)throw std::runtime_error("target application cannot be inspected; permission denied");
    FILETIME created{},exited{},kernel{},user{};const bool ok=GetProcessTimes(process,&created,&exited,&kernel,&user)!=FALSE;CloseHandle(process);
    if(!ok)throw std::runtime_error("target application lifetime check failed");return created;
}
void RememberTarget(){
    pasteTarget=nullptr;targetPid=0;targetCreated={};
    const auto foreground=GetForegroundWindow();DWORD pid=0;if(foreground)GetWindowThreadProcessId(foreground,&pid);
    if(!foreground||!pid||pid==hostPid||pid==GetCurrentProcessId())throw std::runtime_error("no external paste target is available");
    const auto created=ProcessCreated(pid);pasteTarget=foreground;targetPid=pid;targetCreated=created;
}
HWND CheckedTarget(){
    DWORD pid=0;if(pasteTarget&&IsWindow(pasteTarget))GetWindowThreadProcessId(pasteTarget,&pid);
    if(!pid||pid!=targetPid)throw std::runtime_error("paste target closed; open the launcher from the target application again");
    const auto created=ProcessCreated(pid);
    if(CompareFileTime(&created,&targetCreated)!=0)throw std::runtime_error("paste target process changed");return pasteTarget;
}
void Paste(HWND target){
    if(GetForegroundWindow()!=target){SetForegroundWindow(target);if(GetForegroundWindow()!=target)throw std::runtime_error("copied, but restoring target focus was denied; paste manually");}
    if(GetAsyncKeyState(VK_CONTROL)<0||GetAsyncKeyState(VK_MENU)<0||GetAsyncKeyState(VK_SHIFT)<0||GetAsyncKeyState(VK_LWIN)<0||GetAsyncKeyState(VK_RWIN)<0)
        throw std::runtime_error("copied, but release modifier keys before pasting");
    INPUT input[4]{};for(auto& value:input)value.type=INPUT_KEYBOARD;
    input[0].ki.wVk=VK_CONTROL;input[1].ki.wVk='V';input[2].ki.wVk='V';input[2].ki.dwFlags=KEYEVENTF_KEYUP;input[3].ki.wVk=VK_CONTROL;input[3].ki.dwFlags=KEYEVENTF_KEYUP;
    const auto count=SendInput(ARRAYSIZE(input),input,sizeof(INPUT));
    if(count!=ARRAYSIZE(input)){
        INPUT releases[2]{};for(auto& value:releases){value.type=INPUT_KEYBOARD;value.ki.dwFlags=KEYEVENTF_KEYUP;}releases[0].ki.wVk='V';releases[1].ki.wVk=VK_CONTROL;SendInput(ARRAYSIZE(releases),releases,sizeof(INPUT));
        throw std::runtime_error("copied, but simulated paste was denied (possibly UIPI/elevated application)");
    }
}
void ConvertImage(const std::filesystem::path& source,const std::filesystem::path& destination) {
    const auto bytes=std::filesystem::file_size(source);
    if(bytes<24 || bytes>kMaximumBytes)throw std::runtime_error("image conversion exceeds size budget");
    std::ifstream input(source,std::ios::binary);std::vector<BYTE> content(static_cast<size_t>(bytes));input.read(reinterpret_cast<char*>(content.data()),static_cast<std::streamsize>(content.size()));
    if(!input)throw std::runtime_error("image conversion input read failed");
    auto partial=destination;partial+=L".partial";
    try {
        {
            winrt::com_ptr<IWICImagingFactory> factory;winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory,nullptr,CLSCTX_INPROC_SERVER,IID_PPV_ARGS(factory.put())));
            winrt::com_ptr<IWICStream> stream;winrt::check_hresult(factory->CreateStream(stream.put()));winrt::check_hresult(stream->InitializeFromMemory(content.data(),static_cast<DWORD>(content.size())));
            winrt::com_ptr<IWICBitmapDecoder> decoder;winrt::check_hresult(factory->CreateDecoderFromStream(stream.get(),nullptr,WICDecodeMetadataCacheOnLoad,decoder.put()));
            winrt::com_ptr<IWICBitmapFrameDecode> frame;winrt::check_hresult(decoder->GetFrame(0,frame.put()));
            UINT width=0,height=0;winrt::check_hresult(frame->GetSize(&width,&height));
            if(!width||!height||width>65536||height>65536||static_cast<uint64_t>(width)*height>100000000)throw std::runtime_error("image dimensions exceed conversion budget");
            winrt::com_ptr<IWICStream> output;winrt::check_hresult(factory->CreateStream(output.put()));winrt::check_hresult(output->InitializeFromFilename(partial.c_str(),GENERIC_WRITE));
            winrt::com_ptr<IWICBitmapEncoder> encoder;winrt::check_hresult(factory->CreateEncoder(GUID_ContainerFormatPng,nullptr,encoder.put()));winrt::check_hresult(encoder->Initialize(output.get(),WICBitmapEncoderNoCache));
            winrt::com_ptr<IWICBitmapFrameEncode> encoded;winrt::check_hresult(encoder->CreateNewFrame(encoded.put(),nullptr));winrt::check_hresult(encoded->Initialize(nullptr));winrt::check_hresult(encoded->SetSize(width,height));
            auto pixel=GUID_WICPixelFormat32bppBGRA;winrt::check_hresult(encoded->SetPixelFormat(&pixel));
            winrt::com_ptr<IWICFormatConverter> converter;winrt::check_hresult(factory->CreateFormatConverter(converter.put()));winrt::check_hresult(converter->Initialize(frame.get(),pixel,WICBitmapDitherTypeNone,nullptr,0,WICBitmapPaletteTypeCustom));
            winrt::check_hresult(encoded->WriteSource(converter.get(),nullptr));winrt::check_hresult(encoded->Commit());winrt::check_hresult(encoder->Commit());
        }
        if(!MoveFileExW(partial.c_str(),destination.c_str(),MOVEFILE_WRITE_THROUGH))throw std::runtime_error("converted PNG publication failed");
    } catch(...) {std::error_code ignored;std::filesystem::remove(partial,ignored);throw;}
}
void Command(const std::string& line) {
    std::wstring id;
    try {
        if(line.size()>65536)throw std::runtime_error("request exceeds 64 KiB");
        const auto request=JsonObject::Parse(winrt::to_hstring(line));
        if(request.GetNamedNumber(L"protocol",0)!=1)throw std::runtime_error("unsupported clipboard protocol");
        id=request.GetNamedString(L"id");
        if(id.empty()||id.size()>80||request.GetNamedString(L"sessionId")!=sessionId)throw std::runtime_error("invalid request identity");
        const auto operation=request.GetNamedString(L"operation");
        if(operation==L"configure"){
            paused=request.GetNamedBoolean(L"paused",false);
            excludedApps.clear();
            for(const auto& value:request.GetNamedArray(L"excludedApps",JsonArray{}))excludedApps.push_back(Lower(std::wstring(value.GetString())));
            if(excludedApps.size()>256)throw std::runtime_error("too many excluded applications");
            configured=true;Reply(id,true);
        }else if(operation==L"convert-image"){
            const std::filesystem::path input(std::wstring(request.GetNamedString(L"input"))),output(std::wstring(request.GetNamedString(L"output")));
            if(input.empty()||output.empty()||input.has_parent_path()||output.has_parent_path()||input.extension()!=L".bmp"||output.extension()!=L".png")throw std::runtime_error("image conversion requires private spool basenames");
            const auto source=std::filesystem::canonical(spool/input),destination=spool/output;
            if(source.parent_path()!=spool||std::filesystem::exists(destination))throw std::runtime_error("invalid image conversion scope");
            if(imageBusy)throw std::runtime_error("An image conversion is already running");
            if(imageWorker.joinable())imageWorker.join();
            imageBusy=true;
            imageWorker=std::thread([source,destination,id]{
                auto result=std::make_unique<ImageResult>();result->id=id;bool initialized=false;
                try{winrt::init_apartment(winrt::apartment_type::multi_threaded);initialized=true;ConvertImage(source,destination);result->ok=true;}catch(const std::exception& error){result->error=error.what();}catch(...){result->error="Windows image conversion failed";}
                if(initialized)winrt::uninit_apartment();
                if(!finished&&PostMessageW(listenerWindow,kImageResult,0,reinterpret_cast<LPARAM>(result.get())))result.release();
            });
        }else if(operation==L"remember"){
            RememberTarget();Reply(id,true);
        }else if(operation==L"restore"||operation==L"paste"){
            const std::filesystem::path filename(std::wstring(request.GetNamedString(L"file")));
            if(filename.empty()||filename.has_parent_path()||filename.extension()!=L".scb")throw std::runtime_error("restore file must be a private spool basename");
            const auto target=std::filesystem::canonical(spool/filename);
            if(target.parent_path()!=spool)throw std::runtime_error("restore path escaped spool");
            const auto destination=operation==L"paste"?CheckedTarget():nullptr;
            Replay(target);if(destination)Paste(destination);Reply(id,true);
        }else if(operation==L"stop"){
            configured=false;paused=true;RemoveClipboardFormatListener(listenerWindow);Reply(id,true);finished=true;PostQuitMessage(0);
        }else throw std::runtime_error("unknown native clipboard operation");
    }catch(const std::exception& error){Reply(id,false,error.what());}
    catch(...){Reply(id,false,"invalid native clipboard request");}
}
LRESULT CALLBACK WindowProc(HWND window,UINT message,WPARAM wparam,LPARAM lparam){
    if(message==WM_CLIPBOARDUPDATE){try{CaptureChange();}catch(const std::exception& error){auto event=Event(L"error");event.SetNamedValue(L"error",JsonValue::CreateStringValue(winrt::to_hstring(error.what())));Send(event);}catch(...){auto event=Event(L"error");event.SetNamedValue(L"error",JsonValue::CreateStringValue(L"native clipboard capture failed"));Send(event);}return 0;}
    if(message==kInput){auto line=std::unique_ptr<std::string>(reinterpret_cast<std::string*>(lparam));Command(*line);return 0;}
    if(message==kImageResult){imageBusy=false;auto result=std::unique_ptr<ImageResult>(reinterpret_cast<ImageResult*>(lparam));Reply(result->id,result->ok,result->error);return 0;}
    if(message==kEof){finished=true;PostQuitMessage(0);return 0;}
    return DefWindowProcW(window,message,wparam,lparam);
}
}

int wmain(int argc,wchar_t** argv){
    try{
        // This explicit conversion path never registers a clipboard listener or
        // opens any clipboard. It also permits controlled image-only validation.
        if(argc==4&&std::wstring_view(argv[1])==L"--convert-image"){
            winrt::init_apartment(winrt::apartment_type::single_threaded);ConvertImage(std::filesystem::path(argv[2]),std::filesystem::path(argv[3]));winrt::uninit_apartment();return 0;
        }
        std::wstring mode;
        for(int i=1;i<argc;++i){const std::wstring value(argv[i]);
            if(value.starts_with(L"--spark233-session="))sessionId=value.substr(19);
            else if(value.starts_with(L"--spark233-spool="))spool=value.substr(17);
            else if(value.starts_with(L"--spark233-mode="))mode=value.substr(16);
            else if(value.starts_with(L"--spark233-host-pid="))hostPid=std::stoul(value.substr(20));
            else throw std::runtime_error("unknown clipboard service argument");
        }
        if(!hostPid||sessionId.empty()||sessionId.size()>80||sessionId.find_first_not_of(L"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")!=std::wstring::npos)throw std::runtime_error("invalid clipboard service session");
        if(!spool.is_absolute()||!std::filesystem::is_directory(spool))throw std::runtime_error("private spool must already exist");
        spool=std::filesystem::canonical(spool);
        if(mode==L"production")productionAccess=true;
        else if(mode==L"isolated")RequireIsolation();
        else throw std::runtime_error("explicit clipboard execution mode required");
        winrt::init_apartment(winrt::apartment_type::single_threaded);
        WNDCLASSW type{};type.lpfnWndProc=WindowProc;type.hInstance=GetModuleHandleW(nullptr);type.lpszClassName=L"spark233.Clipboard.Listener";
        if(!RegisterClassW(&type))throw std::runtime_error("clipboard listener class failed");
        listenerWindow=CreateWindowExW(0,type.lpszClassName,L"spark233 clipboard",0,0,0,0,0,HWND_MESSAGE,nullptr,type.hInstance,nullptr);
        if(!listenerWindow||!AddClipboardFormatListener(listenerWindow))throw std::runtime_error("clipboard listener registration failed");
        auto ready=Event(L"ready");ready.SetNamedValue(L"pid",JsonValue::CreateNumberValue(GetCurrentProcessId()));ready.SetNamedValue(L"station",JsonValue::CreateStringValue(ObjectName(GetProcessWindowStation())));Send(ready);
        std::thread reader([]{
            std::string pending;const auto input=GetStdHandle(STD_INPUT_HANDLE);
            while(!finished){
                DWORD available=0;if(!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr)){PostMessageW(listenerWindow,kEof,0,0);break;}
                if(!available){Sleep(20);continue;}
                char buffer[4096];DWORD count=0;
                if(!ReadFile(input,buffer,static_cast<DWORD>(std::min<size_t>(sizeof(buffer),available)),&count,nullptr)||!count){PostMessageW(listenerWindow,kEof,0,0);break;}
                pending.append(buffer,count);
                size_t newline;
                while((newline=pending.find('\n'))!=std::string::npos){auto line=new std::string(pending.substr(0,newline));pending.erase(0,newline+1);if(!PostMessageW(listenerWindow,kInput,0,reinterpret_cast<LPARAM>(line)))delete line;}
                if(pending.size()>65536){PostMessageW(listenerWindow,kEof,0,0);break;}
            }
        });
        MSG message;while(GetMessageW(&message,nullptr,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}
        finished=true;reader.join();if(imageWorker.joinable())imageWorker.join();RemoveClipboardFormatListener(listenerWindow);DestroyWindow(listenerWindow);
        auto stopped=Event(L"stopped");Send(stopped);return 0;
    }catch(const std::exception& error){std::cerr<<error.what()<<": "<<GetLastError()<<std::endl;return 1;}
    catch(...){std::cerr<<"native clipboard initialization failed"<<std::endl;return 1;}
}
