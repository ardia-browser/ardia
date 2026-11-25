#ifndef ARDIA_WIN_WEBUI_WEBUI_BRIDGE_H_
#define ARDIA_WIN_WEBUI_WEBUI_BRIDGE_H_

#include <cstdint>
#include <string>
#include <string_view>

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_ui_message_handler.h"

namespace ardia_win::webui {

class ShellHostView;

class ShellBridge : public content::WebUIMessageHandler,
                    public content::WebContentsObserver {
 public:
  ShellBridge(content::WebContents* shell, base::WeakPtr<ShellHostView> host);
  ShellBridge(const ShellBridge&) = delete;
  ShellBridge& operator=(const ShellBridge&) = delete;
  ~ShellBridge() override;

  uint64_t generation() const { return generation_; }
  bool Live();
  void Send(std::string_view module,
            std::string_view event,
            const base::Value& payload);
  void Reply(const std::string& id, bool success, base::Value response);
  base::WeakPtr<ShellBridge> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

 private:
  void RegisterMessages() override;
  void OnJavascriptDisallowed() override;
  void PrimaryPageChanged(content::Page& page) override;
  void PrimaryMainFrameRenderProcessGone(base::TerminationStatus status) override;

  void Activate();
  void Request(const base::ListValue& arguments);

  base::WeakPtr<ShellHostView> host_;
  uint64_t generation_ = 0;
  base::WeakPtrFactory<ShellBridge> weak_factory_{this};
};

}

#endif
