#include "ardia/mac/ac_mac_extension_view.h"

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

#include <algorithm>
#include <cmath>
#include <optional>
#include <utility>
#include <vector>

#include "ardia/mac/ac_mac_shell_bridge.h"
#include "ardia/mac/ac_mac_shell_host.h"
#include "ardia/mac/ac_mac_system_policy.h"
#include "base/apple/foundation_util.h"
#include "base/base64.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/sys_string_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/timer/timer.h"
#include "chrome/browser/extensions/api/side_panel/side_panel_service.h"
#include "chrome/browser/extensions/extension_action_runner.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/browser/extensions/extension_view.h"
#include "chrome/browser/extensions/extension_view_host.h"
#include "chrome/browser/extensions/extension_view_host_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/navigation_entry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "extensions/browser/extension_action.h"
#include "extensions/browser/extension_action_manager.h"
#include "extensions/browser/extension_host_registry.h"
#include "extensions/browser/extension_install_prompt_client.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_registry_observer.h"
#include "extensions/browser/extension_util.h"
#include "extensions/browser/install_prompt_data.h"
#include "extensions/common/extension.h"
#include "extensions/common/file_util.h"
#include "extensions/common/manifest.h"
#include "extensions/common/mojom/manifest.mojom-shared.h"
#include "ui/base/base_window.h"
#include "ui/compositor/layer.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/geometry/rounded_corners_f.h"
#include "ui/gfx/image/image.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/gfx/image/image_skia_rep.h"
#include "ui/views/controls/native/native_view_host.h"
#include "ui/views/controls/webview/webview.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/view_tracker.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

using InstallDone = extensions::ExtensionInstallPromptClient::DoneCallback;
using InstallPayload = extensions::ExtensionInstallPromptClient::DoneCallbackPayload;
using InstallResult = extensions::ExtensionInstallPromptClient::Result;

extern bool (*g_ardia_extension_install_prompt)(Profile* profile,
                                                content::WebContents* parent,
                                                const extensions::InstallPromptData& prompt,
                                                InstallDone* done_callback);
extern bool (*g_ardia_extension_side_panel)(BrowserWindowInterface* browser_window,
                                            content::WebContents* web_contents,
                                            const extensions::ExtensionId& extension_id,
                                            bool open);

namespace ardia_mac {

namespace ext = extension_policy;

using Done = ExtensionViews::Done;

namespace {

constexpr base::TimeDelta kRevealSettle = base::Milliseconds(100);
constexpr base::TimeDelta kRevealDeadline = base::Milliseconds(600);
constexpr base::TimeDelta kDecorationWait = base::Milliseconds(300);
constexpr base::TaskTraits kFileReads = {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
                                         base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN};

void Fail(Done done, std::string_view code, std::string_view message) {
  std::move(done).Run(false, Failure(code, message));
}

void ReplyJson(Done done, const base::Value& value) {
  std::move(done).Run(true, base::Value(base::WriteJson(value).value_or("null")));
}

double Css(double dip, double zoom) {
  return std::round(dip / zoom * 1e4) / 1e4;
}

bool Only(const base::DictValue& input, std::initializer_list<std::string_view> keys) {
  if (input.size() != keys.size()) {
    return false;
  }
  return std::ranges::all_of(keys, [&input](std::string_view key) { return input.contains(key); });
}

bool IdField(const base::DictValue& input, std::string_view key) {
  const std::string* id = input.FindString(key);
  return id && ext::ValidExtensionId(*id);
}

bool TabField(const base::DictValue& input, std::string_view key) {
  const std::string* tab = input.FindString(key);
  return tab && ext::ValidTabKey(*tab);
}

std::string ValidateCall(std::string_view name, const base::DictValue& input) {
  if (name == "extensions.chooseFolder") {
    return input.empty() ? "" : "This call takes no arguments";
  }
  if (name == "extensions.inspectUnpacked") {
    const std::string* path = input.FindString("path");
    return Only(input, {"path"}) && path && ext::ValidFolderPath(*path) ? ""
                                                                         : "An absolute, normalized path is required";
  }
  if (name == "extensions.resolveInstallPrompt") {
    const std::string* id = input.FindString("requestId");
    const base::Value* accepted = input.Find("accepted");
    return Only(input, {"requestId", "accepted"}) && id && ext::ValidRequestId(*id) && accepted &&
                   accepted->is_bool()
               ? ""
               : "A request id and a boolean answer are required";
  }
  if (name == "extensions.actionStates") {
    const base::ListValue* ids = input.FindList("ids");
    if (!Only(input, {"tabId", "ids"}) || !TabField(input, "tabId") || !ids || ids->size() > ext::kMaxActionIds) {
      return "A tab and at most 64 extension ids are required";
    }
    for (const base::Value& id : *ids) {
      if (!id.is_string() || !ext::ValidExtensionId(id.GetString())) {
        return "Invalid extension id";
      }
    }
    return "";
  }
  if (name == "extensions.sidePanelUrl") {
    return Only(input, {"tabId", "extensionId"}) && TabField(input, "tabId") && IdField(input, "extensionId")
               ? ""
               : "A tab and an extension id are required";
  }
  return "This extension call is unavailable in the Mac WebUI shell";
}

std::optional<base::DictValue> ParseInput(const base::Value* args) {
  if (args && !args->is_string() && !args->is_none()) {
    return std::nullopt;
  }
  const std::string json = args && args->is_string() ? args->GetString() : "{}";
  if (json.size() > ext::kMaxCallJson || json.find('\0') != std::string::npos) {
    return std::nullopt;
  }
  std::optional<base::Value> parsed = base::JSONReader::Read(json, base::JSON_PARSE_RFC, 16);
  if (!parsed || !parsed->is_dict()) {
    return std::nullopt;
  }
  return std::move(parsed->GetDict());
}

const extensions::Extension* Enabled(content::BrowserContext* context, const std::string& id) {
  const extensions::Extension* extension =
      extensions::ExtensionRegistry::Get(context)->enabled_extensions().GetByID(id);
  if (extension && context->IsOffTheRecord() && !extensions::util::IsIncognitoEnabled(id, context)) {
    return nullptr;
  }
  return extension;
}

std::string PngDataUrl(const gfx::Image& image) {
  if (image.IsEmpty()) {
    return "";
  }
  const gfx::ImageSkiaRep& rep = image.ToImageSkia()->GetRepresentation(2.0f);
  const std::optional<std::vector<uint8_t>> png = gfx::PNGCodec::EncodeBGRASkBitmap(rep.GetBitmap(), false);
  return png ? "data:image/png;base64," + base::Base64Encode(*png) : "";
}

std::string ReadIcon(const base::FilePath& root, const std::string& relative) {
  const std::optional<std::string> clean = ext::ResourcePath(relative);
  const std::string_view mime = clean ? ext::ImageMimeType(*clean) : std::string_view();
  if (!clean || mime.empty()) {
    return "";
  }
  const base::FilePath real_root = base::MakeAbsoluteFilePath(root);
  const base::FilePath real_file = base::MakeAbsoluteFilePath(root.Append(*clean));
  if (real_root.empty() || real_file.empty() || !real_root.IsParent(real_file)) {
    return "";
  }
  std::string bytes;
  if (!base::ReadFileToStringWithMaxSize(real_file, &bytes, ext::kMaxIconBytes)) {
    return "";
  }
  return "data:" + std::string(mime) + ";base64," + base::Base64Encode(bytes);
}

std::optional<std::string> LargestIcon(const base::DictValue* icons) {
  if (!icons) {
    return std::nullopt;
  }
  std::optional<std::pair<int, std::string>> best;
  for (const auto [size, path] : *icons) {
    int pixels = 0;
    if (!base::StringToInt(size, &pixels) || !path.is_string() || pixels <= 0 || pixels > 512) {
      continue;
    }
    if (!best || pixels > best->first) {
      best = std::make_pair(pixels, path.GetString());
    }
  }
  return best ? std::optional<std::string>(best->second) : std::nullopt;
}

base::ListValue Strings(const base::ListValue* list) {
  base::ListValue strings;
  if (!list) {
    return strings;
  }
  for (const base::Value& entry : *list) {
    if (entry.is_string() && strings.size() < 256) {
      strings.Append(entry.GetString());
    }
  }
  return strings;
}

base::Value OptionalText(const std::string* text) {
  return text && !text->empty() ? base::Value(*text) : base::Value();
}

struct Inspected {
  std::string error;
  std::optional<base::DictValue> package;
};

Inspected Inspect(base::FilePath path) {
  Inspected result;
  std::u16string error;
  scoped_refptr<extensions::Extension> extension = extensions::file_util::LoadExtension(
      path, extensions::mojom::ManifestLocation::kUnpacked, extensions::Extension::FOLLOW_SYMLINKS_ANYWHERE, &error);
  if (!extension) {
    result.error = error.empty() ? "Manifest file is missing or unreadable" : base::UTF16ToUTF8(error);
    return result;
  }
  const base::DictValue& manifest = *extension->manifest()->value();
  const base::DictValue* action = manifest.FindDict("action");
  if (!action) {
    action = manifest.FindDict("browser_action");
  }
  const base::DictValue* options_ui = manifest.FindDict("options_ui");
  const base::DictValue* side_panel = manifest.FindDict("side_panel");
  const std::optional<std::string> icon = LargestIcon(manifest.FindDict("icons"));
  base::DictValue package;
  package.Set("id", extension->id());
  package.Set("name", extension->name());
  package.Set("shortName", OptionalText(manifest.FindString("short_name")));
  package.Set("version", extension->VersionString());
  package.Set("description", manifest.FindString("description") ? *manifest.FindString("description") : "");
  package.Set("manifestVersion", manifest.FindInt("manifest_version").value_or(2));
  const std::string icon_url = icon ? ReadIcon(path, *icon) : std::string();
  package.Set("icon", icon_url.empty() ? base::Value() : base::Value(icon_url));
  package.Set("permissions", Strings(manifest.FindList("permissions")));
  package.Set("optionalPermissions", Strings(manifest.FindList("optional_permissions")));
  package.Set("hostPermissions", Strings(manifest.FindList("host_permissions")));
  package.Set("hasAction", action != nullptr);
  package.Set("popup", OptionalText(action ? action->FindString("default_popup") : nullptr));
  package.Set("optionsPage", OptionalText(options_ui ? options_ui->FindString("page")
                                                     : manifest.FindString("options_page")));
  package.Set("sidePanel", OptionalText(side_panel ? side_panel->FindString("default_path") : nullptr));
  package.Set("path", path.value());
  result.package = std::move(package);
  return result;
}

void AbortPrompt(std::string request);

class PromptParentWatch : public content::WebContentsObserver {
 public:
  explicit PromptParentWatch(content::WebContents* parent) : content::WebContentsObserver(parent) {}

  void Track(std::string request) { request_ = std::move(request); }

  void WebContentsDestroyed() override {
    Observe(nullptr);
    if (request_.empty()) {
      return;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE, base::BindOnce(&AbortPrompt, request_));
  }

 private:
  std::string request_;
};

struct PendingInstall {
  InstallDone done;
  base::WeakPtr<Profile> profile;
  std::unique_ptr<PromptParentWatch> parent;
};

ext::PromptLedger<PendingInstall>& Prompts() {
  static base::NoDestructor<ext::PromptLedger<PendingInstall>> prompts;
  return *prompts;
}

void Answer(PendingInstall pending, InstallResult result) {
  if (!pending.profile || pending.done.is_null()) {
    return;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(std::move(pending.done), InstallPayload(result)));
}

void AbortPrompt(std::string request) {
  std::optional<PendingInstall> pending = Prompts().Take(request);
  if (!pending) {
    return;
  }
  for (ShellHostView* host : Hosts()) {
    if (ExtensionViews* views = host->extension_views()) {
      views->DeliverExtensionEvent("extensions.installPromptCancelled",
                                   base::DictValue().Set("requestId", request));
    }
  }
  Answer(std::move(*pending), InstallResult::ABORTED);
}

ShellHostView* HostForProfile(Profile* profile, content::WebContents* parent, std::string* key) {
  for (ShellHostView* host : Hosts()) {
    if (PageBinding* binding = parent ? host->BindingForContents(parent) : nullptr) {
      *key = binding->key();
      return host;
    }
  }
  for (ShellHostView* host : Hosts()) {
    for (BrowserWindowInterface* member : host->Members()) {
      if (member->GetProfile() == profile) {
        return host;
      }
    }
  }
  return nullptr;
}

bool InstallPromptHook(Profile* profile,
                       content::WebContents* parent,
                       const extensions::InstallPromptData& prompt,
                       InstallDone* done) {
  const extensions::Extension* extension = prompt.extension();
  if (!extension || !done || done->is_null() || !profile || profile->IsOffTheRecord()) {
    return false;
  }
  if (prompt.type() == extensions::InstallPromptData::EXTERNAL_INSTALL_PROMPT) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(std::move(*done), InstallPayload(InstallResult::ABORTED)));
    return true;
  }
  std::string key;
  ShellHostView* host = HostForProfile(profile, parent, &key);
  if (!host || !host->extension_views() || !host->extension_views()->ShellLive()) {
    return false;
  }
  if (Prompts().full()) {
    Trace("extension install prompt left to Chrome: too many pending prompts");
    return false;
  }
  base::ListValue permissions;
  for (size_t index = 0; index < prompt.GetPermissionCount() && index < 256; ++index) {
    permissions.Append(base::UTF16ToUTF8(prompt.GetPermission(index)));
  }
  std::string icon;
  if (!prompt.icon().IsEmpty()) {
    if (scoped_refptr<base::RefCountedMemory> png = prompt.icon().As1xPNGBytes(); png && png->size()) {
      icon = "data:image/png;base64," + base::Base64Encode(*png);
    }
  }
  auto watch = parent ? std::make_unique<PromptParentWatch>(parent) : nullptr;
  PromptParentWatch* parent_watch = watch.get();
  std::optional<std::string> request =
      Prompts().Add(ProfileName(profile), host->window_id(),
                    PendingInstall{std::move(*done), profile->GetWeakPtr(), std::move(watch)});
  if (!request) {
    Trace("extension install prompt refused: too many pending prompts");
    return false;
  }
  if (parent_watch) {
    parent_watch->Track(*request);
  }
  host->extension_views()->DeliverExtensionEvent(
      "extensions.installPrompt",
      base::DictValue()
          .Set("requestId", *request)
          .Set("profile", ProfileName(profile))
          .Set("id", extension->id())
          .Set("name", extension->name())
          .Set("version", extension->VersionString())
          .Set("type", ext::PromptTypeName(static_cast<int>(prompt.type())))
          .Set("icon", icon)
          .Set("permissions", std::move(permissions))
          .Set("tabId", key.empty() ? base::Value() : base::Value(key)));
  return true;
}

bool SidePanelHook(BrowserWindowInterface* browser,
                   content::WebContents* contents,
                   const extensions::ExtensionId& extension_id,
                   bool open) {
  if (!contents && browser && browser->GetActiveTabInterface()) {
    contents = browser->GetActiveTabInterface()->GetContents();
  }
  if (!contents || !ext::ValidExtensionId(extension_id)) {
    return false;
  }
  for (ShellHostView* host : Hosts()) {
    PageBinding* binding = host->BindingForContents(contents);
    if (binding && host->extension_views()) {
      host->extension_views()->DeliverExtensionEvent(
          "extensions.sidePanel",
          base::DictValue().Set("tabId", binding->key()).Set("extensionId", extension_id).Set("open", open));
      return true;
    }
  }
  return false;
}

void InstallHooks() {
  static bool installed = false;
  if (installed) {
    return;
  }
  installed = true;
  if (!g_ardia_extension_install_prompt) {
    g_ardia_extension_install_prompt = &InstallPromptHook;
  }
  if (!g_ardia_extension_side_panel) {
    g_ardia_extension_side_panel = &SidePanelHook;
  }
}

NSView* ContentView(content::WebContents* contents) {
  return contents ? contents->GetNativeView().GetNativeNSView() : nil;
}

}

class ExtensionViews::Surface : public extensions::ExtensionView,
                                public content::WebContentsObserver,
                                public extensions::ExtensionRegistryObserver,
                                public extensions::ExtensionHostRegistry::Observer {
 public:
  Surface(ExtensionViews* owner,
          int id,
          ext::SurfaceKind kind,
          std::unique_ptr<extensions::ExtensionViewHost> host)
      : owner_(owner), id_(id), kind_(kind), host_(std::move(host)) {
    host_->set_view(this);
    Observe(host_->host_contents());
    host_->SetCloseHandler(base::BindOnce(&Surface::ClosedByChrome, weak_factory_.GetWeakPtr()));
    content::BrowserContext* context = host_->browser_context();
    registry_observation_.Observe(extensions::ExtensionRegistry::Get(context));
    hosts_observation_.Observe(extensions::ExtensionHostRegistry::Get(context));
    ShellHostView* parent = owner_->host();
    auto view = std::make_unique<views::WebView>(context);
    view_ = kind_ == ext::SurfaceKind::kSidePanel ? parent->AddChildViewAt(std::move(view), 0)
                                                  : parent->AddChildView(std::move(view));
    view_->SetVisible(false);
    view_->SetWebContents(contents());
  }
  Surface(const Surface&) = delete;
  Surface& operator=(const Surface&) = delete;
  ~Surface() override {
    Observe(nullptr);
    ReturnFocus();
    if (view_) {
      view_->SetWebContents(nullptr);
      owner_->host()->RemoveChildViewT(view_.ExtractAsDangling());
    }
    host_->set_view(nullptr);
  }

  content::WebContents* contents() const { return host_->host_contents(); }
  const std::string& extension_id() const { return host_->extension_id(); }
  ext::SurfaceKind kind() const { return kind_; }

  void Start() {
    owner_->SurfaceEvent(id_, base::DictValue().Set("type", "ready"));
    host_->CreateRendererSoon();
  }

  void Place(const gfx::Rect& bounds, bool visible, std::optional<gfx::RoundedCornersF> radii) {
    if (!visible) {
      ReturnFocus();
    }
    if (radii) {
      radii_ = *radii;
    }
    view_->SetBoundsRect(bounds);
    view_->SetVisible(visible);
    ApplyRadii();
    owner_->host()->Restack();
    SetShown(visible);
  }

  void Position(const ext::PopupPlacement& placement, double radius, int fade_ms, bool wanted,
                std::optional<int> decorated, std::optional<double> decorated_scale) {
    placement_ = placement;
    radius_ = radius;
    fade_ms_ = fade_ms;
    wanted_ = wanted;
    if (decorated && decorated_scale && std::abs(*decorated_scale - Scale() * Zoom()) < 1e-3) {
      decorated_ = std::max(decorated_, *decorated);
    }
    if (!wanted_) {
      Conceal(false);
    }
    Relayout();
  }

  void Relayout() {
    if (kind_ != ext::SurfaceKind::kPopup || !placement_) {
      return;
    }
    const double zoom = Zoom();
    const double scale = Scale();
    const std::optional<ext::PopupLimits> limits = ext::PopupLimitsFor(*placement_, zoom);
    if (!limits) {
      return Conceal(true);
    }
    if (limits != limits_) {
      limits_ = limits;
      ApplyAutoResize();
    }
    gfx::Point origin;
    views::View::ConvertPointToWidget(owner_->host(), &origin);
    const std::optional<ext::Box> box = ext::PopupBoxFor(*placement_, zoom, preferred_.width(), preferred_.height(),
                                                         origin.x() * scale, origin.y() * scale, scale);
    if (!box) {
      return Conceal(true);
    }
    const gfx::Rect bounds(box->x, box->y, box->width, box->height);
    if (view_->bounds() != bounds) {
      view_->SetBoundsRect(bounds);
    }
    radii_ = gfx::RoundedCornersF(static_cast<float>(ext::CornerRadius(radius_, zoom)));
    if (wanted_ && !view_->GetVisible()) {
      Stage();
    }
    ApplyRadii();
    EmitFrame(false);
    if (wanted_ && !settled_ && host_->has_loaded_once() && !preferred_.IsEmpty() && !settle_timer_.IsRunning()) {
      Unsettle();
    }
    MaybeReveal();
  }

  void Raise() {
    if (kind_ == ext::SurfaceKind::kPopup) {
      owner_->host()->ReorderChildView(view_, owner_->host()->children().size());
    }
  }

  void Focus() {
    const views::Widget* widget = view_->GetWidget();
    views::FocusManager* focus = view_->GetFocusManager();
    switch (ext::SurfaceFocusFor(native_shown_, widget && widget->IsActive())) {
      case ext::SurfaceFocus::kNone:
        return;
      case ext::SurfaceFocus::kStored:
        if (focus) {
          focus->SetStoredFocusView(view_);
        }
        return;
      case ext::SurfaceFocus::kTaken:
        if (focus && focus->GetFocusedView() && !Owns(focus->GetFocusedView())) {
          focus_before_.SetView(focus->GetFocusedView());
        }
        view_->RequestFocus();
        contents()->Focus();
        return;
    }
  }

  gfx::NativeView GetNativeView() override { return contents()->GetNativeView(); }

  void ResizeDueToAutoResize(content::WebContents*, const gfx::Size& size) override {
    if (kind_ != ext::SurfaceKind::kPopup || size == preferred_) {
      return;
    }
    preferred_ = size;
    const double zoom = Zoom();
    owner_->SurfaceEvent(id_, base::DictValue()
                                  .Set("type", "preferredSize")
                                  .Set("value", base::DictValue()
                                                    .Set("width", Css(size.width(), zoom))
                                                    .Set("height", Css(size.height(), zoom))));
    if (host_->has_loaded_once()) {
      Unsettle();
    }
    Relayout();
  }

  void RenderFrameCreated(content::RenderFrameHost* frame) override {
    if (frame == contents()->GetPrimaryMainFrame()) {
      EnableAutoResize(frame);
    }
  }

  bool HandleKeyboardEvent(content::WebContents*, const input::NativeWebKeyboardEvent&) override { return false; }

  void OnLoaded() override {
    ReportNavigation();
    if (kind_ == ext::SurfaceKind::kPopup && !preferred_.IsEmpty()) {
      Unsettle();
    }
  }

  void DidStartLoading() override { ReportNavigation(); }
  void DidStopLoading() override { ReportNavigation(); }
  void TitleWasSet(content::NavigationEntry*) override { ReportNavigation(); }

  void RenderFrameHostChanged(content::RenderFrameHost* old_host, content::RenderFrameHost* new_host) override {
    if (old_host && new_host == contents()->GetPrimaryMainFrame() && new_host->IsRenderFrameLive()) {
      EnableAutoResize(new_host);
    }
  }

  void OnExtensionUnloaded(content::BrowserContext*,
                           const extensions::Extension* extension,
                           extensions::UnloadedExtensionReason) override {
    if (extension->id() == extension_id()) {
      PostClosed();
    }
  }

  void OnShutdown(extensions::ExtensionRegistry*) override { registry_observation_.Reset(); }

  void OnExtensionHostRenderProcessGone(content::BrowserContext*, extensions::ExtensionHost* host) override {
    if (host == host_.get()) {
      PostClosed();
    }
  }

  void OnExtensionHostRegistryShutdown(extensions::ExtensionHostRegistry*) override { hosts_observation_.Reset(); }

 private:
  void EnableAutoResize(content::RenderFrameHost* frame) {
    if (kind_ != ext::SurfaceKind::kPopup || !frame->GetView()) {
      return;
    }
    const ext::PopupLimits limits = limits_.value_or(ext::PopupLimits());
    frame->GetView()->EnableAutoResize(gfx::Size(limits.min_width, limits.min_height),
                                       gfx::Size(limits.max_width, limits.max_height));
  }

  void ApplyAutoResize() {
    content::RenderFrameHost* frame = contents()->GetPrimaryMainFrame();
    if (frame && frame->IsRenderFrameLive()) {
      EnableAutoResize(frame);
    }
  }

  double Zoom() const {
    const double zoom = owner_->host()->ShellZoom();
    return ext::ValidZoom(zoom) ? zoom : 1.0;
  }

  double Scale() const {
    const views::Widget* widget = view_ ? view_->GetWidget() : nullptr;
    const ui::Layer* layer = widget ? widget->GetLayer() : nullptr;
    return layer ? layer->device_scale_factor() : 1.0;
  }

  void ApplyRadii() { view_->holder()->SetNativeViewCornerRadii(radii_); }

  void Unsettle() {
    if (native_shown_ || deadline_passed_) {
      return;
    }
    settled_ = false;
    settle_timer_.Start(FROM_HERE, kRevealSettle, this, &Surface::Settle);
    if (!deadline_timer_.IsRunning()) {
      deadline_timer_.Start(FROM_HERE, kRevealDeadline, this, &Surface::PassDeadline);
    }
  }

  void Settle() {
    settled_ = true;
    MaybeReveal();
  }

  void PassDeadline() {
    settle_timer_.Stop();
    deadline_passed_ = true;
    Settle();
  }

  void WaiveDecoration() {
    decoration_waived_ = true;
    MaybeReveal();
  }

  void EmitFrame(bool force) {
    const gfx::Rect bounds = view_->bounds();
    if (bounds.IsEmpty()) {
      return;
    }
    const double zoom = Zoom();
    base::DictValue rect = base::DictValue()
                               .Set("x", Css(bounds.x(), zoom))
                               .Set("y", Css(bounds.y(), zoom))
                               .Set("width", Css(bounds.width(), zoom))
                               .Set("height", Css(bounds.height(), zoom))
                               .Set("radius", Css(radii_.upper_left(), zoom))
                               .Set("scale", Scale() * zoom)
                               .Set("reveal", revealing_ || native_shown_);
    if (!force && last_frame_ == rect) {
      return;
    }
    last_frame_ = rect.Clone();
    ++serial_;
    rect.Set("serial", serial_);
    owner_->SurfaceEvent(id_, base::DictValue().Set("type", "frame").Set("value", std::move(rect)));
  }

  void MaybeReveal() {
    if (kind_ != ext::SurfaceKind::kPopup || native_shown_ || !wanted_ || !limits_ || !settled_ ||
        !host_->has_loaded_once() || preferred_.IsEmpty() || view_->bounds().IsEmpty()) {
      return;
    }
    if (!revealing_) {
      revealing_ = true;
      EmitFrame(true);
      decoration_timer_.Start(FROM_HERE, kDecorationWait, this, &Surface::WaiveDecoration);
      return;
    }
    if (decorated_ >= serial_ || decoration_waived_) {
      Reveal();
    }
  }

  void Stage() {
    SetContentHidden(true);
    view_->SetVisible(true);
    owner_->host()->Restack();
  }

  void SetContentHidden(bool hidden) {
    NSView* page = ContentView(contents());
    if (!page) {
      return;
    }
    [page.layer removeAllAnimations];
    page.alphaValue = hidden ? 0.0 : 1.0;
  }

  void Reveal() {
    if (!revealing_ || !wanted_ || !settled_ || !limits_ || view_->bounds().IsEmpty()) {
      return;
    }
    decoration_timer_.Stop();
    settle_timer_.Stop();
    deadline_timer_.Stop();
    revealing_ = false;
    if (!view_->GetVisible()) {
      Stage();
    }
    ApplyRadii();
    if (NSView* page = ContentView(contents())) {
      if (fade_ms_ > 0 && !BackgroundInstance()) {
        page.alphaValue = 0.0;
        const double seconds = fade_ms_ / 1000.0;
        [NSAnimationContext runAnimationGroup:^(NSAnimationContext* context) {
          context.duration = seconds;
          context.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
          page.animator.alphaValue = 1.0;
        }];
      } else {
        page.alphaValue = 1.0;
      }
    }
    SetShown(true);
    EmitFrame(false);
  }

  void Conceal(bool room_lost) {
    ReturnFocus();
    settle_timer_.Stop();
    deadline_timer_.Stop();
    decoration_timer_.Stop();
    settled_ = false;
    deadline_passed_ = false;
    decoration_waived_ = false;
    revealing_ = false;
    SetContentHidden(false);
    view_->SetVisible(false);
    SetShown(false);
    EmitFrame(false);
    if (!room_lost) {
      return;
    }
    limits_.reset();
    last_frame_.reset();
    view_->SetBoundsRect(gfx::Rect());
  }

  bool Owns(const views::View* view) const { return view_ && view && (view == view_ || view_->Contains(view)); }

  void ReturnFocus() {
    views::FocusManager* focus = view_ ? view_->GetFocusManager() : nullptr;
    views::View* before = focus_before_.view();
    focus_before_.SetView(nullptr);
    if (!focus || !before || !Owns(focus->GetFocusedView())) {
      return;
    }
    if (before->IsDrawn() && before->IsFocusable()) {
      before->RequestFocus();
    }
  }

  void SetShown(bool shown) {
    if (native_shown_ == shown) {
      return;
    }
    native_shown_ = shown;
    owner_->SurfaceEvent(id_, base::DictValue().Set("type", "shown").Set("value", shown));
  }

  void ReportNavigation() {
    content::WebContents* page = contents();
    owner_->SurfaceEvent(id_, base::DictValue()
                                  .Set("type", "navigation")
                                  .Set("state", base::DictValue()
                                                    .Set("url", page->GetVisibleURL().spec())
                                                    .Set("title", page->GetTitle())
                                                    .Set("canGoBack", false)
                                                    .Set("canGoForward", false)
                                                    .Set("isLoading", page->IsLoading())));
  }

  void ClosedByChrome(extensions::ExtensionHost*) { PostClosed(); }

  void PostClosed() {
    if (std::exchange(closing_, true)) {
      return;
    }
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&ExtensionViews::SurfaceClosed, owner_->GetWeakPtr(), id_, true));
  }

  raw_ptr<ExtensionViews> owner_;
  const int id_;
  const ext::SurfaceKind kind_;
  std::unique_ptr<extensions::ExtensionViewHost> host_;
  raw_ptr<views::WebView> view_ = nullptr;
  gfx::Size preferred_;
  std::optional<ext::PopupPlacement> placement_;
  std::optional<ext::PopupLimits> limits_;
  gfx::RoundedCornersF radii_;
  double radius_ = 0;
  int fade_ms_ = 0;
  bool wanted_ = false;
  bool settled_ = false;
  bool revealing_ = false;
  bool native_shown_ = false;
  bool deadline_passed_ = false;
  bool decoration_waived_ = false;
  int serial_ = 0;
  int decorated_ = 0;
  std::optional<base::DictValue> last_frame_;
  views::ViewTracker focus_before_;
  base::OneShotTimer settle_timer_;
  base::OneShotTimer deadline_timer_;
  base::OneShotTimer decoration_timer_;
  bool closing_ = false;
  base::ScopedObservation<extensions::ExtensionRegistry, extensions::ExtensionRegistryObserver>
      registry_observation_{this};
  base::ScopedObservation<extensions::ExtensionHostRegistry, extensions::ExtensionHostRegistry::Observer>
      hosts_observation_{this};
  base::WeakPtrFactory<Surface> weak_factory_{this};
};

ExtensionViews::ExtensionViews(ShellHostView* host) : host_(host) {
  InstallHooks();
}

ExtensionViews::~ExtensionViews() {
  weak_factory_.InvalidateWeakPtrs();
  AbortPrompts();
  CloseAll();
}

bool ExtensionViews::ShellLive() const {
  return host_->handler_ && host_->handler_->Live();
}

void ExtensionViews::AbortPrompts() {
  for (const std::string& request : Prompts().OfWindow(host_->window_id())) {
    if (std::optional<PendingInstall> pending = Prompts().Take(request)) {
      Answer(std::move(*pending), InstallResult::ABORTED);
    }
  }
}

bool ExtensionViews::Handles(std::string_view method) {
  return std::ranges::find(ext::kSurfaceMethods, method) != std::end(ext::kSurfaceMethods);
}

bool ExtensionViews::HandlesEngineCall(std::string_view name) {
  return std::ranges::find(ext::kExtensionCalls, name) != std::end(ext::kExtensionCalls);
}

void ExtensionViews::AppendCapabilities(base::ListValue& capabilities) {
  for (std::string_view method : ext::kSurfaceMethods) {
    capabilities.Append(method);
  }
  for (std::string_view call : ext::kExtensionCalls) {
    capabilities.Append(call);
  }
}

std::string ExtensionViews::ExecuteAction(content::WebContents* contents, const base::ListValue* values) {
  if (!contents || !values || values->size() != 1 || !(*values)[0].is_string() ||
      !ext::ValidExtensionId((*values)[0].GetString())) {
    return "";
  }
  const extensions::Extension* extension = Enabled(contents->GetBrowserContext(), (*values)[0].GetString());
  extensions::ExtensionActionRunner* runner = extensions::ExtensionActionRunner::GetForWebContents(contents);
  if (!extension || !runner) {
    return "none";
  }
  switch (runner->RunAction(extension, true)) {
    case extensions::ExtensionAction::ShowAction::kShowPopup:
      return "popup";
    case extensions::ExtensionAction::ShowAction::kToggleSidePanel:
      return "sidePanel";
    case extensions::ExtensionAction::ShowAction::kNone:
      return "none";
  }
  return "none";
}

void ExtensionViews::DeliverExtensionEvent(std::string_view name, base::DictValue data) {
  host_->Emit("ArdiaExtensions", "extensions",
              base::Value(base::DictValue().Set("name", name).Set("data", std::move(data))));
}

void ExtensionViews::Invoke(const std::string& method, const base::DictValue& args, Done done) {
  const uint64_t generation = host_->renderer_generation_;
  if (method == "extensionView.create") {
    return Create(args, generation, std::move(done));
  }
  if (method == "extensionView.viewport") {
    return Viewport(args, generation, std::move(done));
  }
  if (method == "extensionView.place") {
    return Place(args, generation, std::move(done));
  }
  if (method == "extensionView.command") {
    return Command(args, generation, std::move(done));
  }
  if (method == "extensionView.release") {
    return Release(args, generation, std::move(done));
  }
  Fail(std::move(done), "ERR_UNKNOWN_CALL", "Unknown extension view operation");
}

void ExtensionViews::Create(const base::DictValue& args, uint64_t generation, Done done) {
  const std::string* kind_name = args.FindString("kind");
  const std::string* url = args.FindString("url");
  const std::string* profile = args.FindString("profile");
  const std::optional<ext::SurfaceKind> kind = kind_name ? ext::SurfaceKindFor(*kind_name) : std::nullopt;
  if (!Only(args, {"kind", "url", "profile"}) || !profile || !url || !kind) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_REQUEST",
                "An extension view needs exactly a kind, a URL and a profile");
  }
  const std::optional<std::string> extension_id = ext::ExtensionUrlHost(*url);
  if (!extension_id) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_REQUEST", "Extension views only load chrome-extension:// pages");
  }
  WithProfile(*profile, base::BindOnce(&ExtensionViews::CreateIn, GetWeakPtr(), *kind, *url, *extension_id,
                                       generation, std::move(done)));
}

void ExtensionViews::CreateIn(ext::SurfaceKind kind,
                              std::string url,
                              std::string extension_id,
                              uint64_t generation,
                              Done done,
                              Profile* profile) {
  if (generation != host_->renderer_generation_) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_STALE", "The shell reloaded");
  }
  BrowserWindowInterface* browser = profile ? host_->EnsureMember(profile) : nullptr;
  if (!browser) {
    return Fail(std::move(done), "ERR_WINDOW_CLOSED", "Extension views need this window's own profile");
  }
  const extensions::Extension* extension = Enabled(profile, extension_id);
  if (!extension) {
    return Fail(std::move(done), "ERR_EXTENSION_UNAVAILABLE", "The extension is not enabled");
  }
  const GURL page(url);
  if (!page.is_valid() || page.host() != extension_id) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_REQUEST", "Invalid extension view URL");
  }
  const std::optional<int> id = book_.Open(kind, extension_id, generation);
  if (!id) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_LIMIT", "Too many extension views in this window");
  }
  std::unique_ptr<extensions::ExtensionViewHost> host =
      kind == ext::SurfaceKind::kPopup
          ? extensions::ExtensionViewHostFactory::CreatePopupHost(*extension, page, browser)
          : extensions::ExtensionViewHostFactory::CreateSidePanelHost(*extension, page, browser, nullptr);
  if (!host) {
    book_.Close(*id);
    return Fail(std::move(done), "ERR_EXTENSION_UNAVAILABLE", "Chrome could not host the extension page");
  }
  auto surface = std::make_unique<Surface>(this, *id, kind, std::move(host));
  Surface* raw = surface.get();
  surfaces_[*id] = std::move(surface);
  std::move(done).Run(true, base::Value(base::DictValue().Set("id", *id)));
  if (surfaces_.contains(*id)) {
    raw->Start();
  }
}

ExtensionViews::Surface* ExtensionViews::Owned(const base::DictValue& args, uint64_t generation) {
  const base::Value* value = args.Find("id");
  const std::optional<int> id = ext::SurfaceIdFrom(value && value->is_int(), value && value->is_int() ? value->GetInt() : 0);
  if (!id || !book_.Owns(*id, generation)) {
    return nullptr;
  }
  const auto found = surfaces_.find(*id);
  return found == surfaces_.end() ? nullptr : found->second.get();
}

void ExtensionViews::Viewport(const base::DictValue& args, uint64_t generation, Done done) {
  Surface* surface = Owned(args, generation);
  const base::DictValue* rect = args.FindDict("rect");
  if (!surface || !rect) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_STALE", "No such extension view");
  }
  const double scale = host_->ShellZoom();
  const std::optional<ext::Box> box =
      ext::ViewportBox(rect->FindDouble("x").value_or(NAN), rect->FindDouble("y").value_or(NAN),
                       rect->FindDouble("width").value_or(NAN), rect->FindDouble("height").value_or(NAN), scale,
                       host_->width(), host_->height());
  if (!box) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_REQUEST", "Viewport coordinates must be finite");
  }
  std::optional<gfx::RoundedCornersF> radii;
  if (const base::DictValue* corners = args.FindDict("radii")) {
    const auto corner = [&](std::string_view key) {
      return static_cast<float>(ext::CornerRadius(corners->FindDouble(key).value_or(0), scale));
    };
    radii = gfx::RoundedCornersF(corner("upperLeft"), corner("upperRight"), corner("lowerRight"),
                                 corner("lowerLeft"));
  }
  const gfx::Rect bounds(box->x, box->y, box->width, box->height);
  surface->Place(bounds, args.FindBool("visible").value_or(false) && !bounds.IsEmpty(), radii);
  std::move(done).Run(true, base::Value());
}

void ExtensionViews::Place(const base::DictValue& args, uint64_t generation, Done done) {
  Surface* surface = Owned(args, generation);
  if (!surface || surface->kind() != ext::SurfaceKind::kPopup) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_STALE", "No such extension popup");
  }
  const base::DictValue* anchor = args.FindDict("anchor");
  const base::DictValue* room = args.FindDict("room");
  if (!anchor || !room) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_REQUEST", "A popup needs an anchor and a room");
  }
  const ext::PopupPlacement placement{
      .anchor_right = anchor->FindDouble("right").value_or(NAN),
      .anchor_top = anchor->FindDouble("top").value_or(NAN),
      .room_left = room->FindDouble("left").value_or(NAN),
      .room_right = room->FindDouble("right").value_or(NAN),
      .room_bottom = room->FindDouble("bottom").value_or(NAN),
  };
  const double radius = args.FindDouble("radius").value_or(0);
  const int fade_ms = args.FindInt("fadeMs").value_or(0);
  if (!ext::PlacementIsFinite(placement) || !ext::ValidPopupRadius(radius) || !ext::ValidFade(fade_ms)) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_REQUEST", "Popup placement must be finite");
  }
  surface->Position(placement, std::min(radius, ext::kMaxCornerRadius), fade_ms,
                    args.FindBool("visible").value_or(false), args.FindInt("decorated"),
                    args.FindDouble("decoratedScale"));
  std::move(done).Run(true, base::Value());
}

void ExtensionViews::Command(const base::DictValue& args, uint64_t generation, Done done) {
  Surface* surface = Owned(args, generation);
  const std::string* command = args.FindString("command");
  if (!surface || !command) {
    return Fail(std::move(done), "ERR_EXTENSION_VIEW_STALE", "No such extension view");
  }
  if (*command == "focus") {
    surface->Focus();
    return std::move(done).Run(true, base::Value());
  }
  if (*command == "evaluate") {
    return Fail(std::move(done), "ERR_PAGE_EVALUATION_REFUSED", "Extension views run no page script");
  }
  Fail(std::move(done), "ERR_UNKNOWN_COMMAND", "Extension views do not support this command");
}

void ExtensionViews::Release(const base::DictValue& args, uint64_t generation, Done done) {
  const base::Value* value = args.Find("id");
  const std::optional<int> id = ext::SurfaceIdFrom(value && value->is_int(), value && value->is_int() ? value->GetInt() : 0);
  if (id && book_.Owns(*id, generation)) {
    Destroy(*id);
  }
  std::move(done).Run(true, base::Value());
}

void ExtensionViews::Destroy(int id) {
  book_.Close(id);
  const auto found = surfaces_.find(id);
  if (found == surfaces_.end()) {
    return;
  }
  std::unique_ptr<Surface> surface = std::move(found->second);
  surfaces_.erase(found);
}

void ExtensionViews::SurfaceClosed(int id, bool report) {
  if (!surfaces_.contains(id)) {
    return;
  }
  if (report) {
    SurfaceEvent(id, base::DictValue().Set("type", "windowClose"));
  }
  Destroy(id);
}

void ExtensionViews::SurfaceEvent(int id, base::DictValue event) {
  host_->Emit("ArdiaExtensionView", base::NumberToString(id), base::Value(std::move(event)));
}

void ExtensionViews::RetireOlderThan(uint64_t generation) {
  AbortPrompts();
  for (const int id : book_.CloseOlderThan(generation)) {
    const auto found = surfaces_.find(id);
    if (found == surfaces_.end()) {
      continue;
    }
    std::unique_ptr<Surface> surface = std::move(found->second);
    surfaces_.erase(found);
  }
}

void ExtensionViews::CloseAll() {
  book_.CloseAll();
  std::map<int, std::unique_ptr<Surface>> surfaces = std::move(surfaces_);
  surfaces_.clear();
  surfaces.clear();
}

void ExtensionViews::RaisePopups() {
  for (const auto& [id, surface] : surfaces_) {
    surface->Raise();
  }
}

void ExtensionViews::Relayout() {
  for (const auto& [id, surface] : surfaces_) {
    surface->Relayout();
  }
}

content::WebContents* ExtensionViews::ProfileTab(Profile* profile, const std::string& key, std::string* code) const {
  PageBinding* binding = host_->BindingForKey(key);
  content::WebContents* contents = binding ? binding->contents() : nullptr;
  if (!contents) {
    *code = "ERR_TAB_UNAVAILABLE";
  } else if (contents->GetBrowserContext() != profile) {
    *code = "ERR_PROFILE_WINDOW";
  }
  return code->empty() ? contents : nullptr;
}

void ExtensionViews::EngineCall(const std::string& name, Profile* profile, const base::Value* args, Done done) {
  std::optional<base::DictValue> input = ParseInput(args);
  if (!input) {
    return Fail(std::move(done), "ERR_EXTENSION_REQUEST", "Extension arguments must be a JSON object");
  }
  if (const std::string invalid = ValidateCall(name, *input); !invalid.empty()) {
    return Fail(std::move(done), "ERR_EXTENSION_REQUEST", invalid);
  }
  if (!profile || profile->IsOffTheRecord() || profile->ShutdownStarted()) {
    return Fail(std::move(done), "ERR_PROFILE_UNAVAILABLE", "The extension profile is unavailable");
  }
  if (name == "extensions.inspectUnpacked") {
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, kFileReads, base::BindOnce(&Inspect, base::FilePath(*input->FindString("path"))),
        base::BindOnce(
            [](Done done, Inspected inspected) {
              if (!inspected.package) {
                return Fail(std::move(done), "ERR_EXTENSION_INVALID", inspected.error);
              }
              ReplyJson(std::move(done), base::Value(std::move(*inspected.package)));
            },
            std::move(done)));
    return;
  }
  if (name == "extensions.chooseFolder") {
    return ChooseFolder(std::move(done));
  }
  if (name == "extensions.resolveInstallPrompt") {
    return ResolvePrompt(profile, *input, std::move(done));
  }
  if (name == "extensions.actionStates") {
    return ActionStates(profile, *input, std::move(done));
  }
  SidePanelUrl(profile, *input, std::move(done));
}

void ExtensionViews::ActionStates(Profile* profile, const base::DictValue& input, Done done) {
  std::string code;
  content::WebContents* contents = ProfileTab(profile, *input.FindString("tabId"), &code);
  if (!contents) {
    return Fail(std::move(done), code, "The tab is not this profile's tab in this window");
  }
  content::BrowserContext* context = contents->GetBrowserContext();
  const int tab_id = extensions::ExtensionTabUtil::GetTabId(contents);
  base::DictValue states;
  for (const base::Value& id : *input.FindList("ids")) {
    const extensions::Extension* extension = Enabled(context, id.GetString());
    extensions::ExtensionAction* action =
        extension ? extensions::ExtensionActionManager::Get(context)->GetExtensionAction(*extension) : nullptr;
    if (!action) {
      continue;
    }
    gfx::Image icon = action->GetExplicitlySetIcon(tab_id);
    if (icon.IsEmpty()) {
      icon = action->GetDeclarativeIcon(tab_id);
    }
    const std::optional<std::string> badge_color = ext::HexColor(action->GetBadgeBackgroundColor(tab_id));
    const std::optional<std::string> badge_text_color = ext::HexColor(action->GetBadgeTextColor(tab_id));
    states.Set(id.GetString(),
               base::DictValue()
                   .Set("title", action->GetTitle(tab_id))
                   .Set("badgeText", ext::DisplayBadge(action->GetDisplayBadgeText(tab_id)))
                   .Set("badgeColor", badge_color ? base::Value(*badge_color) : base::Value())
                   .Set("badgeTextColor", badge_text_color ? base::Value(*badge_text_color) : base::Value())
                   .Set("popup", action->GetPopupUrl(tab_id).spec())
                   .Set("enabled", action->GetIsVisible(tab_id))
                   .Set("icon", PngDataUrl(icon)));
  }
  ReplyJson(std::move(done), base::Value(std::move(states)));
}

void ExtensionViews::SidePanelUrl(Profile* profile, const base::DictValue& input, Done done) {
  std::string code;
  content::WebContents* contents = ProfileTab(profile, *input.FindString("tabId"), &code);
  if (!contents) {
    return Fail(std::move(done), code, "The tab is not this profile's tab in this window");
  }
  content::BrowserContext* context = contents->GetBrowserContext();
  const extensions::Extension* extension = Enabled(context, *input.FindString("extensionId"));
  extensions::SidePanelService* service = extension ? extensions::SidePanelService::Get(context) : nullptr;
  if (!service) {
    return ReplyJson(std::move(done), base::Value());
  }
  const auto options = service->GetOptions(*extension, extensions::ExtensionTabUtil::GetTabId(contents));
  if (!options.path || !options.enabled.value_or(false)) {
    return ReplyJson(std::move(done), base::Value());
  }
  ReplyJson(std::move(done), base::Value(extension->GetResourceURL(*options.path).spec()));
}

void ExtensionViews::ChooseFolder(Done done) {
  if (BackgroundInstance()) {
    Trace("background instance: extensions.chooseFolder answered cancelled, no panel shown");
    return ReplyJson(std::move(done), base::Value());
  }
  BrowserWindowInterface* browser = host_->browser();
  NSWindow* window = browser && browser->GetWindow() ? browser->GetWindow()->GetNativeWindow().GetNativeNSWindow()
                                                     : nil;
  if (!window) {
    return Fail(std::move(done), "ERR_WINDOW_CLOSED", "The window closed before the folder picker opened");
  }
  if (choosing_) {
    return Fail(std::move(done), "ERR_FOLDER_PICKER_OPEN", "A folder dialog is already open in this window");
  }
  choosing_ = true;
  NSOpenPanel* panel = [NSOpenPanel openPanel];
  panel.canChooseFiles = NO;
  panel.canChooseDirectories = YES;
  panel.allowsMultipleSelection = NO;
  panel.message = @"Select the extension's folder";
  auto shared = std::make_shared<Done>(std::move(done));
  scoped_refptr<base::SequencedTaskRunner> runner = base::SequencedTaskRunner::GetCurrentDefault();
  base::WeakPtr<ExtensionViews> weak = GetWeakPtr();
  [panel beginSheetModalForWindow:window
                completionHandler:^(NSModalResponse response) {
                  const std::string path = response == NSModalResponseOK && panel.URL.isFileURL
                                               ? base::SysNSStringToUTF8(panel.URL.path)
                                               : std::string();
                  runner->PostTask(FROM_HERE, base::BindOnce(
                                                  [](base::WeakPtr<ExtensionViews> self, std::shared_ptr<Done> done,
                                                     std::string path) {
                                                    if (self) {
                                                      self->choosing_ = false;
                                                    }
                                                    if (*done) {
                                                      ReplyJson(std::move(*done), ext::ValidFolderPath(path)
                                                                                      ? base::Value(path)
                                                                                      : base::Value());
                                                    }
                                                  },
                                                  weak, shared, path));
                }];
}

void ExtensionViews::ResolvePrompt(Profile* profile, const base::DictValue& input, Done done) {
  const std::string request = *input.FindString("requestId");
  switch (Prompts().Check(request, host_->window_id(), ProfileName(profile))) {
    case ext::PromptResolve::kUnknown:
      return Fail(std::move(done), "ERR_EXTENSION_PROMPT_STALE", "No such pending install prompt");
    case ext::PromptResolve::kWrongWindow:
    case ext::PromptResolve::kWrongProfile:
      return Fail(std::move(done), "ERR_EXTENSION_PROMPT_STALE", "The prompt belongs to another window");
    case ext::PromptResolve::kResolved:
      break;
  }
  std::optional<PendingInstall> pending = Prompts().Take(request);
  const bool accepted = input.FindBool("accepted").value_or(false);
  if (pending) {
    Answer(std::move(*pending), accepted ? InstallResult::ACCEPTED : InstallResult::USER_CANCELED);
  }
  ReplyJson(std::move(done), base::Value());
}

}
