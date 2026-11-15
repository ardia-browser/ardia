#ifndef ARDIA_LINUX_UI_HOST_ARDIA_APP_UI_H_
#define ARDIA_LINUX_UI_HOST_ARDIA_APP_UI_H_

#include <memory>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"

namespace ardia_linux {

class ArdiaAppUI : public content::WebUIController {
 public:
  explicit ArdiaAppUI(content::WebUI* web_ui);
  ArdiaAppUI(const ArdiaAppUI&) = delete;
  ArdiaAppUI& operator=(const ArdiaAppUI&) = delete;
  ~ArdiaAppUI() override;

 private:
  WEB_UI_CONTROLLER_TYPE_DECL();
};

class ArdiaAppUIConfig : public content::WebUIConfig {
 public:
  ArdiaAppUIConfig(base::FilePath ui_dir,
                   base::FilePath translations_dir,
                   std::vector<std::string> script_hashes);
  ~ArdiaAppUIConfig() override;

  bool IsWebUIEnabled(content::BrowserContext* browser_context) override;
  std::unique_ptr<content::WebUIController> CreateWebUIController(
      content::WebUI* web_ui,
      const GURL& url) override;
  void RegisterURLDataSource(content::BrowserContext* browser_context) override;

 private:
  const base::FilePath ui_dir_;
  const base::FilePath translations_dir_;
  const std::vector<std::string> script_hashes_;
};

}

#endif
