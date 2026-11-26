#ifndef ARDIA_WIN_WEBUI_WEBUI_UPDATE_POLICY_H_
#define ARDIA_WIN_WEBUI_WEBUI_UPDATE_POLICY_H_

#include <cstddef>
#include <cstdint>
#include <cmath>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace ardia_win::webui_update {

inline constexpr std::string_view kReleasesUnder = "https://github.com/ardia-browser/ardia/releases/download/";
inline constexpr std::string_view kReleaseFeed =
    "https://github.com/ardia-browser/ardia/releases/download/windows-alpha/windows-update.json";
inline constexpr std::string_view kSignatureSuffix = ".sig";
inline constexpr size_t kManifestLimit = 64 * 1024;
inline constexpr size_t kSignatureBytes = 64;
inline constexpr uint64_t kInstallerLimit = uint64_t{1} << 30;
inline constexpr uint64_t kLargestBuild = (uint64_t{1} << 53) - 1;
inline constexpr size_t kBuildFileLimit = 4096;
inline constexpr size_t kVerifierOutputLimit = 8192;
inline constexpr uint32_t kManifestCheckTimeoutMs = 15000;
inline constexpr uint32_t kPackageCheckTimeoutMs = 180000;
inline constexpr int kSmallFileTimeoutSeconds = 60;
inline constexpr int kInstallerTimeoutSeconds = 30 * 60;
inline constexpr size_t kUrlLimit = 512;
inline constexpr size_t kPrefixLimit = 256;
inline constexpr size_t kVersionLimit = 64;
inline constexpr size_t kReasonLimit = 200;
inline constexpr size_t kInstanceLimit = 4096;
inline constexpr size_t kInstallerStemDigits = 16;

inline constexpr wchar_t kVerifierName[] = L"ardia-update-verify.exe";
inline constexpr wchar_t kKeyName[] = L"windows-update.pem";
inline constexpr wchar_t kBuildFileName[] = L"Ardia.build.json";
inline constexpr wchar_t kUninstallerName[] = L"unins000.exe";
inline constexpr wchar_t kUpdatesFolder[] = L"Updates";
inline constexpr wchar_t kManifestFileName[] = L"windows-update.json";
inline constexpr wchar_t kSignatureFileName[] = L"windows-update.json.sig";
inline constexpr wchar_t kInstallerArguments[] =
    L"/SILENT /SUPPRESSMSGBOXES /NORESTART /CLOSEAPPLICATIONS /FORCECLOSEAPPLICATIONS /relaunch=1";

inline constexpr std::string_view kRedirectHosts[] = {
    "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"};
inline constexpr std::string_view kLocalHttpHosts[] = {"127.0.0.1", "localhost", "10.0.2.2"};

inline constexpr uint32_t kFileReadData = 0x00000001;
inline constexpr uint32_t kFileReadAttributes = 0x00000080;
inline constexpr uint32_t kSynchronize = 0x00100000;
inline constexpr uint32_t kDeleteAccess = 0x00010000;
inline constexpr uint32_t kFileShareRead = 0x00000001;
inline constexpr uint32_t kHeldInstallerAccess = kFileReadData | kFileReadAttributes | kSynchronize;
inline constexpr uint32_t kHeldInstallerShare = kFileShareRead;

constexpr bool HeldInstallerLetsItRun(uint32_t access, uint32_t share) {
  return (access & kDeleteAccess) == 0 && (access & ~kHeldInstallerAccess) == 0 && share == kFileShareRead;
}

inline constexpr std::string_view kInstallerKind = "installer";
inline constexpr std::string_view kPortableKind = "portable";
inline constexpr std::string_view kUnsupportedKind = "unsupported";

inline constexpr std::string_view kNetworkReason = "network";
inline constexpr std::string_view kTooLargeReason = "tooLarge";
inline constexpr std::string_view kDiskReason = "disk";
inline constexpr std::string_view kVersionReason = "version";
inline constexpr std::string_view kBusyReason = "busy";
inline constexpr std::string_view kChecksumReason = "checksum";
inline constexpr std::string_view kSignatureReason = "signature";
inline constexpr std::string_view kManifestReason = "manifest";
inline constexpr std::string_view kMissingReason = "missing";
inline constexpr std::string_view kVerifierReason = "verifier";
inline constexpr std::string_view kKindReason = "kind";
inline constexpr std::string_view kInstallReason = "install";
inline constexpr std::string_view kOtherReason = "other";

constexpr bool IsDigit(char c) {
  return c >= '0' && c <= '9';
}

constexpr bool IsLowerHex(char c) {
  return IsDigit(c) || (c >= 'a' && c <= 'f');
}

constexpr bool IsAsciiAlnum(char c) {
  return IsDigit(c) || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

constexpr bool ValidVersion(std::string_view version) {
  if (version.empty() || version.size() > kVersionLimit || !IsDigit(version.front())) {
    return false;
  }
  for (const char c : version) {
    if (!IsAsciiAlnum(c) && c != '.' && c != '+' && c != '-') {
      return false;
    }
  }
  return true;
}

constexpr bool ValidBuild(uint64_t build) {
  return build >= 1 && build <= kLargestBuild;
}

constexpr bool ValidSha256(std::string_view text) {
  if (text.size() != 64) {
    return false;
  }
  for (const char c : text) {
    if (!IsLowerHex(c)) {
      return false;
    }
  }
  return true;
}

constexpr std::optional<uint64_t> ParseCount(std::string_view text) {
  if (text.empty() || text.size() > 16 || text.front() < '1' || text.front() > '9') {
    return std::nullopt;
  }
  uint64_t value = 0;
  for (const char c : text) {
    if (!IsDigit(c)) {
      return std::nullopt;
    }
    value = value * 10 + static_cast<uint64_t>(c - '0');
  }
  return value;
}

constexpr bool ValidPathText(std::string_view text) {
  for (const char c : text) {
    if (!IsAsciiAlnum(c) && c != '.' && c != '_' && c != '+' && c != '/' && c != '-') {
      return false;
    }
  }
  if (text.find("..") != std::string_view::npos || text.find("//") != std::string_view::npos) {
    return false;
  }
  size_t start = 0;
  while (start <= text.size()) {
    const size_t slash = text.find('/', start);
    const std::string_view segment =
        text.substr(start, slash == std::string_view::npos ? std::string_view::npos : slash - start);
    if (segment == ".") {
      return false;
    }
    if (slash == std::string_view::npos) {
      break;
    }
    start = slash + 1;
  }
  return true;
}

constexpr bool Lists(const auto& names, std::string_view name) {
  for (const std::string_view listed : names) {
    if (listed == name) {
      return true;
    }
  }
  return false;
}

constexpr bool ValidPublishedUnder(std::string_view prefix) {
  if (prefix.empty() || prefix.size() > kPrefixLimit || prefix.back() != '/') {
    return false;
  }
  bool http = false;
  std::string_view rest;
  if (prefix.starts_with("https://")) {
    rest = prefix.substr(8);
  } else if (prefix.starts_with("http://")) {
    http = true;
    rest = prefix.substr(7);
  } else {
    return false;
  }
  const size_t slash = rest.find('/');
  if (slash == std::string_view::npos || slash == 0) {
    return false;
  }
  const std::string_view authority = rest.substr(0, slash);
  const std::string_view path = rest.substr(slash + 1);
  if (path.starts_with("/") || !ValidPathText(path)) {
    return false;
  }
  const size_t colon = authority.find(':');
  const std::string_view host = authority.substr(0, colon);
  if (colon != std::string_view::npos) {
    const std::optional<uint64_t> port = ParseCount(authority.substr(colon + 1));
    if (!port || *port > 65535 || authority.size() - colon - 1 > 5) {
      return false;
    }
  }
  if (host.empty() || host.front() == '.' || host.back() == '.') {
    return false;
  }
  for (const char c : host) {
    if (!IsAsciiAlnum(c) && c != '.' && c != '-') {
      return false;
    }
  }
  return !http || Lists(kLocalHttpHosts, host);
}

constexpr std::string_view FolderOf(std::string_view url) {
  const size_t slash = url.rfind('/');
  return slash == std::string_view::npos ? std::string_view() : url.substr(0, slash + 1);
}

constexpr bool ValidFeedUrl(std::string_view url) {
  if (url.empty() || url.size() > kUrlLimit) {
    return false;
  }
  const std::string_view folder = FolderOf(url);
  const std::string_view leaf = url.substr(folder.size());
  return ValidPublishedUnder(folder) && leaf.size() > 5 && leaf.ends_with(".json") && IsAsciiAlnum(leaf.front()) &&
         ValidPathText(leaf);
}

constexpr bool ValidInstallerUrl(std::string_view url, std::string_view prefix) {
  if (!ValidPublishedUnder(prefix) || url.size() > kUrlLimit || !url.starts_with(prefix)) {
    return false;
  }
  const std::string_view rest = url.substr(prefix.size());
  if (rest.empty() || rest.front() == '/' || !ValidPathText(rest) || !rest.ends_with(".exe")) {
    return false;
  }
  const std::string_view stem_path = rest.substr(0, rest.size() - 4);
  const size_t slash = stem_path.rfind('/');
  const std::string_view stem = slash == std::string_view::npos ? stem_path : stem_path.substr(slash + 1);
  return !stem.empty() && IsAsciiAlnum(stem.front());
}

struct Feed {
  std::string manifest;
  std::string signature;
  std::string published_under;
  bool release = true;
};

inline Feed ReleaseFeed() {
  return Feed{std::string(kReleaseFeed), std::string(kReleaseFeed) + std::string(kSignatureSuffix),
              std::string(kReleasesUnder), true};
}

inline std::optional<Feed> TestFeed(std::string_view url) {
  if (!ValidFeedUrl(url)) {
    return std::nullopt;
  }
  return Feed{std::string(url), std::string(url) + std::string(kSignatureSuffix), std::string(FolderOf(url)), false};
}

constexpr bool AllowedRedirect(std::string_view scheme, std::string_view host, int port, bool release_feed) {
  return release_feed && scheme == "https" && port == 443 && Lists(kRedirectHosts, host);
}

inline std::optional<std::string> InstanceValue(std::string_view text, std::string_view key) {
  if (text.size() > kInstanceLimit || key.empty()) {
    return std::nullopt;
  }
  std::optional<std::string> found;
  size_t start = 0;
  while (start <= text.size()) {
    const size_t comma = text.find(',', start);
    std::string_view piece =
        text.substr(start, comma == std::string_view::npos ? std::string_view::npos : comma - start);
    while (!piece.empty() && (piece.front() == ' ' || piece.front() == '\t')) {
      piece.remove_prefix(1);
    }
    while (!piece.empty() && (piece.back() == ' ' || piece.back() == '\t')) {
      piece.remove_suffix(1);
    }
    const size_t equals = piece.find('=');
    if (equals != std::string_view::npos) {
      std::string_view name = piece.substr(0, equals);
      while (!name.empty() && name.back() == ' ') {
        name.remove_suffix(1);
      }
      if (name == key) {
        std::string_view value = piece.substr(equals + 1);
        while (!value.empty() && value.front() == ' ') {
          value.remove_prefix(1);
        }
        found = std::string(value);
      }
    }
    if (comma == std::string_view::npos) {
      break;
    }
    start = comma + 1;
  }
  if (found && found->empty()) {
    return std::nullopt;
  }
  return found;
}

inline std::string_view LastLine(std::string_view output) {
  while (!output.empty() && (output.back() == '\n' || output.back() == '\r')) {
    output.remove_suffix(1);
  }
  const size_t newline = output.rfind('\n');
  std::string_view line = newline == std::string_view::npos ? output : output.substr(newline + 1);
  if (!line.empty() && line.back() == '\r') {
    line.remove_suffix(1);
  }
  return line;
}

inline std::vector<std::string_view> Words(std::string_view line) {
  std::vector<std::string_view> words;
  size_t start = 0;
  while (start < line.size()) {
    if (line[start] == ' ') {
      ++start;
      continue;
    }
    const size_t end = line.find(' ', start);
    words.push_back(line.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start));
    if (end == std::string_view::npos) {
      break;
    }
    start = end;
  }
  return words;
}

struct Offer {
  std::string version;
  uint64_t build = 0;
  std::string url;
  std::string sha256;
  uint64_t bytes = 0;
};

enum class Verdict { kOk, kUpToDate, kFailed };

struct VerifierAnswer {
  Verdict verdict = Verdict::kFailed;
  Offer offer;
  std::string reason = std::string(kVerifierReason);
};

inline std::string_view FailureReason(std::string_view verifier_reason) {
  if (verifier_reason == "signature") return kSignatureReason;
  if (verifier_reason == "manifest" || verifier_reason == "version") return kManifestReason;
  if (verifier_reason == "missing") return kMissingReason;
  if (verifier_reason == "checksum") return kChecksumReason;
  return kVerifierReason;
}

inline VerifierAnswer ReadVerifierAnswer(bool exited,
                                         int exit_code,
                                         std::string_view output,
                                         uint64_t current_build,
                                         std::string_view published_under) {
  VerifierAnswer answer;
  if (!exited) {
    return answer;
  }
  const std::string_view line = LastLine(output);
  if (line.starts_with("failed ")) {
    const std::string_view reason = line.substr(7);
    if (exit_code != 0 && (reason == "notNewer" || reason == "kind")) {
      answer.verdict = Verdict::kUpToDate;
      answer.reason.clear();
      return answer;
    }
    answer.reason = std::string(exit_code != 0 ? FailureReason(reason) : kVerifierReason);
    return answer;
  }
  if (exit_code != 0 || !line.starts_with("ok ")) {
    return answer;
  }
  const std::vector<std::string_view> words = Words(line.substr(3));
  if (words.size() != 5) {
    return answer;
  }
  const std::optional<uint64_t> build = ParseCount(words[1]);
  const std::optional<uint64_t> bytes = ParseCount(words[4]);
  if (!ValidVersion(words[0]) || !build || !ValidBuild(*build) || *build <= current_build || !bytes ||
      *bytes > kInstallerLimit || !ValidSha256(words[3]) || !ValidInstallerUrl(words[2], published_under)) {
    return answer;
  }
  answer.verdict = Verdict::kOk;
  answer.reason.clear();
  answer.offer = Offer{std::string(words[0]), *build, std::string(words[2]), std::string(words[3]), *bytes};
  return answer;
}

inline bool SameOffer(const Offer& a, const Offer& b) {
  return a.version == b.version && a.build == b.build && a.url == b.url && a.sha256 == b.sha256 &&
         a.bytes == b.bytes;
}

inline std::string InstallerFileName(std::string_view sha256) {
  if (!ValidSha256(sha256)) {
    return std::string();
  }
  return "Ardia-Setup-" + std::string(sha256.substr(0, kInstallerStemDigits)) + ".exe";
}

inline std::string HexLower(const uint8_t* bytes, size_t count);

inline std::string StagingFileName(std::string_view sha256, uint64_t nonce) {
  if (!ValidSha256(sha256)) {
    return std::string();
  }
  uint8_t bytes[8] = {};
  for (int i = 7; i >= 0; --i) {
    bytes[i] = static_cast<uint8_t>(nonce & 0xff);
    nonce >>= 8;
  }
  return "Ardia-Setup-" + std::string(sha256.substr(0, kInstallerStemDigits)) + "-" + HexLower(bytes, 8) + ".part";
}

constexpr bool LowerHexOfSize(std::string_view text, size_t size) {
  if (text.size() != size) {
    return false;
  }
  for (const char c : text) {
    if (!IsLowerHex(c)) {
      return false;
    }
  }
  return true;
}

constexpr bool IsInstallerLeftover(std::string_view name) {
  constexpr std::string_view kPrefix = "Ardia-Setup-";
  if (!name.starts_with(kPrefix)) {
    return false;
  }
  std::string_view rest = name.substr(kPrefix.size());
  if (rest.ends_with(".exe")) {
    return LowerHexOfSize(rest.substr(0, rest.size() - 4), kInstallerStemDigits);
  }
  if (!rest.ends_with(".part") || rest.size() != kInstallerStemDigits * 2 + 1 + 5) {
    return false;
  }
  return LowerHexOfSize(rest.substr(0, kInstallerStemDigits), kInstallerStemDigits) &&
         rest[kInstallerStemDigits] == '-' &&
         LowerHexOfSize(rest.substr(kInstallerStemDigits + 1, kInstallerStemDigits), kInstallerStemDigits);
}

inline bool IsScratchName(std::string_view name) {
  constexpr std::string_view kPrefix = "verify-";
  if (!name.starts_with(kPrefix)) {
    return false;
  }
  const std::string_view rest = name.substr(kPrefix.size());
  const size_t dash = rest.find('-');
  if (dash == std::string_view::npos) {
    return false;
  }
  return ParseCount(rest.substr(0, dash)).has_value() && ParseCount(rest.substr(dash + 1)).has_value();
}

inline std::string ScratchName(uint64_t process, uint64_t sequence) {
  return "verify-" + std::to_string(process == 0 ? 1 : process) + "-" + std::to_string(sequence == 0 ? 1 : sequence);
}

inline std::wstring QuoteArgument(std::wstring_view argument) {
  std::wstring quoted(1, L'"');
  size_t backslashes = 0;
  for (const wchar_t c : argument) {
    if (c == L'\\') {
      ++backslashes;
      continue;
    }
    if (c == L'"') {
      quoted.append(backslashes * 2 + 1, L'\\');
      quoted.push_back(L'"');
    } else {
      quoted.append(backslashes, L'\\');
      quoted.push_back(c);
    }
    backslashes = 0;
  }
  quoted.append(backslashes * 2, L'\\');
  quoted.push_back(L'"');
  return quoted;
}

inline bool PlainCommandPath(std::wstring_view path) {
  if (path.empty() || path.size() > 32767) {
    return false;
  }
  for (const wchar_t c : path) {
    if (c < 0x20 || c == L'"') {
      return false;
    }
  }
  return true;
}

struct VerifierPaths {
  std::wstring verifier;
  std::wstring key;
  std::wstring manifest;
  std::wstring signature;
  std::wstring package;
};

inline std::wstring Widened(std::string_view ascii) {
  return std::wstring(ascii.begin(), ascii.end());
}

inline std::optional<std::wstring> VerifierCommand(const VerifierPaths& paths,
                                                   std::string_view published_under,
                                                   std::string_view cpu,
                                                   uint64_t current_build) {
  if (!PlainCommandPath(paths.verifier) || !PlainCommandPath(paths.key) || !PlainCommandPath(paths.manifest) ||
      !PlainCommandPath(paths.signature) || (!paths.package.empty() && !PlainCommandPath(paths.package)) ||
      !ValidPublishedUnder(published_under) || (cpu != "x64" && cpu != "arm64") || current_build > kLargestBuild) {
    return std::nullopt;
  }
  std::wstring command = QuoteArgument(paths.verifier);
  command += paths.package.empty() ? L" windows-manifest" : L" windows-package";
  command += L" --key " + QuoteArgument(paths.key);
  command += L" --manifest " + QuoteArgument(paths.manifest);
  command += L" --signature " + QuoteArgument(paths.signature);
  command += L" --published-under " + QuoteArgument(Widened(published_under));
  command += L" --cpu " + Widened(cpu);
  command += L" --current-build " + std::to_wstring(current_build);
  if (!paths.package.empty()) {
    command += L" --package " + QuoteArgument(paths.package);
  }
  return command;
}

inline std::optional<std::wstring> InstallerCommand(std::wstring_view installer) {
  if (!PlainCommandPath(installer)) {
    return std::nullopt;
  }
  return QuoteArgument(installer) + L" " + kInstallerArguments;
}

inline std::string HexLower(const uint8_t* bytes, size_t count) {
  static constexpr char kDigits[] = "0123456789abcdef";
  std::string hex;
  hex.reserve(count * 2);
  for (size_t i = 0; i < count; ++i) {
    hex.push_back(kDigits[bytes[i] >> 4]);
    hex.push_back(kDigits[bytes[i] & 0xf]);
  }
  return hex;
}

inline std::wstring FoldedPath(std::wstring_view path) {
  constexpr std::wstring_view kLongPrefix = L"\\\\?\\";
  while (!path.empty() && (path.front() == L' ' || path.front() == L'\t')) {
    path.remove_prefix(1);
  }
  while (!path.empty() && (path.back() == L' ' || path.back() == L'\t')) {
    path.remove_suffix(1);
  }
  if (path.starts_with(kLongPrefix)) {
    path.remove_prefix(kLongPrefix.size());
  }
  std::wstring folded;
  folded.reserve(path.size());
  for (const wchar_t c : path) {
    const wchar_t slash = c == L'/' ? L'\\' : c;
    folded.push_back(slash >= L'A' && slash <= L'Z' ? static_cast<wchar_t>(slash - L'A' + L'a') : slash);
  }
  for (size_t dot = folded.find(L"\\.\\"); dot != std::wstring::npos; dot = folded.find(L"\\.\\")) {
    folded.erase(dot, 2);
  }
  while (folded.size() > 2 && folded.ends_with(L"\\.")) {
    folded.resize(folded.size() - 2);
  }
  while (folded.size() > 3 && folded.back() == L'\\') {
    folded.pop_back();
  }
  return folded;
}

inline bool ScratchDataDirectory(std::wstring_view active, std::wstring_view production) {
  const std::wstring folded_active = FoldedPath(active);
  const std::wstring folded_production = FoldedPath(production);
  return folded_active.empty() || folded_production.empty() || folded_active != folded_production;
}

struct Installation {
  bool identity = false;
  bool verifier = false;
  bool key = false;
  bool uninstaller = false;
};

constexpr std::string_view InstallKind(const Installation& found) {
  if (!found.identity || !found.verifier || !found.key) {
    return kUnsupportedKind;
  }
  return found.uninstaller ? kInstallerKind : kPortableKind;
}

enum class UpdateCall { kInstallKind, kStatus, kCheck, kUpdate, kClaimOutcome, kRestart };

inline constexpr int kLargestRun = 1000000000;

constexpr std::optional<UpdateCall> ParseUpdateCall(std::string_view method) {
  if (method == "ArdiaUpdates.installKind") return UpdateCall::kInstallKind;
  if (method == "ArdiaUpdates.status") return UpdateCall::kStatus;
  if (method == "ArdiaUpdates.check") return UpdateCall::kCheck;
  if (method == "ArdiaUpdates.update") return UpdateCall::kUpdate;
  if (method == "ArdiaUpdates.claimOutcome") return UpdateCall::kClaimOutcome;
  if (method == "ArdiaUpdates.restart") return UpdateCall::kRestart;
  return std::nullopt;
}

enum class ArgumentKind { kNull, kBool, kInt, kDouble, kString, kList, kDict };

struct CallArgument {
  ArgumentKind kind = ArgumentKind::kNull;
  double number = 0;
};

enum class ArgumentsShape { kOmitted, kList, kNotList };

struct CallRequest {
  UpdateCall call = UpdateCall::kStatus;
  uint64_t build = 0;
  int run = 0;
};

struct CallCheck {
  std::optional<CallRequest> request;
  std::string_view refusal;
};

inline std::optional<double> WholeNumber(const CallArgument& argument) {
  if (argument.kind != ArgumentKind::kInt && argument.kind != ArgumentKind::kDouble) {
    return std::nullopt;
  }
  if (!std::isfinite(argument.number) || std::floor(argument.number) != argument.number) {
    return std::nullopt;
  }
  return argument.number;
}

inline CallCheck CheckUpdateCall(std::string_view method, ArgumentsShape shape, std::span<const CallArgument> args) {
  const std::optional<UpdateCall> call = ParseUpdateCall(method);
  if (!call) {
    return {std::nullopt, "Unknown update method"};
  }
  if (shape == ArgumentsShape::kNotList) {
    return {std::nullopt, "args must be a list"};
  }
  switch (*call) {
    case UpdateCall::kInstallKind:
    case UpdateCall::kStatus:
    case UpdateCall::kCheck:
    case UpdateCall::kRestart:
      if (!args.empty()) {
        return {std::nullopt, "this update call takes no arguments"};
      }
      return {CallRequest{*call, 0, 0}, {}};
    case UpdateCall::kUpdate: {
      const std::optional<double> build = args.size() == 1 ? WholeNumber(args[0]) : std::nullopt;
      if (!build || *build < 1 || *build > static_cast<double>(kLargestBuild)) {
        return {std::nullopt, "update takes a build number"};
      }
      return {CallRequest{*call, static_cast<uint64_t>(*build), 0}, {}};
    }
    case UpdateCall::kClaimOutcome: {
      const std::optional<double> run = args.size() == 1 ? WholeNumber(args[0]) : std::nullopt;
      if (!run || *run < 0 || *run > kLargestRun) {
        return {std::nullopt, "claimOutcome takes a run number"};
      }
      return {CallRequest{*call, 0, static_cast<int>(*run)}, {}};
    }
  }
  return {std::nullopt, "Unknown update method"};
}

enum class Phase { kIdle, kChecking, kUpToDate, kAvailable, kDownloading, kReady, kFailed };

constexpr std::string_view PhaseName(Phase phase) {
  switch (phase) {
    case Phase::kIdle:
      return "idle";
    case Phase::kChecking:
      return "checking";
    case Phase::kUpToDate:
      return "upToDate";
    case Phase::kAvailable:
      return "available";
    case Phase::kDownloading:
      return "downloading";
    case Phase::kReady:
      return "ready";
    case Phase::kFailed:
      return "failed";
  }
  return "idle";
}

struct UpdateState {
  Phase phase = Phase::kIdle;
  std::optional<Offer> offer;
  std::string reason;
  int run = 0;
  int check = 0;
  bool claimed = false;
  bool installing = false;
};

constexpr bool Busy(const UpdateState& state) {
  return state.phase == Phase::kChecking || state.phase == Phase::kDownloading || state.phase == Phase::kReady;
}

inline std::optional<int> BeginCheck(UpdateState& state) {
  if (Busy(state)) {
    return std::nullopt;
  }
  state.phase = Phase::kChecking;
  state.reason.clear();
  return ++state.check;
}

inline void CheckFinished(UpdateState& state, int check, Verdict verdict, const Offer& offer, std::string_view reason) {
  if (state.phase != Phase::kChecking || state.check != check) {
    return;
  }
  if (verdict == Verdict::kOk) {
    state.phase = Phase::kAvailable;
    state.offer = offer;
    state.reason.clear();
    return;
  }
  state.offer.reset();
  state.phase = verdict == Verdict::kUpToDate ? Phase::kUpToDate : Phase::kIdle;
  state.reason = verdict == Verdict::kUpToDate ? std::string() : std::string(reason.substr(0, kReasonLimit));
}

inline std::optional<int> BeginDownload(UpdateState& state, uint64_t build) {
  if (state.phase != Phase::kAvailable || !state.offer || state.offer->build != build || !ValidBuild(build)) {
    return std::nullopt;
  }
  state.phase = Phase::kDownloading;
  state.reason.clear();
  state.claimed = false;
  return ++state.run;
}

inline void DownloadFinished(UpdateState& state, int run, bool ok, std::string_view reason) {
  if (state.run != run || state.phase != Phase::kDownloading) {
    return;
  }
  state.phase = ok ? Phase::kReady : Phase::kFailed;
  state.reason = ok ? std::string() : std::string(reason.empty() ? kOtherReason : reason.substr(0, kReasonLimit));
}

inline void InstallRefused(UpdateState& state, int run, std::string_view reason) {
  if (state.run != run || state.phase != Phase::kReady) {
    return;
  }
  state.installing = false;
  state.phase = Phase::kFailed;
  state.claimed = false;
  state.reason = std::string(reason.empty() ? kInstallReason : reason.substr(0, kReasonLimit));
}

inline bool ClaimOutcome(UpdateState& state, int run) {
  if (run <= 0 || run != state.run || state.claimed) {
    return false;
  }
  if (state.phase != Phase::kReady && state.phase != Phase::kFailed) {
    return false;
  }
  state.claimed = true;
  return true;
}

constexpr bool ReadyToInstall(const UpdateState& state) {
  return state.phase == Phase::kReady && state.offer.has_value() && state.run > 0;
}

enum class InstallStart { kStarted, kInstalling, kNotReady };

inline InstallStart BeginInstall(UpdateState& state) {
  if (!ReadyToInstall(state)) {
    return InstallStart::kNotReady;
  }
  if (state.installing) {
    return InstallStart::kInstalling;
  }
  state.installing = true;
  return InstallStart::kStarted;
}

}

#endif
