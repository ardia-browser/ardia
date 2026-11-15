// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/test_gate.h"

#include <dirent.h>
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

#include <array>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/environment.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/nix/xdg_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/values.h"

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

constexpr std::array<std::string_view, 3> kSingletonLinks = {
    "SingletonLock", "SingletonSocket", "SingletonCookie"};
constexpr int kDeepestProfileFolder = 64;
constexpr size_t kLargestLocalState = size_t{64} << 20;

struct DirCloser {
  void operator()(DIR* dir) const { closedir(dir); }
};

bool IsSingletonLink(const base::FilePath& path,
                     const base::FilePath& chromium_root) {
  if (path.DirName() != chromium_root) {
    return false;
  }
  const std::string name = path.BaseName().value();
  for (std::string_view singleton : kSingletonLinks) {
    if (name == singleton) {
      return true;
    }
  }
  return false;
}

std::string LinkTargetOf(const base::FilePath& link) {
  base::FilePath target;
  if (!base::ReadSymbolicLink(link, &target)) {
    return std::string();
  }
  if (!target.IsAbsolute()) {
    target = link.DirName().Append(target);
  }
  const std::string resolved = Canonical(target);
  if (base::FilePath(resolved).ReferencesParent()) {
    return std::string();
  }
  return resolved;
}

std::string EntryOutside(const base::FilePath& path,
                         const struct stat& facts,
                         const base::FilePath& chromium_root) {
  if (S_ISLNK(facts.st_mode)) {
    if (IsSingletonLink(path, chromium_root)) {
      return std::string();
    }
    const std::string target = LinkTargetOf(path);
    if (target.empty() || !WithinOrSame(target, chromium_root.value())) {
      return "ARDIA_DATA_DIR's profile entry " + path.value() +
             " links outside its Chromium folder";
    }
    return std::string();
  }
  if (S_ISREG(facts.st_mode) && facts.st_nlink > 1) {
    return "ARDIA_DATA_DIR's profile file " + path.value() +
           " is hard linked elsewhere";
  }
  if (!S_ISREG(facts.st_mode) && !S_ISDIR(facts.st_mode) &&
      !S_ISSOCK(facts.st_mode) && !S_ISFIFO(facts.st_mode)) {
    return "ARDIA_DATA_DIR's profile entry " + path.value() +
           " is a device or an unknown kind of file";
  }
  return std::string();
}

std::string ProfileTreeOutside(const base::FilePath& chromium_root) {
  std::vector<std::pair<base::FilePath, int>> folders = {{chromium_root, 0}};
  while (!folders.empty()) {
    auto [folder, depth] = std::move(folders.back());
    folders.pop_back();
    std::unique_ptr<DIR, DirCloser> listing(opendir(folder.value().c_str()));
    if (!listing) {
      return "ARDIA_DATA_DIR's profile folder " + folder.value() +
             " can't be read";
    }
    while (const dirent* entry = readdir(listing.get())) {
      const std::string_view name(entry->d_name);
      if (name == "." || name == "..") {
        continue;
      }
      const base::FilePath path = folder.Append(name);
      struct stat facts;
      if (lstat(path.value().c_str(), &facts) != 0) {
        return "ARDIA_DATA_DIR's profile entry " + path.value() +
               " can't be checked";
      }
      std::string outside = EntryOutside(path, facts, chromium_root);
      if (!outside.empty()) {
        return outside;
      }
      if (S_ISDIR(facts.st_mode)) {
        if (depth >= kDeepestProfileFolder) {
          return "ARDIA_DATA_DIR's profile folders nest too deep to check";
        }
        folders.emplace_back(path, depth + 1);
      }
    }
  }
  return std::string();
}

bool IsPlainProfileName(std::string_view name) {
  return !name.empty() && name != "." && name != ".." &&
         name.find('/') == std::string_view::npos &&
         name.find('\0') == std::string_view::npos;
}

std::string ProfileNameOutside(const base::Value* name) {
  if (!name) {
    return std::string();
  }
  const std::string* text = name->GetIfString();
  if (!text || !IsPlainProfileName(*text)) {
    return "ARDIA_DATA_DIR's Local State names a profile outside its "
           "Chromium folder";
  }
  return std::string();
}

std::string SavedProfilesOutside(const base::FilePath& chromium_root) {
  const base::FilePath local_state = chromium_root.Append("Local State");
  if (!base::PathExists(local_state)) {
    return std::string();
  }
  std::string json;
  if (!base::ReadFileToStringWithMaxSize(local_state, &json,
                                         kLargestLocalState)) {
    return "ARDIA_DATA_DIR's Local State can't be read";
  }
  std::optional<base::Value> parsed = base::JSONReader::Read(
      json,
      base::JSON_PARSE_CHROMIUM_EXTENSIONS | base::JSON_ALLOW_TRAILING_COMMAS);
  if (!parsed || !parsed->is_dict()) {
    return "ARDIA_DATA_DIR's Local State can't be parsed";
  }
  const base::DictValue* profile = parsed->GetDict().FindDict("profile");
  if (!profile) {
    return std::string();
  }
  std::vector<const base::Value*> names = {profile->Find("last_used")};
  if (const base::DictValue* info_cache = profile->FindDict("info_cache")) {
    for (const auto [key, value] : *info_cache) {
      if (!IsPlainProfileName(key)) {
        return "ARDIA_DATA_DIR's Local State names a profile outside its "
               "Chromium folder";
      }
    }
  }
  for (const char* list_key : {"last_active_profiles", "profiles_order"}) {
    if (const base::ListValue* list = profile->FindList(list_key)) {
      for (const base::Value& name : *list) {
        names.push_back(&name);
      }
    }
  }
  for (const base::Value* name : names) {
    std::string outside = ProfileNameOutside(name);
    if (!outside.empty()) {
      return outside;
    }
  }
  return std::string();
}

}

std::string ScratchProfileRefusal(const base::FilePath& chromium_root) {
  std::string refusal = ProfileTreeOutside(chromium_root);
  if (refusal.empty()) {
    refusal = SavedProfilesOutside(chromium_root);
  }
  return refusal;
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
  std::string clash = ClashOf(held_paths);
  if (!clash.empty()) {
    return clash;
  }
  return ScratchProfileRefusal(base::FilePath(held_paths.back()));
}

}
