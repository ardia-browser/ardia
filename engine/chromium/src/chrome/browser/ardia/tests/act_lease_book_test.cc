// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <new>
#include <string>
#include <vector>

#include "chrome/browser/ardia/ac_cli_act_lease_book.h"

std::atomic<long> g_allocations{0};

void* operator new(std::size_t size) {
  ++g_allocations;
  if (void* memory = std::malloc(size ? size : 1)) {
    return memory;
  }
  throw std::bad_alloc();
}

void operator delete(void* memory) noexcept {
  std::free(memory);
}

void operator delete(void* memory, std::size_t) noexcept {
  std::free(memory);
}

namespace {

int failures = 0;

void Expect(bool ok, const std::string& name) {
  if (!ok) {
    ++failures;
    std::printf("FAIL  %s\n", name.c_str());
  }
}

const int kPageHost = 0;
const int kPrerenderHost = 0;
const int kOtherHost = 0;

const ardia::ActLeaseDocument kPage{7, &kPageHost, 70};
const ardia::ActLeaseDocument kNextDocument{7, &kPageHost, 71};
const ardia::ActLeaseDocument kPrerender{7, &kPrerenderHost, 70};
const ardia::ActLeaseDocument kOtherTab{9, &kOtherHost, 90};

void LeasedAndWithheldMethods() {
  for (const char* method :
       {"Input.dispatchMouseEvent", "Input.dispatchKeyEvent",
        "Input.insertText", "Ardia.dispatchClick", "Page.navigate",
        "Page.reload", "Page.handleJavaScriptDialog"}) {
    Expect(ardia::IsActLeasedMethod(method), std::string("leased: ") + method);
    Expect(!ardia::IsActWithheldMethod(method),
           std::string("not withheld: ") + method);
  }
  for (const char* method : {"DOM.focus", "Page.captureScreenshot"}) {
    Expect(ardia::IsActWithheldMethod(method),
           std::string("withheld: ") + method);
    Expect(!ardia::IsActLeasedMethod(method),
           std::string("withheld, so never leased: ") + method);
  }
  for (const char* method :
       {"DOM.getDocument", "DOM.getBoxModel", "Accessibility.getFullAXTree",
        "Page.getFrameTree", "Target.attachToTarget", "Input.dispatch",
        "input.insertText", "Input.insertTextX", "", "DOM.focusX",
        "Ardia.scrollIntoView",
        "DOM.scrollIntoViewIfNeeded", "Emulation.setFocusEmulationEnabled"}) {
    Expect(!ardia::IsActLeasedMethod(method) &&
               !ardia::IsActWithheldMethod(method),
           std::string("neither: ") + method);
  }
}

void GrantNamesTheApprovedDocument() {
  Expect(ardia::ExpectedDocumentCurrent(70, 70),
         "the document approved on the card is still current, so it leases");
  Expect(!ardia::ExpectedDocumentCurrent(70, 71),
         "a replacement document since approval is refused (document_changed)");
  Expect(!ardia::ExpectedDocumentCurrent(0, 70),
         "a grant that names no approved document is refused");
  Expect(!ardia::ExpectedDocumentCurrent(70, 0),
         "a tab whose document has no engine id yet is refused");
}

void GrantAdmitRelease() {
  ardia::ActLeaseBook book;
  Expect(book.Admit("plugin-1", kPage) == 0, "nothing admits before a grant");
  const auto lease = book.Grant("plugin-1", kPage);
  Expect(lease.has_value() && *lease > 0, "a grant answers a positive id");
  Expect(book.Admit("plugin-1", kPage) == *lease, "the grant admits its page");
  Expect(book.Admit("plugin-2", kPage) == 0,
         "another credential isn't admitted");
  Expect(book.Admit("plugin-1", kNextDocument) == 0,
         "the next document on the same tab isn't admitted");
  Expect(book.Admit("plugin-1", kPrerender) == 0,
         "a prerender target in the same tab isn't admitted, even with the "
         "primary document's id");
  Expect(book.Admit("plugin-1", kOtherTab) == 0, "another tab isn't admitted");
  Expect(book.CoversDocument("plugin-1", 7, 70),
         "frames of the leased document are covered");
  Expect(!book.CoversDocument("plugin-1", 7, 71),
         "frames of another document aren't");
  Expect(!book.CoversDocument("plugin-2", 7, 70),
         "frames aren't covered for another credential");
  Expect(book.Release(*lease), "release answers true once");
  Expect(!book.Release(*lease), "a second release answers false");
  Expect(book.Admit("plugin-1", kPage) == 0, "a released lease admits nothing");
  Expect(!book.Grant("", kPage).has_value(), "an empty credential is refused");
  Expect(!book.Grant("plugin-1", ardia::ActLeaseDocument{7, &kPageHost, 0})
              .has_value(),
         "a page with no document is refused");
  Expect(!book.Grant("plugin-1", ardia::ActLeaseDocument{7, nullptr, 70})
              .has_value(),
         "a page with no target is refused");
  Expect(!book.Grant("plugin-1", ardia::ActLeaseDocument{0, &kPageHost, 70})
              .has_value(),
         "a page with no tab is refused");
}

void GrantsAreCapturedNotLatest() {
  ardia::ActLeaseBook book;
  const int64_t first = *book.Grant("plugin-1", kPage);
  const int64_t admitted = book.Admit("plugin-1", kPage);
  Expect(admitted == first, "the first grant admits");
  book.Release(first);
  const int64_t second = *book.Grant("plugin-1", kPage);
  Expect(second != first, "a new grant never reuses an id");
  Expect(!book.GrantLive(admitted, "plugin-1", kPage),
         "input admitted under the first grant can't ride the second");
  Expect(book.GrantLive(second, "plugin-1", kPage), "the second grant is live");
  Expect(!book.GrantLive(second, "plugin-2", kPage),
         "a grant is live only for its own credential");
  Expect(!book.GrantLive(second, "plugin-1", kNextDocument),
         "a grant is live only on its own document");
  Expect(!book.GrantLive(second, "plugin-1", kPrerender),
         "a grant is live only for its own target");
  Expect(!book.GrantLive(0, "plugin-1", kPage), "no grant is never live");
  Expect(!book.GrantLive(-1, "plugin-1", kPage), "a negative grant is never live");
  const int64_t third = *book.Grant("plugin-1", kPage);
  Expect(book.Admit("plugin-1", kPage) == third, "the newest grant admits");
  book.Release(third);
  Expect(book.Admit("plugin-1", kPage) == second,
         "an older live grant still admits once the newer one ends");
}

void IdsSurviveClear() {
  ardia::ActLeaseBook book;
  const int64_t before = *book.Grant("plugin-1", kPage);
  book.Clear();
  Expect(book.Live() == 0, "clear drops every lease");
  Expect(!book.GrantLive(before, "plugin-1", kPage),
         "a grant from before a clear is dead");
  const int64_t after = *book.Grant("plugin-1", kPage);
  Expect(after > before, "ids keep counting after a clear");
}

void BulkReleases() {
  ardia::ActLeaseBook book;
  book.Grant("plugin-1", kPage);
  book.Grant("plugin-1", kOtherTab);
  book.Grant("plugin-2", kPage);
  Expect(book.ReleaseCredential("plugin-1") == 2,
         "a revoked credential loses all its leases");
  Expect(book.Admit("plugin-2", kPage) != 0, "other credentials keep theirs");
  book.Grant("plugin-1", kPage);
  Expect(book.ReleaseTabExcept(7, 71) == 2,
         "a new document ends every lease on the old one");
  Expect(book.Live() == 0, "nothing is left on the tab");
  book.Grant("plugin-1", kNextDocument);
  Expect(book.ReleaseTabExcept(7, 71) == 0,
         "leases on the current document stay");
  book.Grant("plugin-2", kOtherTab);
  Expect(book.ReleaseTab(7) == 1, "a closed tab or a renderer exit ends its leases");
  Expect(book.Admit("plugin-2", kOtherTab) != 0, "other tabs keep theirs");
}

class FakeHold final : public ardia::ActHold {
 public:
  explicit FakeHold(bool on, bool approved = true)
      : on_(on), approved_(approved) {}

  bool IsOn() override { return on_; }
  bool TurnOn() override {
    ++turned_on;
    on_ = !refuse;
    return !refuse;
  }
  void TurnOff() override {
    ++turned_off;
    on_ = false;
  }
  bool StillApproved() override { return approved_; }
  bool on() const { return on_; }

  bool refuse = false;
  int turned_on = 0;
  int turned_off = 0;

 private:
  bool on_;
  bool approved_;
};

void AFailedGrantLeavesAHoldItDidNotTake() {
  ardia::ActLeaseBook book;
  for (size_t i = 0; i < ardia::kMaxActLeasesPerCredential; ++i) {
    book.Grant("plugin-1", kOtherTab);
  }
  FakeHold existing(true);
  const ardia::ActGrant full = book.GrantWithHold("plugin-1", kPage, existing);
  Expect(full.refusal == ardia::ActGrantRefusal::kFull && !full.lease,
         "a grant over the cap is refused");
  Expect(existing.turned_on == 0 && existing.turned_off == 0 && existing.on(),
         "the cap is checked before the hold, and a hold that was already on "
         "stays on");
  FakeHold replaced(true, false);
  const ardia::ActGrant stale =
      book.GrantWithHold("plugin-2", kPage, replaced);
  Expect(stale.refusal == ardia::ActGrantRefusal::kReplaced &&
             replaced.turned_off == 0 && replaced.on(),
         "a grant whose document changed during the hold leaves a hold it "
         "didn't take");
  FakeHold shared(true);
  const ardia::ActGrant granted = book.GrantWithHold("plugin-3", kPage, shared);
  Expect(granted.lease > 0 && book.Release(granted.lease) &&
             book.TakeEndedHolds().empty(),
         "a lease that found the hold on never turns it off when it ends");
}

void AFailedGrantDropsOnlyTheHoldItTook() {
  ardia::ActLeaseBook book;
  FakeHold taken(false, false);
  const ardia::ActGrant stale = book.GrantWithHold("plugin-1", kPage, taken);
  Expect(stale.refusal == ardia::ActGrantRefusal::kReplaced &&
             taken.turned_on == 1 && taken.turned_off == 1 && !taken.on(),
         "a grant whose document changed during the hold drops the hold it "
         "took");
  FakeHold refused(false);
  refused.refuse = true;
  Expect(book.GrantWithHold("plugin-1", kPage, refused).refusal ==
                 ardia::ActGrantRefusal::kNotShown &&
             refused.turned_off == 0,
         "a hold that can't be taken refuses the grant");
  const std::optional<int64_t> other = book.Grant("plugin-1", kPage, false);
  FakeHold retaken(false, false);
  book.GrantWithHold("plugin-1", kPage, retaken);
  Expect(retaken.turned_off == 0 && retaken.on() && other &&
             book.Release(*other) && book.TakeEndedHolds().size() == 1,
         "a hold a failed grant took while another lease of that credential "
         "is live stays on, owned by the lease, and ends with it");
  FakeHold fresh(false);
  const ardia::ActGrant granted = book.GrantWithHold("plugin-1", kPage, fresh);
  Expect(granted.lease > 0 && book.Release(granted.lease) &&
             book.TakeEndedHolds().size() == 1,
         "a lease that took the hold turns it off when it ends");
}

void AGrantOnANewDocumentTakesOverTheEndedLeasesHold() {
  ardia::ActLeaseBook book;
  book.Grant("plugin-1", kPage);
  FakeHold on(true);
  const ardia::ActGrant granted =
      book.GrantWithHold("plugin-1", kNextDocument, on);
  Expect(granted.lease > 0 && book.TakeEndedHolds().empty() && on.on(),
         "a grant on the tab's new document takes over the hold the old "
         "document's lease took, so it isn't turned off in between");
  Expect(book.Release(granted.lease) && book.TakeEndedHolds().size() == 1,
         "and turns it off when it ends");
}

void DeliveryIsMarkedPerTicket() {
  ardia::ActLeaseBook book;
  const int64_t lease = *book.Grant("plugin-1", kPage);
  const int64_t waiting = book.ActionAdmitted(lease);
  const int64_t forwarded = book.ActionAdmitted(lease);
  book.NoteDelivering(forwarded);
  book.NoteDelivering(0);
  Expect(!book.Delivering(waiting) && book.Delivering(forwarded),
         "only a ticket whose last check before forwarding passed counts as "
         "delivering");
  book.ActionReturned(forwarded);
  Expect(!book.Delivering(forwarded), "a returned ticket isn't delivering");
}

void Capped() {
  ardia::ActLeaseBook book;
  for (size_t i = 0; i < ardia::kMaxActLeasesPerCredential; ++i) {
    Expect(book.Grant("plugin-1", kPage).has_value(), "grants up to the cap");
  }
  Expect(!book.Grant("plugin-1", kPage).has_value(),
         "one more than the cap is refused");
  Expect(book.Grant("plugin-2", kPage).has_value(),
         "the cap is per credential");
}

void CredentialsAreForgottenWithTheirLastLease() {
  ardia::ActLeaseBook book;
  const int64_t first = *book.Grant("plugin-1", kPage);
  const int64_t second = *book.Grant("plugin-1", kOtherTab);
  Expect(book.LiveFor("plugin-1") == 2, "a credential counts its live leases");
  book.Release(first);
  book.Release(second);
  Expect(book.LiveFor("plugin-1") == 0, "the count drops with each release");
  Expect(book.Admit("plugin-1", kPage) == 0,
         "a credential with no live lease admits nothing");
  const int64_t again = *book.Grant("plugin-1", kPage);
  Expect(book.Admit("plugin-1", kPage) == again,
         "a credential granted again after its last lease ended works");
  Expect(!book.GrantLive(first, "plugin-1", kPage),
         "an old grant stays dead when the credential comes back");
}

using Holds = std::vector<ardia::ActLeaseHold>;

void HoldFollowsTheLeaseAndItsLastAction() {
  ardia::ActLeaseBook book;
  Expect(!book.HoldHeld("plugin-1", 7), "no hold before a grant");
  const int64_t lease = *book.Grant("plugin-1", kPage);
  Expect(book.HoldHeld("plugin-1", 7), "a grant holds its tab");
  Expect(book.TabOf(lease) == 7, "a lease names its tab");
  const int64_t ticket = book.ActionAdmitted(lease);
  Expect(ticket > 0, "an admitted action gets a ticket");
  Expect(book.TicketLive(ticket, "plugin-1", kPage),
         "its ticket is live while the lease is");
  Expect(!book.TicketLive(ticket, "plugin-2", kPage) &&
             !book.TicketLive(ticket, "plugin-1", kNextDocument),
         "a ticket is live only for its credential and document");
  book.Release(lease);
  Expect(!book.TicketLive(ticket, "plugin-1", kPage),
         "a ticket dies with its lease, so a held delivery is refused");
  Expect(book.TakeEndedHolds().empty(),
         "a released lease keeps the hold while its admitted action runs");
  Expect(book.HoldHeld("plugin-1", 7), "the hold is still on");
  Expect(book.ActionReturned(ticket), "the action returns once");
  Expect(!book.ActionReturned(ticket), "a second return settles nothing");
  Expect(book.TakeEndedHolds() == Holds{{"plugin-1", 7}},
         "the hold ends once the last admitted action has returned");
  Expect(!book.HoldHeld("plugin-1", 7), "and it's gone");
  Expect(book.TakeEndedHolds().empty(), "an ended hold is reported once");
}

void HoldIsCountedPerCredentialAndTab() {
  ardia::ActLeaseBook book;
  const int64_t first = *book.Grant("plugin-1", kPage);
  const int64_t second = *book.Grant("plugin-1", kPage);
  const int64_t other = *book.Grant("plugin-2", kPage);
  book.Release(first);
  Expect(book.TakeEndedHolds().empty(),
         "a second lease of the same credential on the tab keeps the hold");
  book.Release(second);
  Expect(book.TakeEndedHolds() == Holds{{"plugin-1", 7}},
         "the last lease of that credential on the tab ends its hold");
  Expect(book.HoldHeld("plugin-2", 7),
         "another credential's hold on the same tab is its own");
  book.Release(other);
  Expect(book.TakeEndedHolds() == Holds{{"plugin-2", 7}},
         "and it ends with that credential's last lease");
}

void EveryEndPathEndsTheHold() {
  {
    ardia::ActLeaseBook book;
    book.Grant("plugin-1", kPage);
    book.ReleaseTabExcept(7, 71);
    Expect(book.TakeEndedHolds() == Holds{{"plugin-1", 7}},
           "a new document ends the hold");
  }
  {
    ardia::ActLeaseBook book;
    book.Grant("plugin-1", kPage);
    book.Grant("plugin-1", kOtherTab);
    book.ReleaseCredential("plugin-1");
    const Holds ended = book.TakeEndedHolds();
    Expect(ended.size() == 2, "a revoke ends the credential's holds on every tab");
  }
  {
    ardia::ActLeaseBook book;
    book.Grant("plugin-1", kPage);
    book.ReleaseTab(7);
    Expect(book.TakeEndedHolds() == Holds{{"plugin-1", 7}},
           "a renderer exit ends the hold");
  }
  {
    ardia::ActLeaseBook book;
    book.ActionAdmitted(*book.Grant("plugin-1", kPage));
    book.ReleaseTab(7);
    book.DropTabHolds(7);
    Expect(book.TakeEndedHolds().empty() && !book.HoldHeld("plugin-1", 7),
           "a closed tab drops its holds without asking to turn them off");
  }
  {
    ardia::ActLeaseBook book;
    const int64_t first = *book.Grant("plugin-1", kPage);
    book.Grant("plugin-1", kPage);
    book.Grant("plugin-1", kOtherTab);
    book.Grant("plugin-2", kPage);
    std::vector<int64_t> tabs = book.TabsLeasedBy("plugin-1");
    std::sort(tabs.begin(), tabs.end());
    Expect(tabs == std::vector<int64_t>{7, 9},
           "a credential's leased tabs are listed once each");
    const int64_t ticket = book.ActionAdmitted(first);
    Expect(book.ReleaseCredentialOnTab("plugin-1", 7) == 2,
           "the last detach ends that credential's leases on the tab");
    Expect(book.Admit("plugin-1", kPage) == 0,
           "a fresh attach needs a new grant");
    Expect(book.Admit("plugin-1", kOtherTab) != 0,
           "its leases on other tabs stay");
    Expect(book.Admit("plugin-2", kPage) != 0,
           "another credential's lease on the tab stays");
    Expect(book.TakeEndedHolds().empty(),
           "the hold waits for the action admitted before the detach");
    book.ActionReturned(ticket);
    Expect(book.TakeEndedHolds() == Holds{{"plugin-1", 7}},
           "and ends once it has returned");
    Expect(book.ReleaseCredentialOnTab("plugin-3", 7) == 0,
           "an unknown credential ends nothing");
  }
  {
    ardia::ActLeaseBook book;
    book.Grant("plugin-1", kPage);
    book.Grant("plugin-2", kOtherTab);
    book.Clear();
    Expect(book.TakeEndedHolds().size() == 2,
           "clearing the book (control server stopped) ends every hold");
  }
  {
    ardia::ActLeaseBook book;
    Expect(book.ActionAdmitted(42) == 0 && !book.ActionReturned(0),
           "an action without a live lease gets no ticket");
    Expect(book.TakeEndedHolds().empty() && !book.HoldHeld("plugin-1", 7),
           "and counts nothing");
  }
}

void ExpiredActionsEndTheHoldAndTheirDeliveries() {
  ardia::ActLeaseBook book;
  const int64_t lease = *book.Grant("plugin-1", kPage);
  const int64_t pending = book.ActionAdmitted(lease);
  book.Release(lease);
  Expect(book.TakeEndedHolds().empty() && book.ActionsPending() == 1,
         "a released lease waits for its pending action");
  Expect(book.ActionReturned(pending),
         "the per-action deadline returns an action Chromium never answered");
  Expect(book.TakeEndedHolds() == Holds{{"plugin-1", 7}},
         "and the hold ends with it");
  Expect(!book.TicketLive(pending, "plugin-1", kPage),
         "its ticket is dead, so a delivery still waiting for it can't land");
  const int64_t again = *book.Grant("plugin-1", kPage);
  const int64_t fresh = book.ActionAdmitted(again);
  Expect(fresh != pending, "a later command gets a new ticket");
  Expect(!book.ActionReturned(pending),
         "a late reply for the expired action settles nothing");
  Expect(book.TicketLive(fresh, "plugin-1", kPage),
         "and the later command's ticket is untouched");
}

void LastActionReturnsDuringARevoke() {
  ardia::ActLeaseBook book;
  const int64_t on_page = *book.Grant("plugin-1", kPage);
  const int64_t on_other = *book.Grant("plugin-1", kOtherTab);
  const int64_t page_action = book.ActionAdmitted(on_page);
  const int64_t other_action = book.ActionAdmitted(on_other);
  Expect(book.ReleaseCredential("plugin-1") == 2,
         "the revoke ends both leases");
  Expect(book.TakeEndedHolds().empty(),
         "both holds wait for their pending actions");
  std::vector<int64_t> returned = {page_action};
  for (int64_t ticket : returned) {
    book.ActionReturned(ticket);
  }
  Expect(book.TakeEndedHolds() == Holds{{"plugin-1", 7}},
         "the last action on the first tab ends its hold during the revoke");
  Expect(book.HoldHeld("plugin-1", 9),
         "the other tab's hold waits for its own pending action");
  Expect(book.ActionsPending() == 1, "one action is still pending");
  book.ActionReturned(other_action);
  Expect(book.TakeEndedHolds() == Holds{{"plugin-1", 9}},
         "and ends once that returns");
  Expect(book.Live() == 0 && book.ActionsPending() == 0,
         "nothing is left after the revoke");
}

std::vector<int> g_hosts(64);

ardia::ActLeaseDocument BenchDocument(int tab) {
  return ardia::ActLeaseDocument{tab + 1, &g_hosts[tab], 1000 + tab};
}

void AdmitBenchmark() {
  ardia::ActLeaseBook book;
  std::vector<std::string> credentials;
  for (int i = 0; i < 16; ++i) {
    credentials.push_back("plugin-" + std::to_string(i));
  }
  std::vector<int64_t> grants;
  for (int i = 0; i < 16; ++i) {
    for (int j = 0; j < 8; ++j) {
      grants.push_back(*book.Grant(credentials[i], BenchDocument((i * 8 + j) % 64)));
    }
  }
  const std::string unknown = "plugin-unknown";
  constexpr int kChecks = 1000000;
  long admitted = 0;
  const long admit_allocations_before = g_allocations.load();
  const auto admit_start = std::chrono::steady_clock::now();
  for (int i = 0; i < kChecks; ++i) {
    const std::string& credential =
        (i & 7) == 7 ? unknown : credentials[(i / 64) % 16];
    admitted += book.Admit(credential, BenchDocument(i % 64)) != 0;
  }
  const double admit_ms = std::chrono::duration<double, std::milli>(
                              std::chrono::steady_clock::now() - admit_start)
                              .count();
  const long admit_allocations =
      g_allocations.load() - admit_allocations_before;
  std::printf(
      "bench: 1M Admit checks over %zu leases in %.1f ms (%.1f ns each, %ld "
      "allocations)\n",
      book.Live(), admit_ms, admit_ms * 1e6 / kChecks, admit_allocations);
  Expect(admit_allocations == 0, "Admit allocates nothing");
  const long allocations_before = g_allocations.load();
  const auto start = std::chrono::steady_clock::now();
  for (int i = 0; i < kChecks; ++i) {
    const int tab = i % 64;
    const std::string& credential =
        (i & 7) == 7 ? unknown : credentials[(i / 64) % 16];
    admitted += book.Admit(credential, BenchDocument(tab)) != 0;
    admitted += book.CoversDocument(credential, tab + 1, 1000 + tab);
    admitted += book.GrantLive(grants[i % grants.size()], credential,
                               BenchDocument(tab));
  }
  const auto elapsed = std::chrono::steady_clock::now() - start;
  const long allocations = g_allocations.load() - allocations_before;
  const double total_ms =
      std::chrono::duration<double, std::milli>(elapsed).count();
  const double ns_per_check = total_ms * 1e6 / (3.0 * kChecks);
  std::printf(
      "bench: 1M rounds of Admit + CoversDocument + GrantLive over %zu leases "
      "in %.1f ms (%.1f ns per check, %ld allocations, %ld hits)\n",
      book.Live(), total_ms, ns_per_check, allocations, admitted);
  Expect(allocations == 0, "the checks allocate nothing");
  std::vector<int64_t> tickets;
  for (int64_t grant : grants) {
    tickets.push_back(book.ActionAdmitted(grant));
  }
  const long ticket_allocations_before = g_allocations.load();
  long live = 0;
  for (int i = 0; i < kChecks; ++i) {
    const int tab = i % 64;
    live += book.TicketLive(tickets[i % tickets.size()],
                            credentials[(i / 64) % 16], BenchDocument(tab));
  }
  Expect(g_allocations.load() == ticket_allocations_before,
         "checking a delivery's ticket allocates nothing");
  Expect(live > 0, "some tickets are live in the benchmark");
  Expect(ns_per_check < 2000, "a check stays well under 2 microseconds");
  Expect(admitted > 0, "the benchmark exercises hits as well as misses");
}

}

int main() {
  LeasedAndWithheldMethods();
  GrantNamesTheApprovedDocument();
  GrantAdmitRelease();
  GrantsAreCapturedNotLatest();
  IdsSurviveClear();
  BulkReleases();
  Capped();
  AFailedGrantLeavesAHoldItDidNotTake();
  AFailedGrantDropsOnlyTheHoldItTook();
  AGrantOnANewDocumentTakesOverTheEndedLeasesHold();
  DeliveryIsMarkedPerTicket();
  CredentialsAreForgottenWithTheirLastLease();
  HoldFollowsTheLeaseAndItsLastAction();
  HoldIsCountedPerCredentialAndTab();
  EveryEndPathEndsTheHold();
  ExpiredActionsEndTheHoldAndTheirDeliveries();
  LastActionReturnsDuringARevoke();
  AdmitBenchmark();
  if (failures) {
    std::printf("%d failure(s)\n", failures);
    return 1;
  }
  std::printf("ok\n");
  return 0;
}
