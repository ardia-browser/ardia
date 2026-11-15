// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_LOG_H_
#define ARDIA_LINUX_LOG_H_

#include <string_view>

#include "base/files/file_path.h"

namespace ardia_linux {

base::FilePath DataDirectory();

void Note(std::string_view area, std::string_view message);

void NoteActivation(std::string_view message);

}

#endif
