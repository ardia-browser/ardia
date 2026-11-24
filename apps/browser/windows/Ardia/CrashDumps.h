#pragma once

#include <algorithm>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <system_error>
#include <utility>
#include <vector>

namespace Ardia {
namespace CrashDumps {

constexpr uint32_t kSignature = 0x504d444d;
constexpr uint32_t kModuleList = 4;
constexpr uint32_t kException = 6;
constexpr uint32_t kMiscInfo = 15;
constexpr uint32_t kCrashpadInfo = 0x43500001;
constexpr uint32_t kMiscProcessTimes = 0x2;
constexpr uint16_t kAnnotationString = 1;
constexpr uint32_t kMaxCount = 4096;
constexpr uint32_t kSimulatedCode = 0x517a7ed;
constexpr uint32_t kAccessViolation = 0xC0000005;
constexpr uint32_t kInPageError = 0xC0000006;
constexpr size_t kPerKind = 5;
constexpr size_t kMaxKey = 64;
constexpr size_t kMaxValue = 256;
constexpr size_t kMaxModuleName = 2048;
constexpr uintmax_t kMaxDumpBytes = 32u * 1024u * 1024u;

struct Frame {
  std::string image;
  std::optional<uint64_t> offset;
};

struct Report {
  std::string incidentId;
  double time = 0;
  double fileTime = 0;
  std::string process;
  std::string terminationNamespace;
  std::string signal;
  std::string exceptionSubtype;
  std::string engineVersion;
  std::string appVersion;
  std::optional<int64_t> uptimeSeconds;
  std::vector<Frame> frames;
};

struct Stream {
  uint32_t size = 0;
  uint32_t rva = 0;
};

struct ModuleRecord {
  uint64_t base = 0;
  uint32_t size = 0;
  uint32_t nameRva = 0;
};

class Reader {
 public:
  Reader(const uint8_t *data, size_t size) : data_(data), size_(size) {}

  bool Fits(uint64_t offset, uint64_t length) const {
    return offset <= size_ && length <= size_ - offset;
  }

  std::optional<uint16_t> U16(uint64_t offset) const {
    if (!Fits(offset, 2)) return std::nullopt;
    return static_cast<uint16_t>(data_[offset] | (data_[offset + 1] << 8));
  }

  std::optional<uint32_t> U32(uint64_t offset) const {
    if (!Fits(offset, 4)) return std::nullopt;
    uint32_t value = 0;
    for (int index = 3; index >= 0; --index) value = (value << 8) | data_[offset + static_cast<uint64_t>(index)];
    return value;
  }

  std::optional<uint64_t> U64(uint64_t offset) const {
    if (!Fits(offset, 8)) return std::nullopt;
    uint64_t value = 0;
    for (int index = 7; index >= 0; --index) value = (value << 8) | data_[offset + static_cast<uint64_t>(index)];
    return value;
  }

  std::optional<std::string> Bytes(uint64_t offset, uint64_t length, size_t most) const {
    if (length > most || !Fits(offset, length)) return std::nullopt;
    return std::string(reinterpret_cast<const char *>(data_ + offset), static_cast<size_t>(length));
  }

  std::optional<std::string> Utf8(uint64_t rva, size_t most) const {
    auto length = U32(rva);
    if (!length) return std::nullopt;
    return Bytes(rva + 4, *length, most);
  }

  std::optional<std::string> Utf16(uint64_t rva, size_t most) const {
    auto length = U32(rva);
    if (!length || *length % 2 != 0 || *length / 2 > most || !Fits(rva + 4, *length)) return std::nullopt;
    std::string text;
    uint32_t pending = 0;
    for (uint64_t at = rva + 4; at < rva + 4 + *length; at += 2) {
      uint32_t unit = static_cast<uint32_t>(data_[at] | (data_[at + 1] << 8));
      if (pending != 0) {
        if (unit >= 0xDC00 && unit <= 0xDFFF) {
          AppendCodePoint(text, 0x10000 + ((pending - 0xD800) << 10) + (unit - 0xDC00));
          pending = 0;
          continue;
        }
        AppendCodePoint(text, 0xFFFD);
        pending = 0;
      }
      if (unit >= 0xD800 && unit <= 0xDBFF) pending = unit;
      else if (unit >= 0xDC00 && unit <= 0xDFFF) AppendCodePoint(text, 0xFFFD);
      else AppendCodePoint(text, unit);
    }
    if (pending != 0) AppendCodePoint(text, 0xFFFD);
    return text;
  }

  static void AppendCodePoint(std::string &text, uint32_t point) {
    if (point < 0x80) {
      text.push_back(static_cast<char>(point));
    } else if (point < 0x800) {
      text.push_back(static_cast<char>(0xC0 | (point >> 6)));
      text.push_back(static_cast<char>(0x80 | (point & 0x3F)));
    } else if (point < 0x10000) {
      text.push_back(static_cast<char>(0xE0 | (point >> 12)));
      text.push_back(static_cast<char>(0x80 | ((point >> 6) & 0x3F)));
      text.push_back(static_cast<char>(0x80 | (point & 0x3F)));
    } else {
      text.push_back(static_cast<char>(0xF0 | (point >> 18)));
      text.push_back(static_cast<char>(0x80 | ((point >> 12) & 0x3F)));
      text.push_back(static_cast<char>(0x80 | ((point >> 6) & 0x3F)));
      text.push_back(static_cast<char>(0x80 | (point & 0x3F)));
    }
  }

 private:
  const uint8_t *data_;
  size_t size_;
};

using Annotations = std::map<std::string, std::string>;

inline bool WantedAnnotation(std::string_view name) {
  return name == "ptype" || name == "ver" || name == "ardia-ver";
}

inline std::optional<std::map<uint32_t, Stream>> Streams(const Reader &reader) {
  if (reader.U32(0) != kSignature) return std::nullopt;
  auto count = reader.U32(8);
  auto directory = reader.U32(12);
  if (!count || !directory || *count > kMaxCount) return std::nullopt;
  std::map<uint32_t, Stream> found;
  for (uint32_t index = 0; index < *count; ++index) {
    uint64_t at = static_cast<uint64_t>(*directory) + static_cast<uint64_t>(index) * 12;
    auto type = reader.U32(at);
    auto size = reader.U32(at + 4);
    auto rva = reader.U32(at + 8);
    if (!type || !size || !rva) return std::nullopt;
    if (found.find(*type) == found.end() && reader.Fits(*rva, *size)) found[*type] = Stream{*size, *rva};
  }
  return found;
}

inline std::vector<ModuleRecord> Modules(const Reader &reader, std::optional<Stream> stream) {
  std::vector<ModuleRecord> list;
  if (!stream || stream->size < 4) return list;
  std::optional<uint32_t> rva = stream->rva;
  auto count = reader.U32(*rva);
  if (!count || *count > kMaxCount || *count > (stream->size - 4) / 108) return list;
  for (uint32_t index = 0; index < *count; ++index) {
    uint64_t at = static_cast<uint64_t>(*rva) + 4 + static_cast<uint64_t>(index) * 108;
    auto base = reader.U64(at);
    auto size = reader.U32(at + 8);
    auto name = reader.U32(at + 20);
    if (!base || !size || !name) break;
    list.push_back(ModuleRecord{*base, *size, *name});
  }
  return list;
}

inline void Dictionary(const Reader &reader, uint64_t rva, Annotations &into) {
  auto count = reader.U32(rva);
  if (!count || *count > kMaxCount) return;
  for (uint32_t index = 0; index < *count; ++index) {
    auto key = reader.U32(rva + 4 + static_cast<uint64_t>(index) * 8);
    auto value = reader.U32(rva + 8 + static_cast<uint64_t>(index) * 8);
    if (!key || !value) return;
    auto name = reader.Utf8(*key, kMaxKey);
    if (!name || !WantedAnnotation(*name)) continue;
    auto text = reader.Utf8(*value, kMaxValue);
    if (text) into[*name] = *text;
  }
}

inline void AnnotationObjects(const Reader &reader, uint64_t rva, Annotations &into) {
  auto count = reader.U32(rva);
  if (!count || *count > kMaxCount) return;
  for (uint32_t index = 0; index < *count; ++index) {
    uint64_t at = rva + 4 + static_cast<uint64_t>(index) * 12;
    auto name = reader.U32(at);
    auto type = reader.U16(at + 4);
    auto value = reader.U32(at + 8);
    if (!name || !type || *type != kAnnotationString || !value) continue;
    auto key = reader.Utf8(*name, kMaxKey);
    if (!key || !WantedAnnotation(*key)) continue;
    auto text = reader.Utf8(*value, kMaxValue);
    if (!text) continue;
    while (!text->empty() && text->back() == '\0') text->pop_back();
    into[*key] = *text;
  }
}

inline Annotations ReadAnnotations(const Reader &reader, std::optional<uint32_t> rva) {
  Annotations found;
  if (!rva) return found;
  uint64_t base = *rva;
  uint32_t simpleSize = reader.U32(base + 36).value_or(0);
  uint32_t simple = reader.U32(base + 40).value_or(0);
  if (simpleSize != 0) Dictionary(reader, simple, found);
  uint32_t listSize = reader.U32(base + 44).value_or(0);
  uint32_t list = reader.U32(base + 48).value_or(0);
  auto count = listSize != 0 ? reader.U32(list) : std::nullopt;
  if (!count || *count > kMaxCount) return found;
  for (uint32_t index = 0; index < *count; ++index) {
    uint64_t at = static_cast<uint64_t>(list) + 4 + static_cast<uint64_t>(index) * 12;
    auto location = reader.U32(at + 8);
    if (!location) break;
    if (reader.U32(static_cast<uint64_t>(*location) + 12).value_or(0) > 0)
      Dictionary(reader, reader.U32(static_cast<uint64_t>(*location) + 16).value_or(0), found);
    if (reader.U32(static_cast<uint64_t>(*location) + 20).value_or(0) > 0)
      AnnotationObjects(reader, reader.U32(static_cast<uint64_t>(*location) + 24).value_or(0), found);
  }
  return found;
}

struct ExceptionName {
  uint32_t code;
  const char *name;
};

inline const char *NameOf(uint32_t code) {
  static const ExceptionName names[] = {
      {0x80000001, "EXCEPTION_GUARD_PAGE"},
      {0x80000002, "EXCEPTION_DATATYPE_MISALIGNMENT"},
      {0x80000003, "EXCEPTION_BREAKPOINT"},
      {0x80000004, "EXCEPTION_SINGLE_STEP"},
      {0x40000015, "STATUS_FATAL_APP_EXIT"},
      {0xC0000005, "EXCEPTION_ACCESS_VIOLATION"},
      {0xC0000006, "EXCEPTION_IN_PAGE_ERROR"},
      {0xC000001D, "EXCEPTION_ILLEGAL_INSTRUCTION"},
      {0xC0000017, "STATUS_NO_MEMORY"},
      {0xC0000025, "EXCEPTION_NONCONTINUABLE_EXCEPTION"},
      {0xC0000026, "EXCEPTION_INVALID_DISPOSITION"},
      {0xC000007B, "STATUS_INVALID_IMAGE_FORMAT"},
      {0xC000008C, "EXCEPTION_ARRAY_BOUNDS_EXCEEDED"},
      {0xC000008D, "EXCEPTION_FLT_DENORMAL_OPERAND"},
      {0xC000008E, "EXCEPTION_FLT_DIVIDE_BY_ZERO"},
      {0xC000008F, "EXCEPTION_FLT_INEXACT_RESULT"},
      {0xC0000090, "EXCEPTION_FLT_INVALID_OPERATION"},
      {0xC0000091, "EXCEPTION_FLT_OVERFLOW"},
      {0xC0000092, "EXCEPTION_FLT_STACK_CHECK"},
      {0xC0000093, "EXCEPTION_FLT_UNDERFLOW"},
      {0xC0000094, "EXCEPTION_INT_DIVIDE_BY_ZERO"},
      {0xC0000095, "EXCEPTION_INT_OVERFLOW"},
      {0xC0000096, "EXCEPTION_PRIV_INSTRUCTION"},
      {0xC00000FD, "EXCEPTION_STACK_OVERFLOW"},
      {0xC000012D, "STATUS_COMMITMENT_LIMIT"},
      {0xC0000135, "STATUS_DLL_NOT_FOUND"},
      {0xC0000139, "STATUS_ENTRYPOINT_NOT_FOUND"},
      {0xC0000142, "STATUS_DLL_INIT_FAILED"},
      {0xC0000194, "EXCEPTION_POSSIBLE_DEADLOCK"},
      {0xC0000374, "STATUS_HEAP_CORRUPTION"},
      {0xC0000409, "STATUS_STACK_BUFFER_OVERRUN"},
      {0xC000041D, "STATUS_FATAL_USER_CALLBACK_EXCEPTION"},
      {0xC0000417, "STATUS_INVALID_CRUNTIME_PARAMETER"},
      {0xC0000420, "STATUS_ASSERTION_FAILURE"},
      {0xC0000602, "STATUS_FAIL_FAST_EXCEPTION"},
      {0xE06D7363, "MSVC_CPP_EXCEPTION"},
  };
  for (const ExceptionName &entry : names)
    if (entry.code == code) return entry.name;
  return nullptr;
}

inline std::string StatusName(uint32_t code) {
  static const char digits[] = "0123456789ABCDEF";
  std::string text = "STATUS_";
  for (int shift = 28; shift >= 0; shift -= 4) text.push_back(digits[(code >> shift) & 0xF]);
  return text;
}

inline std::string ProcessOf(const Annotations &annotations) {
  auto found = annotations.find("ptype");
  std::string kind = found == annotations.end() ? "browser" : found->second;
  if (kind == "browser") return "browser";
  if (kind == "renderer" || kind == "extension") return "renderer";
  if (kind == "gpu-process") return "gpu";
  if (kind == "ppapi") return "plugin";
  return "utility";
}

inline bool IsAppVersion(const std::string &text) {
  size_t at = 0;
  auto digits = [&]() {
    size_t start = at;
    while (at < text.size() && text[at] >= '0' && text[at] <= '9') ++at;
    return at > start;
  };
  auto dot = [&]() {
    if (at < text.size() && text[at] == '.') {
      ++at;
      return true;
    }
    return false;
  };
  if (!digits() || !dot() || !digits() || !dot() || !digits()) return false;
  if (at == text.size()) return true;
  if (text[at] != '-') return false;
  ++at;
  size_t start = at;
  while (at < text.size() && text[at] >= 'a' && text[at] <= 'z') ++at;
  if (at == start || !dot() || !digits()) return false;
  return at == text.size();
}

inline bool IsEngineVersion(const std::string &text) {
  size_t groups = 0;
  size_t at = 0;
  while (at < text.size()) {
    size_t start = at;
    while (at < text.size() && text[at] >= '0' && text[at] <= '9') ++at;
    if (at == start) return false;
    ++groups;
    if (at == text.size()) break;
    if (text[at] != '.') return false;
    ++at;
    if (at == text.size()) return false;
  }
  return groups >= 2 && groups <= 4;
}

inline bool IsModuleFileName(const std::string &name) {
  if (name.size() < 5 || name.size() > 80) return false;
  for (char c : name) {
    bool plain = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '.' || c == '_' || c == '-' || c == '+';
    if (!plain) return false;
  }
  std::string tail = name.substr(name.size() - 4);
  for (char &c : tail)
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
  return tail == ".dll" || tail == ".exe" || tail == ".sys" || tail == ".drv" || tail == ".ocx" || tail == ".cpl";
}

inline bool HasScheme(const std::string &path) {
  size_t colon = path.find(':');
  if (colon == std::string::npos || colon == 0) return false;
  if (colon == 1 && path.size() > 2 && path[2] == '\\') return false;
  for (size_t index = 0; index < colon; ++index) {
    char c = path[index];
    bool letter = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
    if (!letter && (index == 0 || !((c >= '0' && c <= '9') || c == '+' || c == '-' || c == '.'))) return false;
  }
  return true;
}

inline std::string BaseName(const std::string &path) {
  if (HasScheme(path) || path.find("://") != std::string::npos) return "???";
  size_t cut = path.find_last_of("/\\");
  std::string base = cut == std::string::npos ? path : path.substr(cut + 1);
  return IsModuleFileName(base) ? base : "???";
}

inline std::optional<Report> Parse(const uint8_t *data, size_t size, std::string incidentId, double fileTime) {
  Reader reader(data, size);
  auto found = Streams(reader);
  if (!found) return std::nullopt;
  auto seconds = reader.U32(20);
  if (!seconds) return std::nullopt;
  auto thrown = found->find(kException);
  if (thrown == found->end() || thrown->second.size < 168) return std::nullopt;
  uint64_t at = thrown->second.rva;
  auto code = reader.U32(at + 8);
  auto address = reader.U64(at + 24);
  if (!code || !address || *code == kSimulatedCode) return std::nullopt;
  uint32_t parameters = reader.U32(at + 32).value_or(0);
  uint64_t firstParameter = parameters > 0 ? reader.U64(at + 40).value_or(UINT64_MAX) : UINT64_MAX;

  Report report;
  report.incidentId = std::move(incidentId);
  report.time = static_cast<double>(*seconds) * 1000.0;
  report.fileTime = fileTime;
  report.terminationNamespace = "WIN32_EXCEPTION";
  const char *name = NameOf(*code);
  report.signal = name != nullptr ? std::string(name) : StatusName(*code);
  if (*code == kAccessViolation || *code == kInPageError) {
    if (firstParameter == 0) report.exceptionSubtype = "ACCESS_READ";
    else if (firstParameter == 1) report.exceptionSubtype = "ACCESS_WRITE";
    else if (firstParameter == 8) report.exceptionSubtype = "ACCESS_EXECUTE";
  }

  auto info = found->find(kCrashpadInfo);
  bool infoWhole = info != found->end() && info->second.size >= 52;
  Annotations annotations = ReadAnnotations(reader, infoWhole ? std::optional<uint32_t>(info->second.rva) : std::nullopt);
  report.process = ProcessOf(annotations);
  auto version = annotations.find("ver");
  if (report.process != "browser" && version != annotations.end() && IsEngineVersion(version->second)) report.engineVersion = version->second;
  auto app = annotations.find("ardia-ver");
  if (report.process == "browser" && app != annotations.end() && IsAppVersion(app->second)) report.appVersion = app->second;

  auto misc = found->find(kMiscInfo);
  if (misc != found->end() && misc->second.size >= 16) {
    auto flags = reader.U32(static_cast<uint64_t>(misc->second.rva) + 4);
    auto created = reader.U32(static_cast<uint64_t>(misc->second.rva) + 12);
    if (flags && created && (*flags & kMiscProcessTimes) != 0 && *created != 0 && *seconds >= *created)
      report.uptimeSeconds = static_cast<int64_t>(*seconds - *created);
  }

  auto moduleList = found->find(kModuleList);
  std::vector<ModuleRecord> modules = Modules(reader, moduleList == found->end() ? std::nullopt : std::optional<Stream>(moduleList->second));
  Frame frame;
  frame.image = "???";
  for (const ModuleRecord &module : modules) {
    if (*address < module.base || *address - module.base >= module.size) continue;
    auto path = reader.Utf16(module.nameRva, kMaxModuleName);
    frame.image = BaseName(path.value_or(std::string{}));
    frame.offset = *address - module.base;
    break;
  }
  report.frames.push_back(std::move(frame));
  return report;
}

inline std::vector<Report> NewestPerKind(std::vector<Report> reports) {
  auto older = [](const Report &a, const Report &b) { return a.fileTime < b.fileTime; };
  std::stable_sort(reports.begin(), reports.end(), older);
  std::vector<Report> browser;
  std::vector<Report> helpers;
  for (Report &report : reports) (report.process == "browser" ? browser : helpers).push_back(std::move(report));
  auto newest = [](std::vector<Report> &list) {
    if (list.size() > kPerKind) list.erase(list.begin(), list.end() - static_cast<std::ptrdiff_t>(kPerKind));
  };
  newest(browser);
  newest(helpers);
  std::vector<Report> merged;
  for (Report &report : browser) merged.push_back(std::move(report));
  for (Report &report : helpers) merged.push_back(std::move(report));
  std::stable_sort(merged.begin(), merged.end(), older);
  return merged;
}

inline bool IsPlainFileName(std::string_view name) {
  if (name.empty() || name.size() > 128 || name == "." || name == "..") return false;
  return name.find_first_of("/\\:*?\"<>|") == std::string_view::npos;
}

inline bool IsDumpFileName(std::string_view name) {
  if (!IsPlainFileName(name) || name.size() <= 4 || name.size() > 68) return false;
  for (char c : name.substr(0, name.size() - 4))
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-')) return false;
  std::string stem;
  for (char c : name.substr(0, name.size() - 4)) stem.push_back(c >= 'a' && c <= 'z' ? static_cast<char>(c - 'a' + 'A') : c);
  if (stem == "CON" || stem == "PRN" || stem == "AUX" || stem == "NUL") return false;
  if (stem.size() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem[3] >= '0' && stem[3] <= '9') return false;
  std::string_view tail = name.substr(name.size() - 4);
  const char *want = ".dmp";
  for (size_t index = 0; index < 4; ++index) {
    char c = tail[index];
    if (c >= 'A' && c <= 'Z') c = static_cast<char>(c - 'A' + 'a');
    if (c != want[index]) return false;
  }
  return true;
}

inline std::optional<std::vector<uint8_t>> DecodeHex(std::string_view text) {
  if (text.size() % 2 != 0) return std::nullopt;
  auto nibble = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  };
  std::vector<uint8_t> bytes;
  bytes.reserve(text.size() / 2);
  for (size_t index = 0; index < text.size(); index += 2) {
    int high = nibble(text[index]);
    int low = nibble(text[index + 1]);
    if (high < 0 || low < 0) return std::nullopt;
    bytes.push_back(static_cast<uint8_t>((high << 4) | low));
  }
  return bytes;
}

struct Entry {
  std::filesystem::path path;
  double time = 0;
};

inline double UnixMilliseconds(std::filesystem::file_time_type stamp) {
#if defined(_WIN32)
  constexpr int64_t unixEpochInFileTime = 116444736000000000ll;
  using FileTimeTicks = std::chrono::duration<int64_t, std::ratio<1, 10000000>>;
  int64_t ticks = std::chrono::duration_cast<FileTimeTicks>(stamp.time_since_epoch()).count();
  return static_cast<double>((ticks - unixEpochInFileTime) / 10000);
#else
  auto moment = std::filesystem::file_time_type::clock::to_sys(stamp);
  return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(moment.time_since_epoch()).count());
#endif
}

inline std::string IncidentId(const std::filesystem::path &path) {
  auto stem = path.stem().native();
  if (stem.empty() || stem.size() > 64) return {};
  std::string id;
  for (auto c : stem) {
    bool plain = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '-';
    if (!plain) return {};
    id.push_back(static_cast<char>(c));
  }
  return id;
}

inline std::vector<Entry> List(const std::filesystem::path &folder, double since) {
  std::vector<Entry> entries;
  std::error_code error;
  std::filesystem::directory_iterator walk(folder, error);
  std::filesystem::directory_iterator end;
  if (error) return entries;
  for (; walk != end; walk.increment(error)) {
    if (error) break;
    const std::filesystem::path &path = walk->path();
    std::string extension;
    const auto suffix = path.extension().native();
    for (auto c : suffix) extension.push_back(static_cast<uint32_t>(c) < 0x80 ? static_cast<char>(c) : '?');
    if (!IsDumpFileName("x" + extension)) continue;
    std::error_code status;
    if (!std::filesystem::is_regular_file(path, status) || status) continue;
    uintmax_t bytes = std::filesystem::file_size(path, status);
    if (status || bytes == 0 || bytes > kMaxDumpBytes) continue;
    auto stamp = std::filesystem::last_write_time(path, status);
    if (status) continue;
    double time = UnixMilliseconds(stamp);
    if (time > since) entries.push_back(Entry{path, time});
  }
  return entries;
}

inline std::optional<std::vector<uint8_t>> ReadAll(const std::filesystem::path &path) {
  std::error_code status;
  uintmax_t size = std::filesystem::file_size(path, status);
  if (status || size == 0 || size > kMaxDumpBytes) return std::nullopt;
  std::ifstream stream(path, std::ios::binary);
  if (!stream) return std::nullopt;
  std::vector<uint8_t> bytes(static_cast<size_t>(size));
  stream.read(reinterpret_cast<char *>(bytes.data()), static_cast<std::streamsize>(size));
  if (static_cast<uintmax_t>(stream.gcount()) != size) return std::nullopt;
  return bytes;
}

inline std::vector<Report> Collect(const std::vector<std::filesystem::path> &folders, double since) {
  std::vector<Entry> entries;
  for (const std::filesystem::path &folder : folders)
    for (Entry &entry : List(folder, since)) entries.push_back(std::move(entry));
  std::vector<Report> reports;
  for (const Entry &entry : entries) {
    auto bytes = ReadAll(entry.path);
    if (!bytes) continue;
    auto report = Parse(bytes->data(), bytes->size(), IncidentId(entry.path), entry.time);
    if (report) reports.push_back(std::move(*report));
  }
  return NewestPerKind(std::move(reports));
}

}
}
