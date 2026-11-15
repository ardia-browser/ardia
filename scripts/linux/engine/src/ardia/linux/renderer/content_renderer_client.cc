#include "ardia/linux/renderer/content_renderer_client.h"

#include "ardia/linux/renderer/app_bridge_frame.h"
#include "content/public/common/url_constants.h"
#include "content/public/renderer/render_frame.h"
#include "third_party/blink/public/platform/web_string.h"
#include "third_party/blink/public/web/web_security_policy.h"

namespace ardia_linux {

ContentRendererClient::ContentRendererClient() = default;

ContentRendererClient::~ContentRendererClient() = default;

void ContentRendererClient::RenderThreadStarted() {
  ardiacore::ACContentRendererClient::RenderThreadStarted();
  blink::WebSecurityPolicy::RegisterURLSchemeAsSupportingFetchAPI(
      blink::WebString::FromAscii(content::kChromeUIScheme));
}

void ContentRendererClient::RenderFrameCreated(
    content::RenderFrame* render_frame) {
  ardiacore::ACContentRendererClient::RenderFrameCreated(render_frame);
  if (render_frame->IsMainFrame()) {
    new AppBridgeFrame(render_frame);
  }
}

}
