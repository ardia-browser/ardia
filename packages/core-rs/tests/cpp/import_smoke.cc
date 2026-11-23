#include <cstdio>
#include <memory>
#include <string>
#include <string_view>

#include "ardia_core.h"
#include "ardia_import.h"

static_assert(sizeof(ardia_buf) == sizeof(ardia_import_buf), "ardia_core.h and ardia_import.h share one translation unit");
static_assert(static_cast<int>(ARDIA_IMPORT_STATUS_OK) == static_cast<int>(ARDIA_STATUS_OK), "both start at OK");

namespace {

struct BufDeleter {
  void operator()(ardia_import_buf *buf) const {
    ardia_import_buf_free(buf);
    delete buf;
  }
};

using Buf = std::unique_ptr<ardia_import_buf, BufDeleter>;

struct Answer {
  ardia_import_status status;
  Buf buf;

  std::string_view text() const { return {reinterpret_cast<const char *>(buf->ptr), buf->len}; }
};

Answer Parse(const std::string *local, const std::string *account) {
  ardia_import_bytes local_bytes{};
  ardia_import_bytes account_bytes{};
  if (local) local_bytes = {reinterpret_cast<const uint8_t *>(local->data()), local->size()};
  if (account) account_bytes = {reinterpret_cast<const uint8_t *>(account->data()), account->size()};
  Buf out(new ardia_import_buf);
  ardia_import_status status = ardia_import_chromium_bookmarks(local ? &local_bytes : nullptr, account ? &account_bytes : nullptr, out.get());
  return {status, std::move(out)};
}

Answer ParseHtml(const std::string *html) {
  ardia_import_bytes bytes{};
  if (html) bytes = {reinterpret_cast<const uint8_t *>(html->data()), html->size()};
  Buf out(new ardia_import_buf);
  ardia_import_status status = ardia_import_netscape_bookmarks(html ? &bytes : nullptr, out.get());
  return {status, std::move(out)};
}

int Fail(const char *what) {
  std::fprintf(stderr, "ardia_import C++ smoke failed: %s\n", what);
  return 1;
}

}

int main() {
  const std::string local =
      R"({"roots":{"bookmark_bar":{"type":"folder","name":"Favorites bar","children":[)"
      R"({"type":"url","name":"Ardia","url":"https://ardia.dev/"},3,)"
      R"({"type":"folder","name":"Work","children":[{"type":"url","name":"","url":"file:///tmp/x"}]}]}}})";
  const std::string account = R"({"roots":{"bookmark_bar":{"type":"folder","children":[{"type":"url","url":"https://account/"}]}}})";
  const std::string truncated = local.substr(0, 20);
  int status = 0;
  if (ardia_import_abi_version() != ARDIA_IMPORT_ABI_VERSION) return Fail("abi version");
  Answer tree = Parse(&local, &account);
  if (tree.status != ARDIA_IMPORT_STATUS_OK) return Fail("parse");
  if (tree.text().find(R"("title":"Favorites bar")") == std::string_view::npos ||
      tree.text().find("https://account/") == std::string_view::npos ||
      tree.text().find("file:///tmp/x") == std::string_view::npos)
    status = Fail("tree");
  Answer missing = Parse(nullptr, nullptr);
  if (missing.status != ARDIA_IMPORT_STATUS_NOT_FOUND || missing.text() != R"({"code":"notFound"})") status = Fail("not found");
  Answer unreadable = Parse(&truncated, nullptr);
  if (unreadable.status != ARDIA_IMPORT_STATUS_UNREADABLE || unreadable.text() != R"({"code":"unreadable"})") status = Fail("unreadable");
  Answer ignored = Parse(&local, &truncated);
  if (ignored.status != ARDIA_IMPORT_STATUS_OK || ignored.text().find("https://account/") != std::string_view::npos) status = Fail("account ignored");
  const std::string html =
      R"(<dl><p><dt><h3 id="com.apple.ReadingList">Later</h3><dl><p>)"
      R"(<dt><a href='https://later.example/?a=1&amp;b=2' add_date=1700000000>Read <b>me</b><!-- x --> later</a>)"
      R"(</dl><p></dl><p>)";
  const std::string empty_html = "<!DOCTYPE NETSCAPE-Bookmark-file-1>";
  Answer html_tree = ParseHtml(&html);
  if (html_tree.status != ARDIA_IMPORT_STATUS_OK) return Fail("netscape parse");
  if (html_tree.text().find(R"("role":"readingList")") == std::string_view::npos ||
      html_tree.text().find(R"("title":"Read me later")") == std::string_view::npos ||
      html_tree.text().find("https://later.example/?a=1&b=2") == std::string_view::npos)
    status = Fail("netscape tree");
  Answer html_missing = ParseHtml(nullptr);
  if (html_missing.status != ARDIA_IMPORT_STATUS_NOT_FOUND || html_missing.text() != R"({"code":"notFound"})") status = Fail("netscape not found");
  Answer html_empty = ParseHtml(&empty_html);
  if (html_empty.status != ARDIA_IMPORT_STATUS_UNREADABLE || html_empty.text() != R"({"code":"unreadable"})") status = Fail("netscape unreadable");
  if (status == 0) std::printf("ardia_import C++ smoke passed\n");
  return status;
}
