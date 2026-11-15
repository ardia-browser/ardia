#ifndef ARDIA_LINUX_RENDERER_CONTENT_RENDERER_CLIENT_H_
#define ARDIA_LINUX_RENDERER_CONTENT_RENDERER_CLIENT_H_

#include "ardia/core/renderer/ac_content_renderer_client.h"

namespace ardia_linux {

class ContentRendererClient : public ardiacore::ACContentRendererClient {
 public:
  ContentRendererClient();
  ContentRendererClient(const ContentRendererClient&) = delete;
  ContentRendererClient& operator=(const ContentRendererClient&) = delete;
  ~ContentRendererClient() override;

  void RenderFrameCreated(content::RenderFrame* render_frame) override;
};

}

#endif
