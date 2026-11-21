// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_act_leases.h"

#include "ardia/core/ac_content_hooks.h"
#include "ardia/core/ac_launch_switches.h"
#include "ardia/core/ac_plugin_refusals.h"

#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "base/functional/function_ref.h"
#include "base/memory/weak_ptr.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/strings/strcat.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_plugin_credentials.h"
#include "chrome/browser/ardia/ac_cli_token_policy.h"
#include "chrome/browser/ardia/ac_cli_token_policy_internal.h"
#include "chrome/browser/ardia/ac_cli_visible_tabs.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/document_user_data.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"

namespace ardia {
namespace {

struct Totals {
  int granted = 0;
  int released = 0;
  int ended_by_document = 0;
  int ended_by_detach = 0;
  int commands_refused = 0;
  int deliveries_refused = 0;
};

Totals& TotalsSoFar() {
  static Totals totals;
  return totals;
}

ActLeaseBook& Book() {
  static base::NoDestructor<ActLeaseBook> book;
  return *book;
}

int64_t g_last_tab = 0;
int64_t g_last_document = 0;

class LeasedDocument : public content::DocumentUserData<LeasedDocument> {
 public:
  ~LeasedDocument() override = default;

  int64_t id() const { return id_; }

 private:
  explicit LeasedDocument(content::RenderFrameHost* frame)
      : content::DocumentUserData<LeasedDocument>(frame),
        id_(++g_last_document) {}

  friend content::DocumentUserData<LeasedDocument>;
  DOCUMENT_USER_DATA_KEY_DECL();

  const int64_t id_;
};

DOCUMENT_USER_DATA_KEY_IMPL(LeasedDocument);

int64_t DocumentIdOf(content::RenderFrameHost* main) {
  LeasedDocument* document =
      main ? LeasedDocument::GetForCurrentDocument(main) : nullptr;
  return document ? document->id() : 0;
}

class LeasedTab;

std::unordered_map<int64_t, LeasedTab*>& Tabs() {
  static base::NoDestructor<std::unordered_map<int64_t, LeasedTab*>> tabs;
  return *tabs;
}

void EndHolds();

bool HoldVisible(const std::string& credential_id,
                 content::WebContents* contents,
                 bool on) {
  return contents && SetPluginTabVisibleHold(credential_id, contents, on) ==
                         PluginTabHold::kOk;
}

class LeasedTab : public content::WebContentsObserver,
                  public content::WebContentsUserData<LeasedTab> {
 public:
  ~LeasedTab() override { Forget(); }

  int64_t tab() const { return tab_; }

  const void* PageTarget(scoped_refptr<content::DevToolsAgentHost> page) {
    if (page_ != page) {
      Book().ReleaseTab(tab_);
      EndHolds();
      page_ = std::move(page);
    }
    return page_.get();
  }

  void PrimaryPageChanged(content::Page& page) override {
    TotalsSoFar().ended_by_document += static_cast<int>(Book().ReleaseTabExcept(
        tab_, DocumentIdOf(web_contents()->GetPrimaryMainFrame())));
    EndHolds();
  }

  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override {
    TotalsSoFar().ended_by_document +=
        static_cast<int>(Book().ReleaseTab(tab_));
    EndHolds();
  }

  void WebContentsDestroyed() override { Forget(); }

 private:
  explicit LeasedTab(content::WebContents* contents)
      : content::WebContentsObserver(contents),
        content::WebContentsUserData<LeasedTab>(*contents),
        tab_(++g_last_tab) {
    Tabs()[tab_] = this;
  }

  void Forget() {
    Book().ReleaseTab(tab_);
    Book().DropTabHolds(tab_);
    Tabs().erase(tab_);
  }
  friend class content::WebContentsUserData<LeasedTab>;
  WEB_CONTENTS_USER_DATA_KEY_DECL();

  const int64_t tab_;
  scoped_refptr<content::DevToolsAgentHost> page_;
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(LeasedTab);

void EndHolds() {
  for (const ActLeaseHold& hold : Book().TakeEndedHolds()) {
    if (Book().HoldHeld(hold.credential, hold.tab)) {
      continue;
    }
    auto tab = Tabs().find(hold.tab);
    if (tab != Tabs().end()) {
      HoldVisible(hold.credential, tab->second->web_contents(), false);
    }
  }
}

content::RenderFrameHost* LivePrimaryMainFrame(content::WebContents* contents) {
  content::RenderFrameHost* main =
      contents ? contents->GetPrimaryMainFrame() : nullptr;
  return main && main->IsRenderFrameLive() ? main : nullptr;
}

std::optional<ActLeaseDocument> DocumentOfHost(
    content::DevToolsAgentHost* host) {
  content::WebContents* contents = host ? host->GetWebContents() : nullptr;
  LeasedTab* tab = contents ? LeasedTab::FromWebContents(contents) : nullptr;
  const int64_t document = DocumentIdOf(LivePrimaryMainFrame(contents));
  if (!tab || !document) {
    return std::nullopt;
  }
  return ActLeaseDocument{tab->tab(), host, document};
}

}

std::optional<int64_t> ActDocumentOf(content::WebContents* contents) {
  content::RenderFrameHost* main = LivePrimaryMainFrame(contents);
  if (!main) {
    return std::nullopt;
  }
  const int64_t document =
      LeasedDocument::GetOrCreateForCurrentDocument(main)->id();
  if (document > std::numeric_limits<int>::max()) {
    return std::nullopt;
  }
  return document;
}

namespace {

class ContentsHold final : public ActHold {
 public:
  ContentsHold(const std::string& credential_id,
               content::WebContents* contents,
               const void* target,
               int64_t expected_document)
      : credential_id_(credential_id),
        contents_(contents->GetWeakPtr()),
        target_(target),
        expected_document_(expected_document) {}

  bool IsOn() override {
    return contents_ &&
           PluginTabVisibleHoldHeld(credential_id_, contents_.get());
  }

  bool TurnOn() override {
    return HoldVisible(credential_id_, contents_.get(), true);
  }

  void TurnOff() override {
    HoldVisible(credential_id_, contents_.get(), false);
  }

  bool StillApproved() override {
    content::RenderFrameHost* main = LivePrimaryMainFrame(contents_.get());
    if (!main ||
        !ExpectedDocumentCurrent(expected_document_, DocumentIdOf(main))) {
      return false;
    }
    scoped_refptr<content::DevToolsAgentHost> page =
        content::DevToolsAgentHost::GetOrCreateFor(contents_.get());
    return LeasedTab::FromWebContents(contents_.get()) && page.get() == target_;
  }

 private:
  const std::string& credential_id_;
  const base::WeakPtr<content::WebContents> contents_;
  const void* const target_;
  const int64_t expected_document_;
};

const char* GrantRefusalText(ActGrantRefusal why) {
  switch (why) {
    case ActGrantRefusal::kNotShown:
      return refusal::kActTabNotShown;
    case ActGrantRefusal::kReplaced:
      return refusal::kActDocumentReplaced;
    case ActGrantRefusal::kNone:
    case ActGrantRefusal::kFull:
      return refusal::kNoActLeaseNow;
  }
  return refusal::kNoActLeaseNow;
}

}

std::optional<int64_t> GrantActLease(const std::string& credential_id,
                                     content::WebContents* contents,
                                     int64_t expected_document,
                                     std::string* error) {
  content::RenderFrameHost* main = LivePrimaryMainFrame(contents);
  if (!main || !PluginCredentialLive(credential_id)) {
    *error = refusal::kNoActLeaseNow;
    return std::nullopt;
  }
  const int64_t document = DocumentIdOf(main);
  if (!ExpectedDocumentCurrent(expected_document, document)) {
    *error = refusal::kActDocumentReplaced;
    return std::nullopt;
  }
  LeasedTab* tab = LeasedTab::GetOrCreateForWebContents(contents);
  scoped_refptr<content::DevToolsAgentHost> page =
      content::DevToolsAgentHost::GetOrCreateFor(contents);
  if (!page) {
    *error = refusal::kNoActLeaseNow;
    return std::nullopt;
  }
  const void* target = tab->PageTarget(std::move(page));
  ContentsHold hold(credential_id, contents, target, expected_document);
  const ActGrant grant = Book().GrantWithHold(
      credential_id, ActLeaseDocument{tab->tab(), target, document}, hold);
  if (grant.lease > std::numeric_limits<int>::max()) {
    Book().Clear();
  }
  EndHolds();
  if (!grant.lease || grant.lease > std::numeric_limits<int>::max()) {
    *error = GrantRefusalText(grant.refusal);
    return std::nullopt;
  }
  ++TotalsSoFar().granted;
  return grant.lease;
}

bool ReleaseActLease(int64_t lease) {
  const bool released = Book().Release(lease);
  TotalsSoFar().released += released;
  EndHolds();
  return released;
}

void ReleaseActLeasesOf(const std::string& credential_id) {
  TotalsSoFar().released +=
      static_cast<int>(Book().ReleaseCredential(credential_id));
  EndHolds();
}

int64_t ActLeaseActionAdmitted(int64_t lease) {
  return Book().ActionAdmitted(lease);
}

void EndActLeasesWithoutSession(
    const std::string& credential_id,
    base::FunctionRef<bool(content::WebContents*)> attached) {
  size_t ended = 0;
  for (int64_t tab : Book().TabsLeasedBy(credential_id)) {
    auto it = Tabs().find(tab);
    content::WebContents* contents =
        it == Tabs().end() ? nullptr : it->second->web_contents();
    if (!contents || !attached(contents)) {
      ended += Book().ReleaseCredentialOnTab(credential_id, tab);
    }
  }
  TotalsSoFar().ended_by_detach += static_cast<int>(ended);
  EndHolds();
}

void ActLeaseTabDeparted(const std::string& credential_id,
                         content::WebContents* contents) {
  LeasedTab* tab = contents ? LeasedTab::FromWebContents(contents) : nullptr;
  if (!tab) {
    return;
  }
  TotalsSoFar().ended_by_detach += static_cast<int>(
      Book().ReleaseCredentialOnTab(credential_id, tab->tab()));
  EndHolds();
}

void ActLeaseActionsReturned(const std::vector<int64_t>& tickets) {
  for (int64_t ticket : tickets) {
    Book().ActionReturned(ticket);
  }
  EndHolds();
}

int64_t AdmitActLease(const std::string& credential_id,
                      content::DevToolsAgentHost* host) {
  const std::optional<ActLeaseDocument> document = DocumentOfHost(host);
  return document ? Book().Admit(credential_id, *document) : 0;
}

bool ActLeaseCoversFrame(const std::string& credential_id,
                         content::RenderFrameHost* frame) {
  content::RenderFrameHost* main =
      frame ? frame->GetOutermostMainFrame() : nullptr;
  content::WebContents* contents =
      main ? content::WebContents::FromRenderFrameHost(main) : nullptr;
  if (!contents || contents->GetPrimaryMainFrame() != main) {
    return false;
  }
  LeasedTab* tab = LeasedTab::FromWebContents(contents);
  const int64_t document = DocumentIdOf(main);
  return tab && document &&
         Book().CoversDocument(credential_id, tab->tab(), document);
}

bool ActTicketLive(int64_t ticket,
                   const std::string& credential_id,
                   content::DevToolsAgentHost* host) {
  const std::optional<ActLeaseDocument> document = DocumentOfHost(host);
  return document && Book().TicketLive(ticket, credential_id, *document);
}

void ActTicketDelivering(int64_t ticket) {
  Book().NoteDelivering(ticket);
}

bool ActTicketDelivered(int64_t ticket) {
  return Book().Delivering(ticket);
}

void CountActCommandRefused() {
  ++TotalsSoFar().commands_refused;
}

void CountActDeliveryRefused() {
  ++TotalsSoFar().deliveries_refused;
}

base::DictValue ActLeaseTotals() {
  const Totals& totals = TotalsSoFar();
  return base::DictValue()
      .Set("granted", totals.granted)
      .Set("released", totals.released)
      .Set("endedByDocument", totals.ended_by_document)
      .Set("endedByDetach", totals.ended_by_detach)
      .Set("commandsRefused", totals.commands_refused)
      .Set("deliveriesRefused", totals.deliveries_refused)
      .Set("live", static_cast<int>(Book().Live()));
}

}

namespace {

content::WebContents* ScopedTabFor(const base::DictValue& args,
                                   std::string* error) {
  const std::string* credential = args.FindString("credential");
  const std::optional<ardia::PluginScope> scope =
      credential ? ardia::PluginScopeForId(*credential) : std::nullopt;
  if (!scope) {
    *error = "unknown credential";
    return nullptr;
  }
  const std::optional<int> tab = args.FindInt("tab");
  content::WebContents* contents = tab ? ardia::TabWithId(*tab) : nullptr;
  if (!contents) {
    *error = "no such tab";
    return nullptr;
  }
  if (!ardia::cli_token_policy_internal::PluginMayAttachToFrame(
          *scope, contents->GetPrimaryMainFrame())) {
    *error = "out of scope";
    return nullptr;
  }
  return contents;
}

}

AC_ARGS_CALL(ac_cli_act_document) {
  ardia::Reply out = call.TakeReply();
  std::string error;
  content::WebContents* contents = ScopedTabFor(call.args(), &error);
  if (!contents) {
    return out.Error(error);
  }
  const std::optional<int64_t> document = ardia::ActDocumentOf(contents);
  if (!document) {
    return out.Error("no document for this page now");
  }
  out.Send(base::DictValue().Set("document", static_cast<int>(*document)));
}

AC_ARGS_CALL(ac_cli_act_lease) {
  ardia::Reply out = call.TakeReply();
  const base::DictValue& args = call.args();
  std::string error;
  content::WebContents* contents = ScopedTabFor(args, &error);
  if (!contents) {
    return out.Error(error);
  }
  const std::optional<int> expected = args.FindInt("document");
  const std::optional<int64_t> lease = ardia::GrantActLease(
      *args.FindString("credential"), contents, expected.value_or(0), &error);
  if (!lease) {
    return out.Error(error);
  }
  out.Send(base::DictValue().Set("lease", static_cast<int>(*lease)));
}

AC_ARGS_CALL(ac_cli_act_release) {
  ardia::Reply out = call.TakeReply();
  const std::optional<int> lease = call.args().FindInt("lease");
  if (!lease) {
    return out.Error("no lease");
  }
  out.Send(
      base::DictValue().Set("released", ardia::ReleaseActLease(*lease)));
}

AC_ARGS_CALL(ac_cli_test_pointer) {
  ardia::Reply out = call.TakeReply();
  if (!ardiacore::TestFlag("pluginInputHold")) {
    return out.Error("only in a test build with pluginInputHold");
  }
  const base::DictValue& args = call.args();
  if (const std::optional<bool> park = args.FindBool("park")) {
    g_ardia_test_pointer_park = *park;
  }
  if (const std::optional<bool> withhold = args.FindBool("withholdAcks")) {
    g_ardia_test_pointer_withhold_acks = *withhold;
  }
  const size_t released = args.FindBool("release").value_or(false)
                              ? content::ArdiaReleaseParkedPointers()
                              : 0;
  out.Send(base::DictValue()
               .Set("parked", static_cast<int>(content::ArdiaParkedPointerCount()))
               .Set("released", static_cast<int>(released))
               .Set("recoveries", g_ardia_test_pointer_recoveries)
               .Set("holds", ardia::PluginTabVisibleHoldCount()));
}
