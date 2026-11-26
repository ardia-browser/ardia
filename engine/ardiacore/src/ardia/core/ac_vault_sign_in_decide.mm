#import "ardia/core/ac_vault_sign_in_internal.h"

#include <string>
#include <string_view>

#include "base/strings/string_util.h"
#include "content/public/browser/cookie_access_details.h"
#include "content/public/browser/storage_partition.h"
#include "net/http/http_response_headers.h"

namespace ardiacore {
namespace vault_internal {

namespace {

bool PathReadsAsTrouble(std::string_view path) {
  const std::string lower = base::ToLowerASCII(path);
  for (std::string_view word :
       {"denied", "locked", "lockout", "error", "blocked", "challenge",
        "verify", "verification", "consent", "captcha", "suspended",
        "forbidden", "unauthorized"}) {
    if (lower.find(word) != std::string::npos) {
      return true;
    }
  }
  return false;
}

bool IsInfrastructureCookie(const std::string& cookie_name) {
  const std::string name = base::ToLowerASCII(cookie_name);
  for (std::string_view prefix :
       {"__cf", "cf_", "_cfuvid", "awsalb", "awselb", "incap_ses",
        "visid_incap", "nlbi_", "ak_bmsc", "bm_sv", "bm_sz", "_abck", "__ddg",
        "datadome"}) {
    if (name.starts_with(prefix)) {
      return true;
    }
  }
  return false;
}

}

void VaultSignIn::ListenForCookies() {
  cookie_listener_.reset();
  if (!vault_profile_) {
    return;
  }
  vault_profile_->GetDefaultStoragePartition()
      ->GetCookieManagerForBrowserProcess()
      ->AddCookieChangeListener(request_.origin.GetURL(), std::nullopt,
                                cookie_listener_.BindNewPipeAndPassRemote());
}

void VaultSignIn::LoginSucceeded() {
  ProbeInPlace();
}

void VaultSignIn::Judge() {
  if (phase_ == Phase::kDone || filling_ || awaiting_code_) {
    return;
  }
  if (phase_ == Phase::kUsernameSent) {
    Conclude(passkey_requested_      ? "needs_passkey"
             : navigated_since_submit_ ? "needs_human"
                                       : "still_on_login");
    return;
  }
  ProbeAll(true);
}

void VaultSignIn::DeadlinePassed() {
  if (phase_ == Phase::kDone) {
    return;
  }
  if (!submitted_) {
    if (credential_ready_) {
      NoForm();
    } else {
      Conclude("failed");
    }
    return;
  }
  filling_ = false;
  awaiting_code_ = false;
  if (phase_ == Phase::kUsernameSent) {
    Judge();
    return;
  }
  deadline_passed_ = true;
  Decide(last_state_, last_complete_, true);
  if (phase_ != Phase::kDone) {
    ConcludeUnconfirmed();
  }
}

void VaultSignIn::DOMContentLoaded(content::RenderFrameHost* frame) {
  if (phase_ != Phase::kDone && !submitted_ && frame->IsInPrimaryMainFrame()) {
    page_ready_ = true;
    MaybeNoForm();
    return;
  }
  if (phase_ == Phase::kDone || !submitted_ || !navigated_since_submit_ ||
      !IsDecidingFrame(frame) ||
      net::SchemefulSite(frame->GetLastCommittedOrigin()) !=
          net::SchemefulSite(request_.origin)) {
    return;
  }
  ProbeInPlace();
}

bool VaultSignIn::DecidingInPlace() const {
  return submitted_ && !filling_ && !awaiting_code_ &&
         (phase_ == Phase::kPasswordSent || phase_ == Phase::kCodeSent);
}

content::RenderFrameHost* VaultSignIn::DecidingFrame() const {
  if (!contents_) {
    return nullptr;
  }
  content::RenderFrameHost* frame =
      contents_->UnsafeFindFrameByFrameTreeNodeId(filled_node_);
  return frame && frame->IsActive() ? frame : contents_->GetPrimaryMainFrame();
}

void VaultSignIn::ProbeInPlace() {
  if (DecidingInPlace() && !NavigationPending()) {
    ProbeAll(false);
  }
}

void VaultSignIn::ProbeAll(bool final) {
  if (!contents_ || phase_ == Phase::kDone) {
    return;
  }
  if (probes_pending_ > 0) {
    probe_again_ = true;
    probe_again_final_ |= final;
    return;
  }
  probes_.clear();
  ++probe_round_;
  gathered_ = mojom::ACVaultPageState::New();
  gathered_complete_ = true;
  deciding_answered_ = false;
  final_probe_ = final;
  content::RenderFrameHost* deciding = DecidingFrame();
  probe_deciding_frame_ =
      deciding ? deciding->GetGlobalId() : content::GlobalRenderFrameHostId();
  const net::SchemefulSite site(request_.origin);
  contents_->GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&](content::RenderFrameHost* frame) {
        if (!frame->IsActive() || !frame->IsRenderFrameLive() ||
            net::SchemefulSite(frame->GetLastCommittedOrigin()) != site) {
          return;
        }
        mojo::AssociatedRemote<mojom::ACVaultFiller>& remote =
            probes_.emplace_back();
        frame->GetRemoteAssociatedInterfaces()->GetInterface(&remote);
        remote.set_disconnect_handler(base::BindOnce(
            &VaultSignIn::ProbeLost, base::Unretained(this), probe_round_));
        ++probes_pending_;
        remote->ProbeDocument(base::BindOnce(&VaultSignIn::ProbedOne,
                                             weak_factory_.GetWeakPtr(),
                                             probe_round_, frame == deciding));
      });
  if (probes_pending_ == 0) {
    probes_.clear();
    if (final) {
      ConcludeUnconfirmed();
    }
  }
}

void VaultSignIn::ProbeLater(base::TimeDelta delay, bool final) {
  confirm_gone_.Start(FROM_HERE, delay,
                      base::BindOnce(&VaultSignIn::ProbeAll,
                                     base::Unretained(this), final));
}

void VaultSignIn::InvalidateProbes() {
  ++probe_round_;
  probes_pending_ = 0;
  probes_.clear();
  gathered_.reset();
  probe_again_ = false;
  probe_again_final_ = false;
  last_state_ = mojom::ACVaultPageState();
  last_complete_ = false;
  gone_since_ = base::TimeTicks();
  confirm_gone_.Stop();
}

void VaultSignIn::ProbedOne(int round,
                            bool deciding,
                            mojom::ACVaultPageStatePtr state) {
  if (round != probe_round_ || !gathered_) {
    return;
  }
  if (!state || !state->complete) {
    gathered_complete_ = false;
  } else {
    gathered_->password_field |= state->password_field;
    gathered_->code_field |= state->code_field;
    gathered_->challenge |= state->challenge;
    gathered_->error_shown |= state->error_shown;
    gathered_->get_form_blocked |= state->get_form_blocked;
    if (deciding) {
      gathered_->text_field = state->text_field;
      deciding_answered_ = true;
    }
  }
  ProbeFinished(round);
}

void VaultSignIn::ProbeLost(int round) {
  if (round == probe_round_) {
    gathered_complete_ = false;
  }
  ProbeFinished(round);
}

void VaultSignIn::ProbeFinished(int round) {
  if (round != probe_round_ || probes_pending_ == 0 || --probes_pending_ > 0) {
    return;
  }
  probes_.clear();
  last_state_ = *gathered_;
  last_complete_ = gathered_complete_ && deciding_answered_;
  const bool final = final_probe_;
  Decide(last_state_, last_complete_, final);
  if (phase_ != Phase::kDone && probe_again_) {
    const bool again_final = probe_again_final_;
    probe_again_ = false;
    probe_again_final_ = false;
    ProbeAll(again_final);
  }
}

bool VaultSignIn::AnySignal() const {
  return server_cookie_changed_ || nav_away_ || navigated_since_submit_ ||
         url_changed_ || cookie_changed_;
}

bool VaultSignIn::SignedInByNavigation() const {
  return doc_qualifies_ && probe_deciding_frame_ == doc_frame_ &&
         httponly_navigations_.contains(doc_navigation_);
}

void VaultSignIn::Decide(const mojom::ACVaultPageState& state,
                         bool complete,
                         bool final) {
  if (phase_ == Phase::kDone || filling_ || awaiting_code_) {
    return;
  }
  if (!complete || state.password_field || state.code_field ||
      state.challenge || state.error_shown || state.get_form_blocked) {
    gone_since_ = base::TimeTicks();
    confirm_gone_.Stop();
  }
  if (state.get_form_blocked) {
    reason_ = "get_form";
    Conclude("failed");
    return;
  }
  if (NavigationPending()) {
    if (deadline_passed_) {
      ConcludeUnconfirmed();
    }
    return;
  }
  if (doc_error_page_) {
    reason_ = "error_page";
    Conclude("failed");
    return;
  }
  if (doc_status_ >= 400) {
    Conclude("still_on_login");
    return;
  }
  const bool code_step_expected =
      phase_ == Phase::kPasswordSent && request_.code_provider;
  if (state.error_shown) {
    Conclude(phase_ == Phase::kCodeSent && state.code_field ? "needs_human"
                                                             : "still_on_login");
    return;
  }
  if (state.password_field) {
    gone_since_ = base::TimeTicks();
    confirm_gone_.Stop();
    if (navigated_since_submit_ || final) {
      Conclude("still_on_login");
    }
    return;
  }
  if (state.challenge ||
      (state.code_field && !code_step_expected &&
       (phase_ != Phase::kCodeSent || navigated_since_submit_ || final))) {
    Conclude("needs_human");
    return;
  }
  if (state.code_field || (code_step_expected && state.text_field)) {
    if (final) {
      Conclude("needs_human");
    }
    return;
  }
  if (!complete) {
    gone_since_ = base::TimeTicks();
    if (deadline_passed_) {
      ConcludeUnconfirmed();
    } else {
      ProbeLater(kAbsence, final);
    }
    return;
  }
  form_gone_ = true;
  const base::TimeTicks now = base::TimeTicks::Now();
  if (gone_since_.is_null()) {
    gone_since_ = now;
  }
  content::RenderFrameHost* deciding = DecidingFrame();
  if (SignedInByNavigation() && !deadline_passed_ && deciding &&
      !PathReadsAsTrouble(deciding->GetLastCommittedURL().path())) {
    if (!loaded_frames_.contains(probe_deciding_frame_)) {
      if (final) {
        ConcludeUnconfirmed();
      }
      return;
    }
    const base::TimeDelta quiet = now - last_change_;
    const base::TimeDelta settled = now - gone_since_;
    if (quiet < kQuietBeforeSignedIn && settled < kSettleCap) {
      ProbeLater(std::min(kQuietBeforeSignedIn - quiet, kSettleCap - settled),
                 final);
      return;
    }
    evidence_ = "strong";
    Conclude("signed_in");
    return;
  }
  const base::TimeDelta needed = AnySignal() ? kAbsence : kNoSignalWait;
  if (now - gone_since_ < needed) {
    if (deadline_passed_) {
      ConcludeUnconfirmed();
    } else {
      ProbeLater(needed - (now - gone_since_), final);
    }
    return;
  }
  ConcludeUnconfirmed();
}

void VaultSignIn::DidFinishLoad(content::RenderFrameHost* frame,
                                const GURL& validated_url) {
  loaded_frames_.insert(frame->GetGlobalId());
  if (frame->GetGlobalId() == probe_deciding_frame_ ||
      IsDecidingFrame(frame)) {
    ProbeInPlace();
  }
}

void VaultSignIn::ConcludeUnconfirmed() {
  evidence_ = AnySignal() ? "weak" : "none";
  Conclude("submitted");
}

void VaultSignIn::WatchInPlace() {
  content::RenderFrameHost* frame = DecidingFrame();
  if (!DecidingInPlace() || !frame) {
    return;
  }
  if (watch_.is_bound() && watch_frame_ != frame->GetGlobalId()) {
    watch_->StopWatching();
  }
  watch_frame_ = frame->GetGlobalId();
  watch_.reset();
  frame->GetRemoteAssociatedInterfaces()->GetInterface(&watch_);
  watch_.set_disconnect_handler(
      base::BindOnce(&VaultSignIn::WatchGone, base::Unretained(this)));
  watch_->WatchForChange(
      base::BindOnce(&VaultSignIn::PageChanged, weak_factory_.GetWeakPtr()));
}

void VaultSignIn::WatchGone() {
  watch_.reset();
  ProbeInPlace();
  WatchInPlace();
}

void VaultSignIn::PageChanged() {
  last_change_ = base::TimeTicks::Now();
  watch_.reset();
  ProbeInPlace();
  WatchInPlace();
}

void VaultSignIn::DidStartNavigation(content::NavigationHandle* navigation) {
  if (!(submitted_ || filling_) || navigation->IsSameDocument() ||
      (!navigation->IsInPrimaryMainFrame() &&
       navigation->GetFrameTreeNodeId() != filled_node_)) {
    return;
  }
  pending_navigations_.insert(navigation->GetNavigationId());
  InvalidateProbes();
  if (evidence_armed_) {
    step_navigations_.insert(navigation->GetNavigationId());
  }
}

bool VaultSignIn::NavigationPending() const {
  return !pending_navigations_.empty();
}

void VaultSignIn::OnCookieChange(const net::CookieChangeInfo& change) {
  if (change.cause != net::CookieChangeCause::INSERTED || !evidence_armed_ ||
      phase_ == Phase::kDone || IsInfrastructureCookie(change.cookie.Name())) {
    return;
  }
  cookie_changed_ = true;
  ProbeInPlace();
}

void VaultSignIn::OnCookiesAccessed(content::RenderFrameHost* frame,
                                    const content::CookieAccessDetails& details) {
  if (!frame || !SetsServerCookie(details)) {
    return;
  }
  if (frame->GetFrameTreeNodeId() == filled_node_ ||
      frame->GetGlobalId() == doc_frame_) {
    server_cookie_changed_ = true;
    ProbeInPlace();
  }
}

void VaultSignIn::OnCookiesAccessed(content::NavigationHandle* navigation,
                                    const content::CookieAccessDetails& details) {
  if (!step_navigations_.contains(navigation->GetNavigationId()) ||
      details.source != content::CookieAccessDetails::Source::kNavigation ||
      !SetsServerCookie(details)) {
    return;
  }
  const std::vector<GURL>& chain = navigation->GetRedirectChain();
  if (std::ranges::find(chain, details.url) == chain.end()) {
    return;
  }
  server_cookie_changed_ = true;
  httponly_navigations_.insert(navigation->GetNavigationId());
  ProbeInPlace();
}

bool VaultSignIn::SetsServerCookie(
    const content::CookieAccessDetails& details) const {
  if (!evidence_armed_ || phase_ == Phase::kDone ||
      details.type != content::CookieAccessDetails::Type::kChange ||
      details.blocked_by_policy ||
      net::SchemefulSite(details.url) != net::SchemefulSite(request_.origin)) {
    return false;
  }
  const base::Time now = base::Time::Now();
  for (const net::CookieWithAccessResult& entry :
       details.cookie_access_result_list) {
    if (entry.access_result.status.IsInclude() && entry.cookie.IsHttpOnly() &&
        !entry.cookie.Value().empty() && !entry.cookie.IsExpired(now) &&
        !IsInfrastructureCookie(entry.cookie.Name())) {
      return true;
    }
  }
  return false;
}

void VaultSignIn::DidFinishNavigation(content::NavigationHandle* navigation) {
  const bool tracked = navigation->IsInPrimaryMainFrame() ||
                       navigation->GetFrameTreeNodeId() == filled_node_;
  if (!navigation->IsSameDocument()) {
    pending_navigations_.erase(navigation->GetNavigationId());
  }
  if (!navigation->HasCommitted()) {
    return;
  }
  if (navigation->IsSameDocument()) {
    if (DecidingInPlace() && tracked) {
      url_changed_ = true;
      InvalidateProbes();
      ProbeInPlace();
    }
    return;
  }
  Disarm(navigation->GetPreviousRenderFrameHostId());
  if (!tracked) {
    return;
  }
  if (navigation->IsInPrimaryMainFrame()) {
    page_loaded_ = false;
    passkey_requested_ = false;
    if (!submitted_) {
      page_ready_ = false;
      no_form_.Stop();
    }
  }
  if (submitted_ || filling_) {
    navigated_since_submit_ = true;
    last_change_ = base::TimeTicks::Now();
    InvalidateProbes();
    doc_error_page_ = navigation->IsErrorPage();
    const net::HttpResponseHeaders* headers = navigation->GetResponseHeaders();
    doc_status_ = headers ? headers->response_code() : 0;
    const GURL& url = navigation->GetURL();
    const bool this_step =
        evidence_armed_ &&
        step_navigations_.contains(navigation->GetNavigationId());
    const bool same_site =
        net::SchemefulSite(url) == net::SchemefulSite(request_.origin);
    const bool path_changed = url.path() != fill_path_;
    if (this_step && same_site && path_changed) {
      nav_away_ = true;
    }
    doc_qualifies_ = this_step && same_site && path_changed &&
                     !doc_error_page_ && doc_status_ >= 200 &&
                     doc_status_ < 300 && !PathReadsAsTrouble(url.path());
    doc_navigation_ = navigation->GetNavigationId();
    doc_frame_ = navigation->GetRenderFrameHost()
                     ? navigation->GetRenderFrameHost()->GetGlobalId()
                     : content::GlobalRenderFrameHostId();
    settle_.Start(FROM_HERE, kSettleWithoutNavigation,
                  base::BindOnce(&VaultSignIn::Judge,
                                 base::Unretained(this)));
    WatchInPlace();
  }
}

bool VaultSignIn::IsDecidingFrame(content::RenderFrameHost* frame) const {
  return frame->IsInPrimaryMainFrame() ||
         (frame->IsActive() && frame->GetFrameTreeNodeId() == filled_node_);
}

}
}
