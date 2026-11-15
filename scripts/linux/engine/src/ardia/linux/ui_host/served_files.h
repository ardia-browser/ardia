// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_UI_HOST_SERVED_FILES_H_
#define ARDIA_LINUX_UI_HOST_SERVED_FILES_H_

#include <optional>

#include "base/files/file_path.h"

namespace ardia_linux {

inline constexpr char kImportImagesPrefix[] = "import-images/";

void ServeImportImage(const base::FilePath& shown_as,
                      const base::FilePath& file);

std::optional<base::FilePath> ServedImportImage(const base::FilePath& shown_as);

}

#endif
