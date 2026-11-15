// Copyright 2026 Ardia. Apache-2.0.

#ifndef ARDIA_LINUX_PROMPTS_PROMPTS_H_
#define ARDIA_LINUX_PROMPTS_PROMPTS_H_

#include <optional>
#include <string>

#include "ardia/win/api.h"
#include "base/values.h"

namespace content {
class WebContents;
}

namespace ardia_linux {

class DomainVerbs;

void InstallPermissionPrompts();
void AddPermissionVerbs(DomainVerbs& verbs);

void InstallPasswordPrompts();
bool CallPasswordMethod(content::WebContents* contents,
                        const std::string& method,
                        const base::DictValue& args,
                        ardia_win::Reply& reply);

bool CallPromptMethod(content::WebContents* contents,
                      const std::string& method,
                      const base::DictValue& args,
                      ardia_win::Reply& reply);

}

#endif
