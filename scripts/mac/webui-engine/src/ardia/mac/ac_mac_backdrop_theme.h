#ifndef ARDIA_MAC_AC_MAC_BACKDROP_THEME_H_
#define ARDIA_MAC_AC_MAC_BACKDROP_THEME_H_

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace ardia_mac::backdrop_theme {

inline constexpr int kGrainSide = 128;
inline constexpr std::size_t kMaxLayers = 8;
inline constexpr std::size_t kMaxStops = 40;
inline constexpr double kMaxGrainPoints = 1024;

struct Color {
  double red = 0;
  double green = 0;
  double blue = 0;
  double alpha = 0;
  bool display_p3 = false;
  bool operator==(const Color&) const = default;
};

struct Stop {
  double offset = 0;
  Color color;
  bool operator==(const Stop&) const = default;
};

enum class Kind { kFill, kGradient, kGrain };

struct Layer {
  Kind kind = Kind::kFill;
  Color color;
  double start_x = 0.5;
  double start_y = 0;
  double end_x = 0.5;
  double end_y = 1;
  std::vector<Stop> stops;
  std::string texture;
  double points = kGrainSide;
  double opacity = 1;
  bool operator==(const Layer&) const = default;
};

struct Theme {
  std::vector<Layer> layers;
  double opacity = 1;
  std::array<double, 4> radii = {0, 0, 0, 0};
  bool operator==(const Theme&) const = default;
};

inline bool Finite(double value) {
  return std::isfinite(value);
}

inline double Unit(double value) {
  return Finite(value) ? std::clamp(value, 0.0, 1.0) : 0;
}

inline constexpr double kMaxGradientReach = 64;
inline constexpr double kMaxThemeRadius = 512;

inline std::optional<Color> ColorFrom(const std::array<double, 5>& parts) {
  for (double part : parts) {
    if (!Finite(part)) return std::nullopt;
  }
  return Color{Unit(parts[0]), Unit(parts[1]), Unit(parts[2]), Unit(parts[3]), parts[4] == 1};
}

inline std::optional<double> GradientPoint(double value) {
  return Finite(value) && std::abs(value) <= kMaxGradientReach ? std::optional<double>(value) : std::nullopt;
}

inline double ThemeRadius(double value) {
  return Finite(value) ? std::clamp(value, 0.0, kMaxThemeRadius) : 0;
}

inline double GrainPoints(double value) {
  return Finite(value) && value > 0 ? std::min(value, kMaxGrainPoints) : kGrainSide;
}

inline bool LayerCountFits(std::size_t layers) {
  return layers <= kMaxLayers;
}

inline bool StopCountFits(std::size_t stops) {
  return stops > 0 && stops <= kMaxStops;
}

inline bool KnownTexture(std::string_view texture) {
  return texture == "film" || texture == "grain" || texture == "sand" || texture == "denim" || texture == "tweed";
}

inline std::array<std::uint8_t, kGrainSide * kGrainSide> FilmGrainAlpha() {
  std::array<std::uint8_t, kGrainSide * kGrainSide> alpha{};
  const auto fract = [](double value) { return value - std::floor(value); };
  for (int y = 0; y < kGrainSide; ++y) {
    for (int x = 0; x < kGrainSide; ++x) {
      double p0 = fract(x * 0.1031);
      double p1 = fract(y * 0.1031);
      double p2 = fract(x * 0.1031);
      const double d = p0 * (p1 + 33.33) + p1 * (p2 + 33.33) + p2 * (p0 + 33.33);
      p0 += d;
      p1 += d;
      p2 += d;
      const double hash = fract((p0 + p1) * p2);
      alpha[static_cast<std::size_t>(y * kGrainSide + x)] = static_cast<std::uint8_t>(std::lround((1 - hash) * 255));
    }
  }
  return alpha;
}

inline std::array<std::uint8_t, kGrainSide * kGrainSide> TextureGrainAlpha(std::string_view texture) {
  constexpr int n = kGrainSide;
  std::vector<float> alpha(static_cast<std::size_t>(n * n), 0);
  std::uint32_t state = 0x9e3779b9u;
  const auto random = [&state]() {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return static_cast<double>(static_cast<float>(static_cast<double>(state % 10000) / 10000.0));
  };
  const auto add = [&alpha](int x, int y, double value) {
    const int index = (((y % n) + n) % n) * n + (((x % n) + n) % n);
    alpha[static_cast<std::size_t>(index)] = static_cast<float>(std::min(1.0, static_cast<double>(alpha[static_cast<std::size_t>(index)]) + value));
  };
  double gain = 0.211;
  double floor = 0;
  if (texture == "sand") {
    gain = 0.937;
    floor = 0.132;
    for (int i = 0; i < n * n; ++i) alpha[static_cast<std::size_t>(i)] = static_cast<float>(random() * 0.25);
    for (int k = 0; k < (n * n) / 18; ++k) {
      const int x = static_cast<int>(std::trunc(random() * n));
      const int y = static_cast<int>(std::trunc(random() * n));
      const double value = 0.5 + random() * 0.5;
      add(x, y, value);
      add(x + 1, y, value * 0.6);
      add(x, y + 1, value * 0.6);
      add(x + 1, y + 1, value * 0.4);
    }
  } else if (texture == "denim") {
    gain = 0.226;
    floor = 0.068;
    for (int y = 0; y < n; ++y) {
      for (int x = 0; x < n; ++x) {
        const double twill = (x + y) % 4 < 2 ? 0.75 : 0.15;
        alpha[static_cast<std::size_t>(y * n + x)] = static_cast<float>(std::min(1.0, twill * (0.6 + random() * 0.4) + (y % 2 == 0 ? 0.08 : 0)));
      }
    }
  } else if (texture == "tweed") {
    gain = 0.23;
    floor = 0.261;
    for (int i = 0; i < n * n; ++i) alpha[static_cast<std::size_t>(i)] = static_cast<float>(random() * 0.15);
    for (int k = 0; k < (n * n) / 40; ++k) {
      const int x = static_cast<int>(std::trunc(random() * n));
      const int y = static_cast<int>(std::trunc(random() * n));
      const double value = 0.4 + random() * 0.6;
      const bool horizontal = random() < 0.5;
      const int run = 3 + static_cast<int>(std::trunc(random() * 4));
      for (int j = 0; j < run; ++j) horizontal ? add(x + j, y, value) : add(x, y + j, value);
    }
  } else {
    for (int i = 0; i < n * n; ++i) {
      const double u = random();
      alpha[static_cast<std::size_t>(i)] = static_cast<float>(u * u);
    }
  }
  std::array<std::uint8_t, kGrainSide * kGrainSide> bytes{};
  for (int i = 0; i < n * n; ++i) {
    const double value = std::min(255.0, std::max(0.0, floor + gain * static_cast<double>(alpha[static_cast<std::size_t>(i)])) * 255);
    bytes[static_cast<std::size_t>(i)] = static_cast<std::uint8_t>(std::trunc(value));
  }
  return bytes;
}

inline std::array<std::uint8_t, kGrainSide * kGrainSide> GrainAlpha(std::string_view texture) {
  return texture == "film" ? FilmGrainAlpha() : TextureGrainAlpha(texture);
}

inline constexpr std::string_view kBackdropIdPrefix = "backdrop:";

inline std::string BackdropId(std::size_t accepted) {
  return std::string(kBackdropIdPrefix) + std::to_string(accepted);
}

inline std::optional<std::size_t> BackdropIndex(std::string_view id, std::size_t accepted) {
  if (!id.starts_with(kBackdropIdPrefix)) return std::nullopt;
  const std::string_view digits = id.substr(kBackdropIdPrefix.size());
  if (digits.empty() || digits.size() > 6 || (digits.size() > 1 && digits.front() == '0')) return std::nullopt;
  std::size_t index = 0;
  for (char c : digits) {
    if (c < '0' || c > '9') return std::nullopt;
    index = index * 10 + static_cast<std::size_t>(c - '0');
  }
  return index < accepted ? std::optional<std::size_t>(index) : std::nullopt;
}

inline constexpr int kMaxGrainImagePixels = 4096;

inline int GrainImagePixels(double points, double backing_scale, double zoom = 1) {
  const double scale = Finite(backing_scale) && backing_scale > 0 ? backing_scale : 1;
  const double magnify = Finite(zoom) && zoom > 0 ? std::min(zoom, 20.0) : 1;
  const double size = Finite(points) && points > 0 ? std::min(points, kMaxGrainPoints) : kGrainSide;
  return std::clamp(static_cast<int>(std::lround(size * magnify * scale)), 1, kMaxGrainImagePixels);
}

}

#endif
