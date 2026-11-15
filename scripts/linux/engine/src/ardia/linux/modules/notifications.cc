// Copyright 2026 Ardia. Apache-2.0.

#include <cstring>
#include <map>
#include <optional>
#include <vector>
#include <string>
#include <utility>

#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/modules/args.h"
#include "ardia/linux/modules/desktop_entry.h"
#include "ardia/linux/modules/launch_config.h"
#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/windows/app_window.h"
#include "ardia/linux/windows/app_windows.h"
#include "base/base64.h"
#include "base/files/file_util.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/raw_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "components/dbus/thread_linux/dbus_thread_linux.h"
#include "crypto/hash.h"
#include "dbus/bus.h"
#include "dbus/message.h"
#include "dbus/object_path.h"
#include "dbus/object_proxy.h"
#include "base/environment.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "base/uuid.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaNotifications";
constexpr char kPngDataPrefix[] = "data:image/png;base64,";

constexpr char kFreedesktopName[] = "org.freedesktop.Notifications";
constexpr char kFreedesktopPath[] = "/org/freedesktop/Notifications";
constexpr char kFreedesktopInterface[] = "org.freedesktop.Notifications";
constexpr char kDefaultAction[] = "default";
constexpr int kNotifyTimeoutMs = 5000;

struct Shown {
  std::string tab_id;
  std::string window_id;
  base::Value data;
  uint32_t server_id = 0;
};

std::string EscapedBody(std::string_view text) {
  std::string escaped;
  for (char c : text) {
    switch (c) {
      case '&':
        escaped += "&amp;";
        break;
      case '<':
        escaped += "&lt;";
        break;
      case '>':
        escaped += "&gt;";
        break;
      default:
        escaped += c;
    }
  }
  return escaped;
}

std::optional<std::string> PngOf(const std::string* icon) {
  if (!icon || !base::StartsWith(*icon, kPngDataPrefix)) {
    return std::nullopt;
  }
  std::string png;
  if (!base::Base64Decode(std::string_view(*icon).substr(strlen(kPngDataPrefix)),
                          &png)) {
    return std::nullopt;
  }
  return png;
}

base::FilePath WriteIcon(base::FilePath folder, std::string png) {
  const base::FilePath path =
      folder.Append(base::HexEncodeLower(crypto::hash::Sha256(png)) + ".png");
  if (!base::PathExists(path) &&
      (!base::CreateDirectory(folder) || !base::WriteFile(path, png))) {
    return base::FilePath();
  }
  return path;
}

class Notifier {
 public:
  static Notifier& Get() {
    static base::NoDestructor<Notifier> notifier;
    return *notifier;
  }

  void Post(std::string id, base::DictValue options) {
    if (auto shown = shown_.find(id); shown != shown_.end()) {
      replaces_[id] = shown->second.server_id;
    }
    Shown entry;
    if (const std::string* tab = options.FindString("tabId")) {
      entry.tab_id = *tab;
    }
    if (const std::string* window = options.FindString("windowId")) {
      entry.window_id = *window;
    }
    if (const base::Value* data = options.Find("data")) {
      entry.data = data->Clone();
    }
    shown_[id] = std::move(entry);
    std::optional<std::string> png = PngOf(options.FindString("icon"));
    if (!png) {
      Send(id, std::move(options), base::FilePath());
      return;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&WriteIcon, DataDirectory().Append("Notifications"),
                       std::move(*png)),
        base::BindOnce(&Notifier::Send, base::Unretained(this), id,
                       std::move(options)));
  }

  void Remove(const std::string& id) {
    auto shown = shown_.find(id);
    if (shown == shown_.end()) {
      return;
    }
    const uint32_t server_id = shown->second.server_id;
    shown_.erase(shown);
    if (!server_id || !Proxy()) {
      return;
    }
    by_server_id_.erase(server_id);
    dbus::MethodCall close(kFreedesktopInterface, "CloseNotification");
    dbus::MessageWriter writer(&close);
    writer.AppendUint32(server_id);
    proxy_->CallMethod(&close, kNotifyTimeoutMs, base::DoNothing());
  }

  void Respond(std::string id, std::string_view action) {
    auto found = shown_.find(id);
    if (found == shown_.end()) {
      return;
    }
    Shown shown = std::move(found->second);
    shown_.erase(found);
    by_server_id_.erase(shown.server_id);
    if (action == "click" && !shown.window_id.empty()) {
      if (AppWindow* window = AppWindows::Get().Find(shown.window_id)) {
        window->Focus();
      }
    }
    base::DictValue payload;
    payload.Set("id", id);
    payload.Set("action", action);
    payload.Set("tabId", shown.tab_id.empty() ? base::Value()
                                              : base::Value(shown.tab_id));
    payload.Set("windowId", shown.window_id.empty()
                                ? base::Value()
                                : base::Value(shown.window_id));
    payload.Set("data", std::move(shown.data));
    if (ModuleRegistry::Exists()) {
      ModuleRegistry::Get().Emit(kModule, "onNotificationResponse",
                                 base::Value(std::move(payload)));
    }
  }

 private:
  friend class base::NoDestructor<Notifier>;
  Notifier() = default;

  dbus::ObjectProxy* Proxy() {
    if (proxy_) {
      return proxy_;
    }
    scoped_refptr<dbus::Bus> bus = dbus_thread_linux::GetSharedSessionBus();
    if (!bus) {
      return nullptr;
    }
    proxy_ = bus->GetObjectProxy(kFreedesktopName,
                                 dbus::ObjectPath(kFreedesktopPath));
    proxy_->ConnectToSignal(
        kFreedesktopInterface, "ActionInvoked",
        base::BindRepeating(&Notifier::ActionInvoked, base::Unretained(this)),
        base::DoNothing());
    proxy_->ConnectToSignal(
        kFreedesktopInterface, "NotificationClosed",
        base::BindRepeating(&Notifier::Closed, base::Unretained(this)),
        base::DoNothing());
    return proxy_;
  }

  void Send(std::string id, base::DictValue options, base::FilePath icon) {
    if (!shown_.contains(id) || !Proxy()) {
      return;
    }
    const std::string* title = options.FindString("title");
    std::vector<std::string> lines;
    for (const char* key : {"subtitle", "body"}) {
      if (const std::string* line = options.FindString(key);
          line && !line->empty()) {
        lines.push_back(EscapedBody(*line));
      }
    }
    dbus::MethodCall notify(kFreedesktopInterface, "Notify");
    dbus::MessageWriter writer(&notify);
    writer.AppendString("Ardia");
    uint32_t replaces = 0;
    if (auto replaced = replaces_.find(id); replaced != replaces_.end()) {
      replaces = replaced->second;
      replaces_.erase(replaced);
    }
    writer.AppendUint32(replaces);
    writer.AppendString(icon.empty() ? std::string("ardia") : icon.value());
    writer.AppendString(title ? *title : std::string());
    writer.AppendString(base::JoinString(lines, "\n"));
    writer.AppendArrayOfStrings({kDefaultAction, "Open"});
    dbus::MessageWriter hints(nullptr);
    writer.OpenArray("{sv}", &hints);
    dbus::MessageWriter entry(nullptr);
    hints.OpenDictEntry(&entry);
    entry.AppendString("desktop-entry");
    entry.AppendVariantOfString("ardia");
    hints.CloseContainer(&entry);
    hints.OpenDictEntry(&entry);
    entry.AppendString("urgency");
    entry.AppendVariantOfByte(1);
    hints.CloseContainer(&entry);
    if (options.FindBool("silent").value_or(false)) {
      hints.OpenDictEntry(&entry);
      entry.AppendString("suppress-sound");
      entry.AppendVariantOfBool(true);
      hints.CloseContainer(&entry);
    }
    writer.CloseContainer(&hints);
    writer.AppendInt32(-1);
    proxy_->CallMethod(
        &notify, kNotifyTimeoutMs,
        base::BindOnce(&Notifier::Notified, base::Unretained(this), id));
  }

  void Notified(std::string id, dbus::Response* response) {
    uint32_t server_id = 0;
    if (!response || !dbus::MessageReader(response).PopUint32(&server_id)) {
      Note("notifications", "the notification server didn't take a notification");
      shown_.erase(id);
      return;
    }
    auto shown = shown_.find(id);
    if (shown == shown_.end()) {
      dbus::MethodCall close(kFreedesktopInterface, "CloseNotification");
      dbus::MessageWriter(&close).AppendUint32(server_id);
      proxy_->CallMethod(&close, kNotifyTimeoutMs, base::DoNothing());
      return;
    }
    shown->second.server_id = server_id;
    by_server_id_[server_id] = id;
  }

  void ActionInvoked(dbus::Signal* signal) {
    dbus::MessageReader reader(signal);
    uint32_t server_id = 0;
    std::string action;
    if (!reader.PopUint32(&server_id) || !reader.PopString(&action)) {
      return;
    }
    auto found = by_server_id_.find(server_id);
    if (found != by_server_id_.end()) {
      Respond(found->second, "click");
    }
  }

  void Closed(dbus::Signal* signal) {
    dbus::MessageReader reader(signal);
    uint32_t server_id = 0;
    if (!reader.PopUint32(&server_id)) {
      return;
    }
    auto found = by_server_id_.find(server_id);
    if (found != by_server_id_.end()) {
      Respond(found->second, "close");
    }
  }

  raw_ptr<dbus::ObjectProxy> proxy_ = nullptr;
  std::map<std::string, Shown> shown_;
  std::map<std::string, uint32_t> replaces_;
  std::map<uint32_t, std::string> by_server_id_;
};

ModuleResult Post(const base::DictValue* options) {
  if (!options) {
    return ModuleFailure("postNotification takes options");
  }
  const std::string* given = options->FindString("id");
  const std::string id = given && !given->empty()
                             ? *given
                             : base::Uuid::GenerateRandomV4().AsLowercaseString();
  const std::string* title = options->FindString("title");
  if (CurrentLaunchConfig().background) {
    NoteActivation(base::StrCat(
        {"notification (not shown): \"", title ? *title : std::string(),
         "\""}));
    return base::Value(id);
  }
  Notifier::Get().Post(id, options->Clone());
  return base::Value(id);
}

void Remove(const base::ListValue* ids) {
  if (!ids) {
    return;
  }
  for (const base::Value& id : *ids) {
    if (const std::string* text = id.GetIfString()) {
      Notifier::Get().Remove(*text);
    }
  }
}

void OpenSettings() {
  if (CurrentLaunchConfig().background) {
    return;
  }
  std::unique_ptr<base::Environment> env = base::Environment::Create();
  const std::string desktop =
      base::ToLowerASCII(env->GetVar("XDG_CURRENT_DESKTOP").value_or(""));
  std::vector<std::string> argv =
      desktop.find("kde") != std::string::npos
          ? std::vector<std::string>{"kcmshell6", "kcm_notifications"}
          : std::vector<std::string>{"gnome-control-center", "notifications"};
  base::ThreadPool::PostTask(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(
          [](std::vector<std::string> argv) {
            if (!RunTool(argv, base::Seconds(60)).ok) {
              Note("notifications", "no notification settings app answered");
            }
          },
          std::move(argv)));
}

}

void RegisterNotificationsModule(ModuleRegistry& registry) {
  registry.Define(kModule)
      .Sync("notificationCenterPath", SyncOf([](const base::ListValue&) {
              return ModuleResult(base::Value(""));
            }))
      .Async("notificationPermission", AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value("granted"));
             }))
      .Async("requestNotificationPermission",
             AnswerOf([](const base::ListValue&) {
               return ModuleResult(base::Value(true));
             }))
      .Async("postNotification", AnswerOf([](const base::ListValue& args) {
               return Post(DictArg(args, 0));
             }))
      .Async("removeNotifications", AnswerOf([](const base::ListValue& args) {
               Remove(ListArg(args, 0));
               return ModuleResult(base::Value());
             }))
      .Async("openNotificationSettings", AnswerOf([](const base::ListValue&) {
               OpenSettings();
               return ModuleResult(base::Value());
             }));
}

}
