// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/import/browser_icons.h"

#include <array>
#include <string_view>

#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"

namespace ardia_linux::import {

namespace {

constexpr size_t kLongestName = 128;
constexpr int64_t kLargestDesktopFile = 64 * 1024;
constexpr std::array<std::string_view, 7> kSizes = {
    "128x128", "256x256", "96x96", "64x64", "48x48", "512x512", "scalable"};
constexpr std::array<std::string_view, 5> kImageExtensions = {
    ".png", ".svg", ".jpg", ".jpeg", ".webp"};

bool IsIconName(const std::string& name) {
  return !name.empty() && name.size() <= kLongestName && name != "." &&
         name != ".." && name.find('/') == std::string::npos &&
         name.find('\0') == std::string::npos;
}

std::vector<base::FilePath> ThemeRoots(const base::FilePath& home,
                                       const base::FilePath& system_root) {
  return {
      home.Append(".local/share/icons/hicolor"),
      home.Append(".local/share/flatpak/exports/share/icons/hicolor"),
      system_root.Append("var/lib/flatpak/exports/share/icons/hicolor"),
      system_root.Append("usr/local/share/icons/hicolor"),
      system_root.Append("usr/share/icons/hicolor"),
  };
}

bool IsFile(const base::FilePath& path) {
  return base::PathExists(path) && !base::DirectoryExists(path);
}

std::optional<base::FilePath> SnapIcon(const base::FilePath& system_root,
                                       const std::vector<std::string>& names) {
  const base::FilePath desktop_files =
      system_root.Append("var/lib/snapd/desktop/applications");
  std::vector<base::FilePath> entries;
  base::FileEnumerator listing(desktop_files, false,
                               base::FileEnumerator::FILES, "*.desktop");
  for (base::FilePath entry = listing.Next(); !entry.empty();
       entry = listing.Next()) {
    entries.push_back(entry);
  }
  for (const std::string& name : names) {
    for (const base::FilePath& entry : entries) {
      if (!entry.BaseName().value().starts_with(name + "_")) {
        continue;
      }
      std::string text;
      if (!base::ReadFileToStringWithMaxSize(entry, &text,
                                             kLargestDesktopFile)) {
        continue;
      }
      for (std::string_view line : base::SplitStringPiece(
               text, "\n", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
        if (!line.starts_with("Icon=")) {
          continue;
        }
        base::FilePath icon(base::TrimWhitespaceASCII(
            line.substr(5), base::TRIM_ALL));
        if (icon.IsAbsolute() && !icon.ReferencesParent() &&
            IsServableImage(icon) && IsFile(icon)) {
          return icon;
        }
        break;
      }
    }
  }
  return std::nullopt;
}

}

bool IsServableImage(const base::FilePath& path) {
  const std::string extension = base::ToLowerASCII(path.FinalExtension());
  for (std::string_view allowed : kImageExtensions) {
    if (extension == allowed) {
      return true;
    }
  }
  return false;
}

std::optional<base::FilePath> FindBrowserIcon(
    const base::FilePath& home,
    const base::FilePath& system_root,
    const std::vector<std::string>& names) {
  std::vector<std::string> valid;
  for (const std::string& name : names) {
    if (IsIconName(name)) {
      valid.push_back(name);
    }
  }
  const std::vector<base::FilePath> roots = ThemeRoots(home, system_root);
  for (const std::string& name : valid) {
    for (const base::FilePath& root : roots) {
      for (std::string_view size : kSizes) {
        const base::FilePath icon = root.Append(size).Append("apps").Append(
            name + (size == "scalable" ? ".svg" : ".png"));
        if (IsFile(icon)) {
          return icon;
        }
      }
    }
    for (std::string_view extension : {".png", ".svg"}) {
      const base::FilePath icon =
          system_root.Append("usr/share/pixmaps").Append(name + std::string(extension));
      if (IsFile(icon)) {
        return icon;
      }
    }
  }
  return SnapIcon(system_root, valid);
}

}
