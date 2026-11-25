#ifndef ARDIA_WIN_WEBUI_WEBUI_STORAGE_H_
#define ARDIA_WIN_WEBUI_WEBUI_STORAGE_H_

#include <atomic>
#include <cstddef>
#include <optional>
#include <string>
#include <string_view>

#include "ardia/desktop/ac_desktop_policy.h"
#include "ardia/linux/ac_linux_documents.h"
#include "ardia/win/webui/webui_window_policy.h"
#include "base/files/file_path.h"
#include "base/memory/scoped_refptr.h"
#include "base/task/sequenced_task_runner.h"
#include "base/values.h"

class GURL;

namespace ardia_win::webui {

inline constexpr char kSessionName[] = "session.json";
inline constexpr size_t kAssetLimit = 64 * 1024 * 1024;
inline constexpr int kCanonicalDocumentDepth = 48;

struct StoredDocument {
  ardia::desktop_policy::StoredRead outcome =
      ardia::desktop_policy::StoredRead::kFailed;
  std::string contents;
};

scoped_refptr<base::SequencedTaskRunner> FileRunner();

base::FilePath AssetDirectory();

std::string AssetPath(const GURL& url);

std::string MimeType(std::string_view path);

base::FilePath SessionDirectory();

std::optional<base::DictValue> ReadSession(const base::FilePath& directory);

std::optional<base::DictValue> WriteSession(const base::FilePath& directory,
                                            base::DictValue base,
                                            base::DictValue local);

struct SessionWrite {
  SessionWrite();
  SessionWrite(SessionWrite&&);
  SessionWrite& operator=(SessionWrite&&);
  ~SessionWrite();

  std::optional<base::DictValue> session;
  base::DictValue previous;
};

SessionWrite WriteSessionTracked(const base::FilePath& directory,
                                 base::DictValue base,
                                 base::DictValue local);

StoredDocument ReadDocumentFile(const base::FilePath& directory,
                                const std::string& name);

bool WriteDocumentFile(const base::FilePath& directory,
                       const std::string& name,
                       const std::string& contents);

StoredDocument ReadStoredDocument(const base::FilePath& directory,
                                  const std::string& name);

bool WriteStoredDocument(const base::FilePath& directory,
                         const std::string& name,
                         const std::string& contents);

bool RemoveStoredDocument(const base::FilePath& directory,
                          const std::string& name);

base::DictValue ReadBootstrapDocuments(const base::FilePath& directory);

std::atomic<int>& AssetReadsServed();

std::atomic<int>& AssetReadsRefused();

std::atomic<int>& AssetReadsOutsideRoot();

std::atomic<int>& AssetReadsUnreadable();

std::optional<std::string> ReadAsset(base::FilePath directory,
                                     std::string path,
                                     std::string bootstrap_json,
                                     base::FilePath documents);

std::optional<webui_window::Placement> ReadPlacement(
    const base::FilePath& directory);

bool WritePlacement(const base::FilePath& directory,
                    const webui_window::Placement& placement);

ardia::LinuxDocumentRead ReadCanonicalDocument(const base::FilePath& directory,
                                               std::string_view name);

bool WriteCanonicalEnvelope(const base::FilePath& directory,
                            const base::DictValue& envelope);

}

#endif
