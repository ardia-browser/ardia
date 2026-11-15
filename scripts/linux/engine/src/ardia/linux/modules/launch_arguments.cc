// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/modules/launch_arguments.h"

#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "net/base/filename_util.h"
#include "third_party/re2/src/re2/re2.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

bool LooksLikeBareHost(std::string_view text) {
  static const base::NoDestructor<re2::RE2> bare_host(
      R"((?i)(?:localhost|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z][a-z0-9-]*)(?::\d{1,5})?(?:[/?#][^\s\\]*)?)");
  return re2::RE2::FullMatch(text, *bare_host);
}

bool HasScheme(std::string_view text) {
  static const base::NoDestructor<re2::RE2> scheme(
      R"((?is)[a-z][a-z0-9+.-]+:.*)");
  return re2::RE2::FullMatch(text, *scheme);
}

bool NamesADocument(std::string_view text) {
  static const base::NoDestructor<re2::RE2> document(
      R"((?i).*\.(?:html?|xhtml|mhtml|pdf|svg|txt|md|json|xml|png|jpe?g|gif|webp|avif))");
  return re2::RE2::FullMatch(text, *document);
}

base::FilePath WithoutDotComponents(const base::FilePath& path) {
  base::FilePath clean(path.IsAbsolute() ? "/" : "");
  for (const std::string& part : path.GetComponents()) {
    if (part == "." || part == "/") {
      continue;
    }
    clean = clean.empty() ? base::FilePath(part) : clean.Append(part);
  }
  return clean;
}

}

std::string LaunchArgumentText(
    const std::string& argument,
    const base::FilePath& cwd,
    base::FunctionRef<bool(const base::FilePath&)> exists) {
  const std::string text(base::TrimWhitespaceASCII(argument, base::TRIM_ALL));
  if (text.empty() || HasScheme(text)) {
    return text;
  }
  const base::FilePath given(text);
  const base::FilePath path =
      WithoutDotComponents(given.IsAbsolute() ? given : cwd.Append(given));
  const bool pathlike = given.IsAbsolute() || text.starts_with(".") ||
                        text.find('/') != std::string::npos;
  if ((pathlike || !LooksLikeBareHost(text) || NamesADocument(text)) &&
      exists(path)) {
    return net::FilePathToFileURL(path.NormalizePathSeparators()).spec();
  }
  return text;
}

std::vector<std::string> LaunchArgumentTexts(
    const std::vector<std::string>& arguments,
    const base::FilePath& cwd,
    base::FunctionRef<bool(const base::FilePath&)> exists) {
  std::vector<std::string> texts;
  for (const std::string& argument : arguments) {
    std::string text = LaunchArgumentText(argument, cwd, exists);
    if (!text.empty()) {
      texts.push_back(std::move(text));
    }
  }
  return texts;
}

std::vector<std::string> LaunchAddresses(
    const std::vector<std::string>& arguments,
    const base::FilePath& cwd,
    base::FunctionRef<bool(const base::FilePath&)> exists) {
  std::vector<std::string> addresses;
  for (const std::string& text : LaunchArgumentTexts(arguments, cwd, exists)) {
    const GURL url(text);
    if (url.is_valid() && (url.SchemeIsHTTPOrHTTPS() || url.SchemeIsFile())) {
      addresses.push_back(url.spec());
    } else if (!HasScheme(text) && LooksLikeBareHost(text)) {
      addresses.push_back(GURL("http://" + text).spec());
    }
  }
  return addresses;
}

}
