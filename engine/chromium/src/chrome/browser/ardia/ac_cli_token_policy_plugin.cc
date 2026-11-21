// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <cstdint>
#include <initializer_list>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "base/functional/callback.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_plugin_input.h"
#include "chrome/browser/ardia/ac_cli_token_policy.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "components/sessions/core/session_id.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/child_process_security_policy.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_process_host.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/process_map.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace ardia {
namespace cli_token_policy_internal {

namespace {

const std::set<std::string_view>& PluginMethods() {
  static const base::NoDestructor<std::set<std::string_view>> methods({
      "Accessibility.enable",
      "Accessibility.getAXNodeAndAncestors",
      "Accessibility.getChildAXNodes",
      "Accessibility.getFullAXTree",
      "Accessibility.getPartialAXTree",
      "Accessibility.getRootAXNode",
      "Accessibility.queryAXTree",
      "Ardia.dispatchClick",
      "DOM.describeNode",
      "DOM.enable",
      "DOM.getAttributes",
      "DOM.getBoxModel",
      "DOM.getContentQuads",
      "DOM.getDocument",
      "DOM.getNodeForLocation",
      "DOM.getOuterHTML",
      "DOM.querySelector",
      "DOM.querySelectorAll",
      "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent",
      "Input.insertText",
      "Page.enable",
      "Page.getFrameTree",
      "Page.getLayoutMetrics",
      "Page.handleJavaScriptDialog",
      "Page.navigate",
      "Page.reload",
      "Page.setLifecycleEventsEnabled",
      "Target.attachToTarget",
      "Target.detachFromTarget",
      "Target.getTargetInfo",
      "Target.getTargets",
      "Target.setAutoAttach",
  });
  return *methods;
}

constexpr std::string_view kRuntimeHandles[] = {
    "objectId", "executionContextId", "contextId", "uniqueContextId",
};

std::string OnlyParams(const base::DictValue& params,
                       std::initializer_list<std::string_view> allowed) {
  for (auto [key, value] : params) {
    if (std::find(allowed.begin(), allowed.end(), key) == allowed.end()) {
      return base::StrCat({"with ", key});
    }
  }
  return std::string();
}

std::optional<std::string> StringParam(const base::DictValue& params,
                                       const char* name) {
  const std::string* value = params.FindString(name);
  return value ? std::optional<std::string>(*value) : std::nullopt;
}

std::string KeyEventRefusal(const base::DictValue& params) {
  PluginKeyEvent event;
  const base::Value* code = params.Find("windowsVirtualKeyCode");
  if (code) {
    if (!code->is_int()) {
      return "with a key code that isn't a number";
    }
    event.windows_key_code = code->GetInt();
  }
  event.has_native_key_code = params.Find("nativeVirtualKeyCode");
  event.has_system_key = params.Find("isSystemKey");
  if (const base::Value* modifiers = params.Find("modifiers")) {
    if (!modifiers->is_int()) {
      return "with modifiers that aren't an integer";
    }
    event.modifiers = modifiers->GetInt();
  }
  event.type = StringParam(params, "type");
  event.key = StringParam(params, "key");
  event.code = StringParam(params, "code");
  if (const base::Value* commands = params.Find("commands")) {
    event.commands_valid = commands->is_list();
    if (commands->is_list()) {
      for (const base::Value& command : commands->GetList()) {
        if (!command.is_string()) {
          event.commands_valid = false;
          break;
        }
        event.commands.push_back(command.GetString());
      }
    }
  }
  return PluginKeyRefusal(event);
}

std::string MouseEventRefusal(base::DictValue& params) {
  PluginMouseParams mouse;
  const std::string refusal = PluginMouseRefusal(ToPluginParams(params), &mouse);
  if (!refusal.empty()) {
    return refusal;
  }
  base::DictValue rebuilt;
  rebuilt.Set("type", mouse.type);
  rebuilt.Set("x", mouse.x);
  rebuilt.Set("y", mouse.y);
  rebuilt.Set("modifiers", mouse.modifiers);
  if (mouse.delta_x && mouse.delta_y) {
    rebuilt.Set("deltaX", *mouse.delta_x);
    rebuilt.Set("deltaY", *mouse.delta_y);
  }
  params = std::move(rebuilt);
  return std::string();
}

std::string ClickRefusal(base::DictValue& params) {
  PluginClickParams click;
  const std::string refusal = PluginClickRefusal(ToPluginParams(params), &click);
  if (!refusal.empty()) {
    return refusal;
  }
  base::DictValue rebuilt;
  rebuilt.Set("x", click.x);
  rebuilt.Set("y", click.y);
  rebuilt.Set("button", click.button);
  rebuilt.Set("clickCount", click.click_count);
  rebuilt.Set("modifiers", click.modifiers);
  params = std::move(rebuilt);
  return std::string();
}

bool FrameInTargetContents(const PluginScope& scope,
                           const std::string* target_id,
                           const std::string* frame_token) {
  if (!frame_token) {
    return true;
  }
  content::DevToolsAgentHost* host =
      target_id ? content::ArdiaDevToolsAgentHostForId(*target_id) : nullptr;
  content::WebContents* contents = host ? host->GetWebContents() : nullptr;
  if (!contents) {
    return false;
  }
  bool found = false;
  contents->ForEachRenderFrameHostWithAction(
      [&](content::RenderFrameHost* frame) {
        if (frame->GetDevToolsFrameToken().ToString() != *frame_token) {
          return content::RenderFrameHost::FrameIterationAction::kContinue;
        }
        found = frame->IsActive() && PluginMayAttachToFrame(scope, frame);
        return content::RenderFrameHost::FrameIterationAction::kStop;
      });
  return found;
}

const std::set<std::string_view>& PluginPageEvents() {
  static const base::NoDestructor<std::set<std::string_view>> events({
      "Page.documentOpened",
      "Page.domContentEventFired",
      "Page.frameAttached",
      "Page.frameDetached",
      "Page.frameNavigated",
      "Page.frameRequestedNavigation",
      "Page.frameStartedLoading",
      "Page.frameStartedNavigating",
      "Page.frameStoppedLoading",
      "Page.javascriptDialogClosed",
      "Page.javascriptDialogOpening",
      "Page.lifecycleEvent",
      "Page.loadEventFired",
      "Page.navigatedWithinDocument",
  });
  return *events;
}

std::string TargetRefusal(const PluginScope& scope,
                          const std::string& method,
                          base::DictValue& params,
                          const PluginCommandContext& context) {
  if (method == "Target.getTargets") {
    return std::string();
  }
  if (method == "Target.setAutoAttach") {
    if (context.on_root_session) {
      return "on the browser session";
    }
    if (params.FindBool("autoAttach") != false &&
        params.FindBool("flatten") != true) {
      return "without flatten";
    }
    params.Set("waitForDebuggerOnStart", false);
    return std::string();
  }
  if (method == "Target.detachFromTarget") {
    if (const std::string* session = params.FindString("sessionId")) {
      return context.session_known.Run(*session) ? std::string()
                                                 : "on that session";
    }
  }
  if (method == "Target.attachToTarget" &&
      params.FindBool("flatten") != true) {
    return "without flatten";
  }
  if (method == "Target.getTargetInfo" && !params.Find("targetId") &&
      !context.on_root_session) {
    return std::string();
  }
  return PluginMayAttachToTargetId(scope, params.FindString("targetId"))
             ? std::string()
             : "on a target outside the plugin's window";
}

bool IsWebProcess(content::RenderProcessHost* process) {
  if (!process) {
    return false;
  }
  if (content::ChildProcessSecurityPolicy::GetInstance()->HasWebUIBindings(
          process->GetID())) {
    return false;
  }
  extensions::ProcessMap* extension_processes =
      extensions::ProcessMap::Get(process->GetBrowserContext());
  return extension_processes && !extension_processes->Contains(process->GetID());
}

bool InScopeWindow(const PluginScope& scope, content::WebContents* contents) {
  if (!contents) {
    return false;
  }
  tabs::TabInterface* tab = tabs::TabInterface::MaybeGetFromContents(contents);
  BrowserWindowInterface* browser =
      tab ? tab->GetBrowserWindowInterface() : nullptr;
  Profile* profile = browser ? browser->GetProfile() : nullptr;
  return profile && browser->GetSessionID().id() == scope.window &&
         profile->GetPath() == scope.profile &&
         profile->IsOffTheRecord() == scope.off_the_record;
}

bool IsWebFrameInScope(const PluginScope& scope,
                       content::RenderFrameHost* frame) {
  if (!frame || !IsWebProcess(frame->GetProcess()) ||
      !InScopeWindow(scope, content::WebContents::FromRenderFrameHost(frame))) {
    return false;
  }
  const GURL& url = frame->GetLastCommittedURL();
  return url.is_empty() || IsWebUrl(url);
}

}

bool IsWebUrl(const GURL& url) {
  if (url.SchemeIsHTTPOrHTTPS() || url.SchemeIs(url::kDataScheme) ||
      url.IsAboutBlank() || url.IsAboutSrcdoc()) {
    return true;
  }
  if (url.SchemeIsBlob()) {
    const url::Origin origin = url::Origin::Create(url);
    return !origin.opaque() && (origin.scheme() == url::kHttpScheme ||
                                origin.scheme() == url::kHttpsScheme);
  }
  return false;
}

bool IsWebDestination(std::string_view spec) {
  const GURL url(spec);
  return url.is_valid() && IsWebUrl(url) && !url.IsAboutSrcdoc();
}

bool PluginTargetInScope(const PluginScope& scope,
                         content::DevToolsAgentHost* host) {
  if (!host) {
    return false;
  }
  const std::string type = host->GetType();
  if (type != content::DevToolsAgentHost::kTypePage &&
      type != content::DevToolsAgentHost::kTypeTab &&
      type != content::DevToolsAgentHost::kTypeFrame) {
    return false;
  }
  content::WebContents* contents = host->GetWebContents();
  if (!InScopeWindow(scope, contents) ||
      !IsWebProcess(host->GetProcessHost())) {
    return false;
  }
  const GURL url = host->GetURL();
  if (!url.is_empty() && !IsWebUrl(url)) {
    return false;
  }
  return type == content::DevToolsAgentHost::kTypeFrame ||
         IsWebFrameInScope(scope, contents->GetPrimaryMainFrame());
}

bool PluginMayAttachToFrame(const PluginScope& scope,
                            content::RenderFrameHost* frame) {
  return IsWebFrameInScope(scope, frame);
}

bool PluginMayAttachToTargetId(const PluginScope& scope,
                               const std::string* target_id) {
  return target_id &&
         PluginTargetInScope(
             scope, content::ArdiaDevToolsAgentHostForId(*target_id));
}

void ScrubPluginTargetInfo(const PluginScope& scope, base::DictValue* info) {
  if (!info) {
    return;
  }
  info->Remove("browserContextId");
  const std::string* opener = info->FindString("openerId");
  const bool opener_in_scope = opener && PluginMayAttachToTargetId(scope, opener);
  if (!opener_in_scope ||
      !FrameInTargetContents(scope, opener, info->FindString("openerFrameId"))) {
    info->Remove("openerFrameId");
  }
  if (!opener_in_scope) {
    info->Remove("openerId");
    if (info->Find("canAccessOpener")) {
      info->Set("canAccessOpener", false);
    }
  }
  const std::string* parent = info->FindString("parentId");
  if (parent && !PluginMayAttachToTargetId(scope, parent)) {
    info->Remove("parentId");
    info->Remove("parentFrameId");
  } else if (!FrameInTargetContents(scope, info->FindString("targetId"),
                                    info->FindString("parentFrameId"))) {
    info->Remove("parentFrameId");
  }
}

PluginParams ToPluginParams(const base::DictValue& params) {
  PluginParams converted;
  for (auto [name, value] : params) {
    PluginParam param;
    if (value.is_int()) {
      param.kind = PluginParam::Kind::kInt;
      param.int_value = value.GetInt();
    } else if (value.is_double()) {
      param.kind = PluginParam::Kind::kDouble;
      param.double_value = value.GetDouble();
    } else if (value.is_string()) {
      param.kind = PluginParam::Kind::kString;
      param.string_value = value.GetString();
    }
    converted[name] = std::move(param);
  }
  return converted;
}

bool PluginForwardsEvent(std::string_view method) {
  return PluginPageEvents().contains(method) || method.starts_with("DOM.") ||
         method.starts_with("Accessibility.");
}

std::string PluginRefusal(const PluginScope& scope,
                          const std::string& method,
                          base::DictValue& params,
                          const PluginCommandContext& context) {
  if (!PluginMethods().contains(method)) {
    return "here";
  }
  for (std::string_view handle : kRuntimeHandles) {
    if (params.Find(handle)) {
      return base::StrCat({"with ", handle});
    }
  }
  const std::string_view domain =
      std::string_view(method).substr(0, method.find('.'));
  if (domain == "Target") {
    return TargetRefusal(scope, method, params, context);
  }
  if (method == "Input.dispatchKeyEvent") {
    return KeyEventRefusal(params);
  }
  if (method == "Input.dispatchMouseEvent") {
    return MouseEventRefusal(params);
  }
  if (method == kDispatchClick) {
    return ClickRefusal(params);
  }
  if (method == "Page.navigate") {
    std::string refusal = OnlyParams(params, {"url"});
    if (!refusal.empty()) {
      return refusal;
    }
    const std::string* url = params.FindString("url");
    const GURL destination(url ? *url : std::string());
    return destination.is_valid() && (destination.SchemeIsHTTPOrHTTPS() ||
                                      destination.IsAboutBlank())
               ? std::string()
               : "to that URL";
  }
  if (method == "Page.reload") {
    return OnlyParams(params, {"ignoreCache", "loaderId"});
  }
  if (method == "Page.handleJavaScriptDialog") {
    return OnlyParams(params, {"accept", "promptText"});
  }
  return std::string();
}

}

bool PluginMayConnectTo(const PluginScope& scope,
                        content::DevToolsAgentHost* host) {
  return (host && host->GetType() == content::DevToolsAgentHost::kTypeBrowser) ||
         cli_token_policy_internal::PluginTargetInScope(scope, host);
}

}
