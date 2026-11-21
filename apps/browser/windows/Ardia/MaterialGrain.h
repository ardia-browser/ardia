#pragma once

#include <d2d1_1.h>
#include <d3d11.h>
#include <d3d11_4.h>
#include <d3d10.h>
#include <winrt/Microsoft.Graphics.DirectX.h>
#include <winrt/Microsoft.UI.Composition.h>
#include <winrt/Microsoft.UI.Composition.Interop.h>
#include <winrt/Microsoft.UI.Dispatching.h>
#include <winrt/Windows.Graphics.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include "MaterialEffects.h"
#include "MaterialGrainTiles.h"
#include "MaterialSupport.h"

#pragma comment(lib, "d3d11.lib")

namespace Ardia::Grain {

constexpr wchar_t TileSource[] = L"Tile";

struct Border : MaterialEffects::Effect<Border> {
  IFACEMETHODIMP GetEffectId(GUID *id) noexcept override {
    if (!id) return E_POINTER;
    *id = CLSID_D2D1Border;
    return S_OK;
  }

  IFACEMETHODIMP GetPropertyCount(UINT *count) noexcept override {
    if (!count) return E_POINTER;
    *count = 2;
    return S_OK;
  }

  IFACEMETHODIMP GetProperty(UINT index, MaterialEffects::AbiFoundation::IPropertyValue **value) noexcept override {
    if (index != D2D1_BORDER_PROP_EDGE_MODE_X && index != D2D1_BORDER_PROP_EDGE_MODE_Y) return E_INVALIDARG;
    try {
      auto wrap = winrt::Windows::Foundation::PropertyValue::CreateUInt32(static_cast<uint32_t>(D2D1_BORDER_EDGE_MODE_WRAP));
      return MaterialEffects::WriteProperty(value, wrap);
    } catch (...) {
      return winrt::to_hresult();
    }
  }

  std::array<MaterialEffects::NamedProperty, 2> NamedProperties() const noexcept {
    return {
        MaterialEffects::NamedProperty{L"ExtendX", D2D1_BORDER_PROP_EDGE_MODE_X, MaterialEffects::PropertyMapping::GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT},
        MaterialEffects::NamedProperty{L"ExtendY", D2D1_BORDER_PROP_EDGE_MODE_Y, MaterialEffects::PropertyMapping::GRAPHICS_EFFECT_PROPERTY_MAPPING_DIRECT},
    };
  }
};

struct Outcome {
  bool drawn{false};
  std::wstring reason;
};

struct TileSurface {
  winrt::Microsoft::UI::Composition::CompositionDrawingSurface surface{nullptr};
  std::string texture;
  int pixels{0};
  int users{0};
};

struct Device {
  winrt::Microsoft::UI::Composition::Compositor compositor{nullptr};
  winrt::Microsoft::UI::Composition::CompositionGraphicsDevice graphics{nullptr};
  winrt::Microsoft::UI::Composition::CompositionEffectFactory wrap{nullptr};
  winrt::com_ptr<ID3D11Device> d3d;
  winrt::com_ptr<ID2D1Device> d2d;
  std::map<std::string, TileSurface> surfaces;
  const wchar_t *adapter{L"none"};
  std::wstring failure;
  DWORD removalCookie{0};
  bool removalWatchable{true};
};

struct RemovalWatch {
  std::mutex mutex;
  winrt::Microsoft::UI::Dispatching::DispatcherQueue queue{nullptr};
  HANDLE signal{nullptr};
  PTP_WAIT wait{nullptr};
};

inline RemovalWatch &Removals() noexcept {
  static RemovalWatch watch;
  return watch;
}

inline Device &Shared() noexcept {
  static Device device;
  return device;
}

inline std::atomic<bool> &Failed() noexcept {
  static std::atomic<bool> failed{false};
  return failed;
}

inline bool Available() noexcept {
  return !Failed();
}

inline void StopWatching(Device &device) noexcept {
  RemovalWatch &watch = Removals();
  if (watch.wait) ::SetThreadpoolWait(watch.wait, nullptr, nullptr);
  if (device.removalCookie) {
    if (auto latest = device.d3d.try_as<ID3D11Device4>()) latest->UnregisterDeviceRemoved(device.removalCookie);
    device.removalCookie = 0;
  }
}

inline void Forget(Device &device) noexcept {
  StopWatching(device);
  device.surfaces.clear();
  device.wrap = nullptr;
  device.graphics = nullptr;
  device.d2d = nullptr;
  device.d3d = nullptr;
}

inline std::map<uint64_t, std::function<void()>> &FailureListeners() noexcept {
  static std::map<uint64_t, std::function<void()>> listeners;
  return listeners;
}

inline uint64_t ListenForFailure(std::function<void()> listener) noexcept {
  static uint64_t next = 0;
  try {
    FailureListeners().emplace(++next, std::move(listener));
    return next;
  } catch (...) {
    Materials::NoteOnce(L"grain-listen", L"grain: a view could not listen for grain failures, so it keeps its brush if grain fails");
    return 0;
  }
}

inline void StopListeningForFailure(uint64_t id) noexcept {
  if (id) FailureListeners().erase(id);
}

inline void MarkFailed(Device &device, std::wstring const &reason, std::wstring const &noteKey, std::wstring const &note) noexcept {
  Forget(device);
  try {
    device.failure = reason;
  } catch (...) {
    device.failure.clear();
  }
  Materials::NoteOnce(noteKey, note);
  if (Failed().exchange(true)) return;
  std::vector<std::function<void()>> told;
  try {
    for (auto const &[id, listener] : FailureListeners()) told.push_back(listener);
  } catch (...) {
    Materials::NoteOnce(L"grain-tell", L"grain: failed, and could not tell every mounted view to stop drawing");
  }
  for (auto const &tell : told) {
    try {
      tell();
    } catch (...) {
      Materials::NoteOnce(L"grain-tell-view", L"grain: failed, and a mounted view could not clear its brush");
    }
  }
}

inline void Retain(Device &device, std::string const &key) noexcept {
  auto found = device.surfaces.find(key);
  if (found != device.surfaces.end()) found->second.users++;
}

inline void DropUnused(Device &device, std::string const &key) noexcept {
  auto found = device.surfaces.find(key);
  if (found != device.surfaces.end() && found->second.users == 0) device.surfaces.erase(found);
}

inline void Release(Device &device, std::string const &key) noexcept {
  if (key.empty()) return;
  auto found = device.surfaces.find(key);
  if (found == device.surfaces.end()) return;
  if (found->second.users > 0) found->second.users--;
  if (found->second.users == 0) device.surfaces.erase(found);
}

inline HRESULT MakeD3D(winrt::com_ptr<ID3D11Device> &made, const wchar_t *&adapter) noexcept {
  const D3D_FEATURE_LEVEL levels[] = {D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0};
  HRESULT result = E_FAIL;
  for (D3D_DRIVER_TYPE type : {D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP}) {
    made = nullptr;
    result = D3D11CreateDevice(nullptr, type, nullptr, D3D11_CREATE_DEVICE_BGRA_SUPPORT, levels, ARRAYSIZE(levels), D3D11_SDK_VERSION, made.put(), nullptr, nullptr);
    if (SUCCEEDED(result)) {
      adapter = type == D3D_DRIVER_TYPE_HARDWARE ? L"hardware" : L"WARP";
      return result;
    }
  }
  return result;
}

inline void MakeRenderingDevice(winrt::com_ptr<ID3D11Device> &d3d, winrt::com_ptr<ID2D1Device> &d2d, const wchar_t *&adapter, std::wstring &stage) {
  stage = L"creating the Direct3D device";
  HRESULT result = MakeD3D(d3d, adapter);
  if (FAILED(result)) throw winrt::hresult_error(result);
  if (auto protect = d3d.try_as<ID3D10Multithread>()) protect->SetMultithreadProtected(TRUE);
  stage = L"creating the Direct2D device";
  auto dxgi = d3d.as<IDXGIDevice>();
  winrt::com_ptr<ID2D1Factory1> factory;
  D2D1_FACTORY_OPTIONS options{};
  winrt::check_hresult(D2D1CreateFactory(D2D1_FACTORY_TYPE_MULTI_THREADED, __uuidof(ID2D1Factory1), &options, factory.put_void()));
  d2d = nullptr;
  winrt::check_hresult(factory->CreateDevice(dxgi.get(), d2d.put()));
}

inline bool Replace(Device &device, std::wstring &reason, std::wstring const &why) noexcept;

inline void WatchForRemoval(Device &device) noexcept;

inline bool Ready(Device &device, winrt::Microsoft::UI::Composition::Compositor const &compositor, std::wstring &reason) noexcept {
  if (device.graphics && device.compositor == compositor && device.d3d) {
    const HRESULT removed = device.d3d->GetDeviceRemovedReason();
    if (removed == S_OK) return true;
    return Replace(device, reason, std::wstring{L"the Direct3D device was lost ("}.append(Materials::HexOf(removed)).append(L")"));
  }
  Forget(device);
  device.compositor = compositor;
  std::wstring stage;
  try {
    MakeRenderingDevice(device.d3d, device.d2d, device.adapter, stage);
    stage = L"creating the composition graphics device";
    auto interop = compositor.as<winrt::Microsoft::UI::Composition::ICompositorInterop>();
    winrt::check_hresult(interop->CreateGraphicsDevice(device.d2d.get(), &device.graphics));
    stage = L"building the wrap effect";
    auto border = winrt::make_self<Border>();
    border->Name(L"Wrap");
    border->m_sources.push_back(winrt::Microsoft::UI::Composition::CompositionEffectSourceParameter(TileSource));
    device.wrap = compositor.CreateEffectFactory(border.as<winrt::Windows::Graphics::Effects::IGraphicsEffect>());
    device.failure.clear();
    WatchForRemoval(device);
    Materials::NoteOnce(L"grain-device", std::wstring{L"grain: Direct2D tiles on the "}.append(device.adapter).append(L" Direct3D device, wrapped by a Composition border effect"));
    return true;
  } catch (winrt::hresult_error const &error) {
    reason = std::wstring{L"failed while "}.append(stage).append(L": ").append(Materials::Described(error));
  } catch (...) {
    reason = std::wstring{L"failed while "}.append(stage).append(L": unknown error");
  }
  MarkFailed(device, reason, L"grain-none", std::wstring{L"grain: none drawn ("}.append(reason).append(L")"));
  return false;
}

inline void DrawTile(winrt::Microsoft::UI::Composition::CompositionDrawingSurface const &surface, Tile const &tile, int pixels) {
  auto interop = surface.as<winrt::Microsoft::UI::Composition::ICompositionDrawingSurfaceInterop>();
  winrt::com_ptr<ID2D1DeviceContext> context;
  POINT offset{};
  winrt::check_hresult(interop->BeginDraw(nullptr, __uuidof(ID2D1DeviceContext), context.put_void(), &offset));
  HRESULT drawn = S_OK;
  try {
    context->SetDpi(96.0f, 96.0f);
    context->SetTransform(D2D1_MATRIX_3X2_F{1, 0, 0, 1, static_cast<float>(offset.x), static_cast<float>(offset.y)});
    context->Clear(D2D1_COLOR_F{0, 0, 0, 0});
    std::vector<uint8_t> pixelsBgra(tile.alpha.size() * 4, 0);
    for (size_t i = 0; i < tile.alpha.size(); i++) pixelsBgra[i * 4 + 3] = tile.alpha[i];
    D2D1_BITMAP_PROPERTIES1 properties{};
    properties.pixelFormat = D2D1_PIXEL_FORMAT{DXGI_FORMAT_B8G8R8A8_UNORM, D2D1_ALPHA_MODE_PREMULTIPLIED};
    properties.dpiX = 96.0f;
    properties.dpiY = 96.0f;
    winrt::com_ptr<ID2D1Bitmap1> bitmap;
    winrt::check_hresult(context->CreateBitmap(D2D1_SIZE_U{static_cast<UINT32>(tile.side), static_cast<UINT32>(tile.side)}, pixelsBgra.data(), static_cast<UINT32>(tile.side * 4), &properties, bitmap.put()));
    const float stretch = static_cast<float>(pixels) / static_cast<float>(tile.side);
    const bool exactCells = pixels == tile.side || tile.side == HashSide;
    D2D1_BITMAP_BRUSH_PROPERTIES1 wrapped{D2D1_EXTEND_MODE_WRAP, D2D1_EXTEND_MODE_WRAP, exactCells ? D2D1_INTERPOLATION_MODE_NEAREST_NEIGHBOR : D2D1_INTERPOLATION_MODE_LINEAR};
    D2D1_BRUSH_PROPERTIES placement{1.0f, D2D1_MATRIX_3X2_F{stretch, 0, 0, stretch, 0, 0}};
    winrt::com_ptr<ID2D1BitmapBrush1> brush;
    winrt::check_hresult(context->CreateBitmapBrush(bitmap.get(), &wrapped, &placement, brush.put()));
    context->FillRectangle(D2D1_RECT_F{0, 0, static_cast<float>(pixels), static_cast<float>(pixels)}, brush.get());
  } catch (winrt::hresult_error const &error) {
    drawn = error.code();
  } catch (...) {
    drawn = E_FAIL;
  }
  const HRESULT ended = interop->EndDraw();
  winrt::check_hresult(drawn);
  winrt::check_hresult(ended);
}

inline std::string SurfaceKey(std::string const &texture, int pixels) {
  return texture + "@" + std::to_string(pixels);
}

inline winrt::Microsoft::UI::Composition::CompositionDrawingSurface SurfaceFor(Device &device, std::string const &texture, int pixels) {
  const std::string key = SurfaceKey(texture, pixels);
  auto found = device.surfaces.find(key);
  if (found != device.surfaces.end()) return found->second.surface;
  auto surface = device.graphics.CreateDrawingSurface2(
      winrt::Windows::Graphics::SizeInt32{pixels, pixels},
      winrt::Microsoft::Graphics::DirectX::DirectXPixelFormat::B8G8R8A8UIntNormalized,
      winrt::Microsoft::Graphics::DirectX::DirectXAlphaMode::Premultiplied);
  DrawTile(surface, TileFor(texture), pixels);
  device.surfaces.emplace(key, TileSurface{surface, texture, pixels});
  return surface;
}

inline bool Replace(Device &device, std::wstring &reason, std::wstring const &why) noexcept {
  StopWatching(device);
  std::wstring stage;
  try {
    winrt::com_ptr<ID3D11Device> d3d;
    winrt::com_ptr<ID2D1Device> d2d;
    MakeRenderingDevice(d3d, d2d, device.adapter, stage);
    stage = L"giving the composition graphics device the new device";
    winrt::check_hresult(device.graphics.as<winrt::Microsoft::UI::Composition::ICompositionGraphicsDeviceInterop>()->SetRenderingDevice(d2d.get()));
    device.d3d = d3d;
    device.d2d = d2d;
    stage = L"redrawing the tiles";
    for (auto const &[key, tile] : device.surfaces) DrawTile(tile.surface, TileFor(tile.texture), tile.pixels);
    WatchForRemoval(device);
    Materials::NoteOnce(
        std::wstring{L"grain-device-replaced-"}.append(why),
        std::wstring{L"grain: "}.append(why).append(L"; redrew ").append(std::to_wstring(device.surfaces.size())).append(L" tiles on a new ").append(device.adapter).append(L" Direct3D device"));
    return true;
  } catch (winrt::hresult_error const &error) {
    reason = std::wstring{L"failed while "}.append(stage).append(L": ").append(Materials::Described(error));
  } catch (...) {
    reason = std::wstring{L"failed while "}.append(stage).append(L": unknown error");
  }
  MarkFailed(device, reason, L"grain-none-after-replacing", std::wstring{L"grain: none drawn after "}.append(why).append(L" (").append(reason).append(L")"));
  return false;
}

inline void RecoverIfLost(winrt::Microsoft::UI::Composition::Compositor const &compositor) noexcept {
  Device &device = Shared();
  if (!compositor || !device.graphics || device.compositor != compositor || !device.d3d) return;
  if (device.d3d->GetDeviceRemovedReason() == S_OK) {
    if (!device.removalCookie && device.removalWatchable) WatchForRemoval(device);
    return;
  }
  std::wstring reason;
  Ready(device, compositor, reason);
}

inline void CALLBACK DeviceRemoved(PTP_CALLBACK_INSTANCE, PVOID, PTP_WAIT, TP_WAIT_RESULT) {
  winrt::Microsoft::UI::Dispatching::DispatcherQueue queue{nullptr};
  {
    RemovalWatch &watch = Removals();
    std::scoped_lock lock{watch.mutex};
    queue = watch.queue;
  }
  bool queued = false;
  try {
    queued = queue && queue.TryEnqueue([]() noexcept {
      const auto compositor = Shared().compositor;
      RecoverIfLost(compositor);
    });
  } catch (...) {
  }
  if (!queued) Materials::NoteOnce(L"grain-removal-queue", L"grain: the device removal notice could not reach the UI thread; the next grain paint finds the lost device");
}

inline void WatchForRemoval(Device &device) noexcept {
  if (!device.compositor) return;
  auto latest = device.d3d.try_as<ID3D11Device4>();
  if (!latest) {
    device.removalWatchable = false;
    Materials::NoteOnce(L"grain-removal-unsupported", L"grain: this Direct3D device has no removal notice; the next grain paint finds a lost device");
    return;
  }
  RemovalWatch &watch = Removals();
  try {
    {
      std::scoped_lock lock{watch.mutex};
      watch.queue = device.compositor.DispatcherQueue();
    }
    if (!watch.signal) watch.signal = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!watch.wait) watch.wait = ::CreateThreadpoolWait(DeviceRemoved, nullptr, nullptr);
    if (!watch.signal || !watch.wait) {
      Materials::NoteOnce(L"grain-removal-wait", std::wstring{L"grain: the device removal notice could not be set up (error "}.append(std::to_wstring(::GetLastError())).append(L"); retrying on the next grain paint"));
      return;
    }
    const HRESULT registered = latest->RegisterDeviceRemovedEvent(watch.signal, &device.removalCookie);
    if (FAILED(registered)) {
      device.removalCookie = 0;
      Materials::NoteOnce(L"grain-removal-register", std::wstring{L"grain: the device removal notice was refused ("}.append(Materials::HexOf(registered)).append(L"); retrying on the next grain paint"));
      return;
    }
    ::SetThreadpoolWait(watch.wait, watch.signal, nullptr);
  } catch (...) {
    device.removalCookie = 0;
    Materials::NoteOnce(L"grain-removal-error", L"grain: setting up the device removal notice failed; retrying on the next grain paint");
  }
}

struct Painted {
  winrt::Microsoft::UI::Composition::CompositionEffectBrush brush{nullptr};
  Outcome outcome;
};

inline Painted WrappedTile(winrt::Microsoft::UI::Composition::Compositor const &compositor, std::string const &texture, int pixels) noexcept {
  Painted painted;
  Device &device = Shared();
  if (!Ready(device, compositor, painted.outcome.reason)) return painted;
  std::wstring stage{L"drawing the tile"};
  try {
    auto surface = SurfaceFor(device, texture, pixels);
    stage = L"creating the tile brush";
    auto tile = compositor.CreateSurfaceBrush(surface);
    tile.Stretch(winrt::Microsoft::UI::Composition::CompositionStretch::None);
    tile.HorizontalAlignmentRatio(0.0f);
    tile.VerticalAlignmentRatio(0.0f);
    stage = L"creating the wrap brush";
    painted.brush = device.wrap.CreateBrush();
    painted.brush.SetSourceParameter(TileSource, tile);
    painted.outcome.drawn = true;
    return painted;
  } catch (winrt::hresult_error const &error) {
    painted.outcome.reason = std::wstring{L"failed while "}.append(stage).append(L": ").append(Materials::Described(error));
  } catch (...) {
    painted.outcome.reason = std::wstring{L"failed while "}.append(stage).append(L": unknown error");
  }
  painted.brush = nullptr;
  MarkFailed(device, painted.outcome.reason, std::wstring{L"grain-failed-"}.append(Paths::Wide(texture)), std::wstring{L"grain: "}.append(Paths::Wide(texture)).append(L" none drawn (").append(painted.outcome.reason).append(L")"));
  return painted;
}

struct ReadBack {
  Outcome outcome;
  uint64_t alphaSum{0};
};

inline ReadBack DrawnAlphaSum(winrt::Microsoft::UI::Composition::Compositor const &compositor, std::string const &texture, int pixels) noexcept {
  ReadBack answer;
  Device &device = Shared();
  if (!Ready(device, compositor, answer.outcome.reason)) return answer;
  std::wstring stage{L"drawing the tile"};
  try {
    auto surface = SurfaceFor(device, texture, pixels);
    stage = L"creating the copy textures";
    D3D11_TEXTURE2D_DESC description{};
    description.Width = static_cast<UINT>(pixels);
    description.Height = static_cast<UINT>(pixels);
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_DEFAULT;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    winrt::com_ptr<ID3D11Texture2D> copy;
    winrt::check_hresult(device.d3d->CreateTexture2D(&description, nullptr, copy.put()));
    description.Usage = D3D11_USAGE_STAGING;
    description.BindFlags = 0;
    description.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    winrt::com_ptr<ID3D11Texture2D> staging;
    winrt::check_hresult(device.d3d->CreateTexture2D(&description, nullptr, staging.put()));
    stage = L"copying the surface";
    winrt::check_hresult(surface.as<winrt::Microsoft::UI::Composition::ICompositionDrawingSurfaceInterop2>()->CopySurface(copy.get(), 0, 0, nullptr));
    winrt::com_ptr<ID3D11DeviceContext> immediate;
    device.d3d->GetImmediateContext(immediate.put());
    immediate->CopyResource(staging.get(), copy.get());
    stage = L"reading the copy";
    D3D11_MAPPED_SUBRESOURCE mapped{};
    winrt::check_hresult(immediate->Map(staging.get(), 0, D3D11_MAP_READ, 0, &mapped));
    const auto *bytes = static_cast<const uint8_t *>(mapped.pData);
    for (int y = 0; y < pixels; y++) {
      const uint8_t *row = bytes + static_cast<size_t>(y) * mapped.RowPitch;
      for (int x = 0; x < pixels; x++) answer.alphaSum += row[x * 4 + 3];
    }
    immediate->Unmap(staging.get(), 0);
    answer.outcome.drawn = true;
  } catch (winrt::hresult_error const &error) {
    answer.outcome.reason = std::wstring{L"failed while "}.append(stage).append(L": ").append(Materials::Described(error));
  } catch (...) {
    answer.outcome.reason = std::wstring{L"failed while "}.append(stage).append(L": unknown error");
  }
  return answer;
}

struct Redrawn {
  Outcome outcome;
  bool sameSurface{false};
  uint64_t before{0};
  uint64_t after{0};
};

inline Redrawn RedrawnOnReplacedDevice(winrt::Microsoft::UI::Composition::Compositor const &compositor, std::string const &texture, int pixels) noexcept {
  Redrawn answer;
  const ReadBack before = DrawnAlphaSum(compositor, texture, pixels);
  answer.before = before.alphaSum;
  if (!before.outcome.drawn) {
    answer.outcome = before.outcome;
    return answer;
  }
  Device &device = Shared();
  const std::string key = SurfaceKey(texture, pixels);
  auto kept = device.surfaces.find(key);
  if (kept == device.surfaces.end()) {
    answer.outcome.reason = L"the tile was not kept";
    return answer;
  }
  const auto surface = kept->second.surface;
  if (!Replace(device, answer.outcome.reason, L"the self-check replaced the Direct3D device")) return answer;
  const ReadBack after = DrawnAlphaSum(compositor, texture, pixels);
  answer.after = after.alphaSum;
  auto again = device.surfaces.find(key);
  answer.sameSurface = again != device.surfaces.end() && again->second.surface == surface;
  answer.outcome = after.outcome;
  return answer;
}

inline void FailForCheck() noexcept {
  MarkFailed(Shared(), L"the self-check failed the grain on purpose", L"grain-failed-for-check", L"grain: the self-check failed the grain on purpose");
}

inline std::vector<std::string> KeptTiles() noexcept {
  std::vector<std::string> kept;
  try {
    for (auto const &[key, tile] : Shared().surfaces) kept.push_back(key + " used by " + std::to_string(tile.users));
  } catch (...) {
    Materials::NoteOnce(L"grain-kept-tiles", L"grain: the kept tiles could not be listed");
  }
  return kept;
}

struct LastPath {
  std::string path;
  std::string reason;
  std::string texture;
  bool brushed{false};
};

struct LastPathStore {
  std::mutex mutex;
  LastPath path;
  std::map<std::string, LastPath> requests;
};

inline LastPathStore &LastStore() noexcept {
  static LastPathStore store;
  return store;
}

inline void Remember(LastPath path, std::string const &request) noexcept {
  LastPathStore &store = LastStore();
  std::scoped_lock lock{store.mutex};
  if (!request.empty()) store.requests[request] = path;
  store.path = std::move(path);
}

inline LastPath Last(std::string const &request) noexcept {
  LastPathStore &store = LastStore();
  std::scoped_lock lock{store.mutex};
  if (request.empty()) return store.path;
  auto found = store.requests.find(request);
  return found == store.requests.end() ? LastPath{} : found->second;
}

}
