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
#include <cmath>
#include <cstdint>
#include <map>
#include <mutex>
#include <string>
#include <string_view>
#include <vector>

#include "MaterialEffects.h"
#include "MaterialSupport.h"

#pragma comment(lib, "d3d11.lib")

namespace Ardia::Grain {

constexpr int TextureSide = 128;
constexpr float TextureTileDips = 64.0f;
constexpr int HashSide = 256;
constexpr float SmallestCell = 0.25f;
constexpr wchar_t TileSource[] = L"Tile";

struct Darkening {
  float gain;
  float floor;
};

inline bool IsHash(std::string_view texture) noexcept {
  return texture == "hash";
}

inline std::string Known(std::string_view texture) noexcept {
  if (texture == "sand" || texture == "denim" || texture == "tweed" || texture == "hash") return std::string{texture};
  return "grain";
}

inline Darkening ArcDarkening(std::string_view texture) noexcept {
  if (texture == "sand") return {0.937f, 0.132f};
  if (texture == "denim") return {0.226f, 0.068f};
  if (texture == "tweed") return {0.23f, 0.261f};
  return {0.211f, 0.0f};
}

struct Xorshift {
  uint32_t state{0x9E3779B9u};

  float Next() noexcept {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return static_cast<float>(state % 10000u) / 10000.0f;
  }
};

inline std::vector<float> TextureAlpha(std::string_view texture) {
  constexpr int n = TextureSide;
  std::vector<float> alpha(static_cast<size_t>(n * n), 0.0f);
  Xorshift random;
  auto add = [&alpha](int x, int y, float v) noexcept {
    const size_t i = static_cast<size_t>(((y % n + n) % n) * n + (x % n + n) % n);
    alpha[i] = (std::min)(1.0f, alpha[i] + v);
  };
  if (texture == "sand") {
    for (float &value : alpha) value = random.Next() * 0.25f;
    for (int grains = 0; grains < n * n / 18; grains++) {
      const int x = static_cast<int>(random.Next() * static_cast<float>(n));
      const int y = static_cast<int>(random.Next() * static_cast<float>(n));
      const float v = 0.5f + random.Next() * 0.5f;
      add(x, y, v);
      add(x + 1, y, v * 0.6f);
      add(x, y + 1, v * 0.6f);
      add(x + 1, y + 1, v * 0.4f);
    }
  } else if (texture == "denim") {
    for (int y = 0; y < n; y++) {
      for (int x = 0; x < n; x++) {
        const float twill = (x + y) % 4 < 2 ? 0.75f : 0.15f;
        alpha[static_cast<size_t>(y * n + x)] = (std::min)(1.0f, twill * (0.6f + random.Next() * 0.4f) + (y % 2 == 0 ? 0.08f : 0.0f));
      }
    }
  } else if (texture == "tweed") {
    for (float &value : alpha) value = random.Next() * 0.15f;
    for (int threads = 0; threads < n * n / 40; threads++) {
      const int x = static_cast<int>(random.Next() * static_cast<float>(n));
      const int y = static_cast<int>(random.Next() * static_cast<float>(n));
      const float v = 0.4f + random.Next() * 0.6f;
      const bool horizontal = random.Next() < 0.5f;
      const int length = 3 + static_cast<int>(random.Next() * 4.0f);
      for (int k = 0; k < length; k++) {
        if (horizontal) add(x + k, y, v);
        else add(x, y + k, v);
      }
    }
  } else {
    for (float &value : alpha) {
      const float u = random.Next();
      value = u * u;
    }
  }
  return alpha;
}

inline float Fract(float value) noexcept {
  return value - std::floor(value);
}

inline float HashOfCell(float x, float y) noexcept {
  float px = Fract(x * 0.1031f);
  float py = Fract(y * 0.1031f);
  float pz = Fract(x * 0.1031f);
  const float lift = px * (py + 33.33f) + py * (pz + 33.33f) + pz * (px + 33.33f);
  px += lift;
  py += lift;
  pz += lift;
  return Fract((px + py) * pz);
}

struct Tile {
  int side{0};
  std::vector<uint8_t> alpha;
  uint64_t alphaSum{0};
};

inline Tile MakeTile(std::string_view texture) {
  Tile tile;
  if (IsHash(texture)) {
    tile.side = HashSide;
    tile.alpha.resize(static_cast<size_t>(HashSide * HashSide));
    for (int y = 0; y < HashSide; y++) {
      for (int x = 0; x < HashSide; x++) {
        const float darkening = 1.0f - HashOfCell(static_cast<float>(x), static_cast<float>(y));
        tile.alpha[static_cast<size_t>(y * HashSide + x)] = static_cast<uint8_t>(std::lround(std::clamp(darkening, 0.0f, 1.0f) * 255.0f));
      }
    }
  } else {
    tile.side = TextureSide;
    const std::vector<float> alpha = TextureAlpha(texture);
    const Darkening match = ArcDarkening(texture);
    tile.alpha.resize(alpha.size());
    for (size_t i = 0; i < alpha.size(); i++) {
      tile.alpha[i] = static_cast<uint8_t>((std::min)(255.0f, (std::max)(0.0f, match.floor + match.gain * alpha[i]) * 255.0f));
    }
  }
  for (uint8_t value : tile.alpha) tile.alphaSum += value;
  return tile;
}

inline Tile const &TileFor(std::string const &texture) {
  static std::map<std::string, Tile> tiles;
  auto found = tiles.find(texture);
  if (found != tiles.end()) return found->second;
  return tiles.emplace(texture, MakeTile(texture)).first->second;
}

inline int TilePixels(std::string_view texture, float scale, float cellSize) noexcept {
  if (IsHash(texture)) return (std::max)(1, static_cast<int>(std::lround(HashSide * (std::max)(SmallestCell, cellSize))));
  return (std::max)(TextureSide, static_cast<int>(std::lround(TextureTileDips * scale)));
}

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
    return MaterialEffects::WriteProperty(value, winrt::Windows::Foundation::PropertyValue::CreateUInt32(static_cast<uint32_t>(D2D1_BORDER_EDGE_MODE_WRAP)));
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

inline bool &Failed() noexcept {
  static bool failed = false;
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
  Forget(device);
  device.failure = reason;
  Failed() = true;
  Materials::NoteOnce(L"grain-none", std::wstring{L"grain: none drawn ("}.append(reason).append(L")"));
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
  Forget(device);
  device.failure = reason;
  Failed() = true;
  Materials::NoteOnce(L"grain-none", std::wstring{L"grain: none drawn after "}.append(why).append(L" (").append(reason).append(L")"));
  return false;
}

inline void RecoverIfLost(winrt::Microsoft::UI::Composition::Compositor const &compositor) noexcept {
  Device &device = Shared();
  if (!compositor || !device.graphics || device.compositor != compositor || !device.d3d) return;
  if (device.d3d->GetDeviceRemovedReason() == S_OK) return;
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
  if (!queue) return;
  try {
    queue.TryEnqueue([]() noexcept {
      const auto compositor = Shared().compositor;
      RecoverIfLost(compositor);
    });
  } catch (...) {
  }
}

inline void WatchForRemoval(Device &device) noexcept {
  auto latest = device.d3d.try_as<ID3D11Device4>();
  if (!latest || !device.compositor) return;
  RemovalWatch &watch = Removals();
  try {
    {
      std::scoped_lock lock{watch.mutex};
      watch.queue = device.compositor.DispatcherQueue();
    }
    if (!watch.signal) watch.signal = ::CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!watch.wait) watch.wait = ::CreateThreadpoolWait(DeviceRemoved, nullptr, nullptr);
    if (!watch.signal || !watch.wait) return;
    if (FAILED(latest->RegisterDeviceRemovedEvent(watch.signal, &device.removalCookie))) {
      device.removalCookie = 0;
      return;
    }
    ::SetThreadpoolWait(watch.wait, watch.signal, nullptr);
  } catch (...) {
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
  Forget(device);
  device.failure = painted.outcome.reason;
  Failed() = true;
  Materials::NoteOnce(std::wstring{L"grain-failed-"}.append(Paths::Wide(texture)), std::wstring{L"grain: "}.append(Paths::Wide(texture)).append(L" none drawn (").append(painted.outcome.reason).append(L")"));
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

struct LastPath {
  std::string path;
  std::string reason;
  std::string texture;
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
