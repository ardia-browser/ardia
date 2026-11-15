// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_REPORT_H_
#define ARDIA_LINUX_MODULES_REPORT_H_

#include <cstdint>
#include <optional>
#include <string>

#include "base/files/file_path.h"

namespace ardia_linux {

class ModuleRegistry;

void RegisterReportModule(ModuleRegistry& registry);

base::FilePath ReportsFolder();
std::optional<base::FilePath> ReportPathInside(const base::FilePath& root,
                                               const std::string& path);
void NoteReportFileSize(const std::string& path, int64_t size);

}

#endif
