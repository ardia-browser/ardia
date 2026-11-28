#include <initializer_list>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "ardia/linux/ac_linux_extension_service.h"
#include "ardia/linux/ac_linux_extension_views.h"
#include "ardia/linux/ac_linux_extensions.h"
#include "ardia/win/profiles.h"
#include "ardia/win/webui/webui_extension_policy.h"
#include "ardia/win/webui/webui_host_internal.h"
#include "ardia/win/webui/webui_host_view.h"
#include "ardia/win/webui/webui_windows.h"
#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/strings/string_number_conversions.h"
#include "chrome/browser/extensions/extension_action_runner.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "components/zoom/zoom_controller.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_action.h"
#include "extensions/browser/extension_action_manager.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/browser/extension_util.h"
#include "extensions/common/extension.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/image/image.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/gfx/image/image_skia_rep.h"

namespace ardia {

Profile* LinuxExtensionViewProfile(Profile* page_profile,
                                   std::string_view requested,
                                   std::string* code) {
  if (!page_profile) {
    *code = "ERR_WINDOW_CLOSED";
    return nullptr;
  }
  if (page_profile->IsOffTheRecord() && page_profile->ShutdownStarted()) {
    *code = "ERR_PROFILE_ENDING";
    return nullptr;
  }
  if (!ardia_win::webui::SomeWindowIsNamed(page_profile, requested)) {
    *code = "ERR_PROFILE_WINDOW";
    return nullptr;
  }
  return page_profile;
}

}

namespace ardia_win::webui {

std::string ArdiaProfileName(Profile* profile) {
  if (!profile) {
    return std::string();
  }
  return profile == WindowRegistry::Get().app_profile()
             ? std::string(kAppProfileName)
             : NameOfProfile(profile);
}

std::string ShellHostView::WindowProfileName(Profile* profile) const {
  if (!profile) {
    return std::string();
  }
  if (private_window() && profile == page_profile()) {
    return config_.page_profile;
  }
  return profile->IsOffTheRecord() ? std::string() : ArdiaProfileName(profile);
}

bool SomeWindowIsNamed(Profile* profile, std::string_view requested) {
  for (ShellHostView* host : WindowRegistry::Get().Hosts()) {
    if (webui_extension::ViewProfileMatches(requested,
                                            host->WindowProfileName(profile))) {
      return true;
    }
  }
  return false;
}

namespace {

namespace ext = ardia::linux_extensions;
namespace policy = webui_extension;

bool NumbersInRange(const base::DictValue* dict,
                    std::initializer_list<std::string_view> keys) {
  if (!dict) {
    return true;
  }
  for (std::string_view key : keys) {
    const base::Value* value = dict->Find(key);
    if (value && (!value->is_int() && !value->is_double())) {
      return false;
    }
    if (value && !policy::ViewCoordinateInRange(value->GetDouble())) {
      return false;
    }
  }
  return true;
}

bool ViewGeometryInRange(const std::string& method,
                         const base::DictValue& args) {
  if (method == "extensionView.viewport") {
    return NumbersInRange(args.FindDict("rect"),
                          {"x", "y", "width", "height"});
  }
  if (method == "extensionView.place") {
    return NumbersInRange(args.FindDict("anchor"), {"right", "top"}) &&
           NumbersInRange(args.FindDict("room"), {"left", "right", "bottom"}) &&
           NumbersInRange(&args, {"radius", "decoratedScale"});
  }
  return true;
}

const extensions::Extension* EnabledExtension(content::BrowserContext* context,
                                              const std::string& id) {
  const extensions::Extension* extension =
      extensions::ExtensionRegistry::Get(context)->enabled_extensions().GetByID(
          id);
  if (extension && context->IsOffTheRecord() &&
      !extensions::util::IsIncognitoEnabled(id, context)) {
    return nullptr;
  }
  return extension;
}

std::string PngDataUrl(const gfx::Image& image) {
  if (image.IsEmpty()) {
    return "";
  }
  const gfx::ImageSkiaRep& rep = image.ToImageSkia()->GetRepresentation(2.0f);
  const auto png = gfx::PNGCodec::EncodeBGRASkBitmap(rep.GetBitmap(), false);
  return png ? "data:image/png;base64," + base::Base64Encode(*png) : "";
}

double ShellZoom(content::WebContents* shell) {
  return shell ? blink::ZoomLevelToZoomFactor(
                     zoom::ZoomController::GetZoomLevelForWebContents(shell))
               : 1.0;
}

}

std::string ExecuteExtensionAction(content::WebContents* contents,
                                   const base::ListValue* values) {
  if (!contents || !values || values->size() != 1 || !(*values)[0].is_string() ||
      !ext::ValidExtensionId((*values)[0].GetString())) {
    return "";
  }
  const extensions::Extension* extension =
      EnabledExtension(contents->GetBrowserContext(), (*values)[0].GetString());
  auto* runner = extensions::ExtensionActionRunner::GetForWebContents(contents);
  const extensions::ExtensionAction* action =
      extension ? extensions::ExtensionActionManager::Get(
                      contents->GetBrowserContext())
                      ->GetExtensionAction(*extension)
                : nullptr;
  if (!action || !runner) {
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

Profile* ShellHostView::ActiveProfile() const {
  Profile* active = active_profile_.get();
  if (active && MemberFor(active) && !ArdiaProfileName(active).empty()) {
    return active;
  }
  for (BrowserWindowInterface* member : Members()) {
    if (ArdiaProfileName(member->GetProfile()) == config_.page_profile) {
      return member->GetProfile();
    }
  }
  return page_profile();
}

BrowserWindowInterface* ShellHostView::ActiveMember() const {
  BrowserWindowInterface* member = MemberFor(ActiveProfile());
  return member ? member : browser_.get();
}

void ShellHostView::DropExtensionSurfaces() {
  extension_surfaces_member_ = nullptr;
  extension_surfaces_.reset();
  extension_view_ids_.Clear();
}

void ShellHostView::RetireExtensionViews(uint64_t generation) {
  extension_view_ids_.ForgetOlderThan(generation);
  if (extension_surfaces_) {
    extension_surfaces_->RetireOlderThan(generation);
  }
}

void ShellHostView::EmitExtensionView(int internal, base::DictValue event) {
  const std::optional<int> external = extension_view_ids_.External(internal);
  if (!external) {
    return;
  }
  const std::string* type = event.FindString("type");
  if (type && *type == "windowClose") {
    extension_view_ids_.Forget(*external);
  }
  Emit("ArdiaExtensionView", base::NumberToString(*external),
       base::Value(std::move(event)));
}

void ShellHostView::InvokeExtensionView(const std::string& method,
                                        const base::DictValue& args,
                                        Done done) {
  if (is_utility()) {
    return std::move(done).Run(
        false,
        Failure("ERR_UNKNOWN_CALL", "Extension views need a browser window"));
  }
  if (!ViewGeometryInRange(method, args)) {
    return std::move(done).Run(
        false, Failure("ERR_EXTENSION_VIEW_REQUEST",
                       "Extension view coordinates are out of range"));
  }
  ardia::LinuxExtensionSurfaces* surfaces = ExtensionSurfaces();
  if (!surfaces) {
    return std::move(done).Run(
        false, Failure("ERR_WINDOW_CLOSED", "The window is closing"));
  }
  Profile* profile = ActiveProfile();
  const uint64_t generation = renderer_generation_;
  const double zoom = ShellZoom(shell_contents());
  if (method == "extensionView.create") {
    const std::string* requested = args.FindString("profile");
    if (requested && !webui_extension::ViewProfileMatches(
                         *requested, WindowProfileName(profile))) {
      return std::move(done).Run(
          false, Failure("ERR_PROFILE_WINDOW",
                         "Extension views need this window's own profile"));
    }
    return surfaces->Invoke(
        method, args, profile, generation, zoom,
        base::BindOnce(
            [](base::WeakPtr<ShellHostView> host, uint64_t generation,
               Done done, bool ok, base::Value reply) {
              const std::optional<int> internal =
                  ok && reply.is_dict() ? reply.GetDict().FindInt("id")
                                        : std::nullopt;
              if (!internal) {
                return std::move(done).Run(ok, std::move(reply));
              }
              const std::optional<int> external =
                  host ? host->extension_view_ids_.Assign(*internal, generation)
                       : std::nullopt;
              if (!external) {
                return std::move(done).Run(
                    false, Failure("ERR_EXTENSION_VIEW_LIMIT",
                                   "Too many extension views in this window"));
              }
              std::move(done).Run(
                  true, base::Value(base::DictValue().Set("id", *external)));
            },
            GetWeakPtr(), generation, std::move(done)));
  }
  const base::Value* id = args.Find("id");
  const int external = id && id->is_int() ? id->GetInt() : 0;
  base::DictValue routed = args.Clone();
  routed.Set("id", extension_view_ids_.Internal(external));
  if (method == "extensionView.release") {
    extension_view_ids_.Forget(external);
  }
  surfaces->Invoke(method, routed, profile, generation, zoom, std::move(done));
}

ardia::LinuxExtensionSurfaces* ShellHostView::ExtensionSurfaces() {
  BrowserWindowInterface* member = ActiveMember();
  if (extension_surfaces_ && extension_surfaces_member_ != member) {
    DropExtensionSurfaces();
  }
  if (!extension_surfaces_ && browser_ && member) {
    extension_surfaces_member_ = member;
    extension_surfaces_ = std::make_unique<ardia::LinuxExtensionSurfaces>(
        member, this,
        base::BindRepeating(
            [](base::WeakPtr<ShellHostView> host, int id,
               base::DictValue event) {
              if (host) {
                host->EmitExtensionView(id, std::move(event));
              }
            },
            GetWeakPtr()),
        base::BindRepeating(
            [](base::WeakPtr<ShellHostView> host) {
              return ShellZoom(host ? host->shell_contents() : nullptr);
            },
            GetWeakPtr()),
        base::BindRepeating(
            [](base::WeakPtr<ShellHostView> host) -> gfx::NativeView {
              return host && host->shell_contents()
                         ? host->shell_contents()->GetNativeView()
                         : gfx::NativeView();
            },
            GetWeakPtr()));
    extension_surfaces_->SetRestack(base::BindRepeating(
        [](base::WeakPtr<ShellHostView> host) {
          if (host) {
            host->Restack();
          }
        },
        GetWeakPtr()));
  }
  return extension_surfaces_.get();
}

void ShellHostView::ExtensionActionStates(const std::string& profile,
                                          const base::Value* args,
                                          Done done) {
  if (!args || !args->is_string() ||
      !policy::ActionStatesRequestFits(args->GetString())) {
    return std::move(done).Run(
        false, Failure("ERR_EXTENSION_REQUEST",
                       "Extension states need JSON text of at most 64 KiB"));
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(args->GetString(), base::JSON_PARSE_RFC, 8);
  const base::DictValue* input =
      parsed && parsed->is_dict() ? &parsed->GetDict() : nullptr;
  const std::string* tab_key = input ? input->FindString("tabId") : nullptr;
  const base::ListValue* ids = input ? input->FindList("ids") : nullptr;
  if (!tab_key || tab_key->empty() || tab_key->size() > ext::kMaxTabKey ||
      !ids || ids->size() > ext::kMaxActionIds) {
    return std::move(done).Run(
        false, Failure("ERR_EXTENSION_REQUEST",
                       "A tab and at most 64 extension ids are required"));
  }
  PageBinding* binding = BindingForKey(*tab_key);
  content::WebContents* contents = binding ? binding->contents() : nullptr;
  if (!contents) {
    return std::move(done).Run(
        false, Failure("ERR_TAB_UNAVAILABLE", "The tab is not in this window"));
  }
  if (binding->profile() != profile) {
    return std::move(done).Run(
        false, Failure("ERR_PROFILE_WINDOW",
                       "The tab is not this profile's tab in this window"));
  }
  content::BrowserContext* context = contents->GetBrowserContext();
  const int tab_id = extensions::ExtensionTabUtil::GetTabId(contents);
  base::DictValue states;
  for (const base::Value& id : *ids) {
    if (!id.is_string() || !ext::ValidExtensionId(id.GetString())) {
      return std::move(done).Run(
          false, Failure("ERR_EXTENSION_REQUEST", "Invalid extension id"));
    }
    const extensions::Extension* extension =
        EnabledExtension(context, id.GetString());
    extensions::ExtensionAction* action =
        extension ? extensions::ExtensionActionManager::Get(context)
                        ->GetExtensionAction(*extension)
                  : nullptr;
    if (!action) {
      continue;
    }
    gfx::Image icon = action->GetExplicitlySetIcon(tab_id);
    if (icon.IsEmpty()) {
      icon = action->GetDeclarativeIcon(tab_id);
    }
    ext::ActionFacts facts;
    facts.title = action->GetTitle(tab_id);
    facts.badge = action->GetDisplayBadgeText(tab_id);
    facts.badge_color = action->GetBadgeBackgroundColor(tab_id);
    facts.badge_text_color = action->GetBadgeTextColor(tab_id);
    facts.popup = action->GetPopupUrl(tab_id).spec();
    facts.enabled = action->GetIsVisible(tab_id);
    facts.icon = PngDataUrl(icon);
    states.Set(id.GetString(), ext::ActionState(facts));
  }
  std::move(done).Run(true,
                      base::Value(base::WriteJson(states).value_or("{}")));
}

}
