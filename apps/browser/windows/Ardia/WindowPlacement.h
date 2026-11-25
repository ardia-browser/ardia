#pragma once

#include <array>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <locale>
#include <optional>
#include <sstream>
#include <string>
#include <system_error>

#include "Paths.h"

namespace Ardia {

struct SavedPlacement {
  std::array<double, 4> frame{};
  bool maximized{false};
};

struct WindowPlacement {
  static std::optional<SavedPlacement> Load() noexcept {
    try {
      std::ifstream file(Location(), std::ios::binary);
      if (!file) return std::nullopt;
      file.imbue(std::locale::classic());
      SavedPlacement saved;
      int maximized = 0;
      if (!(file >> saved.frame[0] >> saved.frame[1] >> saved.frame[2] >> saved.frame[3] >> maximized)) return std::nullopt;
      for (double value : saved.frame) {
        if (!std::isfinite(value)) return std::nullopt;
      }
      if (saved.frame[2] <= 0 || saved.frame[3] <= 0) return std::nullopt;
      saved.maximized = maximized != 0;
      return saved;
    } catch (...) {
      return std::nullopt;
    }
  }

  static void Save(SavedPlacement const &placement) noexcept {
    try {
      std::ostringstream text;
      text.imbue(std::locale::classic());
      text << std::setprecision(10) << placement.frame[0] << ' ' << placement.frame[1] << ' ' << placement.frame[2] << ' '
           << placement.frame[3] << ' ' << (placement.maximized ? 1 : 0) << '\n';
      std::filesystem::path path = Location();
      std::filesystem::path partial = path;
      partial += L".partial";
      {
        std::ofstream file(partial, std::ios::binary | std::ios::trunc);
        if (!file) return;
        std::string contents = text.str();
        file.write(contents.data(), static_cast<std::streamsize>(contents.size()));
      }
      std::error_code ignored;
      std::filesystem::rename(partial, path, ignored);
    } catch (...) {
    }
  }

 private:
  static std::filesystem::path Location() {
    return Paths::DataDirectory() / L"window-placement.txt";
  }
};

}
