// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_PROMPTS_PROMPTS_H_
#define ARDIA_LINUX_PROMPTS_PROMPTS_H_

#include <memory>
#include <optional>
#include <string>

#include "ardia/win/api.h"
#include "base/values.h"

namespace content {
class WebContents;
class WebContentsViewDelegate;
}

namespace ardia_linux {

class DomainVerbs;

void InstallPermissionPrompts();
void AddPermissionVerbs(DomainVerbs& verbs);

void InstallPasswordPrompts();
void InstallExtensionPrompts();
void AddExtensionInstallVerbs(DomainVerbs& verbs);
bool CallPasswordMethod(content::WebContents* contents,
                        const std::string& method,
                        const base::DictValue& args,
                        ardia_win::Reply& reply);

std::unique_ptr<content::WebContentsViewDelegate> CreatePageViewDelegate(
    content::WebContents* contents);
void AddContextMenuVerbs(DomainVerbs& verbs);

bool CallPromptMethod(content::WebContents* contents,
                      const std::string& method,
                      const base::DictValue& args,
                      ardia_win::Reply& reply);

}

#endif
