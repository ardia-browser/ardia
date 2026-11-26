#ifndef ARDIA_MAC_AC_MAC_EXTENSION_VIEW_H_
#define ARDIA_MAC_AC_MAC_EXTENSION_VIEW_H_

#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <string_view>

#include "ardia/mac/ac_mac_extension_view_policy.h"
#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"

class Profile;

namespace content {
class WebContents;
}

namespace ardia_mac {

class ShellHostView;

class ExtensionViews {
 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;

  explicit ExtensionViews(ShellHostView* host);
  ExtensionViews(const ExtensionViews&) = delete;
  ExtensionViews& operator=(const ExtensionViews&) = delete;
  ~ExtensionViews();

  static bool Handles(std::string_view method);
  static bool HandlesEngineCall(std::string_view name);
  static void AppendCapabilities(base::ListValue& capabilities);
  static std::string ExecuteAction(content::WebContents* contents, const base::ListValue* values);

  void Invoke(const std::string& method, const base::DictValue& args, Done done);
  void EngineCall(const std::string& name, Profile* profile, const base::Value* args, Done done);
  void RetireOlderThan(uint64_t generation);
  void CloseAll();
  void RaisePopups();
  void Relayout();

  void SurfaceClosed(int id, bool report);
  void SurfaceEvent(int id, base::DictValue event);
  void DeliverExtensionEvent(std::string_view name, base::DictValue data);
  bool ShellLive() const;
  ShellHostView* host() const { return host_; }
  base::WeakPtr<ExtensionViews> GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

 private:
  class Surface;

  void Create(const base::DictValue& args, uint64_t generation, Done done);
  void CreateIn(extension_policy::SurfaceKind kind, std::string url, std::string extension_id, uint64_t generation,
                Done done, Profile* profile);
  void Viewport(const base::DictValue& args, uint64_t generation, Done done);
  void Place(const base::DictValue& args, uint64_t generation, Done done);
  void Command(const base::DictValue& args, uint64_t generation, Done done);
  void Release(const base::DictValue& args, uint64_t generation, Done done);
  Surface* Owned(const base::DictValue& args, uint64_t generation);
  void AbortPrompts();
  void Destroy(int id);
  void ActionStates(Profile* profile, const base::DictValue& input, Done done);
  void SidePanelUrl(Profile* profile, const base::DictValue& input, Done done);
  void ChooseFolder(Done done);
  void ResolvePrompt(Profile* profile, const base::DictValue& input, Done done);
  content::WebContents* ProfileTab(Profile* profile, const std::string& key, std::string* code) const;

  raw_ptr<ShellHostView> host_;
  extension_policy::SurfaceBook book_;
  std::map<int, std::unique_ptr<Surface>> surfaces_;
  bool choosing_ = false;
  base::WeakPtrFactory<ExtensionViews> weak_factory_{this};
};

}

#endif
