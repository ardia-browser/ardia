// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_LAUNCH_ARGUMENTS_H_
#define ARDIA_LINUX_MODULES_LAUNCH_ARGUMENTS_H_

#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/function_ref.h"

namespace ardia_linux {

std::string LaunchArgumentText(
    const std::string& argument,
    const base::FilePath& cwd,
    base::FunctionRef<bool(const base::FilePath&)> exists);

std::vector<std::string> LaunchArgumentTexts(
    const std::vector<std::string>& arguments,
    const base::FilePath& cwd,
    base::FunctionRef<bool(const base::FilePath&)> exists);

std::vector<std::string> LaunchAddresses(
    const std::vector<std::string>& arguments,
    const base::FilePath& cwd,
    base::FunctionRef<bool(const base::FilePath&)> exists);

}

#endif
