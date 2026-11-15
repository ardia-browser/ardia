// Copyright 2026 Ardia. Apache-2.0.

#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "ardia/core/ac_hooks.h"
#include "ardia/linux/host/extension_views.h"
#include "ardia/linux/host/host.h"
#include "ardia/linux/log.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/linux/prompts/prompts.h"
#include "ardia/win/tab_state.h"
#include "base/base64.h"
#include "base/functional/bind.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "chrome/browser/extensions/api/side_panel/side_panel_service.h"
#include "chrome/browser/extensions/extension_action_runner.h"
#include "chrome/browser/ui/browser.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/sessions/content/session_tab_helper.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_action.h"
#include "extensions/browser/extension_action_manager.h"
#include "extensions/browser/extension_registry.h"
#include "extensions/common/extension.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/gfx/image/image.h"
#include "ui/gfx/image/image_skia.h"
#include "ui/gfx/image/image_skia_rep.h"

namespace ardia_linux {

namespace {

constexpr char kOpenPopupFailed[] = "Failed to open popup.";

std::string KeyOf(content::WebContents* contents) {
  ardia_win::TabState* state =
      contents ? ardia_win::TabState::FromWebContents(contents) : nullptr;
  return state ? state->key() : std::string();
}

base::Value KeyValue(content::WebContents* contents) {
  const std::string key = KeyOf(contents);
  return key.empty() ? base::Value() : base::Value(key);
}

content::WebContents* TabWithKey(const std::string& key) {
  content::WebContents* found = nullptr;
  if (key.empty()) {
    return nullptr;
  }
  ForEachCurrentBrowserWindowInterfaceOrderedByActivation(
      [&](BrowserWindowInterface* browser) {
        TabStripModel* model = browser->GetTabStripModel();
        for (int i = 0; model && i < model->count(); ++i) {
          content::WebContents* contents = model->GetWebContentsAt(i);
          if (KeyOf(contents) == key) {
            found = contents;
            return false;
          }
        }
        return true;
      });
  return found;
}

const extensions::Extension* EnabledExtension(content::WebContents* contents,
                                              const std::string& id) {
  return contents ? extensions::ExtensionRegistry::Get(
                        contents->GetBrowserContext())
                        ->enabled_extensions()
                        .GetByID(id)
                  : nullptr;
}

base::Value HexColor(SkColor color) {
  if (!SkColorGetA(color)) {
    return base::Value();
  }
  return base::Value(base::StringPrintf("#%02x%02x%02x", SkColorGetR(color),
                                        SkColorGetG(color),
                                        SkColorGetB(color)));
}

std::string PngDataUrl(const gfx::Image& image) {
  if (image.IsEmpty()) {
    return std::string();
  }
  const gfx::ImageSkiaRep& rep =
      image.ToImageSkia()->GetRepresentation(2.0f);
  std::optional<std::vector<uint8_t>> png =
      gfx::PNGCodec::EncodeBGRASkBitmap(rep.GetBitmap(), false);
  return png ? "data:image/png;base64," + base::Base64Encode(*png)
             : std::string();
}

std::string ExecuteAction(content::WebContents* contents,
                          const std::string& extension_id) {
  const extensions::Extension* extension =
      EnabledExtension(contents, extension_id);
  auto* runner =
      contents ? extensions::ExtensionActionRunner::GetForWebContents(contents)
               : nullptr;
  if (!extension || !runner) {
    return "none";
  }
  CountLinux("extensionActionRuns");
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

void ActionStatesVerb(const std::string&,
                      base::DictValue args,
                      ModuleReply reply) {
  base::DictValue states;
  const std::string* key = args.FindString("tabId");
  content::WebContents* contents = key ? TabWithKey(*key) : nullptr;
  const base::ListValue* ids = args.FindList("ids");
  if (!contents || !ids) {
    ReplyJson(std::move(reply), base::Value(std::move(states)));
    return;
  }
  content::BrowserContext* context = contents->GetBrowserContext();
  const int tab_id = sessions::SessionTabHelper::IdForTab(contents).id();
  for (const base::Value& id : *ids) {
    if (!id.is_string()) {
      continue;
    }
    const extensions::Extension* extension =
        EnabledExtension(contents, id.GetString());
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
    const std::string badge = action->GetDisplayBadgeText(tab_id);
    base::DictValue state;
    state.Set("title", action->GetTitle(tab_id));
    state.Set("badgeText",
              base::StartsWith(badge, "<<") ? std::string() : badge);
    state.Set("badgeColor", HexColor(action->GetBadgeBackgroundColor(tab_id)));
    state.Set("badgeTextColor", HexColor(action->GetBadgeTextColor(tab_id)));
    state.Set("popup", action->GetPopupUrl(tab_id).spec());
    state.Set("enabled", action->GetIsVisible(tab_id));
    state.Set("icon", PngDataUrl(icon));
    states.Set(id.GetString(), std::move(state));
  }
  ReplyJson(std::move(reply), base::Value(std::move(states)));
}

void SidePanelUrlVerb(const std::string&,
                      base::DictValue args,
                      ModuleReply reply) {
  const std::string* key = args.FindString("tabId");
  const std::string* extension_id = args.FindString("extensionId");
  content::WebContents* contents = key ? TabWithKey(*key) : nullptr;
  const extensions::Extension* extension =
      extension_id ? EnabledExtension(contents, *extension_id) : nullptr;
  auto* service = extension ? extensions::SidePanelService::Get(
                                  contents->GetBrowserContext())
                            : nullptr;
  if (!service) {
    ReplyNull(std::move(reply));
    return;
  }
  auto options = service->GetOptions(
      *extension, sessions::SessionTabHelper::IdForTab(contents).id());
  if (!options.path || !options.enabled.value_or(false)) {
    ReplyNull(std::move(reply));
    return;
  }
  ReplyJson(std::move(reply),
            base::Value(extension->GetResourceURL(*options.path).spec()));
}

std::optional<bool> OpenActionPopup(BrowserWindowInterface& browser,
                                    const extensions::Extension& extension,
                                    ShowPopupCallback& callback,
                                    std::string* error) {
  if (!Host::Get()->Keeps(&browser)) {
    return std::nullopt;
  }
  tabs::TabInterface* tab = browser.GetActiveTabInterface();
  content::WebContents* contents = tab ? tab->GetContents() : nullptr;
  if (KeyOf(contents).empty() || !ModuleRegistry::Exists()) {
    Note("extensions", "action.openPopup: no shown tab in the window");
    *error = kOpenPopupFailed;
    return false;
  }
  ExpectActionPopup(&browser, extension.id(), std::move(callback));
  base::DictValue request;
  request.Set("tabId", KeyValue(contents));
  request.Set("extensionId", extension.id());
  CountLinux("extensionOpenPopupCalls");
  EmitDomainEvent("extensions", "actionPopup",
                  base::Value(std::move(request)));
  return true;
}

bool ToggleSidePanel(BrowserWindowInterface* browser,
                     content::WebContents* web_contents,
                     const extensions::ExtensionId& extension_id,
                     bool open) {
  content::WebContents* contents = web_contents;
  if (!contents && browser && browser->GetActiveTabInterface()) {
    contents = browser->GetActiveTabInterface()->GetContents();
  }
  if (KeyOf(contents).empty()) {
    return false;
  }
  base::DictValue request;
  request.Set("tabId", KeyValue(contents));
  request.Set("extensionId", extension_id);
  request.Set("open", open);
  EmitDomainEvent("extensions", "sidePanel", base::Value(std::move(request)));
  return true;
}

}

void InstallExtensionActions() {
  g_ardia_open_action_popup = &OpenActionPopup;
  g_ardia_extension_side_panel = &ToggleSidePanel;
}

void AddExtensionActionVerbs(DomainVerbs& verbs) {
  verbs.Add("extensions", "actionStates",
            base::BindRepeating(&ActionStatesVerb));
  verbs.Add("extensions", "sidePanelUrl",
            base::BindRepeating(&SidePanelUrlVerb));
}

bool CallExtensionActionMethod(content::WebContents* contents,
                               const std::string& method,
                               const base::DictValue& args,
                               ardia_win::Reply& reply) {
  if (method != "executeExtensionAction") {
    return false;
  }
  const std::string* extension_id = args.FindString("extensionId");
  base::DictValue result;
  result.Set("result", ExecuteAction(contents, extension_id ? *extension_id
                                                            : std::string()));
  std::move(reply).Run(std::move(result));
  return true;
}

}
