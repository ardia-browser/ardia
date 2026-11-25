// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <cstdint>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/strcat.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "chrome/browser/ardia/ac_cli_cdp.h"
#include "chrome/browser/ardia/ac_cli_ops.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/gfx/geometry/size.h"

namespace ardia {
namespace {

constexpr base::TimeDelta kTick = base::Milliseconds(50);
constexpr base::TimeDelta kIdleCap = base::Milliseconds(2000);
constexpr base::TimeDelta kFrameCap = base::Milliseconds(1000);
constexpr char kIdleScript[] =
    "new Promise(r=>requestIdleCallback(d=>r(d.didTimeout),{timeout:1000}))";

struct SettleArgs {
  std::string owner;
  base::TimeDelta timeout = base::Seconds(10);
  base::TimeDelta quiet = base::Milliseconds(500);
  base::TimeDelta long_request = base::Seconds(10);
  int max_inflight = 0;
  bool idle = true;
  bool frame = true;
};

class SettleOp : public content::WebContentsObserver {
 public:
  static void Start(content::WebContents* contents,
                    SettleArgs args,
                    Reply out) {
    (new SettleOp(contents, std::move(args), std::move(out)))->Begin();
  }

  void DidStartNavigation(content::NavigationHandle* navigation) override {
    if (navigation->IsSameDocument()) {
      return;
    }
    navigations_.insert(navigation->GetNavigationId());
    ++navigations_seen_;
    Restart();
  }

  void DidFinishNavigation(content::NavigationHandle* navigation) override {
    navigations_.erase(navigation->GetNavigationId());
    if (navigation->HasCommitted()) {
      PolicyChanged();
    }
  }

  void WebContentsDestroyed() override { Fail("the tab closed"); }

  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override {
    Fail("the page's process went away");
  }

  ~SettleOp() override {
    if (op_id_) {
      FinishCliOp(op_id_);
    }
  }

 private:
  enum class Phase { kQuiet, kIdle, kFrame };

  SettleOp(content::WebContents* contents, SettleArgs args, Reply out)
      : content::WebContentsObserver(contents),
        args_(std::move(args)),
        out_(std::move(out)) {}

  void Begin() {
    ++CliCounts().settles;
    started_ = base::TimeTicks::Now();
    content::WebContents* contents = web_contents();
    if (std::optional<std::string> refused = CliTabRefusal(contents)) {
      return Fail(*refused);
    }
    if (!args_.owner.empty()) {
      op_id_ = RegisterCliOp(
          args_.owner, base::BindOnce(&SettleOp::Fail,
                                      weak_factory_.GetWeakPtr(),
                                      std::string("cancelled")));
    }
    drawing_ = contents->IncrementCapturerCount(gfx::Size(), true, false,
                                                false);
    policy_ = std::make_unique<CliPolicyWatch>(
        contents, base::BindRepeating(&SettleOp::PolicyChanged,
                                      weak_factory_.GetWeakPtr()));
    deadline_.Start(FROM_HERE, args_.timeout,
                    base::BindOnce(&SettleOp::TimedOut,
                                   base::Unretained(this)));
    std::string error;
    cdp_ = CdpSession::Attach(contents, CdpAccess{}, &error);
    if (!cdp_) {
      return Fail(error);
    }
    cdp_->SetEventSink(
        base::BindRepeating(&SettleOp::Event, weak_factory_.GetWeakPtr()));
    cdp_->Send("Target.setAutoAttach",
               base::DictValue()
                   .Set("autoAttach", true)
                   .Set("waitForDebuggerOnStart", false)
                   .Set("flatten", true),
               base::DoNothingAs<void(CdpResult)>());
    cdp_->Send("Network.enable", base::DictValue(),
               base::BindOnce(&SettleOp::NetworkOn,
                              weak_factory_.GetWeakPtr()));
  }

  void PolicyChanged() {
    if (std::optional<std::string> refused = CliTabRefusal(web_contents())) {
      Fail(*refused);
    }
  }

  void NetworkOn(CdpResult result) {
    if (!result.has_value()) {
      network_unavailable_ = true;
    }
    ticker_.Start(FROM_HERE, kTick,
                  base::BindRepeating(&SettleOp::Tick,
                                      weak_factory_.GetWeakPtr()));
    Tick();
  }

  void Event(const std::string& method,
             base::DictValue params,
             const std::string& session,
             size_t bytes) {
    if (method == "Target.attachedToTarget") {
      const std::string* child = params.FindString("sessionId");
      const base::DictValue* info = params.FindDict("targetInfo");
      const std::string* type = info ? info->FindString("type") : nullptr;
      if (child && type && *type == "iframe") {
        cdp_->Send("Target.setAutoAttach",
                   base::DictValue()
                       .Set("autoAttach", true)
                       .Set("waitForDebuggerOnStart", false)
                       .Set("flatten", true),
                   base::DoNothingAs<void(CdpResult)>(), *child);
        cdp_->Send("Network.enable", base::DictValue(),
                   base::DoNothingAs<void(CdpResult)>(), *child);
      }
      return;
    }
    const std::string* request = params.FindString("requestId");
    if (!request) {
      return;
    }
    const std::string key = base::StrCat({session, ":", *request});
    if (method == "Network.requestWillBeSent") {
      const std::string* type = params.FindString("type");
      if (type && (*type == "EventSource" || *type == "WebSocket")) {
        return;
      }
      if (!inflight_.contains(key)) {
        ++requests_seen_;
        inflight_[key] = base::TimeTicks::Now();
        Restart();
      }
    } else if (method == "Network.loadingFinished" ||
               method == "Network.loadingFailed") {
      if (!inflight_.erase(key)) {
        Restart();
      }
    }
  }

  int CountedInflight(int* long_lived) {
    const base::TimeTicks now = base::TimeTicks::Now();
    int counted = 0;
    *long_lived = 0;
    for (const auto& [key, since] : inflight_) {
      if (now - since >= args_.long_request) {
        ++*long_lived;
      } else {
        ++counted;
      }
    }
    return counted;
  }

  bool Quiet() {
    int long_lived = 0;
    return navigations_.empty() && !web_contents()->IsLoading() &&
           CountedInflight(&long_lived) <= args_.max_inflight;
  }

  void Tick() {
    if (finished_) {
      return;
    }
    if (std::optional<std::string> refused = CliTabRefusal(web_contents())) {
      return Fail(*refused);
    }
    if (DrainDropped()) {
      Restart();
    }
    if (phase_ != Phase::kQuiet) {
      return;
    }
    const base::TimeTicks now = base::TimeTicks::Now();
    if (!Quiet()) {
      quiet_since_.reset();
      return;
    }
    if (!quiet_since_) {
      quiet_since_ = now;
    }
    if (now - *quiet_since_ < args_.quiet) {
      return;
    }
    quiet_at_ = now - started_;
    StartIdle();
  }

  void Restart() {
    quiet_since_.reset();
    if (phase_ == Phase::kQuiet) {
      return;
    }
    ++attempt_;
    ++loops_;
    phase_ = Phase::kQuiet;
    frame_timer_.Stop();
  }

  void StartIdle() {
    if (!args_.idle) {
      idle_ = "skipped";
      return StartFrame();
    }
    phase_ = Phase::kIdle;
    const base::TimeTicks began = base::TimeTicks::Now();
    cdp_->Send(
        "Page.createIsolatedWorld",
        base::DictValue()
            .Set("frameId", web_contents()
                                ->GetPrimaryMainFrame()
                                ->GetDevToolsFrameToken()
                                .ToString())
            .Set("worldName", "ardia-settle")
            .Set("grantUniveralAccess", false),
        base::BindOnce(&SettleOp::GotWorld, weak_factory_.GetWeakPtr(),
                       attempt_, began),
        {}, kIdleCap);
  }

  void GotWorld(int attempt, base::TimeTicks began, CdpResult result) {
    if (attempt != attempt_ || phase_ != Phase::kIdle) {
      return;
    }
    std::optional<int> context =
        result.has_value() ? result->FindInt("executionContextId")
                           : std::nullopt;
    if (!context) {
      idle_ = "unavailable";
      return Restart();
    }
    cdp_->Send("Runtime.evaluate",
               base::DictValue()
                   .Set("expression", kIdleScript)
                   .Set("contextId", *context)
                   .Set("awaitPromise", true)
                   .Set("returnByValue", true)
                   .Set("silent", true),
               base::BindOnce(&SettleOp::Idled, weak_factory_.GetWeakPtr(),
                              attempt, began),
               {}, kIdleCap);
  }

  void Idled(int attempt, base::TimeTicks began, CdpResult result) {
    if (attempt != attempt_ || phase_ != Phase::kIdle) {
      return;
    }
    idle_ms_ += (base::TimeTicks::Now() - began).InMilliseconds();
    const base::DictValue* value =
        result.has_value() ? result->FindDict("result") : nullptr;
    const std::optional<bool> timed_out =
        value ? value->FindBool("value") : std::nullopt;
    if (!timed_out.has_value() || *timed_out) {
      idle_ = "timeout";
      return Restart();
    }
    idle_ = "idle";
    StartFrame();
  }

  void StartFrame() {
    if (!args_.frame) {
      frame_ = "skipped";
      return Recheck();
    }
    phase_ = Phase::kFrame;
    frame_began_ = base::TimeTicks::Now();
    frame_timer_.Start(FROM_HERE, kFrameCap,
                       base::BindOnce(&SettleOp::Framed,
                                      weak_factory_.GetWeakPtr(), attempt_,
                                      false));
    web_contents()->GetPrimaryMainFrame()->InsertVisualStateCallback(
        base::BindOnce(&SettleOp::Framed, weak_factory_.GetWeakPtr(),
                       attempt_));
  }

  void Framed(int attempt, bool committed) {
    if (attempt != attempt_ || phase_ != Phase::kFrame) {
      return;
    }
    frame_timer_.Stop();
    frame_ms_ += (base::TimeTicks::Now() - frame_began_).InMilliseconds();
    if (!committed) {
      frame_ = "timeout";
      return Restart();
    }
    frame_ = "committed";
    Recheck();
  }

  bool DrainDropped() {
    const uint64_t dropped = cdp_->TakeDroppedEvents();
    events_dropped_ += dropped;
    return dropped > 0;
  }

  void Recheck() {
    if (DrainDropped() || !Quiet()) {
      return Restart();
    }
    Done(true);
  }

  void TimedOut() {
    ++CliCounts().settles_timed_out;
    Done(false);
  }

  void Done(bool settled) {
    if (finished_) {
      return;
    }
    DrainDropped();
    int long_lived = 0;
    const int inflight = CountedInflight(&long_lived);
    const int64_t waited = (base::TimeTicks::Now() - started_).InMilliseconds();
    CliCounts().settle_ms += static_cast<uint64_t>(std::max<int64_t>(waited, 0));
    base::DictValue out;
    out.Set("settled", settled);
    out.Set("waitedMs", static_cast<double>(waited));
    if (!settled) {
      out.Set("timedOut", true);
      const char* reason = !navigations_.empty() || web_contents()->IsLoading()
                               ? "navigation"
                           : inflight > args_.max_inflight ? "network"
                           : phase_ == Phase::kIdle       ? "idle"
                           : phase_ == Phase::kFrame      ? "frame"
                                                          : "quiet";
      out.Set("waitingOn", reason);
    }
    out.Set("navigations", base::DictValue()
                               .Set("pending",
                                    static_cast<int>(navigations_.size()))
                               .Set("seen", navigations_seen_));
    out.Set("network",
            base::DictValue()
                .Set("inflight", inflight)
                .Set("longLived", long_lived)
                .Set("seen", requests_seen_)
                .Set("tracked", !network_unavailable_)
                .Set("eventsDropped", static_cast<double>(events_dropped_)));
    out.Set("idle", idle_);
    out.Set("frame", frame_);
    out.Set("loops", loops_);
    if (quiet_at_) {
      out.Set("quietAtMs", static_cast<double>(quiet_at_->InMilliseconds()));
    }
    out.Set("idleMs", static_cast<double>(idle_ms_));
    out.Set("frameMs", static_cast<double>(frame_ms_));
    Finish(std::move(out));
  }

  void Fail(const std::string& why) { Finish(base::unexpected(why)); }

  void Finish(base::expected<base::DictValue, std::string> outcome) {
    if (finished_) {
      return;
    }
    finished_ = true;
    deadline_.Stop();
    ticker_.Stop();
    frame_timer_.Stop();
    drawing_.RunAndReset();
    Observe(nullptr);
    if (outcome.has_value()) {
      out_.Send(std::move(outcome.value()));
    } else {
      out_.Error(outcome.error());
    }
    weak_factory_.InvalidateWeakPtrs();
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE,
                                                               this);
  }

  SettleArgs args_;
  Reply out_;
  int op_id_ = 0;
  bool finished_ = false;
  Phase phase_ = Phase::kQuiet;
  base::TimeTicks started_;
  base::TimeTicks frame_began_;
  std::optional<base::TimeTicks> quiet_since_;
  std::optional<base::TimeDelta> quiet_at_;
  std::set<int64_t> navigations_;
  int navigations_seen_ = 0;
  int attempt_ = 0;
  uint64_t events_dropped_ = 0;
  base::ScopedClosureRunner drawing_;
  std::unique_ptr<CliPolicyWatch> policy_;
  int loops_ = 0;
  std::map<std::string, base::TimeTicks> inflight_;
  int requests_seen_ = 0;
  bool network_unavailable_ = false;
  std::string idle_ = "pending";
  std::string frame_ = "pending";
  int64_t idle_ms_ = 0;
  int64_t frame_ms_ = 0;
  std::unique_ptr<CdpSession> cdp_;
  base::OneShotTimer deadline_;
  base::OneShotTimer frame_timer_;
  base::RepeatingTimer ticker_;
  base::WeakPtrFactory<SettleOp> weak_factory_{this};
};

}
}

AC_ARGS_CALL(ac_cli_wait_settled) {
  ardia::Reply out = call.TakeReply();
  std::optional<int> tab = call.args().FindInt("tab");
  content::WebContents* contents = tab ? ardia::TabWithId(*tab) : nullptr;
  if (!contents || contents->IsBeingDestroyed()) {
    return out.Error("no such tab");
  }
  ardia::SettleArgs args;
  args.owner = call.String("owner");
  if (!args.owner.empty() && !ardia::ValidCliOwner(args.owner)) {
    return out.Error("bad owner");
  }
  const auto read_ms = [&](const char* key, int low, int high,
                           base::TimeDelta* into) {
    std::optional<int> ms = call.args().FindInt(key);
    if (!ms) {
      return true;
    }
    if (*ms < low || *ms > high) {
      return false;
    }
    *into = base::Milliseconds(*ms);
    return true;
  };
  if (!read_ms("timeoutMs", 100, 60000, &args.timeout) ||
      !read_ms("quietMs", 0, 5000, &args.quiet) ||
      !read_ms("longRequestMs", 500, 60000, &args.long_request)) {
    return out.Error(
        "timeoutMs must be 100 to 60000, quietMs 0 to 5000 and longRequestMs "
        "500 to 60000");
  }
  if (std::optional<int> inflight = call.args().FindInt("maxInflight")) {
    if (*inflight < 0 || *inflight > 16) {
      return out.Error("maxInflight must be 0 to 16");
    }
    args.max_inflight = *inflight;
  }
  args.idle = call.Bool("idle", true);
  args.frame = call.Bool("frame", true);
  ardia::SettleOp::Start(contents, std::move(args), std::move(out));
}
