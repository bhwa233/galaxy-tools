#pragma once
#include "SessionResult.h"
#include <TinyOCR/include/tinyocr/tiny_ocr.h>
#include <wincodec.h>
#include <wrl/client.h>
#include <vector>
#include <algorithm>

// Reuse TinyOCR, WIC decoding and the existing session serializer. The upstream
// GUI accepts one image and rebuilds its engine; this headless entry adds only a
// bounded host-owned task mailbox so a single engine can serve consecutive jobs.
namespace Spark233OcrWorker {
inline std::string read(const std::filesystem::path& file) {
    if (std::filesystem::file_size(file) > 4096) throw std::runtime_error("OCR worker request exceeds 4 KiB");
    std::ifstream input(file, std::ios::binary);
    return {std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
}
inline std::vector<uint8_t> image(const std::filesystem::path& file, UINT& width, UINT& height) {
    using Microsoft::WRL::ComPtr;
    ComPtr<IWICImagingFactory> factory;
    winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(&factory)));
    ComPtr<IWICBitmapDecoder> decoder;
    winrt::check_hresult(factory->CreateDecoderFromFilename(file.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnLoad, &decoder));
    ComPtr<IWICBitmapFrameDecode> frame;
    winrt::check_hresult(decoder->GetFrame(0, &frame));
    ComPtr<IWICFormatConverter> converter;
    winrt::check_hresult(factory->CreateFormatConverter(&converter));
    winrt::check_hresult(converter->Initialize(frame.Get(), GUID_WICPixelFormat24bppBGR, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeMedianCut));
    winrt::check_hresult(converter->GetSize(&width, &height));
    if (!width || !height || width > 65536 || height > 65536 || static_cast<uint64_t>(width) * height > 100000000)
        throw std::runtime_error("OCR worker image exceeds task budget");
    std::vector<uint8_t> pixels(static_cast<size_t>(width) * height * 3);
    winrt::check_hresult(converter->CopyPixels(nullptr, width * 3, static_cast<UINT>(pixels.size()), pixels.data()));
    return pixels;
}
inline int run() {
    using namespace Spark233Session;
    winrt::init_apartment(winrt::apartment_type::multi_threaded);
    const auto workerId = argument(L"--spark233-session");
    const auto workerDirectory = directory();
    const auto taskRoot = std::filesystem::canonical(argument(L"--spark233-task-root"));
    const auto hostPid = std::stoul(argument(L"--spark233-host-pid"));
    const auto idleMs = std::clamp(std::stoul(argument(L"--spark233-worker-idle-ms")), 1000UL, 305000UL);
    HANDLE host = OpenProcess(SYNCHRONIZE, FALSE, hostPid);
    if (!host || !taskRoot.is_absolute()) throw std::runtime_error("OCR worker host/task root unavailable");
    struct HostHandle { HANDLE handle; ~HostHandle() { CloseHandle(handle); } } hostHandle{host};
    ControlGuard control;
    auto [recData, recSize] = Ling::Util::getRes(L"PP-OCRv6_rec_tiny.onnx");
    auto [detData, detSize] = Ling::Util::getRes(L"PP-OCRv6_det_tiny.onnx");
    tinyocr::Options opts;
    opts.det_model_data = detData; opts.det_model_size = detSize;
    opts.rec_model_data = recData; opts.rec_model_size = recSize;
    opts.return_word_box = true; opts.return_single_char_box = true;
    tinyocr::TinyOcr engine(opts);
    trace("ocr-worker-engine-ready");
    auto ready = envelope(L"ocr-worker");
    ready.SetNamedValue(L"engineInitializations", JsonValue::CreateNumberValue(1));
    publish(L"worker.json", ready);
    auto lastTask = std::chrono::steady_clock::now();
    unsigned long processed = 0;
    while (!cancellationRequested && WaitForSingleObject(host, 0) == WAIT_TIMEOUT) {
        if (std::chrono::steady_clock::now() - lastTask >= std::chrono::milliseconds(idleMs)) break;
        const auto requestFile = workerDirectory / L"request.json";
        if (!std::filesystem::exists(requestFile)) {
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
            continue;
        }
        const auto request = JsonObject::Parse(winrt::to_hstring(read(requestFile)));
        std::filesystem::remove(requestFile);
        if (request.GetNamedNumber(L"protocol") != 1 || request.GetNamedString(L"workerSessionId") != workerId ||
            request.GetNamedNumber(L"pid") != GetCurrentProcessId()) throw std::runtime_error("OCR worker identity mismatch");
        const std::wstring taskId(request.GetNamedString(L"sessionId"));
        if (taskId.size() != 32 || taskId.find_first_not_of(L"0123456789abcdef") != std::wstring::npos)
            throw std::runtime_error("Invalid OCR worker task identity");
        const auto taskPath = std::filesystem::canonical(taskRoot / taskId);
        if (taskPath.parent_path() != taskRoot || !std::filesystem::is_directory(taskPath))
            throw std::runtime_error("OCR worker task escaped host root");
        taskIdentity = taskId; taskDirectory = taskPath;
        try {
            UINT width = 0, height = 0;
            auto pixels = image(taskPath / L"selection.png", width, height);
            auto result = engine.run(pixels.data(), width, height, 3);
            ++processed;
            if (!cancellationRequested) {
                auto proof = envelope(L"ocr-worker-task");
                proof.SetNamedValue(L"workerSessionId", JsonValue::CreateStringValue(workerId));
                proof.SetNamedValue(L"engineInitializations", JsonValue::CreateNumberValue(1));
                proof.SetNamedValue(L"processed", JsonValue::CreateNumberValue(processed));
                publish(L"worker-proof.json", proof);
                recognition(result, width, height);
            }
        } catch (const std::exception& error) {
            if (!cancellationRequested) {
                auto out = envelope(L"error");
                out.SetNamedValue(L"error", JsonValue::CreateStringValue(winrt::to_hstring(error.what())));
                publish(L"error.json", out);
            }
        } catch (const winrt::hresult_error& error) {
            if (!cancellationRequested) {
                auto out = envelope(L"error");
                out.SetNamedValue(L"error", JsonValue::CreateStringValue(error.message()));
                publish(L"error.json", out);
            }
        }
        taskIdentity.clear(); taskDirectory.clear();
        lastTask = std::chrono::steady_clock::now();
    }
    control.acknowledge();
    trace("ocr-worker-exit");
    return 0;
}
}
