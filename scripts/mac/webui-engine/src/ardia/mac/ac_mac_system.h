#ifndef ARDIA_MAC_AC_MAC_SYSTEM_H_
#define ARDIA_MAC_AC_MAC_SYSTEM_H_

#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <string_view>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"

class Profile;

namespace download {
class DownloadItem;
}

namespace ardia_mac {

class ShellHostView;
class DownloadWatch;

void InstallOpenUrlsHook();

class SystemServices {
 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  explicit SystemServices(ShellHostView* host);
  SystemServices(const SystemServices&) = delete;
  SystemServices& operator=(const SystemServices&) = delete;
  ~SystemServices();

  static bool Handles(std::string_view method);
  static bool HandlesEngineCall(std::string_view name);
  static void AppendCapabilities(base::ListValue& capabilities);
  static void DeliverOpenUrls();
  static void HandOffOpenUrls();

  void Invoke(const std::string& method, const base::ListValue* values, Done done);
  void EngineCall(const std::string& name, Profile* profile, const base::Value* args, Done done);
  void RendererRetired();
  void SyncWatches();
  void SyncWatchesSoon();

  bool ListeningForOpenUrls() const;
  void SendOpenUrls(base::ListValue urls);
  void DownloadChanged(Profile* profile, download::DownloadItem* item);
  void DownloadRemoved(Profile* profile, const std::string& id);
  void WatchGone(uintptr_t profile);
  std::vector<std::string> DownloadTargets(bool finished_only) const;
  base::WeakPtr<SystemServices> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

 private:
  void WatchDownloads(Profile* profile);
  std::set<Profile*> MemberProfiles() const;
  void FileCall(const std::string& method, const base::ListValue& values, Done done);
  void PickFiles(const base::ListValue& values, Done done);
  void PickFolder(const base::ListValue& values, Done done);
  void RefuseQueued(Done done);
  void DownloadsCall(const std::string& name, Profile* profile, base::DictValue input, Done done);

  raw_ptr<ShellHostView> host_;
  std::map<Profile*, std::unique_ptr<DownloadWatch>> watches_;
  std::optional<uint64_t> open_urls_listener_;
  bool picking_ = false;
  base::WeakPtrFactory<SystemServices> weak_factory_{this};
};

}

#endif
