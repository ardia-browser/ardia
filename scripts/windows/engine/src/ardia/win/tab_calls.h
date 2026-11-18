#ifndef ARDIA_WIN_TAB_CALLS_H_
#define ARDIA_WIN_TAB_CALLS_H_

#include <string>

#include "ardia/win/api.h"
#include "base/values.h"

namespace content {
class DevToolsAgentHostClient;
class WebContents;
}

namespace ardia_win {

void UnmarkEngineDevTools(content::WebContents* contents);

const content::DevToolsAgentHostClient* EngineDevToolsClient(
    content::WebContents* contents);

bool CallTabMethod(content::WebContents* contents,
                   const std::string& method,
                   const base::DictValue& args,
                   Reply& reply);

}

#endif
