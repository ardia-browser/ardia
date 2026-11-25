#include "ardia/win/test_gate.h"

#include <windows.h>

#include <algorithm>
#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/base_paths_win.h"
#include "base/files/file_path.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "chrome/install_static/user_data_dir.h"

namespace ardia_win {

namespace {

std::optional<std::wstring> OpenedFinalPath(const base::FilePath& path) {
  constexpr DWORD kShare = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
  HANDLE handle = ::CreateFileW(path.value().c_str(), 0, kShare, nullptr,
                                OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS,
                                nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    return std::nullopt;
  }
  constexpr DWORD kFlags = VOLUME_NAME_GUID | FILE_NAME_NORMALIZED;
  std::optional<std::wstring> found;
  DWORD size = ::GetFinalPathNameByHandleW(handle, nullptr, 0, kFlags);
  if (size > 0) {
    std::wstring value(size, L'\0');
    DWORD written =
        ::GetFinalPathNameByHandleW(handle, value.data(), size, kFlags);
    if (written > 0 && written < size) {
      value.resize(written);
      found = std::move(value);
    }
  }
  ::CloseHandle(handle);
  return found;
}

std::optional<std::wstring> HeldFinalPath(HANDLE handle) {
  constexpr DWORD kFlags = VOLUME_NAME_GUID | FILE_NAME_NORMALIZED;
  DWORD size = ::GetFinalPathNameByHandleW(handle, nullptr, 0, kFlags);
  if (size == 0) {
    return std::nullopt;
  }
  std::wstring value(size, L'\0');
  DWORD written =
      ::GetFinalPathNameByHandleW(handle, value.data(), size, kFlags);
  if (written == 0 || written >= size) {
    return std::nullopt;
  }
  value.resize(written);
  return value;
}

bool Exists(const base::FilePath& path) {
  return ::GetFileAttributesW(path.value().c_str()) != INVALID_FILE_ATTRIBUTES;
}

std::optional<std::wstring> CanonicalPath(const base::FilePath& path) {
  if (Exists(path)) {
    return OpenedFinalPath(path);
  }
  const base::FilePath parent = path.DirName();
  if (parent == path || path.BaseName().empty()) {
    return std::nullopt;
  }
  std::optional<std::wstring> canonical_parent = CanonicalPath(parent);
  if (!canonical_parent) {
    return std::nullopt;
  }
  std::wstring joined = *canonical_parent;
  if (joined.empty() || joined.back() != L'\\') {
    joined.push_back(L'\\');
  }
  return joined + path.BaseName().value();
}

bool SameText(std::wstring_view a, std::wstring_view b) {
  return a.size() == b.size() &&
         ::CompareStringOrdinal(a.data(), static_cast<int>(a.size()), b.data(),
                                static_cast<int>(b.size()),
                                TRUE) == CSTR_EQUAL;
}

bool WithinOrSame(std::wstring_view inner, std::wstring_view outer) {
  while (!outer.empty() && outer.back() == L'\\') {
    outer.remove_suffix(1);
  }
  if (inner.size() < outer.size() ||
      !SameText(inner.substr(0, outer.size()), outer)) {
    return false;
  }
  return inner.size() == outer.size() || inner[outer.size()] == L'\\';
}

bool Overlaps(std::wstring_view a, std::wstring_view b) {
  return WithinOrSame(a, b) || WithinOrSame(b, a);
}

std::wstring RealFolderClashOf(const std::vector<std::wstring>& canonical,
                               std::initializer_list<const wchar_t*> names) {
  for (int key : {base::DIR_LOCAL_APP_DATA, base::DIR_ROAMING_APP_DATA}) {
    base::FilePath folder;
    if (!base::PathService::Get(key, &folder) || folder.empty()) {
      return L"the real profile folder can't be resolved";
    }
    for (const wchar_t* name : names) {
      std::optional<std::wstring> real = CanonicalPath(folder.Append(name));
      if (!real) {
        return L"the real profile folder can't be resolved";
      }
      for (const std::wstring& mine : canonical) {
        if (Overlaps(mine, *real)) {
          return L"ARDIA_DATA_DIR is or overlaps the real profile folder";
        }
      }
    }
  }
  return std::wstring();
}

std::wstring RealFolderClash(const base::FilePath& data_dir) {
  std::vector<std::wstring> canonical;
  for (const base::FilePath& mine :
       {data_dir, data_dir.Append(FILE_PATH_LITERAL("Chromium")),
        data_dir.Append(FILE_PATH_LITERAL("Sync"))}) {
    std::optional<std::wstring> resolved = CanonicalPath(mine);
    if (!resolved) {
      return L"ARDIA_DATA_DIR can't be resolved on a local volume";
    }
    canonical.push_back(*resolved);
  }
  return RealFolderClashOf(canonical, {L"Ardia", L"Ardia WebUI"});
}

std::vector<HANDLE>& HeldFolders() {
  static base::NoDestructor<std::vector<HANDLE>> held;
  return *held;
}

bool TestBuild() {
  base::FilePath exe;
  if (!base::PathService::Get(base::FILE_EXE, &exe) || exe.empty()) {
    return false;
  }
  const DWORD attributes = ::GetFileAttributesW(
      exe.DirName().Append(kTestBuildMarker).value().c_str());
  return attributes != INVALID_FILE_ATTRIBUTES &&
         !(attributes & FILE_ATTRIBUTE_DIRECTORY);
}

}

std::wstring TestGateRefusal(const std::wstring& data_dir,
                             const std::wstring& chromium_user_data_dir) {
  if (data_dir.empty()) {
    return L"no scratch ARDIA_DATA_DIR";
  }
  const base::FilePath path(data_dir);
  if (!path.IsAbsolute()) {
    return L"ARDIA_DATA_DIR is not an absolute path";
  }
  std::wstring clash = RealFolderClash(path);
  if (!clash.empty()) {
    return clash;
  }
  std::optional<std::wstring> expected =
      CanonicalPath(path.Append(FILE_PATH_LITERAL("Chromium")));
  std::optional<std::wstring> opened =
      chromium_user_data_dir.empty()
          ? std::nullopt
          : CanonicalPath(base::FilePath(chromium_user_data_dir));
  if (!expected || !opened || !SameText(*expected, *opened)) {
    return L"Chromium would open another profile folder than ARDIA_DATA_DIR's "
           L"(a --user-data-dir or a policy)";
  }
  if (!TestBuild()) {
    return std::wstring(L"not a test build: no ") + kTestBuildMarker +
           L" beside the app";
  }
  return std::wstring();
}

std::wstring PathWithBackslashes(std::wstring path) {
  std::replace(path.begin(), path.end(), L'/', L'\\');
  while (path.size() > 3 && path.back() == L'\\') {
    path.pop_back();
  }
  return path;
}

std::optional<std::wstring> HeldDosPath(HANDLE handle) {
  constexpr DWORD kFlags = VOLUME_NAME_DOS | FILE_NAME_NORMALIZED;
  DWORD size = ::GetFinalPathNameByHandleW(handle, nullptr, 0, kFlags);
  if (size == 0) {
    return std::nullopt;
  }
  std::wstring value(size, L'\0');
  DWORD written =
      ::GetFinalPathNameByHandleW(handle, value.data(), size, kFlags);
  if (written == 0 || written >= size) {
    return std::nullopt;
  }
  value.resize(written);
  constexpr std::wstring_view kLocal = L"\\\\?\\";
  if (!std::wstring_view(value).starts_with(kLocal) ||
      std::wstring_view(value).substr(kLocal.size()).starts_with(L"UNC\\")) {
    return std::nullopt;
  }
  return value.substr(kLocal.size());
}

std::wstring HoldScratchFolders(const std::wstring& data_dir,
                                const std::wstring& chromium_user_data_dir) {
  const base::FilePath path(data_dir);
  std::vector<std::wstring> canonical;
  std::optional<std::wstring> chromium_as_held;
  for (const base::FilePath& folder :
       {path, path.Append(FILE_PATH_LITERAL("Chromium"))}) {
    ::CreateDirectoryW(folder.value().c_str(), nullptr);
    HANDLE handle = ::CreateFileW(
        folder.value().c_str(), FILE_LIST_DIRECTORY | FILE_TRAVERSE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
      return L"ARDIA_DATA_DIR can't be held open";
    }
    HeldFolders().push_back(handle);
    FILE_ATTRIBUTE_TAG_INFO tag = {};
    if (!::GetFileInformationByHandleEx(handle, FileAttributeTagInfo, &tag,
                                        sizeof(tag)) ||
        (tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
      return L"ARDIA_DATA_DIR or its Chromium folder is a link";
    }
    std::optional<std::wstring> held = HeldFinalPath(handle);
    if (!held) {
      return L"ARDIA_DATA_DIR can't be resolved on a local volume";
    }
    canonical.push_back(*held);
    chromium_as_held = HeldDosPath(handle);
  }
  if (!chromium_as_held ||
      !SameText(*chromium_as_held,
                PathWithBackslashes(chromium_user_data_dir))) {
    return L"Chromium would open its folder by another path than the one "
           L"held (a junction, a short name or a mapped drive in the way)";
  }
  return RealFolderClashOf(canonical, {L"Ardia", L"Ardia WebUI"});
}

bool SameFolder(const std::wstring& a, const std::wstring& b) {
  if (a.empty() || b.empty()) {
    return false;
  }
  const std::optional<std::wstring> first = CanonicalPath(base::FilePath(a));
  const std::optional<std::wstring> second = CanonicalPath(base::FilePath(b));
  return first && second && SameText(*first, *second);
}

base::FilePath AppDataRoot(const wchar_t* variable, int key) {
  wchar_t value[MAX_PATH];
  const DWORD length = ::GetEnvironmentVariableW(variable, value, MAX_PATH);
  if (length > 0 && length < MAX_PATH) {
    return base::FilePath(std::wstring(value, length));
  }
  base::FilePath folder;
  return base::PathService::Get(key, &folder) ? folder : base::FilePath();
}

std::vector<std::optional<std::wstring>> ReactNativeFolders() {
  std::vector<std::optional<std::wstring>> folders;
  for (const auto& [variable, key] :
       {std::pair(L"LOCALAPPDATA", static_cast<int>(base::DIR_LOCAL_APP_DATA)),
        std::pair(L"APPDATA", static_cast<int>(base::DIR_ROAMING_APP_DATA))}) {
    const base::FilePath base_folder = AppDataRoot(variable, key);
    if (base_folder.empty()) {
      folders.push_back(std::nullopt);
      continue;
    }
    const base::FilePath root = base_folder.Append(FILE_PATH_LITERAL("Ardia"));
    folders.push_back(CanonicalPath(root));
    folders.push_back(CanonicalPath(root.Append(FILE_PATH_LITERAL("User Data"))));
  }
  return folders;
}

std::wstring ReactNativeFolderClash(const std::vector<std::wstring>& folders) {
  const std::vector<std::optional<std::wstring>> theirs = ReactNativeFolders();
  for (const std::wstring& folder : folders) {
    std::optional<std::wstring> mine = CanonicalPath(base::FilePath(folder));
    if (!mine) {
      return L"the WebUI folder " + folder + L" can't be resolved";
    }
    if (install_static::WebUITreeHasLink(*mine, nullptr, nullptr)) {
      return L"the WebUI folder " + folder +
             L" holds a link or a folder that can't be listed";
    }
    for (const std::optional<std::wstring>& protected_folder : theirs) {
      if (!protected_folder) {
        return L"a React Native app folder can't be resolved";
      }
      if (Overlaps(*mine, *protected_folder)) {
        return L"the WebUI folder " + folder +
               L" resolves to the React Native app's " + *protected_folder;
      }
    }
  }
  return std::wstring();
}

}
