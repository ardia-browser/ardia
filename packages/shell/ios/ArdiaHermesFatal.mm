#import "ArdiaHermesFatal.h"

#include <fcntl.h>
#include <limits.h>
#include <string.h>
#include <unistd.h>

#include <string>

#include <hermes/hermes.h>
#include <jsi/jsi.h>

namespace {

constexpr size_t kReasonMax = 200;

char gPath[PATH_MAX];

void WriteReason(const std::string &reason) {
  if (gPath[0] == '\0') return;
  char line[kReasonMax];
  size_t length = 0;
  for (char c : reason) {
    if (length == kReasonMax || c == '\n' || c == '\r' || c == '\0') break;
    unsigned char byte = static_cast<unsigned char>(c);
    line[length++] = (byte >= 0x20 && byte < 0x7f) ? c : '?';
  }
  int fd = open(gPath, O_WRONLY | O_CREAT | O_TRUNC, 0600);
  if (fd < 0) return;
  ssize_t written = length > 0 ? write(fd, line, length) : 0;
  (void)written;
  close(fd);
}

}

void ArdiaHermesFatalInstall(NSString *path) {
  const char *utf8 = path.fileSystemRepresentation;
  if (utf8 == NULL || strlen(utf8) >= sizeof(gPath)) return;
  strlcpy(gPath, utf8, sizeof(gPath));
  auto *root = facebook::jsi::castInterface<facebook::hermes::IHermesRootAPI>(facebook::hermes::makeHermesRootAPI());
  if (root != nullptr) root->setFatalHandler(WriteReason);
}
