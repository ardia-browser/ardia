// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_act_lease_book.h"

#include <algorithm>
#include <array>
#include <functional>
#include <string_view>
#include <utility>

namespace ardia {

bool IsActLeasedMethod(std::string_view method) {
  static constexpr std::array<std::string_view, 7> kLeased = {
      "Ardia.dispatchClick",      "Input.dispatchKeyEvent",
      "Input.dispatchMouseEvent", "Input.insertText",
      "Page.handleJavaScriptDialog", "Page.navigate",
      "Page.reload",
  };
  return std::ranges::find(kLeased, method) != kLeased.end();
}

bool IsActWithheldMethod(std::string_view method) {
  static constexpr std::array<std::string_view, 2> kWithheld = {
      "DOM.focus",
      "Page.captureScreenshot",
  };
  return std::ranges::find(kWithheld, method) != kWithheld.end();
}

bool ExpectedDocumentCurrent(int64_t expected, int64_t current) {
  return expected > 0 && expected == current;
}

ActLeaseBook::ActLeaseBook() = default;
ActLeaseBook::~ActLeaseBook() = default;

size_t ActLeaseBook::DocumentKeyHash::operator()(
    const DocumentKey& key) const {
  size_t hash = std::hash<int64_t>()(key.document);
  hash ^= std::hash<int64_t>()(key.tab) + 0x9e3779b97f4a7c15ull +
          (hash << 6) + (hash >> 2);
  hash ^= std::hash<int>()(key.credential) + 0x9e3779b97f4a7c15ull +
          (hash << 6) + (hash >> 2);
  return hash;
}

int ActLeaseBook::CredentialId(const std::string& credential) const {
  auto it = credentials_.find(credential);
  return it == credentials_.end() ? 0 : it->second.id;
}

std::optional<int64_t> ActLeaseBook::Grant(const std::string& credential,
                                           const ActLeaseDocument& document,
                                           bool owns_hold) {
  if (credential.empty() || document.tab <= 0 || !document.target ||
      document.document <= 0 ||
      LiveFor(credential) >= kMaxActLeasesPerCredential) {
    return std::nullopt;
  }
  auto [entry, inserted] = credentials_.try_emplace(credential);
  if (inserted) {
    entry->second.id = ++last_credential_;
    credential_names_[entry->second.id] = credential;
  }
  ++entry->second.live;
  HoldCount& hold = holds_[HoldKey{credential, document.tab}];
  ++hold.leases;
  hold.owned = hold.owned || owns_hold;
  const int64_t lease = ++last_;
  leases_[lease] = Lease{entry->second.id, document};
  by_document_[DocumentKey{entry->second.id, document.tab, document.document}]
      .emplace_back(lease, document.target);
  return lease;
}

ActGrant ActLeaseBook::GrantWithHold(const std::string& credential,
                                     const ActLeaseDocument& document,
                                     ActHold& hold) {
  ReleaseTabExcept(document.tab, document.document);
  if (LiveFor(credential) >= kMaxActLeasesPerCredential) {
    return {0, ActGrantRefusal::kFull};
  }
  const bool inherited = std::erase_if(ended_holds_, [&](const ActLeaseHold& ended) {
    return ended.tab == document.tab && ended.credential == credential;
  });
  const bool acquired = inherited || !hold.IsOn();
  if (!hold.TurnOn()) {
    return {0, ActGrantRefusal::kNotShown};
  }
  if (!hold.StillApproved()) {
    if (acquired) {
      KeepOrDropAcquiredHold(credential, document.tab, hold);
    }
    return {0, ActGrantRefusal::kReplaced};
  }
  const std::optional<int64_t> lease = Grant(credential, document, acquired);
  if (!lease) {
    if (acquired) {
      KeepOrDropAcquiredHold(credential, document.tab, hold);
    }
    return {0, ActGrantRefusal::kFull};
  }
  return {*lease, ActGrantRefusal::kNone};
}

void ActLeaseBook::KeepOrDropAcquiredHold(const std::string& credential,
                                          int64_t tab,
                                          ActHold& hold) {
  auto it = holds_.find(HoldView{credential, tab});
  if (it != holds_.end()) {
    it->second.owned = true;
  } else {
    hold.TurnOff();
  }
}

bool ActLeaseBook::Release(int64_t lease) {
  auto it = leases_.find(lease);
  if (it == leases_.end()) {
    return false;
  }
  const Lease ended = it->second;
  leases_.erase(it);
  const DocumentKey key{ended.credential, ended.document.tab,
                        ended.document.document};
  auto held = by_document_.find(key);
  if (held != by_document_.end()) {
    std::erase_if(held->second,
                  [&](const auto& entry) { return entry.first == lease; });
    if (held->second.empty()) {
      by_document_.erase(held);
    }
  }
  auto name = credential_names_.find(ended.credential);
  if (name != credential_names_.end()) {
    const std::string credential = name->second;
    auto entry = credentials_.find(credential);
    if (entry != credentials_.end() && --entry->second.live == 0) {
      credentials_.erase(entry);
      credential_names_.erase(name);
    }
    Unhold(credential, ended.document.tab, true, false);
  }
  return true;
}

size_t ActLeaseBook::HoldKeyHash::operator()(const HoldView& key) const {
  size_t hash = std::hash<std::string_view>()(key.credential);
  hash ^= std::hash<int64_t>()(key.tab) + 0x9e3779b97f4a7c15ull +
          (hash << 6) + (hash >> 2);
  return hash;
}

size_t ActLeaseBook::HoldKeyHash::operator()(const HoldKey& key) const {
  return (*this)(HoldView{key.credential, key.tab});
}

bool ActLeaseBook::HoldKeyEqual::operator()(const HoldKey& a,
                                            const HoldKey& b) const {
  return a.tab == b.tab && a.credential == b.credential;
}

bool ActLeaseBook::HoldKeyEqual::operator()(const HoldKey& a,
                                            const HoldView& b) const {
  return a.tab == b.tab && a.credential == b.credential;
}

bool ActLeaseBook::HoldKeyEqual::operator()(const HoldView& a,
                                            const HoldKey& b) const {
  return a.tab == b.tab && a.credential == b.credential;
}

void ActLeaseBook::Unhold(const std::string& credential,
                          int64_t tab,
                          bool lease,
                          bool action) {
  auto it = holds_.find(HoldView{credential, tab});
  if (it == holds_.end()) {
    return;
  }
  if (lease && it->second.leases) {
    --it->second.leases;
  }
  if (action && it->second.actions) {
    --it->second.actions;
  }
  if (!it->second.leases && !it->second.actions) {
    if (it->second.owned) {
      ended_holds_.push_back(ActLeaseHold{credential, tab});
    }
    holds_.erase(it);
  }
}

int64_t ActLeaseBook::TabOf(int64_t lease) const {
  auto it = leases_.find(lease);
  return it == leases_.end() ? 0 : it->second.document.tab;
}

int64_t ActLeaseBook::ActionAdmitted(int64_t lease) {
  auto it = leases_.find(lease);
  if (it == leases_.end()) {
    return 0;
  }
  auto name = credential_names_.find(it->second.credential);
  if (name == credential_names_.end()) {
    return 0;
  }
  const int64_t tab = it->second.document.tab;
  auto hold = holds_.find(HoldView{name->second, tab});
  if (hold == holds_.end()) {
    return 0;
  }
  ++hold->second.actions;
  const int64_t ticket = ++last_ticket_;
  actions_[ticket] = Action{lease, name->second, tab};
  return ticket;
}

bool ActLeaseBook::ActionReturned(int64_t ticket) {
  auto it = actions_.find(ticket);
  if (it == actions_.end()) {
    return false;
  }
  const Action ended = std::move(it->second);
  actions_.erase(it);
  Unhold(ended.credential, ended.tab, false, true);
  return true;
}

void ActLeaseBook::NoteDelivering(int64_t ticket) {
  auto it = actions_.find(ticket);
  if (it != actions_.end()) {
    it->second.delivering = true;
  }
}

bool ActLeaseBook::Delivering(int64_t ticket) const {
  auto it = actions_.find(ticket);
  return it != actions_.end() && it->second.delivering;
}

bool ActLeaseBook::TicketLive(int64_t ticket,
                              const std::string& credential,
                              const ActLeaseDocument& document) const {
  auto it = actions_.find(ticket);
  return it != actions_.end() && GrantLive(it->second.lease, credential, document);
}

bool ActLeaseBook::HoldHeld(const std::string& credential, int64_t tab) const {
  return holds_.contains(HoldView{credential, tab});
}

std::vector<ActLeaseHold> ActLeaseBook::TakeEndedHolds() {
  return std::exchange(ended_holds_, {});
}

void ActLeaseBook::DropTabHolds(int64_t tab) {
  std::erase_if(holds_,
                [&](const auto& entry) { return entry.first.tab == tab; });
  std::erase_if(ended_holds_,
                [&](const ActLeaseHold& hold) { return hold.tab == tab; });
}

template <typename Ends>
size_t ActLeaseBook::ReleaseWhere(Ends ends) {
  std::vector<int64_t> ended;
  for (const auto& [lease, entry] : leases_) {
    if (ends(entry)) {
      ended.push_back(lease);
    }
  }
  for (int64_t lease : ended) {
    Release(lease);
  }
  return ended.size();
}

size_t ActLeaseBook::ReleaseCredential(const std::string& credential) {
  const int id = CredentialId(credential);
  return id ? ReleaseWhere([&](const Lease& lease) {
    return lease.credential == id;
  })
            : 0;
}

size_t ActLeaseBook::ReleaseTab(int64_t tab) {
  return ReleaseWhere(
      [&](const Lease& lease) { return lease.document.tab == tab; });
}

size_t ActLeaseBook::ReleaseTabExcept(int64_t tab, int64_t document) {
  return ReleaseWhere([&](const Lease& lease) {
    return lease.document.tab == tab && lease.document.document != document;
  });
}

size_t ActLeaseBook::ReleaseCredentialOnTab(const std::string& credential,
                                            int64_t tab) {
  const int id = CredentialId(credential);
  return id ? ReleaseWhere([&](const Lease& lease) {
    return lease.credential == id && lease.document.tab == tab;
  })
            : 0;
}

std::vector<int64_t> ActLeaseBook::TabsLeasedBy(
    const std::string& credential) const {
  std::vector<int64_t> tabs;
  const int id = CredentialId(credential);
  if (!id) {
    return tabs;
  }
  for (const auto& [lease, entry] : leases_) {
    if (entry.credential == id &&
        std::ranges::find(tabs, entry.document.tab) == tabs.end()) {
      tabs.push_back(entry.document.tab);
    }
  }
  return tabs;
}

int64_t ActLeaseBook::Admit(const std::string& credential,
                            const ActLeaseDocument& document) const {
  const int id = CredentialId(credential);
  if (!id) {
    return 0;
  }
  auto held =
      by_document_.find(DocumentKey{id, document.tab, document.document});
  if (held == by_document_.end()) {
    return 0;
  }
  for (auto it = held->second.rbegin(); it != held->second.rend(); ++it) {
    if (it->second == document.target) {
      return it->first;
    }
  }
  return 0;
}

bool ActLeaseBook::CoversDocument(const std::string& credential,
                                  int64_t tab,
                                  int64_t document) const {
  const int id = CredentialId(credential);
  return id && by_document_.contains(DocumentKey{id, tab, document});
}

bool ActLeaseBook::GrantLive(int64_t grant,
                             const std::string& credential,
                             const ActLeaseDocument& document) const {
  if (grant <= 0) {
    return false;
  }
  auto it = leases_.find(grant);
  return it != leases_.end() && it->second.document == document &&
         it->second.credential == CredentialId(credential);
}

size_t ActLeaseBook::LiveFor(const std::string& credential) const {
  auto it = credentials_.find(credential);
  return it == credentials_.end() ? 0 : it->second.live;
}

void ActLeaseBook::Clear() {
  for (const auto& [key, count] : holds_) {
    if (count.owned) {
      ended_holds_.push_back(ActLeaseHold{key.credential, key.tab});
    }
  }
  holds_.clear();
  actions_.clear();
  leases_.clear();
  by_document_.clear();
  credentials_.clear();
  credential_names_.clear();
}

}
