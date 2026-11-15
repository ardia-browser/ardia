#ifndef ARDIA_LINUX_RENDERER_APP_BRIDGE_FRAME_H_
#define ARDIA_LINUX_RENDERER_APP_BRIDGE_FRAME_H_

#include <map>
#include <string>

#include "ardia/linux/ui_host/mojom/app_bridge.mojom.h"
#include "base/memory/weak_ptr.h"
#include "content/public/renderer/render_frame_observer.h"
#include "mojo/public/cpp/bindings/associated_receiver.h"
#include "mojo/public/cpp/bindings/associated_remote.h"
#include "v8/include/v8-forward.h"
#include "v8/include/v8-persistent-handle.h"

namespace gin {
class Arguments;
}

namespace ardia_linux {

class AppBridgeFrame : public content::RenderFrameObserver,
                       public mojom::AppBridgeClient {
 public:
  explicit AppBridgeFrame(content::RenderFrame* frame);
  AppBridgeFrame(const AppBridgeFrame&) = delete;
  AppBridgeFrame& operator=(const AppBridgeFrame&) = delete;
  ~AppBridgeFrame() override;

  void OnDestruct() override;
  void DidCreateScriptContext(v8::Local<v8::Context> context,
                              int32_t world_id) override;
  void WillReleaseScriptContext(v8::Local<v8::Context> context,
                                int32_t world_id) override;

  void Event(const std::string& module,
             const std::string& event,
             const std::string& json) override;

 private:
  struct Pending {
    v8::Global<v8::Promise::Resolver> resolver;
    bool unwrap = false;
    std::string module;
    std::string method;
  };

  bool IsAppDocument() const;
  void Install(v8::Local<v8::Context> context);
  void Forget();

  void Modules(gin::Arguments* args);
  void CallSync(bool unwrap, gin::Arguments* args);
  void Call(bool unwrap, gin::Arguments* args);
  void OnEvent(gin::Arguments* args);
  void RemoveListener(int id, gin::Arguments* args);
  void Answered(int id, const std::string& reply);

  mojo::AssociatedRemote<mojom::AppBridge> bridge_;
  mojo::AssociatedReceiver<mojom::AppBridgeClient> client_{this};
  v8::Global<v8::Context> context_;
  std::map<int, v8::Global<v8::Function>> listeners_;
  std::map<int, Pending> pending_;
  int last_id_ = 0;
  base::WeakPtrFactory<AppBridgeFrame> weak_factory_{this};
};

}

#endif
