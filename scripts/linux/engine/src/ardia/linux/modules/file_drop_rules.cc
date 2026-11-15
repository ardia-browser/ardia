// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/file_drop_rules.h"

#include "base/files/file_util.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "net/base/filename_util.h"
#include "third_party/re2/src/re2/re2.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

bool HasExtension(const base::FilePath& path, std::string_view extension) {
  return base::EqualsCaseInsensitiveASCII(path.FinalExtension(), extension);
}

bool IsLinkFile(const base::FilePath& path) {
  return HasExtension(path, ".webloc") || HasExtension(path, ".inetloc") ||
         HasExtension(path, ".url");
}

base::Value Item(std::string_view kind, std::string url) {
  return base::Value(
      base::DictValue().Set("kind", kind).Set("url", std::move(url)));
}

}

std::optional<std::string> DroppedWebUrl(std::string_view raw) {
  std::string_view text = base::TrimWhitespaceASCII(raw, base::TRIM_ALL);
  if (text.empty() || text.size() >= 8192) {
    return std::nullopt;
  }
  GURL url(text);
  if (!url.is_valid() || !url.SchemeIsHTTPOrHTTPS() || url.host().empty()) {
    return std::nullopt;
  }
  return url.spec();
}

std::optional<std::string> LinkFileTarget(const base::FilePath& path,
                                          std::string_view contents) {
  if (HasExtension(path, ".url")) {
    for (std::string_view line : base::SplitStringPiece(
             contents, "\n", base::KEEP_WHITESPACE, base::SPLIT_WANT_ALL)) {
      if (!line.empty() && line.back() == '\r') {
        line.remove_suffix(1);
      }
      if (line.size() >= 4 &&
          base::EqualsCaseInsensitiveASCII(line.substr(0, 4), "url=")) {
        return DroppedWebUrl(line.substr(4));
      }
    }
    return std::nullopt;
  }
  static const re2::LazyRE2 kPlistUrl = {
      R"((?i)<key>\s*URL\s*</key>\s*<string>([^<]*)</string>)"};
  std::string target;
  if (!re2::RE2::PartialMatch(contents, *kPlistUrl, &target)) {
    return std::nullopt;
  }
  base::ReplaceSubstringsAfterOffset(&target, 0, "&amp;", "&");
  return DroppedWebUrl(target);
}

DroppedPath ExamineDroppedPath(const base::FilePath& path) {
  DroppedPath dropped;
  dropped.path = path;
  if (!path.IsAbsolute() || path.ReferencesParent()) {
    return dropped;
  }
  base::File::Info info;
  if (!base::GetFileInfo(path, &info)) {
    return dropped;
  }
  dropped.exists = true;
  dropped.extension_package = !info.is_directory && HasExtension(path, ".crx");
  if (IsLinkFile(path)) {
    std::string contents;
    if (!info.is_directory && info.size <= kMaxLinkFileBytes &&
        base::ReadFileToStringWithMaxSize(path, &contents,
                                          kMaxLinkFileBytes)) {
      if (std::optional<std::string> url = LinkFileTarget(path, contents)) {
        dropped.item = Item("url", std::move(*url));
      }
    }
    return dropped;
  }
  dropped.item = Item("file", net::FilePathToFileURL(path).spec());
  return dropped;
}

DropAccepts DropAcceptsFrom(std::string_view accepts) {
  if (accepts == "extensionPackages") {
    return DropAccepts::kExtensionPackages;
  }
  return accepts == "linksAndText" ? DropAccepts::kLinksAndText
                                   : DropAccepts::kLinks;
}

base::ListValue DroppedItems(const std::vector<const DroppedPath*>& paths,
                             DropAccepts accepts) {
  base::ListValue items;
  if (accepts == DropAccepts::kExtensionPackages) {
    if (paths.empty() || paths.size() > kMaxDroppedItems) {
      return items;
    }
    for (const DroppedPath* path : paths) {
      if (!path->exists || !path->extension_package) {
        return base::ListValue();
      }
    }
    for (const DroppedPath* path : paths) {
      items.Append(Item("file", net::FilePathToFileURL(path->path).spec()));
    }
    return items;
  }
  for (size_t i = 0; i < paths.size() && i < kMaxDroppedItems; ++i) {
    if (paths[i]->exists && !paths[i]->item.is_none()) {
      items.Append(paths[i]->item.Clone());
    }
  }
  return items;
}

}
