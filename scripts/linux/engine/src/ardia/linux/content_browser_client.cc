// Copyright 2026 Ardia. Apache-2.0.

#include "ardia/linux/content_browser_client.h"

#include <utility>

#include "ardia/linux/main_parts.h"
#include "ardia/linux/modules/file_drop.h"
#include "ardia/linux/ui_host/ui_host_parts.h"
#include "ardia/linux/prompts/prompts.h"
#include "chrome/browser/chrome_browser_main.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/browser_main_parts.h"
#include "content/public/browser/web_contents_view_delegate.h"
#include "services/cert_verifier/public/mojom/cert_verifier_service_factory.mojom.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "third_party/blink/public/mojom/window_features/window_features.mojom.h"
#include "url/gurl.h"

namespace ardia_linux {

ContentBrowserClient::ContentBrowserClient() = default;

ContentBrowserClient::~ContentBrowserClient() = default;

std::unique_ptr<content::BrowserMainParts>
ContentBrowserClient::CreateBrowserMainParts(bool is_integration_test) {
  std::unique_ptr<content::BrowserMainParts> parts =
      ChromeContentBrowserClient::CreateBrowserMainParts(is_integration_test);
  static_cast<ChromeBrowserMainParts*>(parts.get())
      ->AddParts(std::make_unique<MainParts>());
  return parts;
}

void ContentBrowserClient::RegisterAssociatedInterfaceBindersForRenderFrameHost(
    content::RenderFrameHost& render_frame_host,
    blink::AssociatedInterfaceRegistry& associated_registry) {
  ChromeContentBrowserClient::
      RegisterAssociatedInterfaceBindersForRenderFrameHost(
          render_frame_host, associated_registry);
  RegisterUiHostBinders(render_frame_host, associated_registry);
}

void ContentBrowserClient::CreateThrottlesForNavigation(
    content::NavigationThrottleRegistry& registry) {
  ChromeContentBrowserClient::CreateThrottlesForNavigation(registry);
  AddUiHostThrottles(registry);
}

bool ContentBrowserClient::CanCreateWindow(
    content::RenderFrameHost* opener,
    const GURL& opener_url,
    const GURL& opener_top_level_frame_url,
    const url::Origin& source_origin,
    content::mojom::WindowContainerType container_type,
    const GURL& target_url,
    const content::Referrer& referrer,
    const std::string& frame_name,
    WindowOpenDisposition disposition,
    const blink::mojom::WindowFeatures& features,
    bool user_gesture,
    bool opener_suppressed,
    bool* no_javascript_access) {
  *no_javascript_access = false;
  if (UiHostOpensAppWindow(opener, target_url, frame_name)) {
    return !opener_suppressed;
  }
  return ChromeContentBrowserClient::CanCreateWindow(
      opener, opener_url, opener_top_level_frame_url, source_origin,
      container_type, target_url, referrer, frame_name, disposition, features,
      user_gesture, opener_suppressed, no_javascript_access);
}

std::unique_ptr<content::WebContentsViewDelegate>
ContentBrowserClient::GetWebContentsViewDelegate(
    content::WebContents* web_contents) {
  if (IsAppUiContents(web_contents)) {
    return CreateAppUiViewDelegate(web_contents);
  }
  return CreatePageViewDelegate(web_contents);
}

void ContentBrowserClient::ConfigureNetworkContextParams(
    content::BrowserContext* context,
    bool in_memory,
    const base::FilePath& relative_partition_path,
    network::mojom::NetworkContextParams* network_context_params,
    cert_verifier::mojom::CertVerifierCreationParams*
        cert_verifier_creation_params) {
  ChromeContentBrowserClient::ConfigureNetworkContextParams(
      context, in_memory, relative_partition_path, network_context_params,
      cert_verifier_creation_params);
  if (!in_memory && relative_partition_path.empty() &&
      !context->IsOffTheRecord()) {
    network_context_params->restore_old_session_cookies = true;
    network_context_params->persist_session_cookies = true;
  }
}

}
