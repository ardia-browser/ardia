import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO = ROOT.parents[1]
SOURCE = ROOT / 'src'
DESKTOP = SOURCE / 'ardia' / 'desktop'
LINUX = REPO / 'engine/ardiacore-linux/src/ardia/linux'
WIN = REPO / 'scripts/windows/engine/src/ardia/win'
CHROMIUM_HEADERS = ('ac_desktop_document_reducer.h', 'ac_desktop_platform.h', 'ac_desktop_tab_policy.h')
FORBIDDEN_INCLUDE = re.compile(r'#include [<"](unistd\.h|fcntl\.h|sys/|windows\.h|dwmapi\.h|gtk|gio/|glib|dbus/|ui/ozone|ui/gtk|'
                               r'wayland|X11/|ardia/linux/|ardia/win/|libsecret|base/posix/|base/win/)')


def layer_files():
    return sorted(path.name for path in DESKTOP.iterdir() if path.is_file())


def gn_sources(text):
    return re.findall(r'^\s*"([^"/:]+\.(?:h|cc))",$', text, re.M)


class DesktopLayerTests(unittest.TestCase):
    def test_every_source_is_built_exactly_once(self):
        listed = gn_sources((DESKTOP / 'BUILD.gn').read_text())
        self.assertEqual(len(listed), len(set(listed)))
        self.assertEqual(sorted(listed), [name for name in layer_files() if name != 'BUILD.gn'])

    def test_the_layer_names_no_operating_system(self):
        for name in layer_files():
            text = (DESKTOP / name).read_text()
            with self.subTest(name=name):
                self.assertIsNone(FORBIDDEN_INCLUDE.search(text))
                self.assertNotRegex(text, r'\bnamespace [a-z_:]*linux|\bIS_LINUX\b|\bIS_WIN\b|\bOS_LINUX\b|_WIN32\b')
                if name.endswith('.h'):
                    self.assertIn(f'#define ARDIA_DESKTOP_{name[:-2].upper()}_H_', text)

    def test_the_build_serves_linux_and_windows_only(self):
        build = (DESKTOP / 'BUILD.gn').read_text()
        self.assertTrue(build.startswith('assert(is_linux || is_win)\n'))
        self.assertNotIn('$', build)

    def test_the_hosts_link_the_layer_and_no_moved_copy_is_left(self):
        moved = {name[len('ac_desktop_'):] for name in layer_files() if name.startswith('ac_desktop_')}
        for name in moved:
            with self.subTest(name=name):
                self.assertFalse((LINUX / f'ac_linux_{name}').exists())
        self.assertIn('"//ardia/desktop",', (LINUX / 'BUILD.gn').read_text())
        win_build = (WIN / 'BUILD.gn').read_text()
        self.assertIn('"//ardia/desktop",', win_build)
        self.assertIn('"webui/desktop_platform_win.cc",', win_build)

    def test_each_host_provides_the_platform_once(self):
        for host in (LINUX, WIN):
            found = [path for path in host.rglob('*.cc') if 'CreateDesktopPlatform() {' in path.read_text()]
            with self.subTest(host=host.name):
                self.assertEqual(len(found), 1, found)

    def test_every_platform_method_has_a_linux_and_a_windows_implementation(self):
        header = (DESKTOP / 'ac_desktop_platform.h').read_text()
        platform = header[header.index('class DesktopPlatform {'):]
        methods = re.findall(r'virtual [^;(]*?\b(\w+)\(.*= 0;', platform[:platform.index('};')])
        self.assertEqual(len(methods), 9)
        for path in (LINUX / 'ac_linux_desktop_platform.cc', WIN / 'webui/desktop_platform_win.cc'):
            text = path.read_text()
            for method in methods:
                with self.subTest(host=path.name, method=method):
                    self.assertRegex(text, rf'\b{method}\(.*\boverride\b')

    def test_the_capabilities_cover_the_design(self):
        header = (DESKTOP / 'ac_desktop_platform.h').read_text()
        names = re.findall(r'return "(\w+)";', header)
        self.assertEqual(names, ['secrets', 'reauth', 'defaultBrowser', 'loginItem', 'calendar', 'location', 'power',
                                 'openExternal', 'selfUpdate', 'windowDecorations'])

    def test_linux_routes_exactly_its_system_calls_through_the_platform(self):
        platform = (LINUX / 'ac_linux_desktop_platform.h').read_text()
        routed = re.findall(r'"(Ardia[A-Za-z]+\.[A-Za-z]+)"', platform)
        core = (LINUX / 'ac_linux_desktop_core.h').read_text()
        listed = core[core.index('kSystemCapabilities[] = {'):]
        system = re.findall(r'"(Ardia[A-Za-z]+\.[A-Za-z]+)"', listed[:listed.index('};')])
        self.assertEqual(sorted(routed), sorted(system))


@unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
class StandaloneHeaderTests(unittest.TestCase):
    def test_each_plain_header_compiles_on_its_own(self):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-headers-') as scratch:
            for name in layer_files():
                if not name.endswith('.h') or name in CHROMIUM_HEADERS:
                    continue
                unit = pathlib.Path(scratch, f'{name}.cc')
                unit.write_text(f'#include "ardia/desktop/{name}"\n#include "ardia/desktop/{name}"\n')
                with self.subTest(name=name):
                    result = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-fsyntax-only',
                                             '-I', str(SOURCE), str(unit)], capture_output=True, text=True, timeout=120)
                    self.assertEqual(result.returncode, 0, result.stderr)


PATHS_PROGRAM = r"""
#include <cassert>
#include <string>
#include <string_view>

#include "ardia/desktop/ac_desktop_paths.h"

namespace paths = ardia::desktop_paths;

struct NarrowPath {
  using StringType = std::string;
  explicit NarrowPath(std::string_view text) : text(text) {}
  const std::string& value() const { return text; }
  std::string AsUTF8Unsafe() const { return "converted"; }
  static NarrowPath FromUTF8Unsafe(std::string_view) { return NarrowPath("converted"); }
  std::string text;
};

struct WidePath {
  using StringType = std::wstring;
  const std::wstring& value() const { return text; }
  std::string AsUTF8Unsafe() const {
    std::string out;
    for (wchar_t c : text) out.push_back(c < 0x80 ? static_cast<char>(c) : '?');
    return out;
  }
  static WidePath FromUTF8Unsafe(std::string_view text) {
    WidePath path;
    for (char c : text) path.text.push_back(static_cast<wchar_t>(static_cast<unsigned char>(c)));
    return path;
  }
  std::wstring text;
};

int main() {
  const std::string raw("/home/u/\xff\xfe not utf-8");
  assert(paths::Text(NarrowPath(raw)) == raw);
  assert(paths::FromText<NarrowPath>(raw).value() == raw);
  assert(paths::FromText<NarrowPath>("").value().empty());
  const WidePath wide = paths::FromText<WidePath>("C:\\Users\\u\\Report Drafts");
  assert(wide.value() == L"C:\\Users\\u\\Report Drafts");
  assert(paths::Text(wide) == "C:\\Users\\u\\Report Drafts");
  return 0;
}
"""


@unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
class PathTextTests(unittest.TestCase):
    def test_narrow_paths_keep_their_bytes_and_wide_paths_convert_through_utf8(self):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-paths-') as scratch:
            unit = pathlib.Path(scratch, 'paths_test.cc')
            unit.write_text(PATHS_PROGRAM)
            binary = pathlib.Path(scratch, 'paths_test')
            built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-I', str(SOURCE), str(unit),
                                    '-o', str(binary)], capture_output=True, text=True, timeout=120)
            self.assertEqual(built.returncode, 0, built.stderr)
            ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stderr)



HOSTS = (LINUX / 'ac_linux_host.cc', WIN / 'webui/webui_host_view.cc')

HOST_HARNESS = r"""
#include <cassert>
#include <cstdint>
#include <functional>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/desktop/ac_desktop_webui_process_policy.h"

#define FROM_HERE 0

struct Profile {
  bool off_the_record = false;
  bool IsOffTheRecord() const { return off_the_record; }
};

namespace base {
enum TerminationStatus {
  TERMINATION_STATUS_NORMAL_TERMINATION,
  TERMINATION_STATUS_ABNORMAL_TERMINATION,
  TERMINATION_STATUS_PROCESS_WAS_KILLED,
  TERMINATION_STATUS_PROCESS_CRASHED,
  TERMINATION_STATUS_STILL_RUNNING,
  TERMINATION_STATUS_LAUNCH_FAILED,
  TERMINATION_STATUS_OOM,
};
template <typename Signature>
class RepeatingCallback;
template <typename R, typename... Args>
class RepeatingCallback<R(Args...)> {
 public:
  RepeatingCallback() = default;
  explicit RepeatingCallback(std::function<R(Args...)> run) : run_(std::move(run)) {}
  R Run(Args... args) const { return run_(args...); }
 private:
  std::function<R(Args...)> run_;
};
template <typename T>
struct WeakPtr {
  T* target = nullptr;
  std::shared_ptr<bool> alive;
  T* get() const { return alive && *alive ? target : nullptr; }
  explicit operator bool() const { return get() != nullptr; }
  T* operator->() const { return get(); }
};
class CallbackListSubscription {
 public:
  CallbackListSubscription() = default;
  explicit CallbackListSubscription(std::function<void()> cancel) : cancel_(std::move(cancel)) {}
  CallbackListSubscription(CallbackListSubscription&& other) : cancel_(std::exchange(other.cancel_, nullptr)) {}
  CallbackListSubscription& operator=(CallbackListSubscription&& other) {
    if (cancel_) cancel_();
    cancel_ = std::exchange(other.cancel_, nullptr);
    return *this;
  }
  ~CallbackListSubscription() {
    if (cancel_) cancel_();
  }
 private:
  std::function<void()> cancel_;
};
template <typename F, typename T>
RepeatingCallback<void(bool)> BindRepeating(F run, WeakPtr<T> weak) {
  return RepeatingCallback<void(bool)>([run, weak](bool value) { run(weak, value); });
}
template <typename T>
class WeakPtrFactory {
 public:
  explicit WeakPtrFactory(T* target) : target_(target), alive_(std::make_shared<bool>(true)) {}
  ~WeakPtrFactory() { *alive_ = false; }
  WeakPtr<T> GetWeakPtr() { return {target_, alive_}; }
 private:
  T* target_;
  std::shared_ptr<bool> alive_;
};
using OnceClosure = std::function<void()>;
template <typename T>
OnceClosure BindOnce(void (T::*method)(), WeakPtr<T> weak) {
  return [method, weak] {
    if (T* target = weak.get()) (target->*method)();
  };
}
inline std::vector<OnceClosure>& Tasks() {
  static std::vector<OnceClosure> tasks;
  return tasks;
}
struct TaskRunner {
  void PostTask(int, OnceClosure task) { Tasks().push_back(std::move(task)); }
};
struct SequencedTaskRunner {
  static TaskRunner* GetCurrentDefault() {
    static TaskRunner runner;
    return &runner;
  }
};
struct TimeDelta {
  double seconds;
  double InSecondsF() const { return seconds; }
};
inline TimeDelta Milliseconds(int milliseconds) { return {milliseconds / 1000.0}; }
using RepeatingClosure = RepeatingCallback<void()>;
inline std::vector<std::shared_ptr<OnceClosure>>& Timers() {
  static std::vector<std::shared_ptr<OnceClosure>> timers;
  return timers;
}
class OneShotTimer {
 public:
  ~OneShotTimer() { Stop(); }
  void Start(int, TimeDelta delay, OnceClosure task) {
    assert(delay.seconds > 0 && delay.seconds <= 1);
    Stop();
    pending_ = std::make_shared<OnceClosure>(std::move(task));
    Timers().push_back(pending_);
  }
  void Stop() {
    if (pending_) *pending_ = nullptr;
    pending_.reset();
  }
  bool IsRunning() const { return pending_ && *pending_; }
 private:
  std::shared_ptr<OnceClosure> pending_;
};
inline size_t LiveTimers() {
  size_t live = 0;
  for (const auto& timer : Timers()) live += *timer ? 1 : 0;
  return live;
}
inline size_t FireTimers() {
  auto timers = std::move(Timers());
  Timers().clear();
  size_t fired = 0;
  for (auto& timer : timers) {
    if (!*timer) continue;
    auto task = std::move(*timer);
    *timer = nullptr;
    task();
    ++fired;
  }
  return fired;
}
struct TimeTicks {
  double seconds = 0;
  static double& Clock() {
    static double clock = 100;
    return clock;
  }
  static TimeTicks Now() { return {Clock()}; }
  TimeDelta operator-(TimeTicks other) const { return {seconds - other.seconds}; }
};
}

namespace browser_shutdown {
inline bool& Quitting() {
  static bool quitting = false;
  return quitting;
}
inline bool IsTryingToQuit() { return Quitting(); }
inline bool& ShutdownStarted() {
  static bool started = false;
  return started;
}
inline bool HasShutdownStarted() { return ShutdownStarted(); }
}

namespace chrome {
inline std::vector<std::pair<int, base::RepeatingCallback<void(bool)>>>& ClosingAllBrowsersCallbacks() {
  static std::vector<std::pair<int, base::RepeatingCallback<void(bool)>>> callbacks;
  return callbacks;
}
inline base::CallbackListSubscription AddClosingAllBrowsersCallback(base::RepeatingCallback<void(bool)> callback) {
  static int next = 0;
  const int id = ++next;
  ClosingAllBrowsersCallbacks().emplace_back(id, std::move(callback));
  return base::CallbackListSubscription([id] {
    auto& callbacks = ClosingAllBrowsersCallbacks();
    std::erase_if(callbacks, [id](const auto& entry) { return entry.first == id; });
  });
}
inline void OnClosingAllBrowsers(bool closing) {
  auto callbacks = ClosingAllBrowsersCallbacks();
  for (auto& [id, callback] : callbacks) callback.Run(closing);
}
}

struct GURL {
  explicit GURL(const char* spec) : spec(spec) {}
  std::string spec;
};

namespace ui {
enum PageTransition { PAGE_TRANSITION_AUTO_TOPLEVEL };
}

namespace content {
struct Referrer {};
enum class ReloadType { NORMAL };
struct NavigationEntry {
  bool initial = false;
  bool IsInitialEntry() const { return initial; }
};
struct NavigationController {
  NavigationEntry* last = nullptr;
  int reloads = 0;
  std::vector<std::string> loads;
  NavigationEntry* GetLastCommittedEntry() { return last; }
  void Reload(ReloadType, bool check_for_repost) {
    assert(!check_for_repost);
    ++reloads;
  }
  void LoadURL(const GURL& url, const Referrer&, ui::PageTransition, const std::string&) { loads.push_back(url.spec); }
};
struct RenderFrameHost {
  bool live = true;
  bool IsRenderFrameLive() const { return live; }
};
struct NavigationHandle {
  bool primary = true;
  bool same_document = false;
  bool committed = false;
  bool error_page = false;
  bool IsInPrimaryMainFrame() const { return primary; }
  bool IsSameDocument() const { return same_document; }
  bool HasCommitted() const { return committed; }
  bool IsErrorPage() const { return error_page; }
};
struct WebContents {
  struct PrivilegedParams {
    int32_t feature_id = 0;
    bool disallow_service_worker_control = false;
    bool disallow_shared_workers = false;
  };
  struct CreateParams {
    explicit CreateParams(Profile* context) : browser_context(context) {}
    Profile* browser_context;
    std::optional<PrivilegedParams> privileged_params;
  };
  static std::unique_ptr<WebContents> Create(const CreateParams& params) {
    auto contents = std::make_unique<WebContents>();
    contents->privileged = params.privileged_params;
    return contents;
  }
  NavigationController& GetController() { return controller; }
  RenderFrameHost* GetPrimaryMainFrame() { return &frame; }
  RenderFrameHost frame;
  std::optional<PrivilegedParams> privileged;
  NavigationController controller;
};
struct Page {};
class WebContentsObserver {
 public:
  explicit WebContentsObserver(WebContents* contents) : contents_(contents) {}
  virtual ~WebContentsObserver() = default;
  WebContents* web_contents() const { return contents_; }
  virtual void PrimaryMainFrameRenderProcessGone(base::TerminationStatus) {}
  virtual void PrimaryPageChanged(Page&) {}
  virtual void DidFinishNavigation(NavigationHandle*) {}
 private:
  WebContents* contents_;
};
}

namespace ardia {
@HOST@
}

namespace {

using ardia::desktop_webui_process::WindowState;

void RunTasks() {
  auto tasks = std::move(base::Tasks());
  base::Tasks().clear();
  for (auto& task : tasks) task();
}

struct Shell {
  content::NavigationEntry committed;
  content::WebContents contents;
  WindowState window = WindowState::kOpen;
  std::vector<int> navigations_at_recovery;
  std::vector<ardia::desktop_webui_process::RecoveryOutcome> outcomes;
  ardia::ShellRecovery recovery{&contents, base::RepeatingCallback<WindowState()>([this] { return window; }),
                                base::RepeatingClosure([this] {
                                  navigations_at_recovery.push_back(
                                      contents.controller.reloads + static_cast<int>(contents.controller.loads.size()));
                                }),
                                base::RepeatingCallback<void(ardia::desktop_webui_process::RecoveryOutcome)>(
                                    [this](ardia::desktop_webui_process::RecoveryOutcome outcome) {
                                      outcomes.push_back(outcome);
                                    })};
  explicit Shell(bool booted = true) {
    contents.controller.last = &committed;
    if (!booted) return;
    content::NavigationHandle initial{true, false, true};
    recovery.DidFinishNavigation(&initial);
  }
  void Crash(base::TerminationStatus status = base::TERMINATION_STATUS_PROCESS_CRASHED) {
    recovery.PrimaryMainFrameRenderProcessGone(status);
    RunTasks();
  }
  int reloads() const { return contents.controller.reloads; }
};

void TestOnlyRegularWindowsGetTheSharedRenderer() {
  Profile regular;
  Profile incognito{true};
  const auto shared = ardia::CreateShellContents(&regular, false);
  assert(shared->privileged && shared->privileged->feature_id == ardia::desktop_webui_process::kSharedShellRendererFeature);
  assert(!shared->privileged->disallow_service_worker_control && !shared->privileged->disallow_shared_workers);
  assert(!ardia::CreateShellContents(&regular, true)->privileged);
  assert(!ardia::CreateShellContents(&incognito, false)->privileged);
  assert(!ardia::CreateShellContents(&incognito, true)->privileged);
}

void TestACrashReloadsTheShell() {
  Shell shell;
  shell.Crash();
  assert(shell.reloads() == 1 && shell.contents.controller.loads.empty());
  shell.Crash(base::TERMINATION_STATUS_NORMAL_TERMINATION);
  shell.Crash(base::TERMINATION_STATUS_STILL_RUNNING);
  assert(shell.reloads() == 1);
}

void TestACrashBeforeTheFirstCommitLoadsTheShellUrl() {
  Shell none;
  none.contents.controller.last = nullptr;
  none.Crash(base::TERMINATION_STATUS_LAUNCH_FAILED);
  assert(none.reloads() == 0 && none.contents.controller.loads == std::vector<std::string>{"chrome://ardia/"});
  Shell initial;
  initial.committed.initial = true;
  initial.Crash(base::TERMINATION_STATUS_OOM);
  assert(initial.reloads() == 0 && initial.contents.controller.loads == std::vector<std::string>{"chrome://ardia/"});
}

void TestACrashDuringAReversibleCloseResumesWhenTheCloseIsCancelled() {
  Shell shell;
  shell.window = WindowState::kPaused;
  for (int crash = 0; crash < 6; ++crash) shell.Crash();
  assert(shell.reloads() == 0);
  shell.recovery.Resume();
  RunTasks();
  assert(shell.reloads() == 0);
  shell.window = WindowState::kOpen;
  shell.recovery.Resume();
  RunTasks();
  assert(shell.reloads() == 1);
  shell.recovery.Resume();
  RunTasks();
  assert(shell.reloads() == 1);
}

void TestANewDocumentSettlesAWaitingRecovery() {
  Shell shell;
  shell.window = WindowState::kPaused;
  shell.Crash();
  content::NavigationHandle committed{true, false, true};
  shell.recovery.DidFinishNavigation(&committed);
  shell.window = WindowState::kOpen;
  shell.recovery.Resume();
  RunTasks();
  assert(shell.reloads() == 0);
}

void TestNoReloadWhenGoneAndAQuitOnlyPauses() {
  Shell gone;
  gone.window = WindowState::kGone;
  gone.Crash();
  assert(gone.reloads() == 0);
  Shell quitting;
  browser_shutdown::Quitting() = true;
  quitting.Crash();
  quitting.recovery.Resume();
  RunTasks();
  assert(quitting.reloads() == 0);
  browser_shutdown::Quitting() = false;
  quitting.recovery.Resume();
  RunTasks();
  assert(quitting.reloads() == 1);
}

void TestACancelledQuitResumesEveryWaitingShell() {
  Shell first;
  Shell second;
  browser_shutdown::Quitting() = true;
  first.Crash();
  second.Crash(base::TERMINATION_STATUS_OOM);
  assert(first.reloads() == 0 && second.reloads() == 0);
  chrome::OnClosingAllBrowsers(true);
  RunTasks();
  assert(first.reloads() == 0 && second.reloads() == 0);
  assert(base::LiveTimers() == 2);
  browser_shutdown::Quitting() = false;
  chrome::OnClosingAllBrowsers(false);
  RunTasks();
  assert(first.reloads() == 1 && second.reloads() == 1);
  assert(base::LiveTimers() == 0);
  chrome::OnClosingAllBrowsers(false);
  RunTasks();
  assert(first.reloads() == 1 && second.reloads() == 1);
}

void TestAStartedShutdownNeverReloads() {
  Shell shell;
  browser_shutdown::Quitting() = true;
  browser_shutdown::ShutdownStarted() = true;
  shell.Crash();
  browser_shutdown::Quitting() = false;
  browser_shutdown::ShutdownStarted() = false;
  chrome::OnClosingAllBrowsers(false);
  RunTasks();
  assert(shell.reloads() == 0);
}

void TestAClosedShellStopsListeningForQuitCancels() {
  const size_t before = chrome::ClosingAllBrowsersCallbacks().size();
  {
    Shell shell;
    assert(chrome::ClosingAllBrowsersCallbacks().size() == before + 1);
  }
  assert(chrome::ClosingAllBrowsersCallbacks().size() == before);
  chrome::OnClosingAllBrowsers(false);
  RunTasks();
}

void TestARecoveryNavigationThatDiesBeforeCommitIsRetried() {
  Shell shell;
  shell.Crash();
  assert(shell.reloads() == 1);
  shell.contents.frame.live = false;
  content::NavigationHandle aborted;
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 2);
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 3);
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 3);
}

void TestOnlyAFailedPrimaryRecoveryNavigationRetries() {
  Shell shell;
  shell.contents.frame.live = false;
  content::NavigationHandle unrelated;
  shell.recovery.DidFinishNavigation(&unrelated);
  RunTasks();
  assert(shell.reloads() == 0);
  shell.Crash();
  assert(shell.reloads() == 1);
  content::NavigationHandle subframe{false};
  content::NavigationHandle same_document{true, true};
  shell.recovery.DidFinishNavigation(&subframe);
  shell.recovery.DidFinishNavigation(&same_document);
  RunTasks();
  assert(shell.reloads() == 1);
  content::NavigationHandle aborted;
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 2);
}

void TestARecoveryWithAnEarlySwappedLiveFrameThatNeverCommitsRetries() {
  Shell shell;
  shell.Crash();
  assert(shell.reloads() == 1);
  shell.contents.frame.live = true;
  content::NavigationHandle aborted;
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 2);
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 3);
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 3);
}

void TestAQuitClearedWithoutTheCallbackIsFoundByPolling() {
  Shell first;
  Shell second;
  browser_shutdown::Quitting() = true;
  first.Crash();
  second.Crash();
  assert(first.reloads() == 0 && second.reloads() == 0);
  assert(base::LiveTimers() == 2);
  assert(base::FireTimers() == 2);
  RunTasks();
  assert(first.reloads() == 0 && second.reloads() == 0);
  assert(base::LiveTimers() == 2);
  browser_shutdown::Quitting() = false;
  assert(base::FireTimers() == 2);
  RunTasks();
  assert(first.reloads() == 1 && second.reloads() == 1);
  assert(base::FireTimers() == 0);
}

void TestPollingStopsWhenShutdownStartsOrTheShellCloses() {
  Shell shell;
  browser_shutdown::Quitting() = true;
  shell.Crash();
  assert(base::LiveTimers() == 1);
  browser_shutdown::ShutdownStarted() = true;
  base::FireTimers();
  RunTasks();
  assert(base::FireTimers() == 0);
  browser_shutdown::ShutdownStarted() = false;
  browser_shutdown::Quitting() = false;
  assert(shell.reloads() == 0);

  auto closing = std::make_unique<Shell>();
  browser_shutdown::Quitting() = true;
  closing->Crash();
  browser_shutdown::Quitting() = false;
  closing.reset();
  assert(base::FireTimers() == 0);
  RunTasks();
}

void TestAReversibleCloseIsNotPolled() {
  Shell shell;
  shell.window = WindowState::kPaused;
  shell.Crash();
  assert(base::LiveTimers() == 0);
}

void TestTheLaunchBootstrapIsDisarmedBeforeEveryRecoveryNavigation() {
  Shell reload;
  reload.Crash();
  assert(reload.navigations_at_recovery == std::vector<int>{0});
  Shell early;
  early.contents.controller.last = nullptr;
  early.Crash();
  assert(early.navigations_at_recovery == std::vector<int>{0});
  assert(early.contents.controller.loads.size() == 1);
  Shell untouched;
  untouched.Crash(base::TERMINATION_STATUS_NORMAL_TERMINATION);
  assert(untouched.navigations_at_recovery.empty());
}

void TestACommittedRecoveryEndsIt() {
  Shell shell;
  shell.Crash();
  content::NavigationHandle committed{true, false, true};
  shell.recovery.DidFinishNavigation(&committed);
  shell.contents.frame.live = false;
  content::NavigationHandle aborted;
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 1);
}

void TestAPageChangeWithoutACommitKeepsTheRecoveryInFlight() {
  Shell shell;
  shell.Crash();
  assert(shell.reloads() == 1);
  content::Page reinitialized;
  shell.recovery.PrimaryPageChanged(reinitialized);
  content::NavigationHandle aborted;
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 2);
  shell.recovery.PrimaryPageChanged(reinitialized);
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 3);
  shell.recovery.PrimaryPageChanged(reinitialized);
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 3);
}

void TestOnlyACommittedCrossDocumentMainFrameNavigationSettlesARecovery() {
  Shell shell;
  shell.Crash();
  content::NavigationHandle subframe{false, false, true};
  content::NavigationHandle same_document{true, true, true};
  shell.recovery.DidFinishNavigation(&subframe);
  shell.recovery.DidFinishNavigation(&same_document);
  content::NavigationHandle aborted;
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 2);
  content::NavigationHandle committed{true, false, true};
  shell.recovery.DidFinishNavigation(&committed);
  shell.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(shell.reloads() == 2);
}

using Outcome = ardia::desktop_webui_process::RecoveryOutcome;

void TestAnInitialShellLoadThatNeverCommitsIsRecovered() {
  Shell fresh(false);
  fresh.contents.controller.last = nullptr;
  content::NavigationHandle aborted;
  fresh.recovery.DidFinishNavigation(&aborted);
  RunTasks();
  assert(fresh.contents.controller.loads == std::vector<std::string>{"chrome://ardia/"});
  assert(fresh.outcomes == std::vector<Outcome>{Outcome::kAttempted});
  content::NavigationHandle committed{true, false, true};
  fresh.recovery.DidFinishNavigation(&committed);
  assert((fresh.outcomes == std::vector<Outcome>{Outcome::kAttempted, Outcome::kRecovered}));
}

void TestAnInitialShellLoadThatCommitsAnErrorPageIsRecovered() {
  Shell fresh(false);
  content::NavigationHandle error_page{true, false, true, true};
  fresh.recovery.DidFinishNavigation(&error_page);
  RunTasks();
  assert(fresh.reloads() == 1);
  assert(fresh.outcomes == std::vector<Outcome>{Outcome::kAttempted});
}

void TestANormalBootIsNotARecovery() {
  Shell booted;
  assert(booted.outcomes.empty());
  content::NavigationHandle aborted;
  content::NavigationHandle error_page{true, false, true, true};
  booted.recovery.DidFinishNavigation(&aborted);
  booted.recovery.DidFinishNavigation(&error_page);
  RunTasks();
  assert(booted.reloads() == 0 && booted.contents.controller.loads.empty());
  assert(booted.outcomes.empty());
}

void TestAnErrorPageDuringARecoveryRetriesAndIsNotRecovered() {
  Shell shell;
  shell.Crash();
  assert(shell.reloads() == 1);
  content::NavigationHandle error_page{true, false, true, true};
  shell.recovery.DidFinishNavigation(&error_page);
  RunTasks();
  assert(shell.reloads() == 2);
  assert((shell.outcomes == std::vector<Outcome>{Outcome::kAttempted, Outcome::kAttempted}));
  content::NavigationHandle committed{true, false, true};
  shell.recovery.DidFinishNavigation(&committed);
  assert((shell.outcomes == std::vector<Outcome>{Outcome::kAttempted, Outcome::kAttempted, Outcome::kRecovered}));
}

void TestEachOutcomeIsReported() {
  Shell shell;
  for (int crash = 0; crash < 4; ++crash) {
    base::TimeTicks::Clock() += 0.25;
    shell.Crash();
  }
  assert((shell.outcomes == std::vector<Outcome>{Outcome::kAttempted, Outcome::kAttempted, Outcome::kAttempted,
                                                 Outcome::kExhausted}));
  Shell gone;
  gone.window = WindowState::kGone;
  gone.Crash();
  assert(gone.outcomes.empty());
  Shell paused;
  paused.window = WindowState::kPaused;
  paused.Crash();
  assert(paused.outcomes.empty());
  Shell recovered;
  recovered.Crash();
  content::NavigationHandle committed{true, false, true};
  recovered.recovery.DidFinishNavigation(&committed);
  assert((recovered.outcomes == std::vector<Outcome>{Outcome::kAttempted, Outcome::kRecovered}));
}

void TestACrashLoopStops() {
  Shell shell;
  for (int crash = 0; crash < 20; ++crash) {
    base::TimeTicks::Clock() += 0.5;
    shell.Crash(base::TERMINATION_STATUS_PROCESS_WAS_KILLED);
  }
  assert(shell.reloads() == static_cast<int>(ardia::desktop_webui_process::kShellReloadsAllowed));
  base::TimeTicks::Clock() += ardia::desktop_webui_process::kShellReloadWindowSeconds;
  shell.Crash();
  assert(shell.reloads() == static_cast<int>(ardia::desktop_webui_process::kShellReloadsAllowed) + 1);
}

void TestAPostedRecoveryOutlivesItsWindowSafely() {
  auto shell = std::make_unique<Shell>();
  shell->recovery.PrimaryMainFrameRenderProcessGone(base::TERMINATION_STATUS_PROCESS_CRASHED);
  shell.reset();
  RunTasks();
}

}

int main() {
  TestOnlyRegularWindowsGetTheSharedRenderer();
  TestACrashReloadsTheShell();
  TestACrashBeforeTheFirstCommitLoadsTheShellUrl();
  TestACrashDuringAReversibleCloseResumesWhenTheCloseIsCancelled();
  TestANewDocumentSettlesAWaitingRecovery();
  TestNoReloadWhenGoneAndAQuitOnlyPauses();
  TestACancelledQuitResumesEveryWaitingShell();
  TestAStartedShutdownNeverReloads();
  TestAClosedShellStopsListeningForQuitCancels();
  TestARecoveryNavigationThatDiesBeforeCommitIsRetried();
  TestOnlyAFailedPrimaryRecoveryNavigationRetries();
  TestACommittedRecoveryEndsIt();
  TestAnInitialShellLoadThatNeverCommitsIsRecovered();
  TestAnInitialShellLoadThatCommitsAnErrorPageIsRecovered();
  TestANormalBootIsNotARecovery();
  TestAnErrorPageDuringARecoveryRetriesAndIsNotRecovered();
  TestEachOutcomeIsReported();
  TestAPageChangeWithoutACommitKeepsTheRecoveryInFlight();
  TestOnlyACommittedCrossDocumentMainFrameNavigationSettlesARecovery();
  TestARecoveryWithAnEarlySwappedLiveFrameThatNeverCommitsRetries();
  TestAQuitClearedWithoutTheCallbackIsFoundByPolling();
  TestPollingStopsWhenShutdownStartsOrTheShellCloses();
  TestAReversibleCloseIsNotPolled();
  TestTheLaunchBootstrapIsDisarmedBeforeEveryRecoveryNavigation();
  TestACrashLoopStops();
  TestAPostedRecoveryOutlivesItsWindowSafely();
  return 0;
}
"""


def host_recovery_source(host):
    text = host.read_text()
    start = text.index('std::unique_ptr<content::WebContents> CreateShellContents(')
    end = text.index('\n};\n', text.index('class ShellRecovery : public content::WebContentsObserver {', start)) + 4
    return text[start:end]


class WebUIProcessPolicyTests(unittest.TestCase):
    def test_no_chromium_patch_changes_the_process_model(self):
        self.assertFalse((REPO / 'engine/patches/chromium-linux-webui-process-per-site.patch').exists())
        self.assertNotIn('webui-process-per-site', (REPO / 'engine/patches/series').read_text())
        self.assertNotIn('webui-process-per-site', (REPO / 'scripts/windows/engine/series-win').read_text())

    def test_each_host_builds_its_shell_contents_from_the_policy(self):
        for host in HOSTS:
            text = host.read_text()
            with self.subTest(host=host.name):
                self.assertIn('#include "ardia/desktop/ac_desktop_webui_process_policy.h"', text)
                self.assertEqual(text.count('"chrome://ardia/"'), 0)
                owned = text.index('SetOwnedWebContents(')
                self.assertRegex(text[owned:owned + 120], r'CreateShellContents\(app_profile[^,]*,\s*private_window\(\)\)')
                self.assertLess(owned, text.index('LoadInitialURL(GURL('))
                self.assertRegex(text, r'LoadInitialURL\(GURL\((ardia::)?desktop_webui_process::kShellUrl\)\)')
                self.assertRegex(text, r'privileged_params =\s*content::WebContents::PrivilegedParams\{\.feature_id = \*feature\}')
                self.assertRegex(text, r'std::make_unique<ShellRecovery>\(')
        for config in (LINUX / 'ac_linux_host.cc', WIN / 'webui/webui_shell.cc'):
            with self.subTest(config=config.name):
                self.assertRegex(config.read_text(), r'DefaultWebUIConfig\((ardia::)?desktop_webui_process::kShellScheme,'
                                                     r'\s*(ardia::)?desktop_webui_process::kShellHost\)')

    def test_linux_resumes_a_recovery_when_a_close_is_cancelled(self):
        text = (LINUX / 'ac_linux_host.cc').read_text()
        self.assertRegex(text, r'if \(!host->close_\.Cancelled\(identity\)\) return;\n\s*'
                               r'if \(host->shell_recovery_\) host->shell_recovery_->Resume\(\);')
        window_state = text[text.index('desktop_webui_process::WindowState ShellHostView::RecoveryWindowState() const {'):]
        window_state = window_state[:window_state.index('\n}\n')]
        self.assertRegex(window_state, r'close_\.Irreversible\(\)\)\s*return desktop_webui_process::WindowState::kGone;')
        self.assertRegex(window_state, r'return closing\(\) \? desktop_webui_process::WindowState::kPaused')

    def test_a_windows_close_is_final(self):
        text = (WIN / 'webui/webui_host_view.cc').read_text()
        self.assertNotIn('WindowState::kPaused', text)
        self.assertNotRegex(text, r'closing_ = false')

    def test_only_the_first_shell_bootstrap_of_the_launch_window_says_startup(self):
        hosts = ((LINUX / 'ac_linux_host.cc', LINUX / 'ac_linux_host.cc', 'host->Bootstrap();', 'NoteAssetServed(AssetPath(url));'),
                 (WIN / 'webui/webui_host_view.cc', WIN / 'webui/webui_shell.cc', 'host->BootstrapJson(),',
                  'host->NoteAssetServed(path);'))
        for host, source, built, served in hosts:
            text = host.read_text()
            with self.subTest(host=host.name):
                self.assertEqual(len(re.findall(r'"startup", launch_bootstrap_\.startup\(\)', text)), 1)
                self.assertNotRegex(text, r'"startup", (startup_|config_\.startup)\)')
                data = source.read_text()
                self.assertEqual(data.count(served), 1)
                self.assertLess(data.index(built), data.index(served))
        header = (WIN / 'webui/webui_host_view.h').read_text()
        self.assertIn('launch_bootstrap_.Served(asset);', header)
        self.assertIn('void NoteAssetServed(std::string_view asset) { launch_bootstrap_.Served(asset); }',
                      (LINUX / 'ac_linux_host.cc').read_text())

    def test_each_host_settles_a_recovery_only_on_a_committed_navigation(self):
        for host in HOSTS:
            text = host_recovery_source(host)
            with self.subTest(host=host.name):
                self.assertNotIn('PrimaryPageChanged', text)
                self.assertEqual(text.count('state_.DocumentCommitted()'), 1)
                self.assertRegex(text, r'if \(handle->HasCommitted\(\) && !handle->IsErrorPage\(\)\) \{\s*'
                                       r'if \(state_\.DocumentCommitted\(\)\)')
                self.assertRegex(text, r'\{\s*state_\.InitialLoadStarted\(\);\s*quit_cancelled_ =')

    def test_each_host_keeps_a_recovery_tally_for_the_next_launch(self):
        hosts = ((LINUX / 'ac_linux_host.cc', 'RotateShellRecoveryDocuments(DocumentDirectory(app_profile));',
                  'base::BindRepeating(&NoteShellRecovery, DocumentDirectory(app_profile))'),
                 (WIN / 'webui/webui_host_view.cc', 'RotateShellRecoveryDocuments();',
                  'base::BindRepeating(&NoteShellRecovery)'))
        for host, rotate, note in hosts:
            text = host.read_text()
            with self.subTest(host=host.name):
                initialize = text[text.index('void ShellHostView::Initialize() {'):]
                initialize = initialize[:initialize.index('\n}\n')]
                self.assertEqual(initialize.count(rotate), 1)
                self.assertLess(initialize.index(rotate), initialize.index('LoadInitialURL('))
                self.assertEqual(text.count(note), 1)
                rotation = text[text.index('void RotateShellRecoveryDocuments('):]
                rotation = rotation[:rotation.index('\n}\n')]
                self.assertIn('static bool rotated = false;', rotation)
                self.assertRegex(rotation, r'RecoveryArchive\(\)\.Rotate\(\s*ReadRecoveryDocument\(directory\),\s*'
                                           r'WriteRecoveryDocument\(directory\)\)')
                noted = text[text.index('void NoteShellRecovery('):]
                noted = noted[:noted.index('\n}\n')]
                self.assertIn('RecoveryTally().Record(outcome);', noted)
                self.assertRegex(noted, r'RecoveryArchive\(\)\.Save\(ReadRecoveryDocument\(directory\),\s*'
                                        r'WriteRecoveryDocument\(directory\), tally\)')
                self.assertIn('RecoveryTally().Json()', noted)
                self.assertNotIn('kShellRecoveryDocument', text)
                self.assertNotIn('kPreviousShellRecoveryDocument', text)
                self.assertEqual(text.count('desktop_webui_process::RecoveryDocuments archive;'), 1)
        linux = (LINUX / 'ac_linux_host.cc').read_text()
        guard = linux[linux.index('if (method == "ArdiaShell.writeDocument" || method == "ArdiaShell.saveDocument" ||'):]
        self.assertIn('desktop_webui_process::ShellRecoveryDocument(name)', guard[:guard.index('return std::move(done)')])
        policy = (WIN / 'webui/webui_policy.h').read_text()
        owned = policy[policy.index('kEngineOwnedWindowsDocumentNames[] = {'):]
        owned = owned[:owned.index('};')]
        for name in ('"shell-recovery.json"', '"shell-recovery-previous.json"', '"launch-guard.json"'):
            self.assertIn(name, owned)

    def test_each_host_disarms_the_launch_bootstrap_before_a_recovery(self):
        for host in HOSTS:
            text = host.read_text()
            with self.subTest(host=host.name):
                made = text.index('std::make_unique<ShellRecovery>(')
                self.assertRegex(text[made:made + 900], r'host->launch_bootstrap_\.NoteRecovery\(\);')

    def test_each_host_waits_out_a_quit_and_resumes_when_it_is_cancelled(self):
        for host in HOSTS:
            text = host_recovery_source(host)
            with self.subTest(host=host.name):
                self.assertIn('chrome::AddClosingAllBrowsersCallback(', text)
                for pattern in (r'const bool shutdown_started = browser_shutdown::HasShutdownStarted\(\);',
                                r'const bool trying_to_quit = browser_shutdown::IsTryingToQuit\(\);',
                                r'ShellWindowState\(\s*shutdown_started, trying_to_quit,\s*window_state_\.Run\(\)\)',
                                r'QuitMayStillBeCancelled\(\s*shutdown_started, trying_to_quit\)',
                                r'quit_poll_\.Start\(',
                                r'void Step\(\) \{\n\s*quit_poll_\.Stop\(\);'):
                    self.assertTrue(re.search(pattern, text), pattern)
                self.assertIn('#include "chrome/browser/lifetime/application_lifetime_desktop.h"', host.read_text())

    @unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
    def test_the_policy_program_passes(self):
        self.compile_and_run((ROOT / 'tests/webui_process_policy_test.cc').read_text())

    @unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
    def test_each_hosts_shell_recovery_runs_against_stubbed_content(self):
        for host in HOSTS:
            with self.subTest(host=host.name):
                self.compile_and_run(HOST_HARNESS.replace('@HOST@', host_recovery_source(host)), '-Wno-unused-parameter')

    def compile_and_run(self, program, *flags):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-webui-process-') as scratch:
            unit = pathlib.Path(scratch, 'program.cc')
            unit.write_text(program)
            binary = pathlib.Path(scratch, 'program')
            built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', *flags, '-I', str(SOURCE),
                                    str(unit), '-o', str(binary)], capture_output=True, text=True, timeout=120)
            self.assertEqual(built.returncode, 0, built.stderr)
            ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stderr)


@unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
class LayoutSyncTests(unittest.TestCase):
    def test_the_layout_and_surface_sync_program_passes(self):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-layout-sync-') as scratch:
            binary = pathlib.Path(scratch, 'layout_sync_test')
            built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-I', str(SOURCE),
                                    str(DESKTOP / 'ac_desktop_layout_sync.cc'), str(ROOT / 'tests/layout_sync_test.cc'),
                                    '-o', str(binary)], capture_output=True, text=True, timeout=180)

            self.assertEqual(built.returncode, 0, built.stderr)
            ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stderr)


class PagerEngineTests(unittest.TestCase):
    def test_the_pager_spring_and_gesture_router_match_the_mac_pager(self):
        compiler = os.environ.get('CXX', 'c++')
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-pager-') as scratch:
            binary = pathlib.Path(scratch, 'pager_engine_test')
            built = subprocess.run([compiler, '-std=c++20', '-Wall', '-Wextra', '-Werror', '-Wconversion', '-Wshadow',
                                    '-I', str(SOURCE), str(ROOT / 'tests' / 'pager_engine_test.cc'), '-o', str(binary)],
                                   capture_output=True, text=True, timeout=180)
            self.assertEqual(built.returncode, 0, built.stderr)
            ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
            self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
            self.assertIn('0 failure(s)', ran.stdout)

    def test_the_pager_constants_match_the_mac_pager(self):
        swift = (REPO / 'packages/ardiacore/ios/Pager.swift').read_text()
        spring = (DESKTOP / 'ac_desktop_pager_spring.h').read_text()
        pairs = {'trackingScale': 'kTrackingScale', 'rubberDimension': 'kRubberDimension',
                 'rubberCoefficient': 'kRubberCoefficient', 'flickVelocity': 'kFlickVelocity',
                 'restDisplacement': 'kRestDisplacement', 'restSpeed': 'kRestSpeed', 'historyWindow': 'kHistoryWindow'}
        for mac, desktop in pairs.items():
            with self.subTest(constant=mac):
                mac_value = float(re.search(rf'private let {mac} = ([0-9.]+)', swift).group(1))
                desktop_value = float(re.search(rf'inline constexpr double {desktop} = ([0-9.]+);', spring).group(1))
                self.assertEqual(mac_value, desktop_value)
        self.assertIn('private let omega = 2 * Double.pi / 0.25', swift)
        self.assertIn('inline constexpr double kOmega = 2 * std::numbers::pi / 0.25;', spring)



def compiler_is_clang(compiler):
    found = subprocess.run([compiler, '--version'], capture_output=True, text=True, timeout=60)
    return 'clang' in found.stdout


@unittest.skipUnless(shutil.which(os.environ.get('CXX', 'c++')), 'no C++ compiler')
class TabRevealTests(unittest.TestCase):
    def build_and_run(self, scratch, name, extra):
        compiler = os.environ.get('CXX', 'c++')
        flags = ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-Wconversion']
        if compiler_is_clang(compiler):
            flags += ['-Wshorten-64-to-32', '-Wunsafe-buffer-usage']
        binary = pathlib.Path(scratch, name)
        built = subprocess.run([compiler, *flags, *extra, '-I', str(SOURCE), str(ROOT / 'tests/tab_reveal_test.cc'), '-o',
                                str(binary)], capture_output=True, text=True, timeout=300)
        self.assertEqual(built.returncode, 0, built.stderr)
        ran = subprocess.run([str(binary)], capture_output=True, text=True, timeout=60)
        self.assertEqual(ran.returncode, 0, ran.stdout + ran.stderr)
        self.assertRegex(ran.stdout, r'^\d+ tests, \d+ checks, 0 failures$')

    def test_the_coordinator_passes_its_unit_tests(self):
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-reveal-') as scratch:
            self.build_and_run(scratch, 'tab_reveal_test', ['-O1'])

    def test_the_coordinator_passes_under_sanitizers(self):
        compiler = os.environ.get('CXX', 'c++')
        sanitize = ['-g', '-fsanitize=address,undefined', '-fno-sanitize-recover=all']
        with tempfile.TemporaryDirectory(prefix='ardia-desktop-reveal-san-') as scratch:
            probe = pathlib.Path(scratch, 'probe.cc')
            probe.write_text('int main() { return 0; }\n')
            linked = subprocess.run([compiler, *sanitize, str(probe), '-o', str(pathlib.Path(scratch, 'probe'))],
                                    capture_output=True, text=True, timeout=120)
            if linked.returncode != 0:
                self.skipTest('the compiler has no address and undefined sanitizers')
            self.build_and_run(scratch, 'tab_reveal_test_sanitized', sanitize)



if __name__ == '__main__':
    unittest.main()
