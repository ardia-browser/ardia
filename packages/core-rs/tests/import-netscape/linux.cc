#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>

#include "ardia/linux/ac_linux_import_formats.h"

int main(int argc, char** argv) {
  if (argc != 2) return 2;
  std::ifstream file(argv[1], std::ios::binary);
  if (!file) return 3;
  const std::string bytes((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
  ardia::linux_import::BookmarksParse parse = ardia::linux_import::ParseNetscapeBookmarks(bytes);
  std::string out;
  if (parse.root) {
    out = "{\"ok\":" + base::ToJson(*parse.root) + "}";
  } else {
    out = "{\"error\":";
    base::WriteString(parse.error_code, out);
    out += "}";
  }
  std::fwrite(out.data(), 1, out.size(), stdout);
  return 0;
}
