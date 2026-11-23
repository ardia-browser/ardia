// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_CONTROL_FILE_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_CONTROL_FILE_H_

#include <cstdint>
#include <string>

#include "base/files/file_path.h"

namespace ardia {

base::FilePath ControlFilePath();
void SetLiveGeneration(uint64_t generation);
std::string WriteControlFile(const base::FilePath& path,
                             const std::string& contents,
                             uint64_t generation);
void DeleteStaleControlFile(const base::FilePath& path);
void DeleteControlFile(const base::FilePath& path);

}

#endif
