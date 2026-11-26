#import "ardia/core/ac_vault_sign_in_internal.h"

#import <AppKit/AppKit.h>

#include <algorithm>
#include <set>
#include <sstream>
#include <string_view>

#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "content/public/browser/storage_partition.h"
#include "base/strings/string_split.h"

namespace ardiacore {
namespace vault_internal {

namespace {

NSNumber* Milliseconds(base::TimeDelta delta) {
  return @(std::max<int64_t>(0, delta.InMilliseconds()));
}

std::string FormDecoded(std::string_view raw) {
  std::string decoded;
  decoded.reserve(raw.size());
  for (size_t i = 0; i < raw.size(); ++i) {
    if (raw[i] == '+') {
      decoded.push_back(' ');
    } else if (raw[i] == '%' && i + 2 < raw.size() &&
               base::IsHexDigit(raw[i + 1]) && base::IsHexDigit(raw[i + 2])) {
      decoded.push_back(static_cast<char>(base::HexDigitToInt(raw[i + 1]) * 16 +
                                          base::HexDigitToInt(raw[i + 2])));
      i += 2;
    } else {
      decoded.push_back(raw[i]);
    }
  }
  return decoded;
}

bool CarriesSession(const char* status) {
  const std::string_view outcome(status);
  return outcome == "signed_in" || outcome == "submitted";
}

}

std::set<VaultSignIn*>& Running() {
  static base::NoDestructor<std::set<VaultSignIn*>> running;
  return *running;
}

VaultSignIn::VaultSignIn(Profile* profile, VaultSignInRequest request, VaultSignInDone done)
    : profile_(profile),
      request_(std::move(request)),
      done_(std::move(done)),
      start_(base::TimeTicks::Now()) {
  Running().insert(this);
  profiles_.AddObservation(profile);
}

VaultSignIn::~VaultSignIn() {
  Running().erase(this);
  TearDown();
  transfer_op_.reset();
  DestroyVaultProfile();
}

void VaultSignIn::Start() {
  int same_profile = 0;
  const net::SchemefulSite site(request_.origin);
  for (VaultSignIn* other : Running()) {
    if (other == this || other->settled_ || other->profile_ != profile_) {
      continue;
    }
    if (++same_profile >= kMostPerProfile ||
        net::SchemefulSite(other->request_.origin) == site) {
      Abort("busy");
      return;
    }
  }
  vault_profile_ = profile_->GetOffTheRecordProfile(
      Profile::OTRProfileID::CreateUnique(kVaultProfilePrefix), true);
  profile_ms_ = base::TimeTicks::Now() - start_;
  if (!vault_profile_) {
    Abort("failed");
    return;
  }
  profiles_.AddObservation(vault_profile_);
  transfer_op_ = std::make_unique<VaultTransfer>(profile_, request_.origin);
  policy_ = std::make_unique<VaultRequestPolicy>(
      request_.origin,
      base::BindRepeating(&VaultSignIn::RequestRefused,
                          weak_factory_.GetWeakPtr()),
      base::BindRepeating(&VaultSignIn::CarriesSecret,
                          base::Unretained(this)),
      base::BindRepeating(&VaultSignIn::SecretInURL,
                          weak_factory_.GetWeakPtr()));
  content::WebContents::CreateParams params(vault_profile_);
  params.initially_hidden = true;
  contents_ = content::WebContents::Create(params);
  contents_->SetDelegate(&contents_delegate_);
  autofill::ChromeAutofillClient::CreateForWebContents(contents_.get());
  ChromePasswordManagerClient::CreateForWebContents(contents_.get());
  NSView* view = contents_->GetNativeView().GetNativeNSView();
  view.frame = NSMakeRect(0, 0, kWidth, kHeight);
  capture_ = contents_->IncrementCapturerCount(
      gfx::Size(kWidth, kHeight), false, false, false);
  Observe(contents_.get());
  ListenForCookies();
  forms_ = std::make_unique<LoginFormIndex>(contents_.get());
  forms_->SetChanged(base::BindRepeating(&VaultSignIn::FormsChanged,
                                         weak_factory_.GetWeakPtr()));
  forms_->SetLoginSucceeded(base::BindRepeating(&VaultSignIn::LoginSucceeded,
                                                weak_factory_.GetWeakPtr()));
  auto* client = ChromePasswordManagerClient::FromWebContents(contents_.get());
  if (!client) {
    Abort("failed");
    return;
  }
  const GURL realm_url = request_.origin.GetURL();
  fetcher_ = std::make_unique<password_manager::FormFetcherImpl>(
      password_manager::PasswordFormDigest(
          password_manager::PasswordForm::Scheme::kHtml,
          password_manager_util::GetSignonRealm(realm_url), realm_url),
      client, false);
  fetcher_->AddConsumer(this);
  fetcher_->Fetch();
  deadline_.Start(FROM_HERE, kDeadline,
                  base::BindOnce(&VaultSignIn::DeadlinePassed,
                                 base::Unretained(this)));
  seed_started_ = base::TimeTicks::Now();
  seed_wait_.Start(FROM_HERE, kSeedWait,
                   base::BindOnce(&VaultSignIn::Load, base::Unretained(this)));
  transfer_op_->Seed(vault_profile_, base::BindOnce(&VaultSignIn::Load,
                                                    weak_factory_.GetWeakPtr()));
}

void VaultSignIn::Load() {
  if (!contents_ || !load_started_.is_null()) {
    return;
  }
  seed_wait_.Stop();
  load_started_ = base::TimeTicks::Now();
  seed_ms_ = load_started_ - seed_started_;
  content::NavigationController::LoadURLParams load(request_.url);
  load.transition_type = ui::PAGE_TRANSITION_AUTO_TOPLEVEL;
  contents_->GetController().LoadURLWithParams(load);
}

void VaultSignIn::Cancel() { Abort("cancelled"); }

bool VaultSignIn::Shows(const content::WebContents* contents) const {
  return contents && contents_ && contents == contents_.get();
}

bool VaultSignIn::Uses(content::BrowserContext* context) const {
  return context && vault_profile_ &&
         context == static_cast<content::BrowserContext*>(vault_profile_.get());
}

const url::Origin& VaultSignIn::origin() const { return request_.origin; }

base::WeakPtr<VaultRequestPolicy> VaultSignIn::policy() const {
  return policy_ ? policy_->GetWeakPtr() : nullptr;
}

base::WeakPtr<VaultSignIn> VaultSignIn::GetWeakPtr() { return weak_factory_.GetWeakPtr(); }

void VaultSignIn::AuthChallenged(bool proxy, bool main_frame, const GURL& url) {
  if (phase_ == Phase::kDone ||
      (!main_frame && !url::Origin::Create(url).IsSameOriginWith(request_.origin))) {
    return;
  }
  reason_ = proxy ? "proxy_auth" : "basic_auth";
  Conclude("needs_human");
}

void VaultSignIn::PasskeyRequested() {
  if (phase_ == Phase::kDone) {
    return;
  }
  passkey_requested_ = true;
  MaybePasskeyOnly();
}

void VaultSignIn::TearDown() {
  password_.clear();
  sent_code_.reset();
  code_.reset();
  filler_.reset();
  probes_.clear();
  watch_.reset();
  if (fetcher_) {
    fetcher_->RemoveConsumer(this);
    fetcher_.reset();
  }
  forms_.reset();
  cookie_listener_.reset();
  Observe(nullptr);
  capture_.RunAndReset();
  if (contents_) {
    contents_->SetDelegate(nullptr);
  }
  contents_.reset();
  seed_wait_.Stop();
}

void VaultSignIn::DestroyVaultProfile() {
  Profile* vault = vault_profile_.get();
  vault_profile_ = nullptr;
  if (!vault) {
    return;
  }
  if (profiles_.IsObservingSource(vault)) {
    profiles_.RemoveObservation(vault);
  }
  if (!profile_gone_) {
    ProfileDestroyer::DestroyOTRProfileWhenAppropriate(vault);
  }
}

void VaultSignIn::StopTimers() {
  retry_.Stop();
  deadline_.Stop();
  settle_.Stop();
  no_form_.Stop();
  code_wait_.Stop();
  confirm_gone_.Stop();
}

void VaultSignIn::Conclude(const char* status) {
  if (phase_ == Phase::kDone) {
    return;
  }
  phase_ = Phase::kDone;
  decided_ = status;
  if (interrupted_ && !reason_ && std::string_view(status) != "signed_in") {
    reason_ = "interrupted";
  }
  if (submitted_) {
    decide_ = base::TimeTicks::Now() - submitted_at_;
  }
  StopTimers();
  password_.clear();
  sent_code_.reset();
  code_.reset();
  filler_.reset();
  probes_.clear();
  if (watch_.is_bound()) {
    watch_->StopWatching();
  }
  watch_.reset();
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&VaultSignIn::AfterConclusion,
                                weak_factory_.GetWeakPtr()));
}

void VaultSignIn::Abort(const char* status) {
  if (settled_) {
    return;
  }
  if (transferring_) {
    cancel_requested_ = true;
    return;
  }
  if (transfer_op_ && transfer_op_->sent()) {
    transfer_ = transfer_op_->counts();
    transfer_state_ = "sent";
  }
  phase_ = Phase::kDone;
  decided_ = status;
  StopTimers();
  TearDown();
  Settle(status);
}

void VaultSignIn::AfterConclusion() {
  if (settled_) {
    return;
  }
  TearDown();
  if (!CarriesSession(decided_) || !transfer_op_ || !vault_profile_ ||
      profile_gone_) {
    Settle(decided_);
    return;
  }
  transfer_started_ = base::TimeTicks::Now();
  const base::TimeDelta left = start_ + kDeadline - transfer_started_;
  if (left <= base::TimeDelta()) {
    TransferTimedOut();
    return;
  }
  transfer_wait_.Start(FROM_HERE, left,
                       base::BindOnce(&VaultSignIn::TransferTimedOut,
                                      base::Unretained(this)));
  transferring_ = true;
  transfer_op_->Run(
      vault_profile_, evidence_ && std::string_view(evidence_) == "none",
      base::BindOnce(&VaultSignIn::Transferred, weak_factory_.GetWeakPtr()));
}

void VaultSignIn::Transferred(VaultTransferCounts counts) {
  transfer_ = counts;
  transfer_state_ = counts.failed ? "partial" : "complete";
  if (evidence_ && std::string_view(evidence_) == "none") {
    if (counts.changed_since_fill) {
      evidence_ = "weak";
    } else {
      transfer_state_ = "none";
    }
  }
  transfer_done_ = base::TimeTicks::Now();
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce(
          [](base::WeakPtr<VaultSignIn> sign_in) {
            if (sign_in) {
              sign_in->Settle(sign_in->decided_);
            }
          },
          weak_factory_.GetWeakPtr()));
}

void VaultSignIn::TransferTimedOut() {
  if (transfer_op_) {
    transfer_ = transfer_op_->counts();
  }
  transfer_state_ = transfer_op_ && transfer_op_->sent() ? "sent" : "timed_out";
  transfer_done_ = base::TimeTicks::Now();
  Settle(decided_);
}

void VaultSignIn::Settle(const char* status) {
  if (settled_) {
    return;
  }
  settled_ = true;
  transfer_wait_.Stop();
  TearDown();
  transfer_op_.reset();
  DestroyVaultProfile();
  const base::TimeTicks now = base::TimeTicks::Now();
  NSDictionary* result = @{
    @"status" : @(status),
    @"readyMs" : ready_.is_null() ? @(-1) : Milliseconds(ready_ - start_),
    @"fillMs" : submitted_ ? Milliseconds(fill_) : @(-1),
    @"totalMs" : Milliseconds(now - start_),
    @"decideMs" : submitted_ ? Milliseconds(decide_) : @(-1),
    @"reason" : reason_ ? @(reason_) : @"",
    @"evidence" : evidence_ ? @(evidence_) : @"",
    @"cancelRequested" : @(cancel_requested_),
    @"signals" : @{
      @"navigated" : @(navigated_since_submit_),
      @"httpOnlyCookie" : @(server_cookie_changed_),
      @"formGone" : @(form_gone_),
      @"pathChanged" : @(nav_away_),
    },
    @"refills" : @(refills_),
    @"profileMs" : Milliseconds(profile_ms_),
    @"seedMs" : Milliseconds(seed_ms_),
    @"loadMs" : load_ms_.is_zero() ? @(-1) : Milliseconds(load_ms_),
    @"scanMs" : Milliseconds(scan_),
    @"transferMs" : transfer_started_.is_null()
        ? @(-1)
        : Milliseconds((transfer_done_.is_null() ? now : transfer_done_) -
                       transfer_started_),
    @"transfer" : @(transfer_state_),
    @"cookies" : @(transfer_.cookies),
    @"conflicts" : @(transfer_.conflicts),
    @"localStorage" : @(transfer_.local_storage),
    @"transferFailed" : @(transfer_.failed),
    @"blockedRequests" : @(policy_ ? policy_->blocked() : 0),
  };
  auto runner = base::SingleThreadTaskRunner::GetCurrentDefault();
  runner->PostTask(FROM_HERE, base::BindOnce(std::move(done_), result));
  runner->DeleteSoon(FROM_HERE, this);
}

void VaultSignIn::Mark(content::RenderFrameHost* frame) {
  if (!frame || !frame->IsRenderFrameLive()) {
    return;
  }
  mojo::AssociatedRemote<mojom::ACVaultFiller> filler;
  frame->GetRemoteAssociatedInterfaces()->GetInterface(&filler);
  filler->MarkVaultFrame();
}

void VaultSignIn::RenderFrameCreated(content::RenderFrameHost* frame) {
  Mark(frame);
}

void VaultSignIn::ReadyToCommitNavigation(content::NavigationHandle* navigation) {
  Mark(navigation->GetRenderFrameHost());
}

void VaultSignIn::RequestRefused() { Conclude("cross_origin"); }

bool VaultSignIn::CarriesSecret(const GURL& url) const {
  if ((password_.empty() && !sent_code_) || !url.has_query()) {
    return false;
  }
  std::vector<std::string> secrets;
  std::vector<std::string> names;
  auto add_forms = [](std::vector<std::string>& into, const std::u16string& text) {
    if (text.empty()) {
      return;
    }
    into.push_back(base::UTF16ToUTF8(text));
    std::string latin1;
    for (char16_t c : text) {
      if (c > 0xFF) {
        return;
      }
      latin1.push_back(static_cast<char>(c));
    }
    into.push_back(std::move(latin1));
  };
  add_forms(secrets, password_.value());
  if (sent_code_) {
    add_forms(secrets, *sent_code_);
  }
  for (const std::u16string& name : secret_names_) {
    add_forms(names, name);
  }
  for (std::string_view pair : base::SplitStringPiece(
           url.query(), "&", base::KEEP_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    const size_t equals = pair.find('=');
    const std::string key = FormDecoded(pair.substr(0, equals));
    const std::string value = equals == std::string_view::npos
                                  ? std::string()
                                  : FormDecoded(pair.substr(equals + 1));
    if (!value.empty() && std::ranges::find(names, key) != names.end() &&
        std::ranges::find(secrets, value) != secrets.end()) {
      return true;
    }
  }
  return false;
}

void VaultSignIn::SecretInURL() {
  reason_ = "get_form";
  Conclude("failed");
}

void VaultSignIn::OnProfileWillBeDestroyed(Profile* profile) {
  if (profile == vault_profile_.get()) {
    profiles_.RemoveObservation(profile);
    vault_profile_ = nullptr;
  } else {
    profiles_.RemoveAllObservations();
    profile_gone_ = true;
    vault_profile_ = nullptr;
    profile_ = nullptr;
  }
  const char* status = phase_ == Phase::kDone ? decided_ : "failed";
  phase_ = Phase::kDone;
  StopTimers();
  transfer_wait_.Stop();
  TearDown();
  Settle(status);
}

VaultSignIn* RunningFor(const content::WebContents* contents) {
  for (VaultSignIn* sign_in : Running()) {
    if (sign_in->Shows(contents)) {
      return sign_in;
    }
  }
  return nullptr;
}

}

using vault_internal::Running;
using vault_internal::RunningFor;
using vault_internal::VaultSignIn;

VaultSignInRequest::VaultSignInRequest() = default;
VaultSignInRequest::VaultSignInRequest(VaultSignInRequest&&) = default;
VaultSignInRequest& VaultSignInRequest::operator=(VaultSignInRequest&&) =
    default;
VaultSignInRequest::~VaultSignInRequest() = default;

base::OnceClosure StartVaultSignIn(Profile* profile,
                                   VaultSignInRequest request,
                                   VaultSignInDone done) {
  auto* sign_in = new VaultSignIn(profile, std::move(request), std::move(done));
  base::OnceClosure cancel =
      base::BindOnce(&VaultSignIn::Cancel, sign_in->GetWeakPtr());
  sign_in->Start();
  return cancel;
}

bool IsVaultBrowserContext(content::BrowserContext* context) {
  Profile* profile = context ? Profile::FromBrowserContext(context) : nullptr;
  if (!profile || !profile->IsOffTheRecord() || profile->IsPrimaryOTRProfile()) {
    return false;
  }
  std::ostringstream id;
  id << profile->GetOTRProfileID();
  return base::StartsWith(id.str(), vault_internal::kVaultProfilePrefix);
}

bool IsVaultSignInFrame(content::RenderFrameHost* frame) {
  return frame && IsVaultBrowserContext(frame->GetBrowserContext());
}

base::WeakPtr<VaultRequestPolicy> VaultRequestPolicyFor(
    content::BrowserContext* context) {
  for (VaultSignIn* sign_in : Running()) {
    if (sign_in->Uses(context)) {
      return sign_in->policy();
    }
  }
  return nullptr;
}

void ClearFilledPasswords(content::WebContents* contents) {
  if (!contents) {
    return;
  }
  contents->ForEachRenderFrameHost([](content::RenderFrameHost* frame) {
    if (!frame->IsRenderFrameLive()) {
      return;
    }
    mojo::AssociatedRemote<mojom::ACVaultFiller> filler;
    frame->GetRemoteAssociatedInterfaces()->GetInterface(&filler);
    filler->ClearFilledPasswords();
  });
}

void NoteVaultAuthChallenge(content::WebContents* contents,
                            bool proxy,
                            bool main_frame,
                            const GURL& url) {
  if (VaultSignIn* sign_in = contents ? RunningFor(contents) : nullptr) {
    sign_in->AuthChallenged(proxy, main_frame, url);
  }
}

void NoteVaultPasskeyRequest(content::RenderFrameHost* frame) {
  content::WebContents* contents =
      frame ? content::WebContents::FromRenderFrameHost(frame) : nullptr;
  if (VaultSignIn* sign_in = contents ? RunningFor(contents) : nullptr) {
    sign_in->PasskeyRequested();
  }
}

}
