#include "ardia/linux/ui_host/ardia_app_ui.h"

#include <utility>

#include "ardia/linux/ui_host/ardia_app_source.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/url_data_source.h"
#include "content/public/browser/web_ui.h"
#include "content/public/common/url_constants.h"
#include "url/gurl.h"

namespace ardia_linux {

ArdiaAppUI::ArdiaAppUI(content::WebUI* web_ui)
    : content::WebUIController(web_ui) {}

ArdiaAppUI::~ArdiaAppUI() = default;

WEB_UI_CONTROLLER_TYPE_IMPL(ArdiaAppUI)

ArdiaAppUIConfig::ArdiaAppUIConfig(base::FilePath ui_dir,
                                   base::FilePath translations_dir)
    : content::WebUIConfig(content::kChromeUIScheme, kArdiaAppHost),
      ui_dir_(std::move(ui_dir)),
      translations_dir_(std::move(translations_dir)) {}

ArdiaAppUIConfig::~ArdiaAppUIConfig() = default;

bool ArdiaAppUIConfig::IsWebUIEnabled(
    content::BrowserContext* browser_context) {
  return !browser_context->IsOffTheRecord();
}

std::unique_ptr<content::WebUIController>
ArdiaAppUIConfig::CreateWebUIController(content::WebUI* web_ui,
                                        const GURL& url) {
  RegisterURLDataSource(web_ui->GetWebContents()->GetBrowserContext());
  return std::make_unique<ArdiaAppUI>(web_ui);
}

void ArdiaAppUIConfig::RegisterURLDataSource(
    content::BrowserContext* browser_context) {
  content::URLDataSource::Add(
      browser_context,
      std::make_unique<ArdiaAppSource>(ui_dir_, translations_dir_));
}

}
