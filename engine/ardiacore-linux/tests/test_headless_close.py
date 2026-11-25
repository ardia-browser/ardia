import pathlib
import shutil
import subprocess
import tempfile
import unittest

from support import method as extract

ROOT = pathlib.Path(__file__).resolve().parents[1]
LINUX = ROOT / 'src' / 'ardia' / 'linux'
HOST = (LINUX / 'ac_linux_host.cc').read_text()

HARNESS = r'''#include <cassert>
#include <cstdio>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <set>
#include <string>
#include <string_view>
#include <utility>

namespace base {
struct UnguessableToken {
  int value = 0;
};
template <class> class OnceCallback;
template <class R, class... A> class OnceCallback<R(A...)> {
 public:
  OnceCallback() = default;
  template <class F> OnceCallback(F fn) : fn_(std::move(fn)) {}
  explicit operator bool() const { return bool(fn_); }
  R Run(A... args) && { return fn_(std::forward<A>(args)...); }
 private:
  std::function<R(A...)> fn_;
};
template <class T> struct WeakPtr {
  T* pointer = nullptr;
  explicit operator bool() const { return pointer != nullptr; }
  T* operator->() const { return pointer; }
};
template <class F, class... Args> auto BindOnce(F function, Args... args) {
  return [function, args...](auto&&... rest) mutable {
    return function(args..., std::forward<decltype(rest)>(rest)...);
  };
}
class CommandLine {
 public:
  static CommandLine* ForCurrentProcess() { static CommandLine command; return &command; }
  bool HasSwitch(std::string_view name) const { return switches_.contains(std::string(name)); }
  void AppendSwitch(std::string_view name) { switches_.insert(std::string(name)); }
 private:
  std::set<std::string> switches_;
};
}

namespace browser_shutdown {
inline bool quitting = false;
inline bool IsTryingToQuit() { return quitting; }
}

namespace views {
struct Widget {
  enum class ClosedReason { kUnspecified };
  base::OnceCallback<void(ClosedReason)> interceptor;
  bool armed = false;
  bool closed = false;
  bool IsClosed() const { return closed; }
  base::WeakPtr<Widget> GetWeakPtr() { return {this}; }
  void MakeCloseSynchronous(base::OnceCallback<void(ClosedReason)> callback) {
    armed = bool(callback);
    interceptor = std::move(callback);
  }
  void CloseWithReason(ClosedReason reason) {
    if (armed) {
      armed = false;
      auto callback = std::move(interceptor);
      std::move(callback).Run(reason);
      return;
    }
    closed = true;
  }
  void Close() { CloseWithReason(ClosedReason::kUnspecified); }
};
}

struct Browser {
  struct SessionId {
    int value;
    int id() const { return value; }
  };
  int session = 0;
  SessionId GetSessionID() const { return {session}; }
};
using BrowserWindowInterface = Browser;

namespace ardia {
enum class LinuxCloseStage { kPrepare, kBeginTeardown, kDestroy };
struct LinuxCloseHooks {
  bool (*defer)(BrowserWindowInterface*, const base::UnguessableToken&, LinuxCloseStage, base::OnceCallback<void(bool)>);
  void (*cancel)(BrowserWindowInterface*, const base::UnguessableToken&);
};
LinuxCloseHooks g_ardia_linux_close_hooks = {};
bool quit_asks_about_downloads = false;
void SetLinuxQuitAsksAboutDownloads(bool asks) { quit_asks_about_downloads = asks; }
}
using namespace ardia;

HEADLESS_RUN

struct ShellHostView {
  struct Close {
    struct Identity {};
    Identity identity() const { return {}; }
  } close_;
  Browser native;
  Browser* browser_ = &native;
  void* browser_view_ = this;
  views::Widget widget;
  bool closing_ = false;
  int deferred = 0;
  int cancelled = 0;
  int window_close_requests = 0;
  Browser* browser() { return browser_; }
  bool closing() const { return closing_; }
  views::Widget* GetWidget() const { return const_cast<views::Widget*>(&widget); }
  base::WeakPtr<ShellHostView> GetWeakPtr() { return {this}; }
  bool ReadyForChromeClose(const Close::Identity&) const { return false; }
  int RequestWindowClose() { return ++window_close_requests; }
  bool DeferChromeClose(const base::UnguessableToken&, LinuxCloseStage, base::OnceCallback<void(bool)>) {
    ++deferred;
    return true;
  }
  void ChromeCloseCancelled(const base::UnguessableToken&) { ++cancelled; }
  void ArmWindowClose();
};

ARM_WINDOW_CLOSE

std::map<int, ShellHostView*>& Hosts() {
  static std::map<int, ShellHostView*> hosts;
  return hosts;
}
std::map<int, ShellHostView*>& Members() {
  static std::map<int, ShellHostView*> members;
  return members;
}
bool IsCompanion(const BrowserWindowInterface* browser) {
  return browser && Members().contains(browser->GetSessionID().id());
}
ShellHostView* MemberHost(const BrowserWindowInterface* browser) {
  const auto found = Members().find(browser->GetSessionID().id());
  return found == Members().end() ? nullptr : found->second;
}

KEEPS_WINDOW

INSTALL_HOOKS

void Headless() { base::CommandLine::ForCurrentProcess()->AppendSwitch("headless"); }

void CloseHooksAreNotInstalledHeadless() {
  Headless();
  InstallCloseHooks();
  assert(!g_ardia_linux_close_hooks.defer);
  assert(!g_ardia_linux_close_hooks.cancel);
  assert(!quit_asks_about_downloads);
}

void CloseHooksReachTheHostInteractive() {
  ShellHostView host;
  host.native.session = 7;
  Hosts()[7] = &host;
  InstallCloseHooks();
  assert(g_ardia_linux_close_hooks.defer);
  assert(g_ardia_linux_close_hooks.cancel);
  assert(quit_asks_about_downloads);
  base::UnguessableToken token{1};
  assert(g_ardia_linux_close_hooks.defer(&host.native, token, LinuxCloseStage::kPrepare, {}));
  assert(host.deferred == 1);
  g_ardia_linux_close_hooks.cancel(&host.native, token);
  assert(host.cancelled == 1);
  Hosts().clear();
}

void HostWindowDoesNotKeepTheBrowserAliveHeadless() {
  Headless();
  ShellHostView host;
  host.native.session = 7;
  Hosts()[7] = &host;
  assert(!KeepsWindowWithoutTabs(&host.native));
  Hosts().clear();
}

void HostWindowIsKeptInteractive() {
  ShellHostView host;
  host.native.session = 7;
  Hosts()[7] = &host;
  assert(!KeepsWindowWithoutTabs(nullptr));
  assert(KeepsWindowWithoutTabs(&host.native));
  Hosts().clear();
}

void CompanionWindowIsKeptUntilItClosesOrTheAppQuitsInteractive() {
  ShellHostView member;
  Browser companion;
  companion.session = 9;
  Members()[9] = &member;
  assert(KeepsWindowWithoutTabs(&companion));
  member.closing_ = true;
  assert(!KeepsWindowWithoutTabs(&companion));
  member.closing_ = false;
  browser_shutdown::quitting = true;
  assert(!KeepsWindowWithoutTabs(&companion));
  browser_shutdown::quitting = false;
  Members().clear();
}

void WindowClosesStraightAwayHeadless() {
  Headless();
  ShellHostView host;
  host.ArmWindowClose();
  assert(!host.widget.armed);
  host.widget.Close();
  assert(host.widget.closed);
  assert(host.window_close_requests == 0);
}

void WindowCloseWaitsForTheShellInteractive() {
  ShellHostView host;
  host.ArmWindowClose();
  assert(host.widget.armed);
  host.widget.Close();
  assert(!host.widget.closed);
  assert(host.window_close_requests == 1);
  assert(host.widget.armed);
}

int main(int argc, char** argv) {
  assert(argc == 2);
  const std::string_view mode = argv[1];
  if (mode == "hooks-headless") CloseHooksAreNotInstalledHeadless();
  else if (mode == "hooks-interactive") CloseHooksReachTheHostInteractive();
  else if (mode == "keep-headless") HostWindowDoesNotKeepTheBrowserAliveHeadless();
  else if (mode == "keep-interactive") HostWindowIsKeptInteractive();
  else if (mode == "companion-interactive") CompanionWindowIsKeptUntilItClosesOrTheAppQuitsInteractive();
  else if (mode == "arm-headless") WindowClosesStraightAwayHeadless();
  else if (mode == "arm-interactive") WindowCloseWaitsForTheShellInteractive();
  else return 2;
  std::puts("ok");
  return 0;
}
'''

PARTS = {
    'HEADLESS_RUN': 'bool HeadlessRun()',
    'ARM_WINDOW_CLOSE': 'void ShellHostView::ArmWindowClose()',
    'KEEPS_WINDOW': 'bool KeepsWindowWithoutTabs(const BrowserWindowInterface* browser)',
    'INSTALL_HOOKS': 'void InstallCloseHooks()',
}


class HeadlessCloseTests(unittest.TestCase):
    binary = None
    scratch = None

    @classmethod
    def tearDownClass(cls):
        if cls.scratch:
            cls.scratch.cleanup()

    def build(self):
        cls = type(self)
        if cls.binary:
            return cls.binary
        compiler = shutil.which('clang++') or shutil.which('c++')
        self.assertIsNotNone(compiler)
        source = HARNESS
        for placeholder, signature in PARTS.items():
            if signature not in HOST:
                self.fail(f'ac_linux_host.cc has no `{signature}`: a headless run (--screenshot, --dump-dom) still '
                          'installs the Linux close hooks, keeps its host window alive and arms the window-close '
                          'handshake, which all wait for a shell page that a headless run never authorizes, so the '
                          'quit headless starts is cancelled and the process never exits')
            source = source.replace(placeholder, extract(HOST, signature))
        cls.scratch = tempfile.TemporaryDirectory(prefix='ardia-headless-close-')
        root = pathlib.Path(cls.scratch.name)
        (root / 'main.cc').write_text(source)
        binary = root / 'headless_close'
        built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-fsanitize=address,undefined',
                                '-fno-omit-frame-pointer', str(root / 'main.cc'), '-o', str(binary)],
                               capture_output=True, text=True, timeout=120)
        self.assertEqual(built.returncode, 0, built.stdout + built.stderr)
        cls.binary = binary
        return binary

    def run_mode(self, mode):
        ran = subprocess.run([str(self.build()), mode], capture_output=True, text=True, timeout=30)
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)

    def test_headless_run_installs_no_close_hooks(self):
        self.run_mode('hooks-headless')

    def test_headless_host_window_does_not_keep_the_browser_alive(self):
        self.run_mode('keep-headless')

    def test_headless_window_closes_without_a_shell_handshake(self):
        self.run_mode('arm-headless')

    def test_interactive_close_hooks_still_reach_the_host(self):
        self.run_mode('hooks-interactive')

    def test_interactive_host_window_is_kept(self):
        self.run_mode('keep-interactive')

    def test_interactive_companion_window_is_kept_until_it_closes_or_the_app_quits(self):
        self.run_mode('companion-interactive')

    def test_interactive_window_close_still_waits_for_the_shell(self):
        self.run_mode('arm-interactive')


if __name__ == '__main__':
    unittest.main()
