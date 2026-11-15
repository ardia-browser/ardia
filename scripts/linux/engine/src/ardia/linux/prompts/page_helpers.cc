// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/prompts/page_helpers.h"

#include "ardia/linux/content_blocker.h"
#include "ardia/linux/prompts/domains.h"
#include "ardia/linux/prompts/prompts.h"

namespace ardia_linux {

void AttachPageHelpers(content::WebContents* contents) {
  WatchBlockedRequests(contents);
}

void RegisterPageModules(ModuleRegistry& registry) {
  InstallPermissionPrompts();
  InstallPasswordPrompts();
  DomainVerbs verbs;
  AddContentBlockerVerbs(verbs);
  AddPermissionVerbs(verbs);
  verbs.Register(registry);
}

bool CallPromptMethod(content::WebContents* contents,
                      const std::string& method,
                      const base::DictValue& args,
                      ardia_win::Reply& reply) {
  return CallPasswordMethod(contents, method, args, reply);
}

}
