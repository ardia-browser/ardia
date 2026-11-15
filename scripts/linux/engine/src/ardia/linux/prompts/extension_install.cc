// Copyright 2026 Ardia. Apache-2.0.

#include <map>
#include <string>
#include <utility>

#include "ardia/core/ac_hooks.h"
#include "ardia/linux/modules/app_modules.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/linux/prompts/prompts.h"
#include "ardia/win/profiles.h"
#include "ardia/win/tab_state.h"
#include "base/base64.h"
#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/memory/ref_counted_memory.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/web_contents.h"
#include "extensions/browser/extension_install_prompt_client.h"
#include "extensions/browser/install_prompt_data.h"
#include "extensions/common/extension.h"

namespace ardia_linux {

namespace {

using InstallDone = extensions::ExtensionInstallPromptClient::DoneCallback;
using Payload = extensions::ExtensionInstallPromptClient::DoneCallbackPayload;
using Result = extensions::ExtensionInstallPromptClient::Result;

std::string PromptTypeName(extensions::InstallPromptData::PromptType type) {
  switch (type) {
    case extensions::InstallPromptData::INSTALL_PROMPT:
      return "install";
    case extensions::InstallPromptData::RE_ENABLE_PROMPT:
      return "re-enable";
    case extensions::InstallPromptData::PERMISSIONS_PROMPT:
      return "permissions";
    case extensions::InstallPromptData::EXTERNAL_INSTALL_PROMPT:
      return "external";
    case extensions::InstallPromptData::REMOTE_INSTALL_PROMPT:
      return "remote";
    case extensions::InstallPromptData::REPAIR_PROMPT:
      return "repair";
    default:
      return "other";
  }
}

struct PendingInstall {
  InstallDone done;
  base::WeakPtr<Profile> profile;
};

std::map<std::string, PendingInstall>& InstallPrompts() {
  static base::NoDestructor<std::map<std::string, PendingInstall>> prompts;
  return *prompts;
}

base::Value TabKeyOf(content::WebContents* contents) {
  ardia_win::TabState* state =
      contents ? ardia_win::TabState::FromWebContents(contents) : nullptr;
  return state && !state->key().empty() ? base::Value(state->key())
                                        : base::Value();
}

bool AskInstall(Profile* profile,
                content::WebContents* parent,
                const extensions::InstallPromptData& prompt,
                InstallDone* done) {
  const extensions::Extension* extension = prompt.extension();
  if (!profile || !extension || !done || done->is_null()) {
    return false;
  }
  if (prompt.type() == extensions::InstallPromptData::EXTERNAL_INSTALL_PROMPT) {
    content::GetUIThreadTaskRunner({})->PostTask(
        FROM_HERE, base::BindOnce(std::move(*done), Payload(Result::ABORTED)));
    return true;
  }
  static int last_id = 0;
  const std::string request_id = "install" + std::to_string(++last_id);
  base::ListValue permissions;
  for (size_t i = 0; i < prompt.GetPermissionCount(); ++i) {
    permissions.Append(base::UTF16ToUTF8(prompt.GetPermission(i)));
  }
  std::string icon;
  if (!prompt.icon().IsEmpty()) {
    if (auto png = prompt.icon().As1xPNGBytes(); png && png->size()) {
      icon = "data:image/png;base64," +
             base::Base64Encode(base::span<const uint8_t>(*png));
    }
  }
  base::DictValue payload;
  payload.Set("requestId", request_id);
  payload.Set("id", extension->id());
  payload.Set("name", extension->name());
  payload.Set("version", extension->VersionString());
  payload.Set("type", PromptTypeName(prompt.type()));
  payload.Set("icon", icon);
  payload.Set("permissions", std::move(permissions));
  payload.Set("tabId", TabKeyOf(parent));
  payload.Set("profile",
              ardia_win::NameOfProfile(profile->GetOriginalProfile()));
  InstallPrompts()[request_id] = {std::move(*done), profile->GetWeakPtr()};
  CountLinux("extensionInstallPrompts");
  content::GetUIThreadTaskRunner({})->PostTask(
      FROM_HERE, base::BindOnce(&EmitDomainEvent, "extensions", "installPrompt",
                                base::Value(std::move(payload))));
  return true;
}

void ResolveInstall(const std::string& request_id, bool accepted) {
  auto it = InstallPrompts().find(request_id);
  if (it == InstallPrompts().end()) {
    return;
  }
  PendingInstall pending = std::move(it->second);
  InstallPrompts().erase(it);
  if (!pending.profile) {
    return;
  }
  std::move(pending.done)
      .Run(Payload(accepted ? Result::ACCEPTED : Result::USER_CANCELED));
}

bool InstalledWithoutBubble(Profile*,
                            scoped_refptr<const extensions::Extension>,
                            const SkBitmap*) {
  return true;
}

void ResolveInstallPromptVerb(const std::string&,
                              base::DictValue args,
                              ModuleReply reply) {
  const std::string* request_id = args.FindString("requestId");
  if (!request_id) {
    ReplyError(std::move(reply), "extensions.resolveInstallPrompt: requestId",
               "ERR_BAD_ARGS");
    return;
  }
  ResolveInstall(*request_id, args.FindBool("accepted").value_or(false));
  ReplyNull(std::move(reply));
}

}

void InstallExtensionPrompts() {
  g_ardia_extension_install_prompt = &AskInstall;
  g_ardia_extension_installed = &InstalledWithoutBubble;
  download_crx_util::g_ardia_prompts_without_tab = true;
}

void AddExtensionInstallVerbs(DomainVerbs& verbs) {
  verbs.Add("extensions", "resolveInstallPrompt",
            base::BindRepeating(&ResolveInstallPromptVerb));
}

}
