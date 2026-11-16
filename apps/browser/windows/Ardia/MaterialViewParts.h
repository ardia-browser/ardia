#pragma once

#include <NativeModules.h>
#include <JSValueComposition.h>
#include <winrt/Microsoft.ReactNative.Composition.h>
#include <winrt/Microsoft.UI.Composition.h>
#include <winrt/Windows.Foundation.Numerics.h>
#include <winrt/Windows.UI.h>

#include <algorithm>
#include <cmath>
#include <string>
#include <utility>

namespace Ardia {

namespace MaterialView {

using ComponentView = winrt::Microsoft::ReactNative::ComponentView;
using CompositionComponentView = winrt::Microsoft::ReactNative::Composition::ComponentView;
using ViewComponentView = winrt::Microsoft::ReactNative::Composition::ViewComponentView;
using LayoutMetrics = winrt::Microsoft::ReactNative::LayoutMetrics;
using Visual = winrt::Microsoft::UI::Composition::Visual;
using float2 = winrt::Windows::Foundation::Numerics::float2;

constexpr winrt::Windows::UI::Color Transparent{0, 0, 0, 0};

inline winrt::Windows::UI::Color Resolved(ComponentView const &view, winrt::Microsoft::ReactNative::Color const &color, winrt::Windows::UI::Color fallback) noexcept {
  if (!color) return fallback;
  try {
    return color.AsWindowsColor(view.as<CompositionComponentView>().Theme());
  } catch (...) {
    return fallback;
  }
}

inline float Finite(float value, float fallback) noexcept {
  return std::isfinite(value) ? value : fallback;
}

inline float ScaleOf(LayoutMetrics const &metrics) noexcept {
  return metrics.PointScaleFactor > 0 ? metrics.PointScaleFactor : 1.0f;
}

inline Visual PlainVisual(ComponentView const &view) noexcept {
  try {
    return view.as<CompositionComponentView>().Compositor().CreateSpriteVisual();
  } catch (...) {
    return nullptr;
  }
}

template <class TView>
inline winrt::com_ptr<TView> Of(ComponentView const &view) noexcept {
  try {
    auto data = view.UserData();
    if (!data) return nullptr;
    return data.as<TView>();
  } catch (...) {
    return nullptr;
  }
}

inline std::pair<float2, float2> GradientLine(float width, float height, float angle, std::string const &span, float reach) noexcept {
  constexpr float degrees = 3.14159265358979f / 180.0f;
  const float radians = Finite(angle, 180.0f) * degrees;
  const float dx = std::sin(radians);
  const float dy = -std::cos(radians);
  const float centerX = width / 2.0f;
  const float centerY = height / 2.0f;
  if (span == "base" || span == "corner") {
    float half = 0;
    if (span == "base") {
      half = std::hypot(width * dx, height * dy) * std::hypot(width, height) / (2.0f * (std::max)(width, height));
    } else {
      half = (width * std::fabs(dx) + height * std::fabs(dy)) / 2.0f;
    }
    const float length = 2.0f * half * Finite(reach, 1.0f);
    const float2 start{centerX - half * dx, centerY - half * dy};
    return {start, float2{start.x + dx * length, start.y + dy * length}};
  }
  const float ex = dx / width;
  const float ey = dy / height;
  const float lengthSquared = ex * ex + ey * ey;
  if (!(lengthSquared > 0)) return {float2{centerX, 0}, float2{centerX, height}};
  const float2 along{ex / lengthSquared / 2.0f, ey / lengthSquared / 2.0f};
  return {float2{centerX - along.x, centerY - along.y}, float2{centerX + along.x, centerY + along.y}};
}

}

}
