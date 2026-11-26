#ifndef ARDIA_MAC_AC_MAC_DOCUMENTS_H_
#define ARDIA_MAC_AC_MAC_DOCUMENTS_H_

#include <cstdint>
#include <memory>
#include <string>
#include <string_view>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/values.h"

namespace ardia_mac {

struct DocumentAuthority;

class DocumentSession {
 public:
  using Done = base::OnceCallback<void(bool, base::Value)>;
  using Changed = base::RepeatingCallback<void(base::Value)>;

  DocumentSession(std::string window_id, Changed changed);
  DocumentSession(const DocumentSession&) = delete;
  DocumentSession& operator=(const DocumentSession&) = delete;
  ~DocumentSession();

  static bool Handles(std::string_view name);
  static bool Reserved(std::string_view name);
  void Call(std::string_view name, const base::Value* args, std::uint64_t renderer_generation, Done done);
  void RendererRetired();

 private:
  bool EnsureClient(std::uint64_t renderer_generation);
  void Deliver(std::uint64_t subscription, base::Value payload);

  const std::string window_id_;
  const Changed changed_;
  std::shared_ptr<DocumentAuthority> authority_;
  std::string client_;
  std::uint64_t client_generation_ = 0;
  std::uint64_t subscription_ = 0;
  bool watched_ = false;
  base::WeakPtrFactory<DocumentSession> weak_factory_{this};
};

}

#endif
