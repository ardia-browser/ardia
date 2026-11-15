#ifndef ARDIA_LINUX_UI_HOST_ARDIA_APP_SOURCE_H_
#define ARDIA_LINUX_UI_HOST_ARDIA_APP_SOURCE_H_

#include <optional>
#include <string>
#include <string_view>

#include "base/files/file_path.h"
#include "content/public/browser/url_data_source.h"

namespace ardia_linux {

inline constexpr char kArdiaAppHost[] = "ardia-app";
inline constexpr char kArdiaAppUrl[] = "chrome://ardia-app/";
inline constexpr char kArdiaAppDocumentUrl[] = "chrome://ardia-app/index.html";
inline constexpr char kTranslationsPrefix[] = "translations/";

std::optional<base::FilePath> ConfinedPath(const base::FilePath& root,
                                           std::string_view relative);

std::string MimeTypeForPath(std::string_view path);

class ArdiaAppSource : public content::URLDataSource {
 public:
  ArdiaAppSource(base::FilePath ui_dir, base::FilePath translations_dir);
  ArdiaAppSource(const ArdiaAppSource&) = delete;
  ArdiaAppSource& operator=(const ArdiaAppSource&) = delete;
  ~ArdiaAppSource() override;

  std::string GetSource() override;
  void StartDataRequest(const GURL& url,
                        const content::WebContents::Getter& wc_getter,
                        GotDataCallback callback) override;
  std::string GetMimeType(const GURL& url) override;
  bool AllowCaching() override;
  bool ShouldServeMimeTypeAsContentTypeHeader() override;
  std::string GetContentSecurityPolicy(
      network::mojom::CSPDirectiveName directive) override;

 private:
  const base::FilePath ui_dir_;
  const base::FilePath translations_dir_;
};

}

#endif
