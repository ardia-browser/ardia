// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/prompts/page_helpers.h"

#include "ardia/linux/content_blocker.h"
#include "ardia/linux/page_channel/page_channel.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/linux/prompts/prompts.h"

namespace ardia_linux {

void AttachPageHelpers(content::WebContents* contents) {
  WatchBlockedRequests(contents);
}

void RegisterPageModules(ModuleRegistry& registry) {
  InstallPermissionPrompts();
  InstallPasswordPrompts();
  InstallExtensionPrompts();
  InstallExtensionActions();
  StartPageScript();
  DomainVerbs verbs;
  AddContentBlockerVerbs(verbs);
  AddPermissionVerbs(verbs);
  AddPasswordVerbs(verbs);
  AddContextMenuVerbs(verbs);
  AddExtensionInstallVerbs(verbs);
  AddExtensionActionVerbs(verbs);
  AddPageChannelVerbs(verbs);
  verbs.Register(registry);
}

bool CallPromptMethod(content::WebContents* contents,
                      const std::string& method,
                      const base::DictValue& args,
                      ardia_win::Reply& reply) {
  if (CallPageChannelMethod(contents, method, args)) {
    base::DictValue done;
    done.Set("ok", true);
    std::move(reply).Run(std::move(done));
    return true;
  }
  return CallExtensionActionMethod(contents, method, args, reply) ||
         CallPasswordMethod(contents, method, args, reply);
}

}
