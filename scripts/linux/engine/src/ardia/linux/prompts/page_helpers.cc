// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/prompts/page_helpers.h"

#include "ardia/linux/content_blocker.h"
#include "ardia/linux/prompts/domains.h"

namespace ardia_linux {

void AttachPageHelpers(content::WebContents* contents) {
  WatchBlockedRequests(contents);
}

void RegisterPageModules(ModuleRegistry& registry) {
  DomainVerbs verbs;
  AddContentBlockerVerbs(verbs);
  verbs.Register(registry);
}

}
