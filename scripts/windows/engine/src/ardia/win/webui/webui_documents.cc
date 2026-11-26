#include "ardia/win/webui/webui_documents.h"

#include <map>
#include <memory>
#include <string>
#include <string_view>

#include "ardia/linux/ac_linux_documents.h"
#include "ardia/win/webui/webui_storage.h"
#include "base/check.h"
#include "base/no_destructor.h"
#include "base/uuid.h"
#include "base/values.h"
#include "content/public/browser/browser_thread.h"

namespace ardia_win::webui {

DocumentAuthority::DocumentAuthority(const base::FilePath& directory)
    : scope(base::Uuid::GenerateRandomV4().AsLowercaseString()),
      service(FileRunner(),
              scope,
              base::Uuid::GenerateRandomV4().AsLowercaseString(),
              ardia::LinuxDocuments::Read([directory](std::string_view name) {
                return ReadCanonicalDocument(directory, name);
              }),
              ardia::LinuxDocuments::Write(
                  [directory](const base::DictValue& envelope) {
                    return WriteCanonicalEnvelope(directory, envelope);
                  })) {}

DocumentAuthority::~DocumentAuthority() = default;

std::shared_ptr<DocumentAuthority> DocumentsFor(
    const base::FilePath& directory) {
  CHECK(content::BrowserThread::CurrentlyOn(content::BrowserThread::UI));
  if (directory.empty()) {
    return nullptr;
  }
  static base::NoDestructor<
      std::map<base::FilePath, std::weak_ptr<DocumentAuthority>>>
      authorities;
  std::weak_ptr<DocumentAuthority>& slot = (*authorities)[directory];
  std::shared_ptr<DocumentAuthority> authority = slot.lock();
  if (!authority) {
    authority = std::make_shared<DocumentAuthority>(directory);
    slot = authority;
  }
  return authority;
}

}
