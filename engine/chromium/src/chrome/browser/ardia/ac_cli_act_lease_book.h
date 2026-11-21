// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_ACT_LEASE_BOOK_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_ACT_LEASE_BOOK_H_

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

namespace ardia {

inline constexpr size_t kMaxActLeasesPerCredential = 8;

bool IsActLeasedMethod(std::string_view method);
bool ExpectedDocumentCurrent(int64_t expected, int64_t current);
bool IsActWithheldMethod(std::string_view method);

struct ActLeaseHold {
  std::string credential;
  int64_t tab = 0;

  bool operator==(const ActLeaseHold&) const = default;
};

struct ActLeaseDocument {
  int64_t tab = 0;
  const void* target = nullptr;
  int64_t document = 0;

  bool operator==(const ActLeaseDocument&) const = default;
};

class ActHold {
 public:
  virtual bool IsOn() = 0;
  virtual bool TurnOn() = 0;
  virtual void TurnOff() = 0;
  virtual bool StillApproved() = 0;

 protected:
  ~ActHold() = default;
};

enum class ActGrantRefusal { kNone, kFull, kNotShown, kReplaced };

struct ActGrant {
  int64_t lease = 0;
  ActGrantRefusal refusal = ActGrantRefusal::kNone;
};

class ActLeaseBook {
 public:
  ActLeaseBook();
  ~ActLeaseBook();
  ActLeaseBook(const ActLeaseBook&) = delete;
  ActLeaseBook& operator=(const ActLeaseBook&) = delete;

  std::optional<int64_t> Grant(const std::string& credential,
                               const ActLeaseDocument& document,
                               bool owns_hold = true);
  ActGrant GrantWithHold(const std::string& credential,
                         const ActLeaseDocument& document,
                         ActHold& hold);
  bool Release(int64_t lease);
  size_t ReleaseCredential(const std::string& credential);
  size_t ReleaseTab(int64_t tab);
  size_t ReleaseTabExcept(int64_t tab, int64_t document);
  size_t ReleaseCredentialOnTab(const std::string& credential, int64_t tab);
  std::vector<int64_t> TabsLeasedBy(const std::string& credential) const;
  int64_t Admit(const std::string& credential,
                const ActLeaseDocument& document) const;
  bool CoversDocument(const std::string& credential,
                      int64_t tab,
                      int64_t document) const;
  bool GrantLive(int64_t grant,
                 const std::string& credential,
                 const ActLeaseDocument& document) const;
  size_t Live() const { return leases_.size(); }
  size_t LiveFor(const std::string& credential) const;
  void Clear();

  int64_t TabOf(int64_t lease) const;
  int64_t ActionAdmitted(int64_t lease);
  bool ActionReturned(int64_t ticket);
  void NoteDelivering(int64_t ticket);
  bool Delivering(int64_t ticket) const;
  bool TicketLive(int64_t ticket,
                  const std::string& credential,
                  const ActLeaseDocument& document) const;
  size_t ActionsPending() const { return actions_.size(); }
  bool HoldHeld(const std::string& credential, int64_t tab) const;
  std::vector<ActLeaseHold> TakeEndedHolds();
  void DropTabHolds(int64_t tab);

 private:
  struct DocumentKey {
    int credential = 0;
    int64_t tab = 0;
    int64_t document = 0;

    bool operator==(const DocumentKey&) const = default;
  };

  struct DocumentKeyHash {
    size_t operator()(const DocumentKey& key) const;
  };

  struct Credential {
    int id = 0;
    size_t live = 0;
  };

  struct Lease {
    int credential = 0;
    ActLeaseDocument document;
  };

  struct HoldKey {
    std::string credential;
    int64_t tab = 0;
  };

  struct HoldView {
    std::string_view credential;
    int64_t tab = 0;
  };

  struct HoldKeyHash {
    using is_transparent = void;
    size_t operator()(const HoldKey& key) const;
    size_t operator()(const HoldView& key) const;
  };

  struct HoldKeyEqual {
    using is_transparent = void;
    bool operator()(const HoldKey& a, const HoldKey& b) const;
    bool operator()(const HoldKey& a, const HoldView& b) const;
    bool operator()(const HoldView& a, const HoldKey& b) const;
  };

  struct HoldCount {
    size_t leases = 0;
    size_t actions = 0;
    bool owned = false;
  };

  struct Action {
    int64_t lease = 0;
    std::string credential;
    int64_t tab = 0;
    bool delivering = false;
  };

  int CredentialId(const std::string& credential) const;
  void KeepOrDropAcquiredHold(const std::string& credential,
                              int64_t tab,
                              ActHold& hold);
  void Unhold(const std::string& credential,
              int64_t tab,
              bool lease,
              bool action);
  template <typename Ends>
  size_t ReleaseWhere(Ends ends);

  std::unordered_map<std::string, Credential> credentials_;
  std::unordered_map<int, std::string> credential_names_;
  std::unordered_map<int64_t, Lease> leases_;
  std::unordered_map<DocumentKey,
                     std::vector<std::pair<int64_t, const void*>>,
                     DocumentKeyHash>
      by_document_;
  std::unordered_map<HoldKey, HoldCount, HoldKeyHash, HoldKeyEqual> holds_;
  std::vector<ActLeaseHold> ended_holds_;
  std::unordered_map<int64_t, Action> actions_;
  int64_t last_ = 0;
  int64_t last_ticket_ = 0;
  int last_credential_ = 0;
};

}

#endif
