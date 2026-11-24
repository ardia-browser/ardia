#include "ardia/win/webui/desktop_platform_win.h"

#include <windows.h>

#include <dpapi.h>
#include <dwmapi.h>
#include <shellapi.h>

#include <algorithm>
#include <atomic>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/desktop/ac_desktop_platform.h"
#include "ardia/win/launch_guard.h"
#include "base/base_paths.h"
#include "base/callback_list.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/files/important_file_writer.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/power_monitor/power_monitor.h"
#include "base/power_monitor/power_observer.h"
#include "base/rand_util.h"
#include "base/containers/span.h"
#include "third_party/icu/source/common/unicode/uchar.h"
#include "third_party/icu/source/common/unicode/utf8.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/threading/scoped_blocking_call.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "base/win/registry.h"
#include "chrome/browser/shell_integration.h"
#include "ui/aura/window.h"
#include "ui/aura/window_tree_host.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

namespace ardia_win {

namespace {

using ardia::desktop::PlatformCall;
using ardia::desktop::PlatformCapability;
using ardia::desktop::PlatformReply;
using ardia::desktop::SecretStatus;

constexpr wchar_t kRunKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Run";
constexpr wchar_t kStartupApprovedKey[] =
    L"Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run";
constexpr wchar_t kPersonalizeKey[] = L"Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize";
constexpr wchar_t kDefaultAppsPage[] = L"ms-settings:defaultapps";
constexpr char kSecretPurpose[] = "ardia-sync-key/v1";
constexpr char kTestInstancePurpose[] = "/test-instance";
constexpr size_t kSecretLimit = 4096;
constexpr size_t kSealedLimit = 64 * 1024;
constexpr base::TimeDelta kPowerSampleInterval = base::Seconds(10);

constexpr std::string_view kExternalSchemes[] = {"http", "https", "mailto"};

std::atomic<int> g_external_opens{0};
std::atomic<int> g_default_apps_opens{0};

void Fail(PlatformReply done, std::string_view code, std::string_view message) {
  std::move(done).Run(false, base::Value(base::DictValue().Set("code", code).Set("message", message)));
}

HWND WidgetWindow(views::Widget* widget) {
  if (!widget || !widget->GetNativeWindow() || !widget->GetNativeWindow()->GetHost()) {
    return nullptr;
  }
  return widget->GetNativeWindow()->GetHost()->GetAcceleratedWidget();
}

bool Lists(const auto& methods, std::string_view method) {
  return std::ranges::any_of(methods, [method](std::string_view listed) { return method == listed; });
}

scoped_refptr<base::SingleThreadTaskRunner> ShellWorker() {
  static base::NoDestructor<scoped_refptr<base::SingleThreadTaskRunner>> worker(
      base::ThreadPool::CreateCOMSTATaskRunner({base::MayBlock(), base::TaskPriority::USER_VISIBLE,
                                                base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN}));
  return *worker;
}

void Wipe(std::string& bytes) {
  if (!bytes.empty()) {
    SecureZeroMemory(bytes.data(), bytes.size());
  }
  bytes.clear();
}

void Wipe(std::vector<uint8_t>& bytes) {
  if (!bytes.empty()) {
    SecureZeroMemory(bytes.data(), bytes.size());
  }
  bytes.clear();
}

std::string PurposeFor(std::string_view account, bool test_instance) {
  std::string purpose(kSecretPurpose);
  if (test_instance) {
    purpose += kTestInstancePurpose;
  }
  purpose += "/";
  purpose += account;
  return purpose;
}

std::optional<std::string> Seal(const std::vector<uint8_t>& secret, std::string purpose) {
  DATA_BLOB plain{static_cast<DWORD>(secret.size()), const_cast<BYTE*>(secret.data())};
  DATA_BLOB extra{static_cast<DWORD>(purpose.size()), reinterpret_cast<BYTE*>(purpose.data())};
  DATA_BLOB sealed{};
  if (!::CryptProtectData(&plain, L"Ardia sync key", &extra, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN,
                          &sealed)) {
    return std::nullopt;
  }
  std::string bytes(reinterpret_cast<const char*>(sealed.pbData), sealed.cbData);
  ::LocalFree(sealed.pbData);
  return bytes;
}

bool Unseal(std::string& sealed_bytes, std::string purpose, std::vector<uint8_t>* secret) {
  DATA_BLOB sealed{static_cast<DWORD>(sealed_bytes.size()), reinterpret_cast<BYTE*>(sealed_bytes.data())};
  DATA_BLOB extra{static_cast<DWORD>(purpose.size()), reinterpret_cast<BYTE*>(purpose.data())};
  DATA_BLOB plain{};
  if (!::CryptUnprotectData(&sealed, nullptr, &extra, nullptr, nullptr, CRYPTPROTECT_UI_FORBIDDEN, &plain)) {
    return false;
  }
  const bool fits = plain.cbData <= kSecretLimit;
  if (fits) {
    secret->assign(plain.pbData, plain.pbData + plain.cbData);
  }
  SecureZeroMemory(plain.pbData, plain.cbData);
  ::LocalFree(plain.pbData);
  return fits;
}

class DpapiSecretStore final : public ardia::desktop::SecretStore {
 public:
  explicit DpapiSecretStore(base::FilePath directory) : directory_(std::move(directory)) {}

  std::string_view kind() const override { return "dpapi"; }

  SecretStatus Load(std::string_view account, std::vector<uint8_t>* secret) override {
    if (!secret || !SecretAccountAllowed(account)) {
      return SecretStatus::kUnavailable;
    }
    base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
    std::string sealed;
    if (!base::PathExists(PathFor(account))) {
      return SecretStatus::kNotFound;
    }
    if (!base::ReadFileToStringWithMaxSize(PathFor(account), &sealed, kSealedLimit)) {
      return SecretStatus::kUnavailable;
    }
    std::vector<uint8_t> plain;
    const bool opened = Unseal(sealed, Purpose(account), &plain);
    if (!opened) {
      Wipe(plain);
      return SecretStatus::kLocked;
    }
    Wipe(*secret);
    *secret = std::move(plain);
    return SecretStatus::kOk;
  }

  SecretStatus Save(std::string_view account, const std::vector<uint8_t>& secret) override {
    if (!SecretAccountAllowed(account) || secret.empty() || secret.size() > kSecretLimit) {
      return SecretStatus::kUnavailable;
    }
    base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
    std::optional<std::string> sealed = Seal(secret, Purpose(account));
    if (!sealed) {
      return SecretStatus::kLocked;
    }
    const bool written = base::CreateDirectory(directory_) &&
                         base::ImportantFileWriter::WriteFileAtomically(PathFor(account), *sealed);
    return written ? SecretStatus::kOk : SecretStatus::kUnavailable;
  }

  SecretStatus Delete(std::string_view account) override {
    if (!SecretAccountAllowed(account)) {
      return SecretStatus::kUnavailable;
    }
    base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
    const base::FilePath path = PathFor(account);
    if (!base::PathExists(path)) {
      return SecretStatus::kNotFound;
    }
    return base::DeleteFile(path) ? SecretStatus::kOk : SecretStatus::kUnavailable;
  }

  SecretStatus Probe() override {
    std::vector<uint8_t> probe = base::RandBytesAsVector(32);
    std::optional<std::string> sealed = Seal(probe, Purpose("probe"));
    if (!sealed) {
      Wipe(probe);
      return SecretStatus::kLocked;
    }
    std::vector<uint8_t> opened;
    const bool same = Unseal(*sealed, Purpose("probe"), &opened) && opened == probe;
    Wipe(probe);
    Wipe(opened);
    return same ? SecretStatus::kOk : SecretStatus::kUnavailable;
  }

  base::FilePath PathFor(std::string_view account) const {
    return directory_.Append(base::UTF8ToWide(SecretFileName(account)));
  }

  static std::string Purpose(std::string_view account) { return PurposeFor(account, ardiacore::TestInstance()); }

 private:
  base::FilePath directory_;
};

bool DefaultBrowserNow() {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  return shell_integration::GetDefaultBrowser() == shell_integration::IS_DEFAULT;
}

bool OpenWithShell(std::wstring target) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  SHELLEXECUTEINFOW info{};
  info.cbSize = sizeof(info);
  info.fMask = SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI;
  info.lpVerb = L"open";
  info.lpFile = target.c_str();
  info.nShow = SW_SHOWNORMAL;
  return ::ShellExecuteExW(&info) != FALSE;
}

std::optional<std::wstring> RunValue() {
  base::win::RegKey key(HKEY_CURRENT_USER, kRunKey, KEY_QUERY_VALUE);
  std::wstring value;
  if (!key.Valid() || key.ReadValue(kLoginItemValue, &value) != ERROR_SUCCESS) {
    return std::nullopt;
  }
  return value;
}

bool StartupDisabledByUser() {
  base::win::RegKey key(HKEY_CURRENT_USER, kStartupApprovedKey, KEY_QUERY_VALUE);
  BYTE state[12]{};
  DWORD size = sizeof(state);
  DWORD type = 0;
  if (!key.Valid() || key.ReadValue(kLoginItemValue, state, &size, &type) != ERROR_SUCCESS || type != REG_BINARY) {
    return false;
  }
  return size > 0 && (state[0] & 1) != 0;
}

base::FilePath Executable() {
  base::FilePath executable;
  if (!base::PathService::Get(base::FILE_EXE, &executable) || !executable.IsAbsolute()) {
    return base::FilePath();
  }
  return executable;
}

std::string LaunchAtLoginStatus() {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  const std::optional<std::wstring> expected = LoginItemCommand(Executable());
  if (!expected) {
    return "notFound";
  }
  const std::optional<std::wstring> stored = RunValue();
  if (!stored || *stored != *expected) {
    return "notRegistered";
  }
  return StartupDisabledByUser() ? "requiresApproval" : "enabled";
}

LONG SetLaunchAtLogin(bool enabled) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  base::win::RegKey key(HKEY_CURRENT_USER, kRunKey, KEY_SET_VALUE | KEY_QUERY_VALUE);
  if (!key.Valid()) {
    return ERROR_ACCESS_DENIED;
  }
  if (!enabled) {
    const LONG removed = key.DeleteValue(kLoginItemValue);
    return removed == ERROR_FILE_NOT_FOUND ? ERROR_SUCCESS : removed;
  }
  const std::optional<std::wstring> command = LoginItemCommand(Executable());
  if (!command) {
    return ERROR_FILE_NOT_FOUND;
  }
  return key.WriteValue(kLoginItemValue, command->c_str());
}

void InvokeDefaultBrowser(std::string_view method, const base::ListValue& args, PlatformReply done) {
  if (!args.empty()) {
    return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "The default browser calls take no arguments");
  }
  const bool changing = method == "ArdiaSystem.setAsDefaultBrowser";
  if (changing && ardiacore::BackgroundInstance()) {
    LOG(INFO) << "Ardia background instance: not opening the default apps page";
    return std::move(done).Run(true, base::Value(false));
  }
  ShellWorker()->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce([](bool changing) {
        if (changing) {
          g_default_apps_opens.fetch_add(1, std::memory_order_relaxed);
          if (!OpenWithShell(kDefaultAppsPage)) {
            LOG(WARNING) << "Ardia: the default apps page did not open";
          }
        }
        return DefaultBrowserNow();
      }, changing),
      base::BindOnce([](PlatformReply done, bool is_default) { std::move(done).Run(true, base::Value(is_default)); },
                     std::move(done)));
}

void InvokeLoginItem(std::string_view method, const base::ListValue& args, PlatformReply done) {
  if (method == "ArdiaSystem.launchAtLoginStatus") {
    if (!args.empty()) {
      return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "The login status takes no arguments");
    }
    ShellWorker()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&LaunchAtLoginStatus),
        base::BindOnce([](PlatformReply done, std::string status) { std::move(done).Run(true, base::Value(status)); },
                       std::move(done)));
    return;
  }
  if (args.size() != 1 || !args[0].is_bool()) {
    return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "Opening at login takes one boolean");
  }
  if (ardiacore::BackgroundInstance()) {
    LOG(INFO) << "Ardia background instance: not changing launch at login";
    return std::move(done).Run(true, base::Value());
  }
  ShellWorker()->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce(&SetLaunchAtLogin, args[0].GetBool()),
      base::BindOnce([](PlatformReply done, LONG result) {
        if (result != ERROR_SUCCESS) {
          return Fail(std::move(done), "ERR_LOGIN_ITEM",
                      "Opening at login could not be changed (" + base::NumberToString(result) + ")");
        }
        std::move(done).Run(true, base::Value());
      }, std::move(done)));
}

void InvokeOpenExternal(const base::ListValue& args, PlatformReply done) {
  if (args.size() != 1 || !args[0].is_string()) {
    return Fail(std::move(done), "ERR_SYSTEM_REQUEST", "A URL is required");
  }
  if (!ExternalUrlAllowed(args[0].GetString())) {
    return std::move(done).Run(true, base::Value(false));
  }
  const GURL url(args[0].GetString());
  if (ardiacore::BackgroundInstance()) {
    LOG(INFO) << "Ardia background instance: not opening a " << url.scheme() << " link in another app";
    return std::move(done).Run(true, base::Value(false));
  }
  ShellWorker()->PostTaskAndReplyWithResult(
      FROM_HERE, base::BindOnce([](std::wstring target) {
        g_external_opens.fetch_add(1, std::memory_order_relaxed);
        return OpenWithShell(std::move(target));
      }, base::UTF8ToWide(url.spec())),
      base::BindOnce([](PlatformReply done, bool opened) { std::move(done).Run(true, base::Value(opened)); },
                     std::move(done)));
}

base::DictValue SamplePower() {
  SYSTEM_POWER_STATUS power{};
  const bool known = ::GetSystemPowerStatus(&power) != FALSE;
  const bool battery = known && power.BatteryFlag != 128 && power.BatteryFlag != 255 &&
                       power.BatteryLifePercent <= 100;
  MEMORYSTATUSEX memory{};
  memory.dwLength = sizeof(memory);
  const bool measured = ::GlobalMemoryStatusEx(&memory) != FALSE;
  const double physical = measured ? static_cast<double>(memory.ullTotalPhys) : 0;
  const double available = measured ? static_cast<double>(memory.ullAvailPhys) : 0;
  const double free_share = physical > 0 ? available / physical : 1;
  const char* pressure = free_share < 0.05 ? "critical" : free_share < 0.10 ? "warning" : "normal";
  return base::DictValue()
      .Set("onBattery", known && power.ACLineStatus == 0)
      .Set("batteryLevel", battery ? base::Value(power.BatteryLifePercent / 100.0) : base::Value())
      .Set("lowPowerMode", known && power.SystemStatusFlag == 1)
      .Set("memoryPressure", pressure)
      .Set("memorySignal", "globalmemorystatus")
      .Set("physicalMemory", physical)
      .Set("power", known ? "windows" : "unavailable")
      .Set("battery", !known ? "unavailable" : battery ? "present" : "absent");
}

class WinPowerMonitor final : public base::PowerSuspendObserver {
 public:
  static WinPowerMonitor& Get() {
    static base::NoDestructor<WinPowerMonitor> monitor;
    return *monitor;
  }

  base::DictValue Current() {
    Start();
    if (!state_) {
      state_ = SamplePower();
    }
    return state_->Clone();
  }

  base::CallbackListSubscription Subscribe(ardia::desktop::DesktopPlatform::PowerListener listener) {
    Start();
    return listeners_.Add(std::move(listener));
  }

  void OnSuspend() override { suspended_ = true; }

  void OnResume() override {
    suspended_ = false;
    Sample();
  }

 private:
  void Start() {
    if (std::exchange(started_, true)) {
      return;
    }
    if (base::PowerMonitor* power = base::PowerMonitor::GetInstance(); power && power->IsInitialized()) {
      power->AddPowerSuspendObserver(this);
    }
    timer_.Start(FROM_HERE, kPowerSampleInterval,
                 base::BindRepeating(&WinPowerMonitor::Sample, base::Unretained(this)));
  }

  void Sample() {
    if (suspended_) {
      return;
    }
    base::DictValue next = SamplePower();
    if (state_ && *state_ == next) {
      return;
    }
    state_ = std::move(next);
    listeners_.Notify(*state_);
  }

  bool started_ = false;
  bool suspended_ = false;
  std::optional<base::DictValue> state_;
  base::RepeatingTimer timer_;
  base::RepeatingCallbackList<void(const base::DictValue&)> listeners_;
};

class WinDesktopPlatform final : public ardia::desktop::DesktopPlatform {
 public:
  std::optional<PlatformCapability> CapabilityFor(std::string_view method) const override {
    if (Lists(kDefaultBrowserCalls, method)) return PlatformCapability::kDefaultBrowser;
    if (Lists(kLoginItemCalls, method)) return PlatformCapability::kLoginItem;
    if (Lists(kOpenExternalCalls, method)) return PlatformCapability::kOpenExternal;
    return std::nullopt;
  }

  void Invoke(PlatformCapability capability, const PlatformCall& call, PlatformReply done) override {
    switch (capability) {
      case PlatformCapability::kDefaultBrowser:
        return InvokeDefaultBrowser(call.method, call.args, std::move(done));
      case PlatformCapability::kLoginItem:
        return InvokeLoginItem(call.method, call.args, std::move(done));
      case PlatformCapability::kOpenExternal:
        return InvokeOpenExternal(call.args, std::move(done));
      case PlatformCapability::kSecrets:
      case PlatformCapability::kReauth:
      case PlatformCapability::kCalendar:
      case PlatformCapability::kLocation:
      case PlatformCapability::kPower:
      case PlatformCapability::kSelfUpdate:
      case PlatformCapability::kWindowDecorations:
        break;
    }
    Fail(std::move(done), "ERR_UNAVAILABLE", "This call isn't available on Windows yet");
  }

  std::unique_ptr<ardia::desktop::SecretStore> OpenSecretStore(const base::FilePath& file_store_directory) override {
    const base::FilePath directory = file_store_directory.empty() ? SecretDirectory() : file_store_directory;
    if (directory.empty() || !directory.IsAbsolute()) {
      return nullptr;
    }
    return std::make_unique<DpapiSecretStore>(directory);
  }

  void InstallReauth() override {}

  void InstallLocationProvider() override {}

  void CurrentPower(base::OnceCallback<void(base::DictValue)> done) override {
    std::move(done).Run(WinPowerMonitor::Get().Current());
  }

  base::CallbackListSubscription WatchPower(PowerListener listener) override {
    return WinPowerMonitor::Get().Subscribe(std::move(listener));
  }

  bool StartWindowMove(views::Widget* widget) override {
    const HWND window = WidgetWindow(widget);
    if (!window || (::GetAsyncKeyState(VK_LBUTTON) & 0x8000) == 0) {
      return false;
    }
    ::ReleaseCapture();
    ::PostMessageW(window, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0);
    return true;
  }

  bool CaptionDoubleClick(views::Widget* widget) override {
    if (!widget) {
      return false;
    }
    if (widget->IsMaximized()) {
      widget->Restore();
    } else {
      widget->Maximize();
    }
    return true;
  }
};

}

bool SystemPrefersDark() {
  base::win::RegKey key(HKEY_CURRENT_USER, kPersonalizeKey, KEY_QUERY_VALUE);
  DWORD light = 1;
  return key.Valid() && key.ReadValueDW(L"AppsUseLightTheme", &light) == ERROR_SUCCESS && light == 0;
}

ShellDecorations ApplyShellDecorations(HWND window) {
  ShellDecorations applied;
  if (!window) {
    return applied;
  }
  applied.dark = SystemPrefersDark();
  const BOOL dark = applied.dark ? TRUE : FALSE;
  applied.dark_title = ::DwmSetWindowAttribute(window, DWMWA_USE_IMMERSIVE_DARK_MODE, &dark, sizeof(dark));
  const DWM_WINDOW_CORNER_PREFERENCE corners = DWMWCP_ROUND;
  applied.corners = ::DwmSetWindowAttribute(window, DWMWA_WINDOW_CORNER_PREFERENCE, &corners, sizeof(corners));
  const DWM_SYSTEMBACKDROP_TYPE backdrop = DWMSBT_MAINWINDOW;
  applied.backdrop = ::DwmSetWindowAttribute(window, DWMWA_SYSTEMBACKDROP_TYPE, &backdrop, sizeof(backdrop));
  return applied;
}

bool PlainCodePoints(std::string_view text) {
  const auto* bytes = reinterpret_cast<const uint8_t*>(text.data());
  const int32_t length = static_cast<int32_t>(text.size());
  int32_t offset = 0;
  while (offset < length) {
    UChar32 point = 0;
    U8_NEXT(bytes, offset, length, point);
    if (point < 0 || point == 0xfffd) {
      return false;
    }
    switch (u_charType(point)) {
      case U_CONTROL_CHAR:
      case U_FORMAT_CHAR:
      case U_SPACE_SEPARATOR:
      case U_LINE_SEPARATOR:
      case U_PARAGRAPH_SEPARATOR:
      case U_SURROGATE:
      case U_PRIVATE_USE_CHAR:
      case U_UNASSIGNED:
        return false;
      default:
        break;
    }
  }
  return true;
}

bool RawUserInfo(std::string_view text) {
  const std::string lowered = base::ToLowerASCII(text.substr(0, 8));
  const size_t start = lowered.starts_with("https://") ? 8 : lowered.starts_with("http://") ? 7 : 0;
  if (!start) {
    return false;
  }
  const std::string_view rest = text.substr(start);
  const std::string_view authority = rest.substr(0, rest.find_first_of("/?#"));
  return authority.find('@') != std::string_view::npos;
}

bool ExternalUrlAllowed(std::string_view text) {
  if (text.empty() || text.size() > kExternalUrlLimit) {
    return false;
  }
  for (const char c : text) {
    const unsigned char byte = static_cast<unsigned char>(c);
    if (byte <= 0x20 || byte == 0x7f || c == '"' || c == '\'' || c == '\\') {
      return false;
    }
  }
  if (!PlainCodePoints(text) || RawUserInfo(text)) {
    return false;
  }
  const GURL url(text);
  if (!url.is_valid() || url.spec().size() > kExternalUrlLimit) {
    return false;
  }
  const std::string scheme(url.scheme());
  if (scheme.empty() || scheme.size() > 64) {
    return false;
  }
  if (std::ranges::none_of(kExternalSchemes, [&scheme](std::string_view allowed) { return scheme == allowed; })) {
    return false;
  }
  if (url.SchemeIsHTTPOrHTTPS() && (!url.has_host() || url.has_username() || url.has_password())) {
    return false;
  }
  if (url.SchemeIsHTTPOrHTTPS()) {
    const std::string raw = base::ToLowerASCII(text);
    const size_t after = scheme.size() + 3;
    if (raw.compare(0, after, scheme + "://") != 0 || raw.size() <= after || raw[after] == '/') {
      return false;
    }
  }
  const std::string host(url.host());
  const std::string path(url.path());
  if (host.find('\\') != std::string::npos || path.starts_with("\\\\")) {
    return false;
  }
  return true;
}

std::string SecretFileName(std::string_view account) {
  return "sync-key-x" + base::ToLowerASCII(base::HexEncode(base::as_byte_span(account))) + ".dpapi";
}

int ExternalOpenCount() {
  return g_external_opens.load(std::memory_order_relaxed);
}

int DefaultAppsOpenCount() {
  return g_default_apps_opens.load(std::memory_order_relaxed);
}

bool SecretAccountAllowed(std::string_view account) {
  if (account.empty() || account.size() > 64) {
    return false;
  }
  return std::ranges::all_of(account, [](char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
  });
}

std::optional<std::wstring> LoginItemCommand(const base::FilePath& executable) {
  const std::wstring& path = executable.value();
  if (path.empty() || !executable.IsAbsolute() || path.find(L'"') != std::wstring::npos ||
      std::ranges::any_of(path, [](wchar_t c) { return c < 0x20; })) {
    return std::nullopt;
  }
  return L"\"" + path + L"\" --ardia-shell=webui";
}

base::FilePath SecretDirectory() {
  const std::wstring data = AppDataDirectory();
  if (data.empty()) {
    return base::FilePath();
  }
  return base::FilePath(data).Append(L"Sync");
}

base::DictValue SecretRoundTrip() {
  std::unique_ptr<ardia::desktop::SecretStore> store = ardia::desktop::Platform().OpenSecretStore(base::FilePath());
  if (!store) {
    return base::DictValue().Set("opened", false);
  }
  auto* dpapi = static_cast<DpapiSecretStore*>(store.get());
  std::vector<uint8_t> secret = base::RandBytesAsVector(32);
  const std::string account = "self-check-" + base::HexEncode(base::RandBytesAsVector(5));
  const SecretStatus saved = store->Save(account, secret);
  std::vector<uint8_t> loaded;
  const SecretStatus read = store->Load(account, &loaded);
  std::string sealed;
  base::ReadFileToStringWithMaxSize(dpapi->PathFor(account), &sealed, kSealedLimit);
  const bool hidden = !sealed.empty() &&
                      std::string_view(sealed).find(std::string_view(reinterpret_cast<const char*>(secret.data()),
                                                                     secret.size())) == std::string_view::npos;
  std::vector<uint8_t> other;
  const bool bound = !sealed.empty() && !Unseal(sealed, PurposeFor(account + "-other", ardiacore::TestInstance()), &other);
  const bool apart = !sealed.empty() && !Unseal(sealed, PurposeFor(account, !ardiacore::TestInstance()), &other);
  const bool rejects_path = store->Save("..\\escape", secret) == SecretStatus::kUnavailable;
  const SecretStatus deleted = store->Delete(account);
  const bool gone = !base::PathExists(dpapi->PathFor(account));
  std::vector<uint8_t> lower_secret = base::RandBytesAsVector(32);
  std::vector<uint8_t> upper_secret = base::RandBytesAsVector(32);
  std::vector<uint8_t> lower_read;
  std::vector<uint8_t> upper_read;
  const bool both_saved = store->Save("caseTest", lower_secret) == SecretStatus::kOk &&
                          store->Save("CaseTest", upper_secret) == SecretStatus::kOk;
  const bool both_read = store->Load("caseTest", &lower_read) == SecretStatus::kOk && lower_read == lower_secret &&
                         store->Load("CaseTest", &upper_read) == SecretStatus::kOk && upper_read == upper_secret;
  const bool lower_deleted = store->Delete("caseTest") == SecretStatus::kOk;
  Wipe(upper_read);
  const bool upper_survives = store->Load("CaseTest", &upper_read) == SecretStatus::kOk && upper_read == upper_secret &&
                              store->Load("caseTest", &lower_read) == SecretStatus::kNotFound;
  const bool upper_deleted = store->Delete("CaseTest") == SecretStatus::kOk;
  const bool case_independent = both_saved && both_read && lower_deleted && upper_survives && upper_deleted &&
                                dpapi->PathFor("caseTest") != dpapi->PathFor("CaseTest");
  base::DictValue report = base::DictValue()
      .Set("opened", true)
      .Set("kind", std::string(store->kind()))
      .Set("directory", base::WideToUTF8(SecretDirectory().value()))
      .Set("probe", store->Probe() == SecretStatus::kOk)
      .Set("saved", saved == SecretStatus::kOk)
      .Set("same", read == SecretStatus::kOk && loaded == secret)
      .Set("hidden", hidden)
      .Set("boundToPurpose", bound)
      .Set("apartFromOtherInstances", apart)
      .Set("rejectsPathAccount", rejects_path)
      .Set("deleted", deleted == SecretStatus::kOk && gone)
      .Set("caseIndependent", case_independent)
      .Set("caseFiles", base::DictValue()
                            .Set("lower", SecretFileName("caseTest"))
                            .Set("upper", SecretFileName("CaseTest")));
  Wipe(secret);
  Wipe(loaded);
  Wipe(other);
  Wipe(sealed);
  Wipe(lower_secret);
  Wipe(upper_secret);
  Wipe(lower_read);
  Wipe(upper_read);
  return report;
}

}

namespace ardia::desktop {

std::unique_ptr<DesktopPlatform> CreateDesktopPlatform() {
  return std::make_unique<ardia_win::WinDesktopPlatform>();
}

}
