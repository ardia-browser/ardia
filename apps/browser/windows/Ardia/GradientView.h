#pragma once

#include <NativeModules.h>
#include <JSValueComposition.h>
#include <winrt/Microsoft.ReactNative.Composition.h>
#include <winrt/Microsoft.UI.Composition.h>

#include <algorithm>
#include <string>
#include <utility>
#include <vector>

#include "GradientFailures.h"
#include "MaterialSupport.h"
#include "MaterialViewParts.h"

namespace Ardia {

namespace GradientParts {

inline float StopAt(std::vector<float> const &stops, size_t index, size_t count) noexcept {
  if (stops.size() == count) return (std::clamp)(MaterialView::Finite(stops[index], 0.0f), 0.0f, 1.0f);
  return count <= 1 ? 0.0f : static_cast<float>(index) / static_cast<float>(count - 1);
}

}

REACT_STRUCT(MaterialGradientProps)
struct MaterialGradientProps : winrt::implements<MaterialGradientProps, winrt::Microsoft::ReactNative::IComponentProps> {
  MaterialGradientProps(winrt::Microsoft::ReactNative::ViewProps props, const winrt::Microsoft::ReactNative::IComponentProps &cloneFrom)
      : ViewProps(props) {
    if (cloneFrom) {
      auto source = cloneFrom.as<MaterialGradientProps>();
      colors = source->colors;
      stops = source->stops;
      angle = source->angle;
      span = source->span;
      reach = source->reach;
      fade = source->fade;
      fadeStops = source->fadeStops;
      fadeAngle = source->fadeAngle;
    }
  }

  void SetProp(uint32_t hash, winrt::hstring propName, winrt::Microsoft::ReactNative::IJSValueReader value) noexcept {
    if (propName == L"colors") colors.clear();
    if (propName == L"stops") stops.clear();
    if (propName == L"fade") fade.clear();
    if (propName == L"fadeStops") fadeStops.clear();
    winrt::Microsoft::ReactNative::ReadProp(hash, propName, value, *this);
  }

  REACT_FIELD(colors)
  std::vector<float> colors;

  REACT_FIELD(stops)
  std::vector<float> stops;

  REACT_FIELD(angle)
  float angle{180};

  REACT_FIELD(span)
  std::string span;

  REACT_FIELD(reach)
  float reach{1};

  REACT_FIELD(fade)
  std::vector<float> fade;

  REACT_FIELD(fadeStops)
  std::vector<float> fadeStops;

  REACT_FIELD(fadeAngle)
  float fadeAngle{90};

  const winrt::Microsoft::ReactNative::ViewProps ViewProps;
};

struct MaterialGradientView : winrt::implements<MaterialGradientView, winrt::Windows::Foundation::IInspectable> {
  void Initialize(MaterialView::ViewComponentView const &) noexcept {}

  MaterialView::Visual CreateVisual(MaterialView::ComponentView const &view) noexcept {
    try {
      m_compositor = view.as<MaterialView::CompositionComponentView>().Compositor();
      m_sprite = m_compositor.CreateSpriteVisual();
    } catch (...) {
      return MaterialView::PlainVisual(view);
    }
    try {
      m_gradient = m_compositor.CreateLinearGradientBrush();
      m_gradient.MappingMode(winrt::Microsoft::UI::Composition::CompositionMappingMode::Absolute);
      Materials::NoteOnce(L"gradient", L"gradients: composition linear gradient brush");
    } catch (winrt::hresult_error const &error) {
      Fail(Materials::Described(error));
    } catch (...) {
      Fail(L"unknown error");
    }
    Restop();
    Refade();
    Place();
    return m_sprite;
  }

  void UpdateProps(MaterialView::ComponentView const &, winrt::com_ptr<MaterialGradientProps> const &props) noexcept {
    std::vector<float> colors = props ? props->colors : std::vector<float>{};
    std::vector<float> stops = props ? props->stops : std::vector<float>{};
    std::vector<float> fade = props ? props->fade : std::vector<float>{};
    std::vector<float> fadeStops = props ? props->fadeStops : std::vector<float>{};
    const bool restop = colors != m_colors || stops != m_stops;
    const bool refade = fade != m_fade || fadeStops != m_fadeStops;
    m_colors = std::move(colors);
    m_stops = std::move(stops);
    m_fade = std::move(fade);
    m_fadeStops = std::move(fadeStops);
    m_angle = props ? MaterialView::Finite(props->angle, 180.0f) : 180.0f;
    m_span = props ? props->span : std::string{};
    m_reach = props ? MaterialView::Finite(props->reach, 1.0f) : 1.0f;
    m_fadeAngle = props ? MaterialView::Finite(props->fadeAngle, 90.0f) : 90.0f;
    if (restop) Restop();
    if (refade) Refade();
    Place();
  }

  void UpdateLayoutMetrics(MaterialView::ComponentView const &, MaterialView::LayoutMetrics const &metrics) noexcept {
    m_metrics = metrics;
    m_measured = true;
    Place();
  }

 private:
  void Fail(std::wstring const &reason) noexcept {
    Materials::MarkGradientFailed();
    m_gradient = nullptr;
    m_masked = nullptr;
    if (m_sprite) m_sprite.Brush(nullptr);
    Materials::NoteOnce(L"gradient-flat", std::wstring{L"gradients: none drawn ("}.append(reason).append(L")"));
  }

  void Restop() noexcept {
    if (!m_gradient || !m_compositor) return;
    try {
      auto stops = m_gradient.ColorStops();
      stops.Clear();
      const size_t count = m_colors.size() / 4;
      for (size_t i = 0; i < count; i++) {
        const float *rgba = m_colors.data() + i * 4;
        stops.Append(m_compositor.CreateColorGradientStop(GradientParts::StopAt(m_stops, i, count), Materials::ColorFromUnit(rgba[0], rgba[1], rgba[2], rgba[3])));
      }
      if (count == 1) stops.Append(m_compositor.CreateColorGradientStop(1.0f, Materials::ColorFromUnit(m_colors[0], m_colors[1], m_colors[2], m_colors[3])));
    } catch (winrt::hresult_error const &error) {
      Fail(Materials::Described(error));
    } catch (...) {
      Fail(L"unknown error");
    }
  }

  void Refade() noexcept {
    if (!m_gradient || !m_compositor || !m_sprite) return;
    if (m_fade.size() < 2) {
      m_masked = nullptr;
      m_mask = nullptr;
      m_sprite.Brush(m_gradient);
      return;
    }
    try {
      if (!m_mask) {
        m_mask = m_compositor.CreateLinearGradientBrush();
        m_mask.MappingMode(winrt::Microsoft::UI::Composition::CompositionMappingMode::Absolute);
      }
      auto stops = m_mask.ColorStops();
      stops.Clear();
      for (size_t i = 0; i < m_fade.size(); i++) {
        const float alpha = (std::clamp)(MaterialView::Finite(m_fade[i], 0.0f), 0.0f, 1.0f);
        stops.Append(m_compositor.CreateColorGradientStop(GradientParts::StopAt(m_fadeStops, i, m_fade.size()), Materials::ColorFromUnit(0, 0, 0, alpha)));
      }
      if (!m_masked) {
        m_masked = m_compositor.CreateMaskBrush();
        m_masked.Source(m_gradient);
        m_masked.Mask(m_mask);
        Materials::NoteOnce(L"gradient-fade", L"gradients: faded through a composition mask brush");
      }
      m_sprite.Brush(m_masked);
    } catch (winrt::hresult_error const &error) {
      FadeFailed(Materials::Described(error));
    } catch (...) {
      FadeFailed(L"unknown error");
    }
  }

  void FadeFailed(std::wstring const &reason) noexcept {
    m_masked = nullptr;
    m_mask = nullptr;
    if (m_sprite && m_gradient) m_sprite.Brush(m_gradient);
    Materials::NoteOnce(L"gradient-unfaded", std::wstring{L"gradients: drawn without their fade ("}.append(reason).append(L")"));
  }

  void Place() noexcept {
    if (!m_gradient || !m_measured) return;
    const float scale = MaterialView::ScaleOf(m_metrics);
    const float width = m_metrics.Frame.Width * scale;
    const float height = m_metrics.Frame.Height * scale;
    if (!(width > 0 && height > 0)) return;
    try {
      const auto [start, end] = MaterialView::GradientLine(width, height, m_angle, m_span, m_reach);
      m_gradient.StartPoint(start);
      m_gradient.EndPoint(end);
      if (m_mask) {
        const auto [fadeStart, fadeEnd] = MaterialView::GradientLine(width, height, m_fadeAngle, std::string{}, 1.0f);
        m_mask.StartPoint(fadeStart);
        m_mask.EndPoint(fadeEnd);
      }
    } catch (...) {
    }
  }

  winrt::Microsoft::UI::Composition::Compositor m_compositor{nullptr};
  winrt::Microsoft::UI::Composition::SpriteVisual m_sprite{nullptr};
  winrt::Microsoft::UI::Composition::CompositionLinearGradientBrush m_gradient{nullptr};
  winrt::Microsoft::UI::Composition::CompositionLinearGradientBrush m_mask{nullptr};
  winrt::Microsoft::UI::Composition::CompositionMaskBrush m_masked{nullptr};
  winrt::Microsoft::ReactNative::LayoutMetrics m_metrics{};
  std::vector<float> m_colors;
  std::vector<float> m_stops;
  std::vector<float> m_fade;
  std::vector<float> m_fadeStops;
  float m_angle{180};
  std::string m_span;
  float m_reach{1};
  float m_fadeAngle{90};
  bool m_measured{false};
};

}
