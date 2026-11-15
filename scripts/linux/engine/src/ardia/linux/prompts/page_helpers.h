// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_PROMPTS_PAGE_HELPERS_H_
#define ARDIA_LINUX_PROMPTS_PAGE_HELPERS_H_

namespace content {
class WebContents;
}

namespace ardia_linux {

class ModuleRegistry;

void AttachPageHelpers(content::WebContents* contents);

void RegisterPageModules(ModuleRegistry& registry);

}

#endif
