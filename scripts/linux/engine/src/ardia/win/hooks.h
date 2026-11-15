#ifndef ARDIA_WIN_HOOKS_H_
#define ARDIA_WIN_HOOKS_H_

#include <optional>

namespace base {
class CommandLine;
class FilePath;
}

class GURL;

namespace content {
class WeakDocumentPtr;
class WebContents;
}

namespace url {
class Origin;
}

extern bool (*g_ardia_win_external_protocol_dialog)(
    const GURL& url,
    content::WebContents* web_contents,
    bool has_user_gesture,
    const std::optional<url::Origin>& initiating_origin,
    content::WeakDocumentPtr initiator_document);

extern bool (*g_ardia_win_relaunched)(const base::CommandLine& command_line,
                                      const base::FilePath& cur_dir);

#endif
