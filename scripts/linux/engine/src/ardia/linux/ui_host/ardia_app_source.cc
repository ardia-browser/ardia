#include "ardia/linux/ui_host/ardia_app_source.h"

#include <utility>

#include "base/containers/fixed_flat_map.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "third_party/re2/src/re2/re2.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted_memory.h"
#include "base/strings/string_util.h"
#include "base/task/thread_pool.h"
#include "content/public/browser/url_data_source.h"
#include "services/network/public/mojom/content_security_policy.mojom.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

constexpr char kIndex[] = "index.html";
constexpr int64_t kLargestFile = 256 * 1024 * 1024;
constexpr int64_t kLargestPolicyFile = 64 * 1024;
constexpr size_t kMostScriptHashes = 32;
constexpr char kScriptHashPattern[] = "'sha256-[A-Za-z0-9+/]{43}='";

constexpr auto kMimeTypes = base::MakeFixedFlatMap<std::string_view,
                                                   std::string_view>({
    {"css", "text/css"},
    {"gif", "image/gif"},
    {"gz", "application/gzip"},
    {"html", "text/html"},
    {"ico", "image/x-icon"},
    {"jpeg", "image/jpeg"},
    {"jpg", "image/jpeg"},
    {"js", "text/javascript"},
    {"json", "application/json"},
    {"m4a", "audio/mp4"},
    {"map", "application/json"},
    {"mjs", "text/javascript"},
    {"mp3", "audio/mpeg"},
    {"mp4", "video/mp4"},
    {"otf", "font/otf"},
    {"png", "image/png"},
    {"svg", "image/svg+xml"},
    {"ttf", "font/ttf"},
    {"txt", "text/plain"},
    {"wasm", "application/wasm"},
    {"wav", "audio/wav"},
    {"webm", "video/webm"},
    {"webp", "image/webp"},
    {"woff", "font/woff"},
    {"woff2", "font/woff2"},
});

scoped_refptr<base::RefCountedMemory> ReadConfined(base::FilePath root,
                                                   std::string relative) {
  std::optional<base::FilePath> path = ConfinedPath(root, relative);
  if (!path) {
    return nullptr;
  }
  std::optional<int64_t> size = base::GetFileSize(*path);
  if (!size || *size > kLargestFile) {
    return nullptr;
  }
  std::string contents;
  if (!base::ReadFileToString(*path, &contents)) {
    return nullptr;
  }
  return base::MakeRefCounted<base::RefCountedString>(std::move(contents));
}

std::string_view PathWithoutQuery(std::string_view path) {
  size_t end = path.find_first_of("?#");
  return end == std::string_view::npos ? path : path.substr(0, end);
}

}

std::optional<base::FilePath> ConfinedPath(const base::FilePath& root,
                                           std::string_view relative) {
  if (root.empty() || relative.empty() || relative.front() == '/' ||
      relative.find('\0') != std::string_view::npos ||
      relative.find('\\') != std::string_view::npos) {
    return std::nullopt;
  }
  base::FilePath relative_path = base::FilePath::FromUTF8Unsafe(relative);
  if (relative_path.ReferencesParent() || relative_path.IsAbsolute()) {
    return std::nullopt;
  }
  base::FilePath real_root = base::MakeAbsoluteFilePath(root);
  if (real_root.empty()) {
    return std::nullopt;
  }
  base::FilePath real_path =
      base::MakeAbsoluteFilePath(real_root.Append(relative_path));
  if (real_path.empty() || !real_root.IsParent(real_path) ||
      base::DirectoryExists(real_path)) {
    return std::nullopt;
  }
  return real_path;
}

std::vector<std::string> ScriptHashesFromJson(std::string_view json) {
  std::vector<std::string> hashes;
  std::optional<base::Value> parsed =
      base::JSONReader::Read(json, base::JSON_PARSE_RFC);
  const base::ListValue* listed =
      parsed && parsed->is_dict() ? parsed->GetDict().FindList("scriptSrc")
                                  : nullptr;
  if (!listed) {
    return hashes;
  }
  for (const base::Value& hash : *listed) {
    if (hashes.size() == kMostScriptHashes) {
      break;
    }
    if (hash.is_string() &&
        RE2::FullMatch(hash.GetString(), kScriptHashPattern)) {
      hashes.push_back(hash.GetString());
    }
  }
  return hashes;
}

std::vector<std::string> ReadScriptHashes(const base::FilePath& ui_dir) {
  std::optional<base::FilePath> path =
      ConfinedPath(ui_dir, kContentSecurityFile);
  std::string json;
  if (!path ||
      !base::ReadFileToStringWithMaxSize(*path, &json, kLargestPolicyFile)) {
    return {};
  }
  return ScriptHashesFromJson(json);
}

std::string ScriptSrc(const std::vector<std::string>& hashes) {
  std::string policy = "script-src 'self' 'wasm-unsafe-eval'";
  for (const std::string& hash : hashes) {
    policy += " " + hash;
  }
  return policy + ";";
}

std::string MimeTypeForPath(std::string_view path) {
  std::string_view clean = PathWithoutQuery(path);
  size_t dot = clean.rfind('.');
  size_t slash = clean.rfind('/');
  if (clean.empty()) {
    return "text/html";
  }
  if (dot == std::string_view::npos ||
      (slash != std::string_view::npos && dot < slash)) {
    return "application/octet-stream";
  }
  std::string extension = base::ToLowerASCII(clean.substr(dot + 1));
  auto found = kMimeTypes.find(extension);
  return found == kMimeTypes.end() ? "application/octet-stream"
                                   : std::string(found->second);
}

ArdiaAppSource::ArdiaAppSource(base::FilePath ui_dir,
                               base::FilePath translations_dir,
                               std::vector<std::string> script_hashes)
    : ui_dir_(std::move(ui_dir)),
      translations_dir_(std::move(translations_dir)),
      script_hashes_(std::move(script_hashes)) {}

ArdiaAppSource::~ArdiaAppSource() = default;

std::string ArdiaAppSource::GetSource() {
  return kArdiaAppHost;
}

void ArdiaAppSource::StartDataRequest(
    const GURL& url,
    const content::WebContents::Getter& wc_getter,
    GotDataCallback callback) {
  std::string path(
      PathWithoutQuery(content::URLDataSource::URLToRequestPath(url)));
  base::FilePath root = ui_dir_;
  if (path.empty()) {
    path = kIndex;
  } else if (path.starts_with(kTranslationsPrefix)) {
    root = translations_dir_;
    path = path.substr(std::string_view(kTranslationsPrefix).size());
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
       base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
      base::BindOnce(&ReadConfined, std::move(root), std::move(path)),
      std::move(callback));
}

std::string ArdiaAppSource::GetMimeType(const GURL& url) {
  return MimeTypeForPath(content::URLDataSource::URLToRequestPath(url));
}

bool ArdiaAppSource::AllowCaching() {
  return false;
}

bool ArdiaAppSource::ShouldServeMimeTypeAsContentTypeHeader() {
  return true;
}

std::string ArdiaAppSource::GetContentSecurityPolicy(
    network::mojom::CSPDirectiveName directive) {
  using Directive = network::mojom::CSPDirectiveName;
  switch (directive) {
    case Directive::DefaultSrc:
      return "default-src 'self';";
    case Directive::ScriptSrc:
      return ScriptSrc(script_hashes_);
    case Directive::StyleSrc:
      return "style-src 'self' 'unsafe-inline';";
    case Directive::ImgSrc:
      return "img-src 'self' data: blob: https: http:;";
    case Directive::MediaSrc:
      return "media-src 'self' data: blob:;";
    case Directive::FontSrc:
      return "font-src 'self' data:;";
    case Directive::ConnectSrc:
      return "connect-src 'self' data: blob: https://api.github.com "
             "https://github.com https://objects.githubusercontent.com "
             "https://release-assets.githubusercontent.com "
             "https://storage.googleapis.com;";
    case Directive::FrameSrc:
      return "frame-src 'self' about: data: blob:;";
    case Directive::ChildSrc:
      return "child-src 'self' blob:;";
    case Directive::WorkerSrc:
      return "worker-src 'self' blob:;";
    case Directive::ObjectSrc:
      return "object-src 'none';";
    case Directive::FrameAncestors:
      return "frame-ancestors 'none';";
    case Directive::RequireTrustedTypesFor:
    case Directive::TrustedTypes:
      return std::string();
    default:
      return content::URLDataSource::GetContentSecurityPolicy(directive);
  }
}

}
