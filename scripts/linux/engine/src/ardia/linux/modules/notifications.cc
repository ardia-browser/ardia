// Copyright 2026 Ardia. Apache-2.0.

#include <cstring>
#include <map>
#include <optional>
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
#include "base/environment.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "base/uuid.h"
#include "chrome/browser/notifications/notification_display_service.h"
#include "chrome/browser/notifications/notification_display_service_factory.h"
#include "chrome/browser/notifications/notification_handler.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "ui/base/models/image_model.h"
#include "ui/gfx/image/image.h"
#include "ui/message_center/public/cpp/notification.h"
#include "ui/message_center/public/cpp/notification_delegate.h"
#include "ui/message_center/public/cpp/notifier_id.h"
#include "url/gurl.h"

namespace ardia_linux {

namespace {

constexpr char kModule[] = "ArdiaNotifications";
constexpr char kNotifierId[] = "ardia";
constexpr char kPngDataPrefix[] = "data:image/png;base64,";

struct Shown {
  std::string tab_id;
  std::string window_id;
  base::Value data;
};

std::map<std::string, Shown>& ShownNotifications() {
  static base::NoDestructor<std::map<std::string, Shown>> shown;
  return *shown;
}

Profile* OriginalProfile() {
  Profile* profile = ProfileManager::GetLastUsedProfileIfLoaded();
  return profile ? profile->GetOriginalProfile() : nullptr;
}

void Respond(const std::string& id, std::string_view action) {
  auto found = ShownNotifications().find(id);
  if (found == ShownNotifications().end()) {
    return;
  }
  Shown shown = std::move(found->second);
  ShownNotifications().erase(found);
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

class Responder : public message_center::NotificationDelegate {
 public:
  explicit Responder(std::string id) : id_(std::move(id)) {}

  void Click(const std::optional<int>&,
             const std::optional<std::u16string>&) override {
    Respond(id_, "click");
  }

  void Close(bool) override { Respond(id_, "close"); }

 private:
  ~Responder() override = default;
  std::string id_;
};

ui::ImageModel IconOf(const std::string* icon) {
  if (!icon || !base::StartsWith(*icon, kPngDataPrefix)) {
    return ui::ImageModel();
  }
  std::string png;
  if (!base::Base64Decode(std::string_view(*icon).substr(strlen(kPngDataPrefix)),
                          &png)) {
    return ui::ImageModel();
  }
  gfx::Image image = gfx::Image::CreateFrom1xPNGBytes(base::as_byte_span(png));
  return image.IsEmpty() ? ui::ImageModel() : ui::ImageModel::FromImage(image);
}

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
  Profile* profile = OriginalProfile();
  if (!profile) {
    return base::Value();
  }
  NotificationDisplayService* service =
      NotificationDisplayServiceFactory::GetForProfile(profile);
  if (ShownNotifications().contains(id)) {
    ShownNotifications().erase(id);
    service->Close(NotificationHandler::Type::TRANSIENT, id);
  }
  std::vector<std::string> lines;
  for (const char* key : {"subtitle", "body"}) {
    if (const std::string* line = options->FindString(key);
        line && !line->empty()) {
      lines.push_back(*line);
    }
  }
  message_center::RichNotificationData rich;
  rich.silent = options->FindBool("silent").value_or(false);
  message_center::Notification notification(
      message_center::NOTIFICATION_TYPE_SIMPLE, id,
      base::UTF8ToUTF16(title ? *title : std::string()),
      base::UTF8ToUTF16(base::JoinString(lines, "\n")),
      IconOf(options->FindString("icon")), u"Ardia", GURL(),
      message_center::NotifierId(message_center::NotifierType::APPLICATION,
                                 kNotifierId),
      rich, base::MakeRefCounted<Responder>(id));
  Shown shown;
  if (const std::string* tab = options->FindString("tabId")) {
    shown.tab_id = *tab;
  }
  if (const std::string* window = options->FindString("windowId")) {
    shown.window_id = *window;
  }
  if (const base::Value* data = options->Find("data")) {
    shown.data = data->Clone();
  }
  ShownNotifications()[id] = std::move(shown);
  service->Display(NotificationHandler::Type::TRANSIENT, notification,
                   nullptr);
  return base::Value(id);
}

void Remove(const base::ListValue* ids) {
  Profile* profile = OriginalProfile();
  if (!ids || !profile) {
    return;
  }
  NotificationDisplayService* service =
      NotificationDisplayServiceFactory::GetForProfile(profile);
  for (const base::Value& id : *ids) {
    if (const std::string* text = id.GetIfString()) {
      ShownNotifications().erase(*text);
      service->Close(NotificationHandler::Type::TRANSIENT, *text);
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
