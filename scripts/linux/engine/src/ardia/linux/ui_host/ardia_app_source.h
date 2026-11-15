#ifndef ARDIA_LINUX_UI_HOST_ARDIA_APP_SOURCE_H_
#define ARDIA_LINUX_UI_HOST_ARDIA_APP_SOURCE_H_

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "content/public/browser/url_data_source.h"

namespace ardia_linux {

inline constexpr char kArdiaAppHost[] = "ardia-app";
inline constexpr char kArdiaAppUrl[] = "chrome://ardia-app/";
inline constexpr char kArdiaAppDocumentUrl[] = "chrome://ardia-app/index.html";
inline constexpr char kTranslationsPrefix[] = "translations/";
inline constexpr char kContentSecurityFile[] = "csp.json";

std::optional<base::FilePath> ConfinedPath(const base::FilePath& root,
                                           std::string_view relative);

std::string MimeTypeForPath(std::string_view path);

std::vector<std::string> ScriptHashesFromJson(std::string_view json);

std::vector<std::string> ReadScriptHashes(const base::FilePath& ui_dir);

std::string ScriptSrc(const std::vector<std::string>& hashes);

class ArdiaAppSource : public content::URLDataSource {
 public:
  ArdiaAppSource(base::FilePath ui_dir,
                 base::FilePath translations_dir,
                 std::vector<std::string> script_hashes);
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
  const std::vector<std::string> script_hashes_;
};

}

#endif
