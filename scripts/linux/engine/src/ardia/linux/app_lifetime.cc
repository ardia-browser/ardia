// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/app_lifetime.h"

#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <string.h>
#include <unistd.h>

#include <string>
#include <utility>

#include "ardia/linux/log.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/ui_host/ui_host_parts.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/posix/eintr_wrapper.h"
#include "base/process/process.h"
#include "base/strings/string_number_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/threading/platform_thread.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/devtools/chrome_devtools_manager_delegate.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "chrome/browser/lifetime/application_lifetime_desktop.h"
#include "components/keep_alive_registry/keep_alive_types.h"
#include "components/keep_alive_registry/scoped_keep_alive.h"

namespace ardia_linux {

namespace {

constexpr base::TimeDelta kQuitAnswerWait = base::Seconds(3);
constexpr base::TimeDelta kExitDeadline = base::Seconds(10);

int g_signal_pipe[2] = {-1, -1};

void OnSignal(int signal) {
  const int saved = errno;
  char number = static_cast<char>(signal);
  [[maybe_unused]] ssize_t written = write(g_signal_pipe[1], &number, 1);
  errno = saved;
}

class SignalReader : public base::PlatformThread::Delegate {
 public:
  explicit SignalReader(scoped_refptr<base::SingleThreadTaskRunner> ui)
      : ui_(std::move(ui)) {}

  void ThreadMain() override {
    base::PlatformThread::SetName("ArdiaSignals");
    while (true) {
      char number = 0;
      const ssize_t got = HANDLE_EINTR(read(g_signal_pipe[0], &number, 1));
      if (got != 1) {
        return;
      }
      ui_->PostTask(FROM_HERE, base::BindOnce(
                                   [](int signal) {
                                     AppLifetime::Get().Signalled(signal);
                                   },
                                   static_cast<int>(number)));
    }
  }

 private:
  scoped_refptr<base::SingleThreadTaskRunner> ui_;
};

void EmitAppEvent(std::string_view type) {
  if (!ModuleRegistry::Exists()) {
    return;
  }
  base::DictValue payload;
  payload.Set("type", type);
  ModuleRegistry::Get().Emit("ArdiaShell", "onAppEvent",
                             base::Value(std::move(payload)));
}

}

AppLifetime& AppLifetime::Get() {
  static base::NoDestructor<AppLifetime> lifetime;
  return *lifetime;
}

AppLifetime::AppLifetime() = default;

AppLifetime::~AppLifetime() = default;

void AppLifetime::HoldKeepAlive() {
  if (!keep_alive_) {
    keep_alive_ = std::make_unique<ScopedKeepAlive>(
        KeepAliveOrigin::APP_CONTROLLER, KeepAliveRestartOption::DISABLED);
  }
}

void AppLifetime::WatchSignals() {
  if (g_signal_pipe[0] >= 0 || pipe2(g_signal_pipe, O_CLOEXEC) != 0) {
    return;
  }
  base::PlatformThread::CreateNonJoinable(
      0, new SignalReader(base::SingleThreadTaskRunner::GetCurrentDefault()));
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = &OnSignal;
  sigemptyset(&action.sa_mask);
  action.sa_flags = SA_RESTART;
  for (int signal : {SIGTERM, SIGINT, SIGHUP}) {
    sigaction(signal, &action, nullptr);
  }
}

void AppLifetime::Signalled(int signal) {
  if (finished_) {
    return;
  }
  if (!quitting_) {
    Note("quit", "signal " + base::NumberToString(signal) + "; asking the UI");
    RequestQuit();
    return;
  }
  Note("quit", "signal " + base::NumberToString(signal) +
                   " again while quitting; quitting now");
  Finish();
}

void AppLifetime::RequestQuit() {
  if (quitting_ || finished_) {
    return;
  }
  quitting_ = true;
  const int mine = ++generation_;
  EmitAppEvent("willQuit");
  answer_timer_.Start(FROM_HERE, kQuitAnswerWait,
                      base::BindOnce(&AppLifetime::AnswerOverdue,
                                     weak_factory_.GetWeakPtr(), mine));
}

void AppLifetime::AnswerOverdue(int generation) {
  if (quitting_ && generation == generation_) {
    Note("quit", "the UI didn't answer willQuit in time; quitting anyway");
    Finish();
  }
}

void AppLifetime::ReplyToTerminate(bool ok) {
  if (!quitting_ || finished_) {
    return;
  }
  if (ok) {
    Finish();
    return;
  }
  quitting_ = false;
  ++generation_;
  answer_timer_.Stop();
  EmitAppEvent("quitCancelled");
}

void AppLifetime::Finish() {
  if (finished_) {
    return;
  }
  finished_ = true;
  answer_timer_.Stop();
  Note("quit", "quitting");
  exit_deadline_.Start(FROM_HERE, kExitDeadline, base::BindOnce([] {
                         Note("quit", "the engine didn't exit in time");
                         base::Process::TerminateCurrentProcessImmediately(0);
                       }));
  AppWindows::Get().CloseAll();
  StopUiHost();
  keep_alive_.reset();
  ChromeDevToolsManagerDelegate::AllowBrowserToClose();
  chrome::ExitIgnoreUnloadHandlers();
}

void AppLifetime::Release() {
  answer_timer_.Stop();
  keep_alive_.reset();
}

}
