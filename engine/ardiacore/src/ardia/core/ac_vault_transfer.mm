#include "ardia/core/ac_vault_transfer.h"

#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/task/single_thread_task_runner.h"
#include "base/strings/strcat.h"
#include "chrome/browser/profiles/profile.h"
#include "components/services/storage/public/mojom/local_storage_control.mojom.h"
#include "content/public/browser/storage_partition.h"
#include "mojo/public/cpp/bindings/pending_remote.h"
#include "net/base/registry_controlled_domains/registry_controlled_domain.h"
#include "net/cookies/cookie_access_result.h"
#include "net/cookies/cookie_options.h"
#include "net/cookies/cookie_partition_key.h"
#include "net/cookies/cookie_util.h"
#include "services/network/public/mojom/network_context.mojom.h"
#include "third_party/blink/public/common/storage_key/storage_key.h"
#include "url/gurl.h"

namespace ardiacore {

namespace {

base::TimeDelta& WriteHold() {
  static base::TimeDelta hold;
  return hold;
}

GURL CookieURL(const net::CanonicalCookie& cookie) {
  return net::cookie_util::CookieDomainAndPathToURL(
      cookie.Domain(), cookie.Path(),
      cookie.SecureAttribute() ||
          cookie.SourceScheme() == net::CookieSourceScheme::kSecure);
}

std::string CookieKey(const net::CanonicalCookie& cookie) {
  return base::StrCat(
      {cookie.Name(), "\n", cookie.Domain(), "\n", cookie.Path(), "\n",
       cookie.IsPartitioned() ? cookie.PartitionKey()->site().Serialize() : ""});
}

template <typename Values, typename Key, typename Value>
bool SignInWrote(const std::optional<Values>& at_fill,
                 const Key& key,
                 const Value& value) {
  if (!at_fill) {
    return true;
  }
  auto found = at_fill->find(key);
  return found == at_fill->end() || found->second != value;
}

void Bind(Profile* profile,
          const url::Origin& origin,
          mojo::Remote<network::mojom::CookieManager>& cookies,
          mojo::Remote<blink::mojom::StorageArea>& storage) {
  content::StoragePartition* partition = profile->GetDefaultStoragePartition();
  partition->GetNetworkContext()->GetCookieManager(
      cookies.BindNewPipeAndPassReceiver());
  partition->GetLocalStorageControl()->BindStorageArea(
      blink::StorageKey::CreateFirstParty(origin),
      storage.BindNewPipeAndPassReceiver());
}

}

VaultTransfer::VaultTransfer(Profile* to, url::Origin origin)
    : origin_(std::move(origin)),
      registrable_domain_(
          net::registry_controlled_domains::GetDomainAndRegistry(
              origin_,
              net::registry_controlled_domains::INCLUDE_PRIVATE_REGISTRIES)) {
  Bind(to, origin_, target_cookies_, target_storage_);
  target_cookies_->GetAllCookies(base::BindOnce(&VaultTransfer::GotSnapshot,
                                                weak_factory_.GetWeakPtr()));
  target_storage_->GetAll(
      mojo::NullRemote(),
      base::BindOnce(
          [](base::WeakPtr<VaultTransfer> transfer,
             std::vector<blink::mojom::KeyValuePtr> data) {
            if (transfer) {
              transfer->storage_before_ = ToStorage(std::move(data));
              transfer->Step();
            }
          },
          weak_factory_.GetWeakPtr()));
}

VaultTransfer::~VaultTransfer() = default;

bool VaultTransfer::Covers(const net::CanonicalCookie& cookie) const {
  std::string domain = cookie.Domain();
  if (!domain.empty() && domain[0] == '.') {
    domain.erase(0, 1);
  }
  const bool apex = registrable_domain_.empty() ||
                    registrable_domain_ == origin_.host();
  if (domain != origin_.host() &&
      (apex || domain != registrable_domain_ || cookie.IsHostCookie())) {
    return false;
  }
  if (!cookie.IsPartitioned()) {
    return true;
  }
  const net::CookiePartitionKey& key = *cookie.PartitionKey();
  return !key.nonce() && key.site() == net::SchemefulSite(origin_);
}

VaultTransfer::CookieValues VaultTransfer::Values(
    const std::vector<net::CanonicalCookie>& cookies) const {
  CookieValues values;
  for (const net::CanonicalCookie& cookie : cookies) {
    if (Covers(cookie)) {
      values[CookieKey(cookie)] = cookie.Value();
    }
  }
  return values;
}

VaultTransfer::Storage VaultTransfer::ToStorage(
    std::vector<blink::mojom::KeyValuePtr> data) {
  Storage storage;
  for (blink::mojom::KeyValuePtr& item : data) {
    storage[std::move(item->key)] = std::move(item->value);
  }
  return storage;
}

void VaultTransfer::GotSnapshot(
    const std::vector<net::CanonicalCookie>& cookies) {
  cookies_before_ = Values(cookies);
  snapshot_list_ = cookies;
  SeedNow();
  Step();
}

void VaultTransfer::Seed(Profile* vault, base::OnceClosure seeded) {
  seeded_ = std::move(seeded);
  vault->GetDefaultStoragePartition()->GetNetworkContext()->GetCookieManager(
      vault_cookies_.BindNewPipeAndPassReceiver());
  SeedNow();
}

void VaultTransfer::SeedNow() {
  if (!seeded_ || !snapshot_list_ || !vault_cookies_) {
    return;
  }
  for (const net::CanonicalCookie& cookie : *snapshot_list_) {
    if (!Covers(cookie)) {
      continue;
    }
    ++seeding_;
    vault_cookies_->SetCanonicalCookie(
        cookie, CookieURL(cookie), net::CookieOptions::MakeAllInclusive(),
        base::BindOnce(
            [](base::WeakPtr<VaultTransfer> transfer, net::CookieAccessResult) {
              if (transfer) {
                transfer->Seeded();
              }
            },
            weak_factory_.GetWeakPtr()));
  }
  snapshot_list_->clear();
  if (seeding_ == 0) {
    std::move(seeded_).Run();
  }
}

void VaultTransfer::Seeded() {
  if (--seeding_ == 0 && seeded_) {
    std::move(seeded_).Run();
  }
}

void VaultTransfer::MarkFillStarted(Profile* vault, base::OnceClosure ready) {
  if (fill_marked_) {
    std::move(ready).Run();
    return;
  }
  fill_marked_ = true;
  baseline_ready_ = std::move(ready);
  if (!vault_cookies_) {
    vault->GetDefaultStoragePartition()->GetNetworkContext()->GetCookieManager(
        vault_cookies_.BindNewPipeAndPassReceiver());
  }
  vault->GetDefaultStoragePartition()->GetLocalStorageControl()->BindStorageArea(
      blink::StorageKey::CreateFirstParty(origin_),
      vault_storage_.BindNewPipeAndPassReceiver());
  vault_cookies_->GetAllCookies(base::BindOnce(
      [](base::WeakPtr<VaultTransfer> transfer,
         const std::vector<net::CanonicalCookie>& cookies) {
        if (transfer) {
          transfer->vault_at_fill_ = transfer->Values(cookies);
          transfer->MaybeBaselineReady();
          transfer->Step();
        }
      },
      weak_factory_.GetWeakPtr()));
  vault_storage_->GetAll(
      mojo::NullRemote(),
      base::BindOnce(
          [](base::WeakPtr<VaultTransfer> transfer,
             std::vector<blink::mojom::KeyValuePtr> data) {
            if (transfer) {
              transfer->vault_storage_at_fill_ = ToStorage(std::move(data));
              transfer->MaybeBaselineReady();
              transfer->Step();
            }
          },
          weak_factory_.GetWeakPtr()));
}

void SetVaultTransferHoldForTesting(base::TimeDelta hold) {
  WriteHold() = hold;
}

base::TimeDelta WriteHoldForTesting() {
  return WriteHold();
}

void VaultTransfer::MaybeBaselineReady() {
  if (baseline_ready_ && vault_at_fill_ && vault_storage_at_fill_) {
    std::move(baseline_ready_).Run();
  }
}

bool VaultTransfer::ChangedSinceFill() const {
  if (!vault_at_fill_ || !vault_storage_at_fill_) {
    return true;
  }
  for (const net::CanonicalCookie& cookie : *vault_list_) {
    if (Covers(cookie) &&
        SignInWrote(vault_at_fill_, CookieKey(cookie), cookie.Value())) {
      return true;
    }
  }
  for (const auto& [key, value] : *vault_items_) {
    if (SignInWrote(vault_storage_at_fill_, key, value)) {
      return true;
    }
  }
  return false;
}

void VaultTransfer::Run(Profile* from,
                        bool only_if_changed_since_fill,
                        base::OnceCallback<void(VaultTransferCounts)> done) {
  done_ = std::move(done);
  only_if_changed_since_fill_ = only_if_changed_since_fill;
  if (!vault_cookies_) {
    from->GetDefaultStoragePartition()->GetNetworkContext()->GetCookieManager(
        vault_cookies_.BindNewPipeAndPassReceiver());
  }
  if (!vault_storage_) {
    from->GetDefaultStoragePartition()
        ->GetLocalStorageControl()
        ->BindStorageArea(blink::StorageKey::CreateFirstParty(origin_),
                          vault_storage_.BindNewPipeAndPassReceiver());
  }
  target_cookies_->GetAllCookies(base::BindOnce(
      [](base::WeakPtr<VaultTransfer> transfer,
         const std::vector<net::CanonicalCookie>& cookies) {
        if (transfer) {
          transfer->target_now_ = transfer->Values(cookies);
          transfer->Step();
        }
      },
      weak_factory_.GetWeakPtr()));
  target_storage_->GetAll(
      mojo::NullRemote(),
      base::BindOnce(
          [](base::WeakPtr<VaultTransfer> transfer,
             std::vector<blink::mojom::KeyValuePtr> data) {
            if (transfer) {
              transfer->storage_now_ = ToStorage(std::move(data));
              transfer->Step();
            }
          },
          weak_factory_.GetWeakPtr()));
  vault_cookies_->GetAllCookies(base::BindOnce(
      [](base::WeakPtr<VaultTransfer> transfer,
         const std::vector<net::CanonicalCookie>& cookies) {
        if (transfer) {
          transfer->vault_list_ = cookies;
          transfer->Step();
        }
      },
      weak_factory_.GetWeakPtr()));
  vault_storage_->GetAll(
      mojo::NullRemote(),
      base::BindOnce(
          [](base::WeakPtr<VaultTransfer> transfer,
             std::vector<blink::mojom::KeyValuePtr> data) {
            if (transfer) {
              transfer->vault_items_ = ToStorage(std::move(data));
              transfer->Step();
            }
          },
          weak_factory_.GetWeakPtr()));
}

void VaultTransfer::Write() {
  writing_ = true;
  counts_.changed_since_fill = ChangedSinceFill();
  if (only_if_changed_since_fill_ && !counts_.changed_since_fill) {
    vault_list_.reset();
    vault_items_.reset();
    return;
  }
  for (const net::CanonicalCookie& cookie : *vault_list_) {
    if (!Covers(cookie)) {
      continue;
    }
    const std::string key = CookieKey(cookie);
    if (!SignInWrote(vault_at_fill_, key, cookie.Value())) {
      continue;
    }
    auto before = cookies_before_->find(key);
    auto now = target_now_->find(key);
    if (now != target_now_->end() && now->second == cookie.Value()) {
      continue;
    }
    const bool changed =
        (before == cookies_before_->end()) != (now == target_now_->end()) ||
        (now != target_now_->end() && now->second != before->second);
    if (changed) {
      ++counts_.conflicts;
      continue;
    }
    cookie_writes_.push_back(cookie);
  }
  for (const auto& [key, value] : *vault_items_) {
    if (!SignInWrote(vault_storage_at_fill_, key, value)) {
      continue;
    }
    auto before = storage_before_->find(key);
    auto now = storage_now_->find(key);
    if (now != storage_now_->end() && now->second == value) {
      continue;
    }
    const bool changed =
        (before == storage_before_->end()) != (now == storage_now_->end()) ||
        (now != storage_now_->end() && now->second != before->second);
    if (changed) {
      ++counts_.conflicts;
      continue;
    }
    storage_writes_.emplace_back(key, value);
  }
  vault_list_.reset();
  vault_items_.reset();
  if (cookie_writes_.empty() && storage_writes_.empty()) {
    return;
  }
  ++pending_;
  target_cookies_->GetAllCookies(base::BindOnce(
      [](base::WeakPtr<VaultTransfer> transfer,
         const std::vector<net::CanonicalCookie>& cookies) {
        if (transfer) {
          transfer->target_recheck_ = transfer->Values(cookies);
          transfer->WriteChecked();
        }
      },
      weak_factory_.GetWeakPtr()));
  target_storage_->GetAll(
      mojo::NullRemote(),
      base::BindOnce(
          [](base::WeakPtr<VaultTransfer> transfer,
             std::vector<blink::mojom::KeyValuePtr> data) {
            if (transfer) {
              transfer->storage_recheck_ = ToStorage(std::move(data));
              transfer->WriteChecked();
            }
          },
          weak_factory_.GetWeakPtr()));
}

void VaultTransfer::WriteChecked() {
  if (!target_recheck_ || !storage_recheck_) {
    return;
  }
  auto same = [](const auto& earlier, const auto& later, const auto& key) {
    auto then = earlier.find(key);
    auto now = later.find(key);
    return (then == earlier.end()) == (now == later.end()) &&
           (then == earlier.end() || then->second == now->second);
  };
  std::vector<base::OnceClosure> writes;
  for (const net::CanonicalCookie& cookie : cookie_writes_) {
    if (!same(*target_now_, *target_recheck_, CookieKey(cookie))) {
      ++counts_.conflicts;
      continue;
    }
    writes.push_back(base::BindOnce(
        [](base::WeakPtr<VaultTransfer> transfer, net::CanonicalCookie cookie) {
          if (!transfer) {
            return;
          }
          transfer->sent_ = true;
          transfer->target_cookies_->SetCanonicalCookie(
              cookie, CookieURL(cookie), net::CookieOptions::MakeAllInclusive(),
              base::BindOnce(
                  [](base::WeakPtr<VaultTransfer> transfer,
                     net::CookieAccessResult result) {
                    if (transfer) {
                      transfer->Wrote(&transfer->counts_.cookies,
                                      result.status.IsInclude());
                    }
                  },
                  transfer));
        },
        weak_factory_.GetWeakPtr(), cookie));
  }
  for (const auto& [key, value] : storage_writes_) {
    if (!same(*storage_now_, *storage_recheck_, key)) {
      ++counts_.conflicts;
      continue;
    }
    writes.push_back(base::BindOnce(
        [](base::WeakPtr<VaultTransfer> transfer, std::vector<uint8_t> key,
           std::vector<uint8_t> value) {
          if (!transfer) {
            return;
          }
          transfer->sent_ = true;
          transfer->target_storage_->Put(
              key, value, std::nullopt, nullptr,
              base::BindOnce(&VaultTransfer::Wrote, transfer,
                             &transfer->counts_.local_storage));
        },
        weak_factory_.GetWeakPtr(), key, value));
  }
  cookie_writes_.clear();
  storage_writes_.clear();
  pending_ += static_cast<int>(writes.size());
  const base::TimeDelta hold = WriteHoldForTesting();
  if (hold.is_positive() && writes.size() > 1) {
    std::move(writes.front()).Run();
    std::vector<base::OnceClosure> rest(std::make_move_iterator(writes.begin() + 1),
                                        std::make_move_iterator(writes.end()));
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](std::vector<base::OnceClosure> rest) {
              for (base::OnceClosure& write : rest) {
                std::move(write).Run();
              }
            },
            std::move(rest)),
        hold);
  } else {
    for (base::OnceClosure& write : writes) {
      std::move(write).Run();
    }
  }
  --pending_;
  Step();
}

void VaultTransfer::Wrote(int* count, bool success) {
  --pending_;
  if (!success) {
    ++counts_.failed;
  } else {
    ++*count;
  }
  Step();
}

void VaultTransfer::Step() {
  if (!done_) {
    return;
  }
  if (!writing_) {
    if (!cookies_before_ || !storage_before_ || !target_now_ || !storage_now_ ||
        !vault_list_ || !vault_items_ ||
        (fill_marked_ && (!vault_at_fill_ || !vault_storage_at_fill_))) {
      return;
    }
    Write();
  }
  if (pending_ == 0) {
    std::move(done_).Run(counts_);
  }
}

}
