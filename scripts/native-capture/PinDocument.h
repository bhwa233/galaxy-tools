#pragma once
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include "History.h"
#include "Shape/ShapeRect.h"
#include "Shape/ShapeEllipse.h"
#include "Shape/ShapeArrow.h"
#include "Shape/ShapeLine.h"
#include "Shape/ShapeNumber.h"
#include "Shape/ShapeText.h"
#include "Shape/ShapeMosaic.h"
#include "Shape/ShapeEraser.h"

// Reuse WinPin's existing History, shape constructors and geometry rebuilders.
// Upstream has no editable document format; a flattened PNG loses these objects.
// This adapter only records their existing state in a bounded versioned document.
struct Spark233PinDocument {
    using Object = winrt::Windows::Data::Json::JsonObject;
    using Array = winrt::Windows::Data::Json::JsonArray;
    using Value = winrt::Windows::Data::Json::JsonValue;
    static constexpr size_t maxDocumentBytes = 8 * 1024 * 1024;
    static constexpr UINT32 maxShapes = 2048;
    static constexpr UINT32 maxPoints = 100000;
    static constexpr UINT32 maxImagePixels = 32000000;

    static void number(Object& value, const wchar_t* key, double field) {
        if (!std::isfinite(field) || std::abs(field) > 1000000)
            throw std::runtime_error("Pin number is outside the document bounds");
        value.SetNamedValue(key, Value::CreateNumberValue(field));
    }
    static float number(const Object& value, const wchar_t* key) {
        const auto field = value.GetNamedNumber(key);
        if (!std::isfinite(field) || std::abs(field) > 1000000)
            throw std::runtime_error("Invalid pin document number");
        return static_cast<float>(field);
    }
    static float positive(const Object& value, const wchar_t* key) {
        const auto result = number(value, key);
        if (result <= 0 || result > 16384) throw std::runtime_error("Invalid pin size");
        return result;
    }
    static void flag(Object& value, const wchar_t* key, bool field) {
        value.SetNamedValue(key, Value::CreateBooleanValue(field));
    }
    static Array numbers(std::initializer_list<float> fields) {
        Array out;
        for (const auto field : fields) {
            if (!std::isfinite(field) || std::abs(field) > 1000000)
                throw std::runtime_error("Invalid pin geometry");
            out.Append(Value::CreateNumberValue(field));
        }
        return out;
    }
    static float component(const Array& array, UINT32 index) {
        const auto value = array.GetNumberAt(index);
        if (!std::isfinite(value) || std::abs(value) > 1000000)
            throw std::runtime_error("Invalid pin geometry component");
        return static_cast<float>(value);
    }
    static void rect(Object& value, const D2D1_RECT_F& field) {
        value.SetNamedValue(L"rect", numbers({field.left, field.top, field.right, field.bottom}));
    }
    static D2D1_RECT_F rect(const Object& value) {
        const auto fields = value.GetNamedArray(L"rect");
        if (fields.Size() != 4) throw std::runtime_error("Invalid pin rectangle");
        D2D1_RECT_F out{ component(fields, 0), component(fields, 1), component(fields, 2), component(fields, 3) };
        if (out.right < out.left || out.bottom < out.top) throw std::runtime_error("Inverted pin rectangle");
        return out;
    }
    static void color(Object& value, const D2D1_COLOR_F& field) {
        value.SetNamedValue(L"color", numbers({field.r, field.g, field.b, field.a}));
    }
    static D2D1_COLOR_F color(const Object& value) {
        const auto fields = value.GetNamedArray(L"color");
        if (fields.Size() != 4) throw std::runtime_error("Invalid pin color");
        D2D1_COLOR_F out{ component(fields, 0), component(fields, 1), component(fields, 2), component(fields, 3) };
        for (const auto field : {out.r, out.g, out.b, out.a})
            if (field < 0 || field > 1) throw std::runtime_error("Invalid pin color component");
        return out;
    }
    static void points(Object& value, const std::vector<D2D1_POINT_2F>& fields) {
        if (fields.size() > maxPoints) throw std::runtime_error("Too many pin points");
        Array out;
        for (const auto& point : fields) out.Append(numbers({point.x, point.y}));
        value.SetNamedValue(L"points", out);
    }
    static std::vector<D2D1_POINT_2F> points(const Object& value, UINT32& remaining) {
        const auto fields = value.GetNamedArray(L"points");
        if (fields.Size() > remaining) throw std::runtime_error("Too many pin points");
        remaining -= fields.Size();
        if (fields.Size() < 2) throw std::runtime_error("Pin stroke needs at least two points");
        std::vector<D2D1_POINT_2F> out;
        out.reserve(fields.Size());
        for (const auto& item : fields) {
            const auto pair = item.GetArray();
            if (pair.Size() != 2) throw std::runtime_error("Invalid pin point");
            out.push_back({component(pair, 0), component(pair, 1)});
        }
        return out;
    }
    static void dimensions(UINT32 width, UINT32 height) {
        if (!width || !height || width > 16000 || height > 16000 ||
            static_cast<UINT64>(width) * height > maxImagePixels)
            throw std::runtime_error("Pin image exceeds the document bounds");
    }
    static Object save(WinPin& win) {
        const auto size = win.screenImg->GetPixelSize();
        dimensions(size.width, size.height);
        if (win.history->shapes.size() > maxShapes) throw std::runtime_error("Too many pin shapes");
        Object document;
        document.SetNamedValue(L"format", Value::CreateStringValue(L"spark233-pin"));
        number(document, L"version", 1);
        number(document, L"width", size.width);
        number(document, L"height", size.height);
        number(document, L"scale", win.scale);
        number(document, L"dpi", win.dpi);
        Array shapes;
        UINT32 pointCount = 0;
        for (const auto& original : win.history->shapes) {
            Object shape;
            flag(shape, L"undo", original->isUndo);
            const auto kind = [&](const wchar_t* name) { shape.SetNamedValue(L"kind", Value::CreateStringValue(name)); };
            if (const auto s = dynamic_cast<ShapeRect*>(original.get())) {
                kind(L"rect"); rect(shape, s->rect); color(shape, s->brush->GetColor());
                number(shape, L"strokeWidth", s->strokeWidth); flag(shape, L"fill", s->isFill);
            } else if (const auto s = dynamic_cast<ShapeEllipse*>(original.get())) {
                kind(L"ellipse"); rect(shape, s->rect); color(shape, s->brush->GetColor());
                number(shape, L"strokeWidth", s->strokeWidth); flag(shape, L"fill", s->isFill);
            } else if (const auto s = dynamic_cast<ShapeArrow*>(original.get())) {
                kind(L"arrow"); color(shape, s->brush->GetColor());
                number(shape, L"startX", s->startX); number(shape, L"startY", s->startY);
                number(shape, L"endX", s->endX); number(shape, L"endY", s->endY);
                number(shape, L"arrowSize", s->arrowSize); flag(shape, L"fill", s->isFill);
            } else if (const auto s = dynamic_cast<ShapeLine*>(original.get())) {
                kind(L"line"); color(shape, s->brush->GetColor()); points(shape, s->linePoints);
                pointCount += static_cast<UINT32>(s->linePoints.size());
                number(shape, L"strokeWidth", s->strokeWidth); flag(shape, L"transparent", s->isTransparent);
            } else if (const auto s = dynamic_cast<ShapeNumber*>(original.get())) {
                kind(L"number"); color(shape, s->brush->GetColor());
                number(shape, L"cx", s->cx); number(shape, L"cy", s->cy); number(shape, L"radius", s->r);
                number(shape, L"angle", s->angle); number(shape, L"value", s->val); flag(shape, L"fill", s->isFill);
            } else if (const auto s = dynamic_cast<ShapeText*>(original.get())) {
                kind(L"text"); rect(shape, s->rect); color(shape, s->color);
                if (s->text.size() > 200000) throw std::runtime_error("Pin text exceeds the document bounds");
                shape.SetNamedValue(L"text", Value::CreateStringValue(s->text));
                number(shape, L"fontSize", s->fontSize); number(shape, L"padding", s->borderPadding);
                flag(shape, L"bold", s->isBold); flag(shape, L"italic", s->isItalic);
            } else if (const auto s = dynamic_cast<ShapeMosaic*>(original.get())) {
                kind(L"mosaic"); rect(shape, s->rect); points(shape, s->linePoints);
                pointCount += static_cast<UINT32>(s->linePoints.size());
                number(shape, L"strokeWidth", s->strokeWidth); flag(shape, L"rectMode", s->isRect);
            } else if (const auto s = dynamic_cast<ShapeEraser*>(original.get())) {
                kind(L"eraser"); rect(shape, s->rect); points(shape, s->linePoints);
                pointCount += static_cast<UINT32>(s->linePoints.size());
                number(shape, L"strokeWidth", s->strokeWidth); flag(shape, L"rectMode", s->isRect);
            } else throw std::runtime_error("Unsupported editable pin shape");
            if (pointCount > maxPoints) throw std::runtime_error("Too many pin points");
            shapes.Append(shape);
        }
        document.SetNamedValue(L"shapes", shapes);
        if (winrt::to_string(document.Stringify()).size() > maxDocumentBytes)
            throw std::runtime_error("Pin document exceeds its size limit");
        return document;
    }
    static void restore(WinPin& win, const Object& document) {
        const auto size = win.screenImg->GetPixelSize();
        dimensions(size.width, size.height);
        if (document.GetNamedString(L"format") != L"spark233-pin" || document.GetNamedNumber(L"version") != 1 ||
            document.GetNamedNumber(L"width") != size.width || document.GetNamedNumber(L"height") != size.height)
            throw std::runtime_error("Pin document image identity mismatch");
        const auto shapes = document.GetNamedArray(L"shapes");
        if (shapes.Size() > maxShapes) throw std::runtime_error("Too many pin shapes");
        UINT32 remaining = maxPoints;
        std::vector<std::unique_ptr<ShapeBase>> restored;
        for (const auto& item : shapes) {
            const auto data = item.GetObject();
            const auto kind = data.GetNamedString(L"kind");
            std::unique_ptr<ShapeBase> result;
            if (kind == L"rect") {
                auto s = std::make_unique<ShapeRect>(&win);
                s->rect = rect(data); s->strokeWidth = positive(data, L"strokeWidth");
                s->isFill = data.GetNamedBoolean(L"fill"); s->brush->SetColor(color(data));
                s->mouseUp(0, 0); result = std::move(s);
            } else if (kind == L"ellipse") {
                auto s = std::make_unique<ShapeEllipse>(&win);
                s->rect = rect(data); s->strokeWidth = positive(data, L"strokeWidth");
                s->cx = (s->rect.left + s->rect.right) / 2; s->cy = (s->rect.top + s->rect.bottom) / 2;
                s->rx = (s->rect.right - s->rect.left) / 2; s->ry = (s->rect.bottom - s->rect.top) / 2;
                s->isFill = data.GetNamedBoolean(L"fill"); s->brush->SetColor(color(data));
                s->mouseUp(0, 0); result = std::move(s);
            } else if (kind == L"arrow") {
                auto s = std::make_unique<ShapeArrow>(&win);
                s->startX = number(data, L"startX"); s->startY = number(data, L"startY");
                s->endX = number(data, L"endX"); s->endY = number(data, L"endY");
                s->arrowSize = positive(data, L"arrowSize"); s->isFill = data.GetNamedBoolean(L"fill");
                s->brush->SetColor(color(data)); s->makeArrow(); s->mouseUp(0, 0); result = std::move(s);
            } else if (kind == L"line") {
                auto s = std::make_unique<ShapeLine>(&win);
                s->linePoints = points(data, remaining); s->strokeWidth = positive(data, L"strokeWidth");
                s->isTransparent = data.GetNamedBoolean(L"transparent"); s->brush->SetColor(color(data));
                s->makePath(); s->mouseUp(0, 0); result = std::move(s);
            } else if (kind == L"number") {
                auto s = std::make_unique<ShapeNumber>(&win);
                s->cx = number(data, L"cx"); s->cy = number(data, L"cy"); s->r = positive(data, L"radius");
                s->angle = number(data, L"angle");
                const auto label = data.GetNamedNumber(L"value");
                if (!std::isfinite(label) || label < 1 || label > 1000000 || std::trunc(label) != label)
                    throw std::runtime_error("Invalid pin number label");
                s->val = static_cast<int>(label);
                s->isFill = data.GetNamedBoolean(L"fill"); s->brush->SetColor(color(data));
                s->makePath(); s->makeTextLayout(); s->mouseUp(0, 0); result = std::move(s);
            } else if (kind == L"text") {
                auto s = std::make_unique<ShapeText>(&win);
                s->text = data.GetNamedString(L"text");
                if (s->text.size() > 200000) throw std::runtime_error("Pin text exceeds the document bounds");
                s->rect = rect(data); s->fontSize = positive(data, L"fontSize"); s->borderPadding = number(data, L"padding");
                if (s->borderPadding < 0) throw std::runtime_error("Invalid pin text padding");
                s->isBold = data.GetNamedBoolean(L"bold"); s->isItalic = data.GetNamedBoolean(L"italic");
                s->color = color(data);
                s->colorValue = (static_cast<UINT32>(std::lround(s->color.r * 255)) << 24) |
                    (static_cast<UINT32>(std::lround(s->color.g * 255)) << 16) |
                    (static_cast<UINT32>(std::lround(s->color.b * 255)) << 8) |
                    static_cast<UINT32>(std::lround(s->color.a * 255));
                s->textBrush->SetColor(s->color); s->makeTextLayout(); result = std::move(s);
            } else if (kind == L"mosaic") {
                auto s = std::make_unique<ShapeMosaic>(&win);
                s->rect = rect(data); s->isRect = data.GetNamedBoolean(L"rectMode");
                if (!s->isRect) s->linePoints = points(data, remaining);
                s->strokeWidth = positive(data, L"strokeWidth");
                if (!s->isRect) s->makePath();
                s->mouseUp(0, 0); result = std::move(s);
            } else if (kind == L"eraser") {
                auto s = std::make_unique<ShapeEraser>(&win);
                s->rect = rect(data); s->isRect = data.GetNamedBoolean(L"rectMode");
                if (!s->isRect) s->linePoints = points(data, remaining);
                s->strokeWidth = positive(data, L"strokeWidth");
                if (!s->isRect) s->makePath();
                s->mouseUp(0, 0); result = std::move(s);
            } else throw std::runtime_error("Unsupported editable pin shape");
            result->isUndo = data.GetNamedBoolean(L"undo");
            restored.push_back(std::move(result));
        }
        const auto scale = number(document, L"scale");
        if (scale < 0.1f || scale > 8.f) throw std::runtime_error("Invalid pin view scale");
        win.history->shapes = std::move(restored);
        win.scale = scale;
    }
    static Object read(const std::filesystem::path& path) {
        if (!std::filesystem::is_regular_file(path) || std::filesystem::file_size(path) > maxDocumentBytes)
            throw std::runtime_error("Invalid pin document file");
        std::ifstream input(path, std::ios::binary);
        const std::string text((std::istreambuf_iterator<char>(input)), std::istreambuf_iterator<char>());
        return Object::Parse(winrt::to_hstring(text));
    }
    static void publish(const std::filesystem::path& path, const Object& value) {
        const auto text = winrt::to_string(value.Stringify());
        if (text.size() > maxDocumentBytes) throw std::runtime_error("Pin document exceeds its size limit");
        const auto partial = std::filesystem::path(path.wstring() + L".partial");
        const auto handle = CreateFileW(partial.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (handle == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot create pin document");
        DWORD written = 0;
        const bool success = WriteFile(handle, text.data(), static_cast<DWORD>(text.size()), &written, nullptr) &&
            written == text.size() && FlushFileBuffers(handle);
        CloseHandle(handle);
        if (!success || !MoveFileExW(partial.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            DeleteFileW(partial.c_str());
            throw std::runtime_error("Cannot commit pin document");
        }
    }
    static std::vector<BYTE> decode(const std::filesystem::path& path, UINT& width, UINT& height) {
        if (!std::filesystem::is_regular_file(path) || std::filesystem::file_size(path) > 160 * 1024 * 1024)
            throw std::runtime_error("Invalid pin source image file");
        using Microsoft::WRL::ComPtr;
        ComPtr<IWICImagingFactory> factory;
        winrt::check_hresult(CoCreateInstance(CLSID_WICImagingFactory, nullptr, CLSCTX_INPROC_SERVER, IID_PPV_ARGS(factory.GetAddressOf())));
        ComPtr<IWICBitmapDecoder> decoder;
        winrt::check_hresult(factory->CreateDecoderFromFilename(path.c_str(), nullptr, GENERIC_READ, WICDecodeMetadataCacheOnLoad, decoder.GetAddressOf()));
        ComPtr<IWICBitmapFrameDecode> frame;
        winrt::check_hresult(decoder->GetFrame(0, frame.GetAddressOf()));
        winrt::check_hresult(frame->GetSize(&width, &height));
        dimensions(width, height);
        ComPtr<IWICFormatConverter> converter;
        winrt::check_hresult(factory->CreateFormatConverter(converter.GetAddressOf()));
        winrt::check_hresult(converter->Initialize(frame.Get(), GUID_WICPixelFormat32bppPBGRA, WICBitmapDitherTypeNone, nullptr, 0, WICBitmapPaletteTypeCustom));
        std::vector<BYTE> pixels(static_cast<size_t>(width) * height * 4);
        winrt::check_hresult(converter->CopyPixels(nullptr, width * 4, static_cast<UINT>(pixels.size()), pixels.data()));
        return pixels;
    }
};
