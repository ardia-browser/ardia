#include "ardia/linux/renderer/content_renderer_client.h"

#include "ardia/linux/renderer/app_bridge_frame.h"
#include "content/public/renderer/render_frame.h"

namespace ardia_linux {

ContentRendererClient::ContentRendererClient() = default;

ContentRendererClient::~ContentRendererClient() = default;

void ContentRendererClient::RenderFrameCreated(
    content::RenderFrame* render_frame) {
  ardiacore::ACContentRendererClient::RenderFrameCreated(render_frame);
  if (render_frame->IsMainFrame()) {
    new AppBridgeFrame(render_frame);
  }
}

}
