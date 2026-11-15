// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/prompts/prompts.h"

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <variant>
#include <vector>

#include "ardia/core/ac_hooks.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/win/tab_state.h"
#include "base/functional/bind.h"
#include "base/memory/ptr_util.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/task/single_thread_task_runner.h"
#include "chrome/browser/file_system_access/file_system_access_permission_request_manager.h"
#include "chrome/browser/permissions/system/system_permission_settings.h"
#include "components/permissions/embedded_permission_prompt_flow_model.h"
#include "components/permissions/permission_prompt.h"
#include "components/permissions/permission_request.h"
#include "components/permissions/permission_uma_constants.h"
#include "components/permissions/permission_util.h"
#include "components/permissions/request_type.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "url/origin.h"

namespace ardia_linux {

namespace {

const char* KindName(permissions::RequestType type) {
  using permissions::RequestType;
  switch (type) {
    case RequestType::kCameraStream:
      return "camera";
    case RequestType::kMicStream:
      return "microphone";
    case RequestType::kCameraPanTiltZoom:
      return "cameraPanTiltZoom";
    case RequestType::kGeolocation:
      return "location";
    case RequestType::kNotifications:
      return "notifications";
    case RequestType::kClipboard:
      return "clipboard";
    case RequestType::kMidiSysex:
      return "midi";
    case RequestType::kMultipleDownloads:
      return "multipleDownloads";
    case RequestType::kLocalFonts:
      return "localFonts";
    case RequestType::kIdleDetection:
      return "idleDetection";
    case RequestType::kStorageAccess:
    case RequestType::kTopLevelStorageAccess:
      return "storageAccess";
    case RequestType::kWindowManagement:
      return "windowManagement";
    case RequestType::kFileSystemAccess:
      return "fileSystem";
    case RequestType::kKeyboardLock:
      return "keyboardLock";
    case RequestType::kPointerLock:
      return "pointerLock";
    case RequestType::kRegisterProtocolHandler:
      return "protocolHandler";
    case RequestType::kSensors:
      return "sensors";
    case RequestType::kLocalNetwork:
    case RequestType::kLoopbackNetwork:
      return "localNetwork";
    case RequestType::kVrSession:
      return "vr";
    case RequestType::kArSession:
      return "ar";
    case RequestType::kHandTracking:
      return "handTracking";
    case RequestType::kIdentityProvider:
      return "identityProvider";
    case RequestType::kWebAppInstallation:
      return "webAppInstallation";
    case RequestType::kCapturedSurfaceControl:
      return "capturedSurfaceControl";
    case RequestType::kDiskQuota:
      return "diskQuota";
    default:
      return nullptr;
  }
}

std::string KeyOf(content::WebContents* contents) {
  ardia_win::TabState* state =
      contents ? ardia_win::TabState::FromWebContents(contents) : nullptr;
  return state ? state->key() : std::string();
}

bool HostedTab(content::WebContents* contents) {
  return !KeyOf(contents).empty();
}

void AskHost(content::WebContents* contents, base::DictValue request) {
  const std::string key = KeyOf(contents);
  request.Set("tabId", key.empty() ? base::Value() : base::Value(key));
  CountLinux("permissionPrompts");
  EmitDomainEvent("permissions", "requested", base::Value(std::move(request)));
}

void TellDismissed(const std::string& id) {
  base::DictValue data;
  data.Set("id", id);
  EmitDomainEvent("permissions", "dismissed", base::Value(std::move(data)));
}

class PermissionPrompt;

std::map<std::string, base::WeakPtr<PermissionPrompt>>& Prompts() {
  static base::NoDestructor<
      std::map<std::string, base::WeakPtr<PermissionPrompt>>>
      prompts;
  return *prompts;
}

using Variant = permissions::EmbeddedPermissionPromptFlowModel::Variant;

enum class Step { kAsk, kAlreadyAllowed, kSystemPrompt, kAcknowledge };

Step StepOf(permissions::PermissionPrompt::Delegate* delegate) {
  permissions::EmbeddedPermissionPromptFlowModel* flow =
      delegate->GetEmbeddedPromptFlowModel();
  if (!flow) {
    return Step::kAsk;
  }
  const bool later_step = delegate->WasCurrentRequestAlreadyDisplayed();
  switch (flow->prompt_variant()) {
    case Variant::kOsPrompt:
      return Step::kSystemPrompt;
    case Variant::kAsk:
    case Variant::kPreviouslyDenied:
      return later_step ? Step::kAcknowledge : Step::kAsk;
    case Variant::kPreviouslyGranted:
      return later_step ? Step::kAcknowledge : Step::kAlreadyAllowed;
    case Variant::kOsSystemSettings:
    case Variant::kAdministratorGranted:
    case Variant::kAdministratorDenied:
    case Variant::kUninitialized:
      return Step::kAcknowledge;
  }
  return Step::kAcknowledge;
}

std::string NextId(char prefix) {
  static int last_id = 0;
  return std::string(1, prefix) + std::to_string(++last_id);
}

class PermissionPrompt : public permissions::PermissionPrompt {
 public:
  PermissionPrompt(content::WebContents* contents, Delegate* delegate)
      : delegate_(delegate), step_(StepOf(delegate)), id_(NextId('p')) {
    Prompts()[id_] = weak_factory_.GetWeakPtr();
    switch (step_) {
      case Step::kAsk:
      case Step::kAlreadyAllowed:
        Ask(contents);
        break;
      case Step::kSystemPrompt:
        PostToSelf(&PermissionPrompt::AskSystem);
        break;
      case Step::kAcknowledge:
        PostToSelf(&PermissionPrompt::Acknowledge);
        break;
    }
  }

  ~PermissionPrompt() override {
    Prompts().erase(id_);
    if (asked_host_ && !answered_) {
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
          FROM_HERE, base::BindOnce(&TellDismissed, id_));
    }
  }

  void Resolve(const std::string& result, bool remember) {
    if (!asked_host_ || answered_) {
      return;
    }
    answered_ = true;
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&PermissionPrompt::Apply,
                                  weak_factory_.GetWeakPtr(), result,
                                  remember));
  }

  bool UpdateAnchor() override { return true; }
  TabSwitchingBehavior GetTabSwitchingBehavior() override {
    return TabSwitchingBehavior::kKeepPromptAlive;
  }
  permissions::PermissionPromptDisposition GetPromptDisposition()
      const override {
    return permissions::PermissionPromptDisposition::CUSTOM_MODAL_DIALOG;
  }
  bool IsAskPrompt() const override { return step_ == Step::kAsk; }
  std::optional<gfx::Rect> GetViewBoundsInScreen() const override {
    return std::nullopt;
  }
  std::vector<permissions::ElementAnchoredBubbleVariant> GetPromptVariants()
      const override {
    return {};
  }
  std::optional<permissions::feature_params::PermissionElementPromptPosition>
  GetPromptPosition() const override {
    return std::nullopt;
  }

 private:
  void Ask(content::WebContents* contents) {
    asked_host_ = true;
    base::ListValue kinds;
    for (const auto& request : delegate_->Requests()) {
      const char* kind = KindName(request->request_type());
      if (kind && !kinds.contains(kind)) {
        kinds.Append(kind);
      }
    }
    base::DictValue request;
    request.Set("id", id_);
    request.Set("origin", delegate_->GetRequestingOrigin().spec());
    request.Set("permissions", std::move(kinds));
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(
            [](base::WeakPtr<PermissionPrompt> prompt,
               base::WeakPtr<content::WebContents> contents,
               base::DictValue request) {
              if (prompt && contents) {
                AskHost(contents.get(), std::move(request));
              }
            },
            weak_factory_.GetWeakPtr(), contents->GetWeakPtr(),
            std::move(request)));
  }

  void PostToSelf(void (PermissionPrompt::*step)()) {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(step, weak_factory_.GetWeakPtr()));
  }

  bool Current() const { return delegate_->GetCurrentPrompt() == this; }

  void Apply(const std::string& result, bool remember) {
    if (!Current()) {
      return;
    }
    Delegate* delegate = delegate_;
    const PromptOptions options(std::monostate{});
    if (step_ == Step::kAlreadyAllowed) {
      if (result == "deny" && remember) {
        delegate->Deny(options);
      } else {
        delegate->Dismiss(options);
      }
      return;
    }
    if (result == "accept") {
      bool one_time = !remember;
      for (const auto& request : delegate->Requests()) {
        one_time &= permissions::PermissionUtil::DoesSupportTemporaryGrants(
            request->GetContentSettingsType());
      }
      if (one_time) {
        delegate->AcceptThisTime(options);
      } else {
        delegate->Accept(options);
      }
    } else if (result == "deny" && remember) {
      delegate->Deny(options);
    } else {
      delegate->Dismiss(options);
    }
  }

  void AskSystem() {
    if (!Current()) {
      return;
    }
    std::vector<ContentSettingsType> types;
    for (const auto& request : delegate_->Requests()) {
      types.push_back(request->GetContentSettingsType());
    }
    pending_system_answers_ = types.size();
    for (ContentSettingsType type : types) {
      system_permission_settings::Request(
          type, base::BindOnce(&PermissionPrompt::OnSystemAnswer,
                               weak_factory_.GetWeakPtr(), types));
    }
  }

  void OnSystemAnswer(std::vector<ContentSettingsType> types) {
    if (pending_system_answers_ == 0 || --pending_system_answers_ > 0 ||
        !Current()) {
      return;
    }
    for (ContentSettingsType type : types) {
      if (system_permission_settings::CanPrompt(type)) {
        return;
      }
    }
    delegate_->AdvanceOrFinalizeEmbeddedPromptFlow();
  }

  void Acknowledge() {
    if (Current()) {
      delegate_->Dismiss(PromptOptions(std::monostate{}));
    }
  }

  const raw_ptr<Delegate> delegate_;
  const Step step_;
  const std::string id_;
  bool asked_host_ = false;
  bool answered_ = false;
  size_t pending_system_answers_ = 0;
  base::WeakPtrFactory<PermissionPrompt> weak_factory_{this};
};

std::unique_ptr<permissions::PermissionPrompt> CreatePrompt(
    content::WebContents* contents,
    permissions::PermissionPrompt::Delegate* delegate,
    bool* default_handling) {
  if (!HostedTab(contents)) {
    *default_handling = true;
    return nullptr;
  }
  *default_handling = false;
  return std::make_unique<PermissionPrompt>(contents, delegate);
}

using RestoreCallback =
    base::OnceCallback<void(permissions::PermissionAction)>;

class FileRestorePrompt : public content::WebContentsObserver {
 public:
  static std::map<std::string, std::unique_ptr<FileRestorePrompt>>& All() {
    static base::NoDestructor<
        std::map<std::string, std::unique_ptr<FileRestorePrompt>>>
        prompts;
    return *prompts;
  }

  static void Start(content::WebContents* contents,
                    const url::Origin& origin,
                    RestoreCallback callback) {
    const std::string id = NextId('r');
    All()[id] = base::WrapUnique(
        new FileRestorePrompt(contents, id, std::move(callback)));
    base::DictValue request;
    request.Set("id", id);
    request.Set("origin", origin.GetURL().spec());
    base::ListValue kinds;
    kinds.Append("fileSystem");
    request.Set("permissions", std::move(kinds));
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](std::string id, base::DictValue request) {
                         auto it = All().find(id);
                         if (it != All().end() && it->second->web_contents()) {
                           AskHost(it->second->web_contents(),
                                   std::move(request));
                         }
                       },
                       id, std::move(request)));
  }

  static bool Resolve(const std::string& id,
                      const std::string& result,
                      bool remember) {
    if (!All().contains(id)) {
      return false;
    }
    permissions::PermissionAction action =
        permissions::PermissionAction::DISMISSED;
    if (result == "accept") {
      action = permissions::PermissionAction::GRANTED_ONCE;
    } else if (result == "deny" && remember) {
      action = permissions::PermissionAction::DENIED;
    }
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&FileRestorePrompt::Finish, id, action, false));
    return true;
  }

  void DidFinishNavigation(content::NavigationHandle* navigation) override {
    if (navigation->IsInPrimaryMainFrame() && navigation->HasCommitted() &&
        !url::IsSameOriginWith(navigation->GetPreviousPrimaryMainFrameURL(),
                               navigation->GetURL())) {
      Dismiss();
    }
  }

  void WebContentsDestroyed() override { Dismiss(); }

 private:
  FileRestorePrompt(content::WebContents* contents,
                    std::string id,
                    RestoreCallback callback)
      : content::WebContentsObserver(contents),
        id_(std::move(id)),
        callback_(std::move(callback)) {}

  void Dismiss() {
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE,
        base::BindOnce(&FileRestorePrompt::Finish, id_,
                       permissions::PermissionAction::DISMISSED, true));
    Observe(nullptr);
  }

  static void Finish(std::string id,
                     permissions::PermissionAction action,
                     bool tell_host) {
    auto it = All().find(id);
    if (it == All().end()) {
      return;
    }
    RestoreCallback callback = std::move(it->second->callback_);
    All().erase(it);
    if (tell_host) {
      TellDismissed(id);
    }
    std::move(callback).Run(action);
  }

  const std::string id_;
  RestoreCallback callback_;
};

bool AskHostToRestoreFiles(
    const FileSystemAccessPermissionRequestManager::RequestData& request,
    RestoreCallback& callback,
    content::WebContents* contents) {
  if (!HostedTab(contents)) {
    return false;
  }
  FileRestorePrompt::Start(contents, request.origin, std::move(callback));
  return true;
}

void ResolvePermission(const std::string& request_id,
                       const std::string& result,
                       bool remember) {
  if (FileRestorePrompt::Resolve(request_id, result, remember)) {
    return;
  }
  auto it = Prompts().find(request_id);
  if (it == Prompts().end() || !it->second) {
    return;
  }
  it->second->Resolve(result, remember);
}

void ResolveVerb(const std::string&, base::DictValue args, ModuleReply reply) {
  const std::string* id = args.FindString("id");
  const std::string* result = args.FindString("result");
  if (!id || !result) {
    ReplyError(std::move(reply), "permissions.resolve: id and result",
               "ERR_BAD_ARGS");
    return;
  }
  ResolvePermission(*id, *result, args.FindBool("remember").value_or(false));
  ReplyNull(std::move(reply));
}

}

void InstallPermissionPrompts() {
  g_ardia_create_permission_prompt = &CreatePrompt;
  g_ardia_file_system_restore_prompt = &AskHostToRestoreFiles;
}

void AddPermissionVerbs(DomainVerbs& verbs) {
  verbs.Add("permissions", "resolve", base::BindRepeating(&ResolveVerb));
}

}
