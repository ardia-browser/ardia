#ifndef ARDIA_WIN_WEBUI_WEBUI_DOCUMENTS_H_
#define ARDIA_WIN_WEBUI_WEBUI_DOCUMENTS_H_

#include <memory>
#include <string>

#include "ardia/linux/ac_linux_document_service.h"
#include "base/files/file_path.h"
#include "base/threading/sequence_bound.h"

namespace ardia_win::webui {

struct DocumentAuthority {
  explicit DocumentAuthority(const base::FilePath& directory);
  DocumentAuthority(const DocumentAuthority&) = delete;
  DocumentAuthority& operator=(const DocumentAuthority&) = delete;
  ~DocumentAuthority();

  const std::string scope;
  base::SequenceBound<ardia::LinuxDocumentService> service;
};

std::shared_ptr<DocumentAuthority> DocumentsFor(const base::FilePath& directory);

}

#endif
