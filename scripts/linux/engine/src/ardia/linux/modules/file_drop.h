// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_MODULES_FILE_DROP_H_
#define ARDIA_LINUX_MODULES_FILE_DROP_H_

#include <memory>

namespace content {
class WebContents;
class WebContentsViewDelegate;
}

namespace ardia_linux {

class ModuleRegistry;

bool IsAppUiContents(content::WebContents* web_contents);

std::unique_ptr<content::WebContentsViewDelegate> CreateAppUiViewDelegate(
    content::WebContents* web_contents);

void RegisterFileDropModule(ModuleRegistry& registry);

}

#endif
