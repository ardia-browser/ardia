// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/test_gate.h"

#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/no_destructor.h"
#include "base/nix/xdg_util.h"
#include "base/strings/string_number_conversions.h"

namespace ardia_linux {

namespace {

std::optional<std::string> RealPath(const std::string& path) {
  char resolved[PATH_MAX];
  if (!realpath(path.c_str(), resolved)) {
    return std::nullopt;
  }
  return std::string(resolved);
}

std::string Canonical(const base::FilePath& path) {
  std::vector<std::string> missing;
  base::FilePath existing = path;
  while (true) {
    if (std::optional<std::string> real = RealPath(existing.value())) {
      base::FilePath joined(*real);
      for (auto it = missing.rbegin(); it != missing.rend(); ++it) {
        joined = joined.Append(*it);
      }
      return joined.value();
    }
    const base::FilePath parent = existing.DirName();
    if (parent == existing) {
      return path.value();
    }
    missing.push_back(existing.BaseName().value());
    existing = parent;
  }
}

bool WithinOrSame(std::string_view inner, std::string_view outer) {
  while (outer.size() > 1 && outer.back() == '/') {
    outer.remove_suffix(1);
  }
  if (!inner.starts_with(outer)) {
    return false;
  }
  return inner.size() == outer.size() || inner[outer.size()] == '/' ||
         outer == "/";
}

bool Overlaps(std::string_view a, std::string_view b) {
  return WithinOrSame(a, b) || WithinOrSame(b, a);
}

std::vector<std::string> RealDataFolders() {
  std::unique_ptr<base::Environment> env = base::Environment::Create();
  const base::FilePath home = base::GetHomeDir();
  const base::FilePath data =
      base::nix::GetXDGDirectory(env.get(), "XDG_DATA_HOME", ".local/share");
  const base::FilePath config =
      base::nix::GetXDGDirectory(env.get(), "XDG_CONFIG_HOME", ".config");
  std::vector<std::string> folders;
  for (const base::FilePath& folder :
       {home.Append(".local/share/ardia"), home.Append(".config/ardia"),
        home.Append(".config/Ardia"), data.Append("ardia"),
        config.Append("ardia"), config.Append("Ardia")}) {
    folders.push_back(Canonical(folder));
  }
  return folders;
}

std::string ClashOf(const std::vector<std::string>& mine) {
  for (const std::string& real : RealDataFolders()) {
    for (const std::string& folder : mine) {
      if (Overlaps(folder, real)) {
        return "ARDIA_DATA_DIR is, is inside or holds the real data folder " +
               real;
      }
    }
  }
  return std::string();
}

bool TestBuild() {
  std::optional<std::string> exe = RealPath("/proc/self/exe");
  if (!exe) {
    return false;
  }
  struct stat marker;
  const base::FilePath path =
      base::FilePath(*exe).DirName().Append(kTestBuildMarker);
  return lstat(path.value().c_str(), &marker) == 0 && S_ISREG(marker.st_mode);
}

std::vector<base::ScopedFD>& HeldFolders() {
  static base::NoDestructor<std::vector<base::ScopedFD>> held;
  return *held;
}

std::optional<std::string> HeldPath(int fd) {
  return RealPath("/proc/self/fd/" + base::NumberToString(fd));
}

}

std::string TestGateRefusal(const base::FilePath& data_dir) {
  if (data_dir.empty()) {
    return "no scratch ARDIA_DATA_DIR";
  }
  if (!data_dir.IsAbsolute()) {
    return "ARDIA_DATA_DIR is not an absolute path";
  }
  std::string clash = ClashOf(
      {Canonical(data_dir), Canonical(data_dir.Append("Chromium"))});
  if (!clash.empty()) {
    return clash;
  }
  if (!TestBuild()) {
    return std::string("not a test build: no ") + kTestBuildMarker +
           " beside the binary";
  }
  return std::string();
}

std::string HoldScratchFolders(const base::FilePath& data_dir) {
  std::vector<std::string> held_paths;
  std::string expected_parent;
  for (const base::FilePath& folder : {data_dir, data_dir.Append("Chromium")}) {
    if (!base::CreateDirectory(folder)) {
      return "ARDIA_DATA_DIR can't be made";
    }
    base::ScopedFD fd(HANDLE_EINTR(
        open(folder.value().c_str(),
             O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)));
    if (!fd.is_valid()) {
      return "ARDIA_DATA_DIR or its Chromium folder is a link or can't be "
             "held open";
    }
    std::optional<std::string> held = HeldPath(fd.get());
    HeldFolders().push_back(std::move(fd));
    if (!held || *held != Canonical(folder)) {
      return "ARDIA_DATA_DIR resolves to another folder than the one held";
    }
    if (!expected_parent.empty() &&
        base::FilePath(*held).DirName().value() != expected_parent) {
      return "ARDIA_DATA_DIR's Chromium folder is not inside the folder held";
    }
    expected_parent = *held;
    held_paths.push_back(*held);
  }
  return ClashOf(held_paths);
}

}
