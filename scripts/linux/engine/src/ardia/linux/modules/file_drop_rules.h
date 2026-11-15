// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_FILE_DROP_RULES_H_
#define ARDIA_LINUX_MODULES_FILE_DROP_RULES_H_

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "base/values.h"

namespace ardia_linux {

inline constexpr size_t kMaxDroppedItems = 50;
inline constexpr int64_t kMaxLinkFileBytes = 64 * 1024;

std::optional<std::string> DroppedWebUrl(std::string_view raw);

std::optional<std::string> LinkFileTarget(const base::FilePath& path,
                                          std::string_view contents);

struct DroppedPath {
  base::FilePath path;
  bool exists = false;
  bool extension_package = false;
  base::Value item;
};

DroppedPath ExamineDroppedPath(const base::FilePath& path);

enum class DropAccepts { kLinks, kLinksAndText, kExtensionPackages };

DropAccepts DropAcceptsFrom(std::string_view accepts);

base::ListValue DroppedItems(const std::vector<const DroppedPath*>& paths,
                             DropAccepts accepts);

}

#endif
