// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_IMPORT_BROWSER_ICONS_H_
#define ARDIA_LINUX_IMPORT_BROWSER_ICONS_H_

#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"

namespace ardia_linux::import {

std::optional<base::FilePath> FindBrowserIcon(
    const base::FilePath& home,
    const base::FilePath& system_root,
    const std::vector<std::string>& names);

bool IsServableImage(const base::FilePath& path);

}

#endif
