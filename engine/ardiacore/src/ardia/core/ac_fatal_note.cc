#include "ardia/core/ac_fatal_note.h"

#include <dlfcn.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <atomic>
#include <string>

#include "base/location.h"
#include "base/logging.h"
#include "base/pending_task.h"
#include "base/task/common/task_annotator.h"

namespace {

struct CrashReporterAnnotations {
  uint64_t version;
  uint64_t message;
  uint64_t signature_string;
  uint64_t backtrace;
  uint64_t message2;
  uint64_t thread;
  uint64_t dialog_mode;
  uint64_t abort_cause;
};

__attribute__((used, section("__DATA,__crash_info")))
CrashReporterAnnotations g_crash_info = {5, 0, 0, 0, 0, 0, 0, 0};

char g_fatal_note[2048];
std::atomic<bool> g_fatal_note_taken{false};
logging::LogMessageHandlerFunction g_previous_handler = nullptr;

const char* BaseName(const char* path) {
  if (!path) {
    return "";
  }
  const char* slash = strrchr(path, '/');
  return slash ? slash + 1 : path;
}

size_t Append(size_t used, const char* format, ...)
    __attribute__((format(printf, 2, 3)));

size_t Append(size_t used, const char* format, ...) {
  if (used >= sizeof(g_fatal_note)) {
    return used;
  }
  va_list args;
  va_start(args, format);
  int wrote = vsnprintf(g_fatal_note + used, sizeof(g_fatal_note) - used,
                        format, args);
  va_end(args);
  if (wrote < 0) {
    return used;
  }
  size_t next = used + static_cast<size_t>(wrote);
  return next < sizeof(g_fatal_note) ? next : sizeof(g_fatal_note) - 1;
}

size_t AppendAddress(size_t used, uintptr_t address) {
  Dl_info info = {};
  if (!address || !dladdr(reinterpret_cast<const void*>(address), &info) ||
      !info.dli_fbase) {
    return Append(used, " 0x%lx", static_cast<unsigned long>(address));
  }
  char image[193];
  size_t length = 0;
  for (const char* c = BaseName(info.dli_fname);
       *c && length + 4 <= sizeof(image) && length < 3 * 64; ++c) {
    if (*c == ' ' || *c == '%') {
      length += static_cast<size_t>(snprintf(image + length,
                                             sizeof(image) - length, "%%%02X",
                                             static_cast<unsigned char>(*c)));
    } else {
      image[length++] = *c;
    }
  }
  image[length] = '\0';
  uintptr_t base = reinterpret_cast<uintptr_t>(info.dli_fbase);
  return Append(used, " %s+0x%lx", image,
                static_cast<unsigned long>(address - base));
}

void WriteFatalNote(const char* file, int line) {
  size_t used = Append(0, "ardia-fatal %s:%d\n", BaseName(file), line);
  const base::PendingTask* task =
      base::TaskAnnotator::CurrentTaskForThread();
  if (task) {
    const base::Location& from = task->posted_from;
    used = Append(used, "ardia-posted-from %s %s:%d",
                  from.function_name() ? from.function_name() : "-",
                  from.file_name() ? BaseName(from.file_name()) : "-",
                  from.line_number());
    used = AppendAddress(used, from.program_counter());
    used = Append(used, "\nardia-task-trace");
    for (uintptr_t address : task->task_backtrace) {
      if (address) {
        used = AppendAddress(used, address);
      }
    }
    used = Append(used, "\n");
  }
  g_crash_info.message = reinterpret_cast<uint64_t>(g_fatal_note);
}

bool NoteFatal(int severity,
               const char* file,
               int line,
               size_t message_start,
               const std::string& text) {
  if (severity == logging::LOGGING_FATAL &&
      !g_fatal_note_taken.exchange(true, std::memory_order_acq_rel)) {
    WriteFatalNote(file, line);
  }
  return g_previous_handler &&
         g_previous_handler(severity, file, line, message_start, text);
}

}

namespace ardiacore {

void NoteFatalMessagesInCrashReports() {
  if (logging::GetLogMessageHandler() == &NoteFatal) {
    return;
  }
  g_previous_handler = logging::GetLogMessageHandler();
  logging::SetLogMessageHandler(&NoteFatal);
}

}
