#pragma once

#include <NativeModules.h>
#include <winrt/Microsoft.ReactNative.Composition.h>
#include <winrt/Microsoft.UI.Composition.h>

#include <algorithm>
#include <cstdio>
#include <string>

#include "MaterialGrain.h"
#include "MaterialSupport.h"
#include "MaterialViews.h"

namespace Ardia {

REACT_STRUCT(MaterialGrainProps)
struct MaterialGrainProps : winrt::implements<MaterialGrainProps, winrt::Microsoft::ReactNative::IComponentProps> {
  MaterialGrainProps(winrt::Microsoft::ReactNative::ViewProps props, const winrt::Microsoft::ReactNative::IComponentProps &cloneFrom)
      : ViewProps(props) {
    if (cloneFrom) {
      auto source = cloneFrom.as<MaterialGrainProps>();
      texture = source->texture;
      amount = source->amount;
      cellSize = source->cellSize;
      requestId = source->requestId;
    }
  }

  void SetProp(uint32_t hash, winrt::hstring propName, winrt::Microsoft::ReactNative::IJSValueReader value) noexcept {
    winrt::Microsoft::ReactNative::ReadProp(hash, propName, value, *this);
  }

  REACT_FIELD(texture)
  std::string texture;

  REACT_FIELD(amount)
  float amount{0};

  REACT_FIELD(cellSize)
  float cellSize{1};

  REACT_FIELD(requestId)
  std::string requestId;

  const winrt::Microsoft::ReactNative::ViewProps ViewProps;
};

struct MaterialGrainView : winrt::implements<MaterialGrainView, winrt::Windows::Foundation::IInspectable> {
  void Initialize(MaterialView::ViewComponentView const &view) noexcept {
    try {
      m_mounted = view.Mounted([](winrt::Windows::Foundation::IInspectable const &, MaterialView::ComponentView const &mounted) noexcept {
        if (auto grain = MaterialView::Of<MaterialGrainView>(mounted)) grain->Paint();
      });
      m_unmounted = view.Unmounted([](winrt::Windows::Foundation::IInspectable const &, MaterialView::ComponentView const &unmounted) noexcept {
        if (auto grain = MaterialView::Of<MaterialGrainView>(unmounted)) grain->LetGo();
      });
      m_destroying = view.Destroying([](winrt::Windows::Foundation::IInspectable const &, MaterialView::ComponentView const &destroyed) noexcept {
        if (auto grain = MaterialView::Of<MaterialGrainView>(destroyed)) grain->Retire();
      });
    } catch (...) {
      Materials::NoteOnce(L"grain-view-events", L"grain: a view could not follow its mounting, so its tile stays kept after it goes");
    }
    m_failureListener = Grain::ListenForFailure([weak = get_weak()]() noexcept {
      if (auto grain = weak.get()) grain->ShowNothing(Grain::Shared().failure);
    });
  }

  MaterialView::Visual CreateVisual(MaterialView::ComponentView const &view) noexcept {
    try {
      m_compositor = view.as<MaterialView::CompositionComponentView>().Compositor();
      m_root = m_compositor.CreateContainerVisual();
      m_sprite = m_compositor.CreateSpriteVisual();
      m_sprite.RelativeSizeAdjustment(MaterialView::float2{1.0f, 1.0f});
      m_root.Children().InsertAtTop(m_sprite);
      Paint();
      return m_root;
    } catch (...) {
      Materials::NoteOnce(L"grain-view-visual", L"grain: a view could not make its visuals, so it draws nothing");
    }
    return MaterialView::PlainVisual(view);
  }

  void UpdateProps(MaterialView::ComponentView const &, winrt::com_ptr<MaterialGrainProps> const &props) noexcept {
    m_texture = Grain::Known(props ? std::string_view{props->texture} : std::string_view{});
    m_amount = props ? std::clamp(MaterialView::Finite(props->amount, 0.0f), 0.0f, 1.0f) : 0.0f;
    m_cellSize = props ? MaterialView::Finite(props->cellSize, 1.0f) : 1.0f;
    const std::string request = props ? props->requestId : std::string{};
    if (request != m_requestId) {
      m_requestId = request;
      m_paintedKey.clear();
    }
    Paint();
  }

  void UpdateLayoutMetrics(MaterialView::ComponentView const &, MaterialView::LayoutMetrics const &metrics) noexcept {
    m_scale = MaterialView::ScaleOf(metrics);
    m_measured = true;
    Paint();
  }

 private:
  void Paint() noexcept {
    if (!m_sprite || !m_compositor || !m_measured) return;
    if (Grain::Failed()) {
      ShowNothing(Grain::Shared().failure);
      return;
    }
    try {
      m_sprite.Opacity(m_amount);
    } catch (...) {
      Materials::NoteOnce(L"grain-view-opacity", L"grain: a view refused its grain amount and keeps its last one");
    }
    Grain::RecoverIfLost(m_compositor);
    if (Grain::Failed()) {
      ShowNothing(Grain::Shared().failure);
      return;
    }
    const int pixels = Grain::TilePixels(m_texture, m_scale, m_cellSize);
    const std::string key = Grain::SurfaceKey(m_texture, pixels);
    if (key == m_paintedKey) return;
    Grain::Painted painted = Grain::WrappedTile(m_compositor, m_texture, pixels);
    if (!painted.outcome.drawn) {
      ShowNothing(painted.outcome.reason);
      return;
    }
    try {
      m_sprite.Brush(painted.brush);
    } catch (...) {
      Grain::DropUnused(Grain::Shared(), key);
      ShowNothing(L"the sprite refused the wrap brush");
      return;
    }
    m_paintedKey = key;
    Hold(key);
    Record({true, {}}, pixels);
  }

  void ShowNothing(std::wstring const &reason) noexcept {
    try {
      if (m_sprite) m_sprite.Brush(nullptr);
    } catch (...) {
      Materials::NoteOnce(L"grain-view-clear", L"grain: a view could not clear its brush");
    }
    LetGo();
    Record({false, reason.empty() ? std::wstring{L"grain failed"} : reason}, 0);
  }

  bool Brushed() const noexcept {
    try {
      return m_sprite && m_sprite.Brush() != nullptr;
    } catch (...) {
      Materials::NoteOnce(L"grain-view-brush-read", L"grain: a view could not read back its brush");
      return false;
    }
  }

  void Hold(std::string const &key) noexcept {
    if (key == m_held) return;
    Grain::Release(Grain::Shared(), m_held);
    Grain::Retain(Grain::Shared(), key);
    m_held = key;
  }

  void LetGo() noexcept {
    Grain::Release(Grain::Shared(), m_held);
    m_held.clear();
    m_paintedKey.clear();
  }

  void Retire() noexcept {
    LetGo();
    Grain::StopListeningForFailure(m_failureListener);
    m_failureListener = 0;
  }

  std::wstring Described(int pixels) const noexcept {
    wchar_t text[96]{};
    if (Grain::IsHash(m_texture)) swprintf_s(text, L"%d px tile of %d cells, %.2f px each", pixels, Grain::HashSide, static_cast<float>(pixels) / Grain::HashSide);
    else swprintf_s(text, L"%d px tile (%.0f DIPs at %.2fx)", pixels, Grain::TextureTileDips, m_scale);
    return text;
  }

  void Record(Grain::Outcome const &outcome, int pixels) noexcept {
    Grain::Remember({outcome.drawn ? "tiled" : "none", Paths::Utf8(outcome.drawn ? Described(pixels) : outcome.reason), m_texture, Brushed()}, m_requestId);
    const std::wstring texture = Paths::Wide(m_texture);
    if (!outcome.drawn) {
      Materials::NoteOnce(std::wstring{L"grain-view-none-"}.append(texture), std::wstring{L"grain: a "}.append(texture).append(L" view draws nothing (").append(outcome.reason).append(L")"));
      return;
    }
    Materials::NoteOnce(
        std::wstring{L"grain-"}.append(texture).append(L"-").append(std::to_wstring(pixels)),
        std::wstring{L"grain: "}.append(texture).append(L" ").append(Described(pixels)).append(L" wrapped across the view"));
  }

  winrt::Microsoft::UI::Composition::Compositor m_compositor{nullptr};
  winrt::Microsoft::UI::Composition::ContainerVisual m_root{nullptr};
  winrt::Microsoft::UI::Composition::SpriteVisual m_sprite{nullptr};
  std::string m_texture{"grain"};
  std::string m_paintedKey;
  std::string m_held;
  std::string m_requestId;
  float m_amount{0};
  float m_cellSize{1};
  float m_scale{1};
  bool m_measured{false};
  uint64_t m_failureListener{0};
  winrt::event_token m_mounted{};
  winrt::event_token m_unmounted{};
  winrt::event_token m_destroying{};
};

inline void RegisterMaterialGrainView(winrt::Microsoft::ReactNative::IReactPackageBuilder const &packageBuilder) noexcept {
  RegisterMaterialView<MaterialGrainView, MaterialGrainProps>(packageBuilder, L"ArdiaMaterialGrain");
}

}
