#ifndef ARDIA_CORE_AC_VAULT_TRANSFER_H_
#define ARDIA_CORE_AC_VAULT_TRANSFER_H_

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/time/time.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/cookies/canonical_cookie.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
#include "third_party/blink/public/mojom/dom_storage/storage_area.mojom.h"
#include "url/origin.h"

class Profile;

namespace ardiacore {

struct VaultTransferCounts {
  int cookies = 0;
  int local_storage = 0;
  int conflicts = 0;
  int failed = 0;
  bool changed_since_fill = false;
};

void SetVaultTransferHoldForTesting(base::TimeDelta hold);
base::TimeDelta WriteHoldForTesting();

class VaultTransfer {
 public:
  VaultTransfer(Profile* to, url::Origin origin);
  ~VaultTransfer();
  VaultTransfer(const VaultTransfer&) = delete;
  VaultTransfer& operator=(const VaultTransfer&) = delete;

  void Seed(Profile* vault, base::OnceClosure seeded);
  void MarkFillStarted(Profile* vault, base::OnceClosure ready);
  void Run(Profile* from,
           bool only_if_changed_since_fill,
           base::OnceCallback<void(VaultTransferCounts)> done);
  const VaultTransferCounts& counts() const { return counts_; }
  bool sent() const { return sent_; }

 private:
  using Storage = std::map<std::vector<uint8_t>, std::vector<uint8_t>>;
  using CookieValues = std::map<std::string, std::string>;

  bool Covers(const net::CanonicalCookie& cookie) const;
  CookieValues Values(const std::vector<net::CanonicalCookie>& cookies) const;
  static Storage ToStorage(std::vector<blink::mojom::KeyValuePtr> data);
  void GotSnapshot(const std::vector<net::CanonicalCookie>& cookies);
  void SeedNow();
  void Seeded();
  void Write();
  void WriteChecked();
  void Wrote(int* count, bool success);
  void Step();
  void MaybeBaselineReady();
  bool ChangedSinceFill() const;

  const url::Origin origin_;
  const std::string registrable_domain_;
  mojo::Remote<network::mojom::CookieManager> target_cookies_;
  mojo::Remote<blink::mojom::StorageArea> target_storage_;
  mojo::Remote<network::mojom::CookieManager> vault_cookies_;
  mojo::Remote<blink::mojom::StorageArea> vault_storage_;
  std::optional<std::vector<net::CanonicalCookie>> snapshot_list_;
  std::optional<CookieValues> cookies_before_;
  std::optional<Storage> storage_before_;
  std::optional<CookieValues> target_now_;
  std::optional<Storage> storage_now_;
  std::optional<std::vector<net::CanonicalCookie>> vault_list_;
  std::optional<Storage> vault_items_;
  bool fill_marked_ = false;
  std::vector<net::CanonicalCookie> cookie_writes_;
  std::vector<std::pair<std::vector<uint8_t>, std::vector<uint8_t>>>
      storage_writes_;
  std::optional<CookieValues> target_recheck_;
  std::optional<Storage> storage_recheck_;
  bool only_if_changed_since_fill_ = false;
  base::OnceClosure baseline_ready_;
  std::optional<CookieValues> vault_at_fill_;
  std::optional<Storage> vault_storage_at_fill_;
  base::OnceClosure seeded_;
  int seeding_ = 0;
  base::OnceCallback<void(VaultTransferCounts)> done_;
  bool writing_ = false;
  bool sent_ = false;
  int pending_ = 0;
  VaultTransferCounts counts_;
  base::WeakPtrFactory<VaultTransfer> weak_factory_{this};
};

}

#endif
