#pragma once

#include "Paths.h"

namespace Ardia {

struct LaunchLog {
  static void OpenFromCommandLine() noexcept {
    int count = 0;
    LPWSTR *arguments = CommandLineToArgvW(GetCommandLineW(), &count);
    if (!arguments) return;
    constexpr std::wstring_view logFileSwitch = L"--log-file=";
    for (int i = 1; i < count; i++) {
      std::wstring_view argument{arguments[i]};
      if (argument.starts_with(logFileSwitch)) Open(std::wstring{argument.substr(logFileSwitch.size())});
    }
    LocalFree(arguments);
    if (File() == INVALID_HANDLE_VALUE) OpenDefault();
  }

  static std::filesystem::path DefaultPath() noexcept {
    try {
      std::filesystem::path folder = Paths::DataDirectory() / L"Logs";
      std::error_code ignored;
      std::filesystem::create_directories(folder, ignored);
      return folder / L"launch.log";
    } catch (...) {
      return {};
    }
  }

  static void Write(std::wstring_view level, std::wstring_view message) noexcept {
    std::scoped_lock lock{Mutex()};
    HANDLE file = File();
    if (file == INVALID_HANDLE_VALUE || Written() >= kMaxBytes) return;
    std::string line = winrt::to_string(level) + " " + std::to_string(ElapsedMs()) + " " + winrt::to_string(message) + "\n";
    Written() += line.size();
    if (Written() >= kMaxBytes) line.append("warning ").append(std::to_string(ElapsedMs())).append(" the launch log reached its size limit; nothing more is written this run\n");
    DWORD wrote = 0;
    WriteFile(file, line.data(), static_cast<DWORD>(line.size()), &wrote, nullptr);
  }

  static uint64_t ElapsedMs() noexcept {
    static const uint64_t started = [] {
      FILETIME created{}, exited{}, kernel{}, user{};
      if (!GetProcessTimes(GetCurrentProcess(), &created, &exited, &kernel, &user)) GetSystemTimeAsFileTime(&created);
      return (static_cast<uint64_t>(created.dwHighDateTime) << 32) | created.dwLowDateTime;
    }();
    FILETIME now{};
    GetSystemTimePreciseAsFileTime(&now);
    uint64_t current = (static_cast<uint64_t>(now.dwHighDateTime) << 32) | now.dwLowDateTime;
    return current > started ? (current - started) / 10000 : 0;
  }

 private:
  static constexpr size_t kMaxBytes = 16 * 1024 * 1024;
  static constexpr uintmax_t kRotateBytes = 4 * 1024 * 1024;

  static size_t &Written() noexcept {
    static size_t written = 0;
    return written;
  }

  static void OpenDefault() noexcept {
    std::filesystem::path path = DefaultPath();
    if (path.empty()) return;
    std::error_code ignored;
    if (std::filesystem::file_size(path, ignored) > kRotateBytes) {
      std::filesystem::rename(path, path.parent_path() / L"launch.previous.log", ignored);
    }
    Open(path.wstring());
  }

  static void Open(const std::wstring &path) noexcept {
    std::scoped_lock lock{Mutex()};
    if (File() != INVALID_HANDLE_VALUE) return;
    File() = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
  }

  static HANDLE &File() noexcept {
    static HANDLE file = INVALID_HANDLE_VALUE;
    return file;
  }

  static std::mutex &Mutex() noexcept {
    static std::mutex mutex;
    return mutex;
  }
};

}
