#ifndef ARDIA_LINUX_UI_HOST_APP_BRIDGE_HOST_H_
#define ARDIA_LINUX_UI_HOST_APP_BRIDGE_HOST_H_

#include <string>
#include <string_view>

#include "ardia/linux/ui_host/modules.h"
#include "ardia/linux/ui_host/mojom/app_bridge.mojom.h"
#include "base/memory/weak_ptr.h"
#include "content/public/browser/document_user_data.h"
#include "mojo/public/cpp/bindings/associated_receiver.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "mojo/public/cpp/bindings/pending_associated_receiver.h"

namespace blink {
class AssociatedInterfaceRegistry;
}

namespace content {
class RenderFrameHost;
}

namespace ardia_linux {

inline constexpr char kBridgeSenderRefused[] = "ERR_LINUX_BRIDGE_SENDER";

void RegisterAppBridgeBinder(content::RenderFrameHost& frame,
                             blink::AssociatedInterfaceRegistry& registry);

class AppBridgeHost : public content::DocumentUserData<AppBridgeHost>,
                      public mojom::AppBridge,
                      public ModuleEventSink {
 public:
  AppBridgeHost(const AppBridgeHost&) = delete;
  AppBridgeHost& operator=(const AppBridgeHost&) = delete;
  ~AppBridgeHost() override;

  static void Bind(content::RenderFrameHost* frame,
                   mojo::PendingAssociatedReceiver<mojom::AppBridge> receiver);

  void Modules(ModulesCallback callback) override;
  void CallSync(const std::string& module,
                const std::string& method,
                const std::string& args,
                CallSyncCallback callback) override;
  void Call(const std::string& module,
            const std::string& method,
            const std::string& args,
            CallCallback callback) override;
  void SetClient(
      mojo::PendingAssociatedRemote<mojom::AppBridgeClient> client) override;

  void OnModuleEvent(std::string_view module,
                     std::string_view event,
                     const base::Value& payload) override;

 private:
  friend class content::DocumentUserData<AppBridgeHost>;
  DOCUMENT_USER_DATA_KEY_DECL();

  explicit AppBridgeHost(content::RenderFrameHost* frame);

  bool Accepts(std::string_view channel);

  mojo::AssociatedReceiver<mojom::AppBridge> receiver_{this};
  mojo::AssociatedRemote<mojom::AppBridgeClient> client_;
  bool refusal_logged_ = false;
  base::WeakPtrFactory<AppBridgeHost> weak_factory_{this};
};

std::string ReplyJson(const ModuleResult& result);

}

#endif
