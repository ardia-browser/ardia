#include <stdio.h>
#include <string.h>

#include "ardia_core.h"
#include "ardia_import.h"

_Static_assert(sizeof(ardia_buf) == sizeof(ardia_import_buf) && (int)ARDIA_STATUS_OK == (int)ARDIA_IMPORT_STATUS_OK,
               "ardia_core.h and ardia_import.h share one translation unit");

static int fail(const char *what) {
  fprintf(stderr, "ardia_import smoke failed: %s\n", what);
  return 1;
}

static int contains(const ardia_import_buf *buf, const char *text) {
  size_t len = strlen(text);
  size_t at;
  if (buf->ptr == NULL || buf->len < len) return 0;
  for (at = 0; at + len <= buf->len; at++) {
    if (memcmp(buf->ptr + at, text, len) == 0) return 1;
  }
  return 0;
}

static int same(const ardia_import_buf *buf, const char *text) {
  return buf->len == strlen(text) && memcmp(buf->ptr, text, buf->len) == 0;
}

int main(void) {
  const char *local = "{\"roots\":{\"bookmark_bar\":{\"type\":\"folder\",\"children\":["
                      "{\"type\":\"url\",\"name\":\"Ardia\",\"url\":\"https://ardia.dev/\",\"date_added\":\"13300000000000000\"},"
                      "{\"type\":\"folder\",\"name\":\"Work\",\"children\":[{\"type\":\"url\",\"name\":\"\xe6\x97\xa5\",\"url\":\"javascript:void(0)\"}]}]}}}";
  const char *account = "{\"roots\":{\"synced\":{\"type\":\"folder\",\"children\":[{\"type\":\"url\",\"url\":\"https://phone.example/\"}]}}}";
  ardia_import_bytes bookmarks = {(const uint8_t *)local, strlen(local)};
  ardia_import_bytes account_bookmarks = {(const uint8_t *)account, strlen(account)};
  ardia_import_bytes broken = {(const uint8_t *)"{", 1};
  ardia_import_bytes oversized = {NULL, (size_t)ARDIA_IMPORT_MAX_INPUT_BYTES + 1};
  const char *html = "<!DOCTYPE NETSCAPE-Bookmark-file-1>\n<DL><p>\n"
                     "<DT><H3 ADD_DATE=\"1700000000\" PERSONAL_TOOLBAR_FOLDER=\"true\">Bar</H3>\n<DL><p>\n"
                     "<DT><A HREF=\"javascript:alert(&quot;hi&quot;)\" ADD_DATE=\"1700000001\">\xe6\x97\xa5 &amp; <3</A>\n"
                     "<DT><A HREF=\"place:sort=8\">Recent</A>\n</DL><p>\n</DL><p>\n";
  ardia_import_bytes netscape = {(const uint8_t *)html, strlen(html)};
  ardia_import_bytes no_bookmarks = {(const uint8_t *)"<DL></DL>", 9};
  ardia_import_buf tree, missing, unreadable, too_large, html_tree, html_missing, html_empty, html_too_large;
  int status = 0;
  if (ardia_import_abi_version() != ARDIA_IMPORT_ABI_VERSION) return fail("abi version");
  if (ardia_import_chromium_bookmarks(&bookmarks, &account_bookmarks, &tree) != ARDIA_IMPORT_STATUS_OK) return fail("parse");
  if (!contains(&tree, "\"role\":\"toolbar\"") || !contains(&tree, "\"role\":\"mobile\"") ||
      !contains(&tree, "\"title\":\"\xe6\x97\xa5\"") || !contains(&tree, "\"dateAdded\":1655526400000.0") ||
      !contains(&tree, "javascript:void(0)"))
    status = fail("tree");
  if (ardia_import_chromium_bookmarks(NULL, NULL, &missing) != ARDIA_IMPORT_STATUS_NOT_FOUND || !same(&missing, "{\"code\":\"notFound\"}")) status = fail("not found");
  if (ardia_import_chromium_bookmarks(&broken, &account_bookmarks, &unreadable) != ARDIA_IMPORT_STATUS_UNREADABLE || !same(&unreadable, "{\"code\":\"unreadable\"}")) status = fail("unreadable");
  if (ardia_import_chromium_bookmarks(&oversized, NULL, &too_large) != ARDIA_IMPORT_STATUS_TOO_LARGE || !same(&too_large, "{\"code\":\"tooLarge\"}")) status = fail("too large");
  if (ardia_import_chromium_bookmarks(&bookmarks, NULL, NULL) != ARDIA_IMPORT_STATUS_INVALID_ARGUMENT) status = fail("null output");
  if (ardia_import_netscape_bookmarks(&netscape, &html_tree) != ARDIA_IMPORT_STATUS_OK) return fail("netscape parse");
  if (!contains(&html_tree, "\"role\":\"toolbar\"") || !contains(&html_tree, "\"title\":\"\xe6\x97\xa5 & <3\"") ||
      !contains(&html_tree, "\"url\":\"javascript:alert(\\\"hi\\\")\"") || !contains(&html_tree, "\"dateAdded\":1700000001000.0") ||
      contains(&html_tree, "place:"))
    status = fail("netscape tree");
  if (ardia_import_netscape_bookmarks(NULL, &html_missing) != ARDIA_IMPORT_STATUS_NOT_FOUND || !same(&html_missing, "{\"code\":\"notFound\"}")) status = fail("netscape not found");
  if (ardia_import_netscape_bookmarks(&no_bookmarks, &html_empty) != ARDIA_IMPORT_STATUS_UNREADABLE || !same(&html_empty, "{\"code\":\"unreadable\"}")) status = fail("netscape unreadable");
  if (ardia_import_netscape_bookmarks(&oversized, &html_too_large) != ARDIA_IMPORT_STATUS_TOO_LARGE || !same(&html_too_large, "{\"code\":\"tooLarge\"}")) status = fail("netscape too large");
  if (ardia_import_netscape_bookmarks(&netscape, NULL) != ARDIA_IMPORT_STATUS_INVALID_ARGUMENT) status = fail("netscape null output");
  ardia_import_buf_free(&html_tree);
  ardia_import_buf_free(&html_missing);
  ardia_import_buf_free(&html_empty);
  ardia_import_buf_free(&html_too_large);
  if (html_tree.ptr != NULL || html_tree.len != 0) status = fail("netscape free resets the buffer");
  ardia_import_buf_free(&tree);
  ardia_import_buf_free(&missing);
  ardia_import_buf_free(&unreadable);
  ardia_import_buf_free(&too_large);
  ardia_import_buf_free(NULL);
  if (tree.ptr != NULL || tree.len != 0) status = fail("free resets the buffer");
  ardia_import_buf_free(&tree);
  if (status == 0) printf("ardia_import smoke passed\n");
  return status;
}
