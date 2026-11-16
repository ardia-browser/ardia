#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <string>
#include <string_view>
#include <vector>

namespace Ardia::Grain {

constexpr int TextureSide = 128;
constexpr float TextureTileDips = 64.0f;
constexpr int HashSide = 256;
constexpr float SmallestCell = 0.25f;
constexpr float LargestCell = 4.0f;

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
  if (IsHash(texture)) return static_cast<int>(std::lround(HashSide * std::clamp(cellSize, SmallestCell, LargestCell)));
  return (std::max)(TextureSide, static_cast<int>(std::lround(TextureTileDips * scale)));
}

}
