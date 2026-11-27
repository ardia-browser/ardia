#ifndef ARDIA_WIN_HOOKS_H_
#define ARDIA_WIN_HOOKS_H_

#include <atomic>
#include <memory>
#include <optional>

#include "base/process/process.h"
#include "base/win/windows_types.h"
#include "ui/base/window_open_disposition.h"

namespace base {
class CommandLine;
class FilePath;
}

class BrowserFrameView;
class BrowserWindowInterface;
class RenderViewContextMenuBase;
class GURL;
class BrowserView;
class BrowserWidget;
class ChromeBrowserMainParts;

namespace blink::mojom {
class WindowFeatures;
}

namespace content {
class RenderFrameHost;
class WeakDocumentPtr;
class WebContents;
struct ContextMenuParams;
}

namespace url {
class Origin;
}

extern bool g_ardia_win_hosts_normal_windows;

extern bool g_ardia_win_shell_frame;

extern std::unique_ptr<BrowserFrameView> (*g_ardia_win_frame_view)(
    BrowserWidget* widget,
    BrowserView* browser_view);

extern void (*g_ardia_win_add_main_parts)(ChromeBrowserMainParts* main_parts);

extern HWND (*g_ardia_win_prompt_window)();

extern bool (*g_ardia_win_external_protocol_dialog)(
    const GURL& url,
    content::WebContents* web_contents,
    bool has_user_gesture,
    const std::optional<url::Origin>& initiating_origin,
    content::WeakDocumentPtr initiator_document);

extern bool (*g_ardia_win_open_as_offer)(
    BrowserWindowInterface* browser,
    WindowOpenDisposition disposition,
    const blink::mojom::WindowFeatures& features);

extern void (*g_ardia_win_offer_inserted)();

extern std::atomic<void (*)(const void* key,
                            const base::Process& process,
                            base::Process::Priority priority)>
    g_ardia_win_renderer_priority;

extern std::atomic<void (*)(const void* key)> g_ardia_win_renderer_gone;

extern std::unique_ptr<RenderViewContextMenuBase> (*g_ardia_win_context_menu)(
    content::RenderFrameHost& render_frame_host,
    const content::ContextMenuParams& params,
    bool is_paste_enabled,
    bool is_paste_and_match_style_enabled);

extern bool (*g_ardia_win_relaunched)(const base::CommandLine& command_line,
                                      const base::FilePath& cur_dir);

#endif
