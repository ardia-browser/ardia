// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback_helpers.h"
#include "base/location.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/strcat.h"
#include "base/strings/stringprintf.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "chrome/browser/ardia/ac_cli_cdp.h"
#include "chrome/browser/ardia/ac_cli_hit_tester.h"
#include "chrome/browser/ardia/ac_cli_ops.h"
#include "chrome/browser/ardia/ac_cli_page_model.h"
#include "chrome/browser/ardia/ac_cli_page_reader.h"
#include "chrome/browser/ardia/ac_cli_tab_ops.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "content/public/browser/host_zoom_map.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host_view.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "third_party/blink/public/common/page/page_zoom.h"
#include "ui/gfx/geometry/size.h"

namespace ardia {
namespace {

using Kind = TabOpKind;
using OpArgs = TabOpArgs;

constexpr base::TimeDelta kOpDeadline = base::Seconds(15);
constexpr size_t kMaxOcclusionChecks = 40;
constexpr int kMaxScrollTries = 4;
constexpr int kMaxEmptyTrees = 5;
constexpr base::TimeDelta kFrameWait = base::Milliseconds(1000);

using Outcome = base::expected<base::DictValue, std::string>;


class TabOp : public content::WebContentsObserver {
 public:
  static void Start(content::WebContents* contents, OpArgs args, Reply out) {
    (new TabOp(contents, std::move(args), std::move(out)))->Begin();
  }

  void WebContentsDestroyed() override { Fail("the tab closed"); }

  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override {
    Fail("the page's process went away");
  }

  void DidFinishNavigation(content::NavigationHandle* navigation) override {
    if (!pressing_ && navigation->HasCommitted() &&
        !navigation->IsSameDocument() && navigation->IsInPrimaryMainFrame()) {
      Fail("the page navigated before Ardia finished reading it");
    }
  }

  ~TabOp() override {
    if (op_id_) {
      FinishCliOp(op_id_);
    }
  }

 private:
  TabOp(content::WebContents* contents, OpArgs args, Reply out)
      : content::WebContentsObserver(contents),
        args_(std::move(args)),
        out_(std::move(out)) {}

  void Begin() {
    content::WebContents* contents = web_contents();
    if (std::optional<std::string> refused = CliTabRefusal(contents)) {
      return Fail(*refused);
    }
    switch (args_.kind) {
      case Kind::kSnapshot:
        ++CliCounts().snapshots;
        break;
      case Kind::kHitTest:
        ++CliCounts().hit_tests;
        break;
      case Kind::kClick:
        ++CliCounts().clicks;
        break;
    }
    if (!args_.owner.empty()) {
      op_id_ = RegisterCliOp(
          args_.owner,
          base::BindOnce(&TabOp::Fail, weak_factory_.GetWeakPtr(),
                         std::string("cancelled")));
    }
    policy_ = std::make_unique<CliPolicyWatch>(
        contents, base::BindRepeating(&TabOp::PolicyChanged,
                                      weak_factory_.GetWeakPtr()));
    if (args_.kind == Kind::kClick) {
      drawing_ = contents->IncrementCapturerCount(gfx::Size(), true, false,
                                                  false);
    }
    deadline_.Start(FROM_HERE, kOpDeadline,
                    base::BindOnce(&TabOp::Fail, base::Unretained(this),
                                   std::string("the page didn't answer in "
                                               "time")));
    TakeTree();
  }

  void TakeTree() {
    content::WebContents* contents = web_contents();
    if (!contents || contents->IsBeingDestroyed()) {
      return Fail("the tab closed");
    }
    if (std::optional<std::string> refused = CliTabRefusal(contents)) {
      return Fail(*refused);
    }
    content::RenderWidgetHostView* view = contents->GetRenderWidgetHostView();
    const double dsf = view ? view->GetDeviceScaleFactor() : 1.0;
    const double zoom = blink::ZoomLevelToZoomFactor(
        content::HostZoomMap::GetZoomLevel(contents));
    scale_ = dsf * zoom;
    if (!probe_) {
      return AttachProbe();
    }
    reader_ = std::make_unique<PageReader>(contents, probe_.get(), &children_,
                                           scale_);
    reader_->Read(
        base::BindOnce(&TabOp::GotModel, weak_factory_.GetWeakPtr()));
  }

  void GotModel(base::expected<PageModel, std::string> model) {
    if (!model.has_value()) {
      if (empty_trees_ < kMaxEmptyTrees) {
        ++empty_trees_;
        return Retake();
      }
      return Fail(model.error());
    }
    if (std::optional<std::string> refused = CliTabRefusal(web_contents())) {
      return Fail(*refused);
    }
    model_ = std::move(model.value());
    hits_.ForgetScroll();
    if (rechecking_) {
      return Recheck();
    }
    Proceed();
  }

  void AttachProbe() {
    std::string error;
    probe_ = CdpSession::Attach(web_contents(), CdpAccess{}, &error);
    if (!probe_) {
      return Fail(error);
    }
    probe_->SetEventSink(
        base::BindRepeating(&TabOp::ProbeEvent, weak_factory_.GetWeakPtr()));
    probe_->Send("Target.setAutoAttach", AutoAttachParams(),
                 base::BindOnce(&TabOp::AutoAttached,
                                weak_factory_.GetWeakPtr()));
  }

  static base::DictValue AutoAttachParams() {
    return base::DictValue()
        .Set("autoAttach", true)
        .Set("waitForDebuggerOnStart", false)
        .Set("flatten", true);
  }

  void ProbeEvent(const std::string& method,
                  base::DictValue params,
                  const std::string& session_id,
                  size_t bytes) {
    if (method == "Target.attachedToTarget") {
      const std::string* child = params.FindString("sessionId");
      const base::DictValue* info = params.FindDict("targetInfo");
      const std::string* target = info ? info->FindString("targetId") : nullptr;
      const std::string* type = info ? info->FindString("type") : nullptr;
      if (child && target && type && *type == "iframe") {
        children_[*target] = *child;
        probe_->Send("Target.setAutoAttach", AutoAttachParams(),
                     base::DoNothingAs<void(CdpResult)>(), *child);
      }
    } else if (method == "Target.detachedFromTarget") {
      const std::string* child = params.FindString("sessionId");
      for (auto it = children_.begin(); child && it != children_.end();) {
        it = it->second == *child ? children_.erase(it) : std::next(it);
      }
    }
  }

  void PolicyChanged() {
    if (std::optional<std::string> refused = CliTabRefusal(web_contents())) {
      return Fail(*refused);
    }
    if (ModelFrameRefused()) {
      Fail("a frame in this tab can't be used");
    }
  }

  void AutoAttached(CdpResult result) {
    TakeTree();
  }

  void Proceed() {
    switch (args_.kind) {
      case Kind::kSnapshot:
        return StartOcclusion();
      case Kind::kHitTest:
      case Kind::kClick:
        return LocateTarget();
    }
  }

  int ScopeRoot() const {
    return model_->modal >= 0 && !args_.whole_page ? model_->modal : 0;
  }

  void StartOcclusion() {
    if (!args_.occlusion || !probe_) {
      return FinishSnapshot();
    }
    checks_ = OcclusionCandidates(*model_, ScopeRoot(), kMaxOcclusionChecks);
    check_cursor_ = 0;
    NextOcclusion();
  }

  void NextOcclusion() {
    if (check_cursor_ >= checks_.size()) {
      return FinishSnapshot();
    }
    const int item = checks_[check_cursor_];
    HitAt(model_->ClickPoint(item),
          base::BindOnce(&TabOp::OcclusionHit, weak_factory_.GetWeakPtr(),
                         item));
  }

  void OcclusionHit(int item, int hit) {
    const int blocker = BlockerOf(*model_, hit, item);
    if (blocker >= 0) {
      occluded_by_[item] = blocker;
      ++CliCounts().occluded_refs;
    }
    ++check_cursor_;
    NextOcclusion();
  }

  using HitDone = base::OnceCallback<void(int)>;

  void HitAt(gfx::PointF point, HitDone done) {
    hits_.Use(probe_.get(), &*model_);
    hits_.HitAt(point, std::move(done));
  }

  void LocateTarget() {
    if (!args_.ref.empty()) {
      RefStore::CreateForWebContents(web_contents());
      RefStore::Resolved resolved =
          RefStore::FromWebContents(web_contents())->Resolve(args_.ref,
                                                             *model_);
      if (resolved.item < 0) {
        ++CliCounts().refs_stale;
        return Fail(resolved.error);
      }
      if (resolved.rebound) {
        ++CliCounts().refs_rebound;
        rebound_ = true;
      }
      target_ = resolved.item;
      const AxItem& item = model_->items[target_];
      if (!model_->InViewport(target_) && scroll_tries_ < kMaxScrollTries &&
          item.dom > 0 && model_->frames[item.frame].reachable) {
        ++scroll_tries_;
        scrolled_ = true;
        return probe_->Send(
            "DOM.scrollIntoViewIfNeeded",
            base::DictValue().Set("backendNodeId", item.dom),
            base::BindOnce(&TabOp::Scrolled, weak_factory_.GetWeakPtr()),
            model_->frames[item.frame].session);
      }
      if (scrolled_ && last_box_ && (item.box.origin() - last_box_->origin())
                                            .Length() > 1.0f &&
          scroll_tries_ < kMaxScrollTries) {
        ++scroll_tries_;
        last_box_ = item.box;
        return Retake();
      }
      if (!model_->InViewport(target_)) {
        return Fail("the element isn't in view and couldn't be scrolled to");
      }
      point_ = model_->ClickPoint(target_);
    } else if (args_.point) {
      point_ = *args_.point;
    } else {
      return Fail("give a ref or a point");
    }
    HitAt(point_, base::BindOnce(&TabOp::TargetHit,
                                 weak_factory_.GetWeakPtr()));
  }

  void Scrolled(CdpResult result) {
    last_box_ = model_->items[target_].box;
    Retake();
  }

  void Retake() {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&TabOp::TakeTree, weak_factory_.GetWeakPtr()),
        base::Milliseconds(120));
  }

  void TargetHit(int hit) {
    RefStore::CreateForWebContents(web_contents());
    RefStore* refs = RefStore::FromWebContents(web_contents());
    base::DictValue out;
    out.Set("point", base::ListValue()
                         .Append(std::round(point_.x() * 10) / 10)
                         .Append(std::round(point_.y() * 10) / 10));
    out.Set("verified", hit >= 0);
    if (hit >= 0) {
      out.Set("hit", DescribeItem(*model_, refs, hit));
    }
    if (target_ >= 0) {
      out.Set("target", DescribeItem(*model_, refs, target_));
      if (rebound_) {
        out.Set("rebound", true);
      }
    }
    const int blocker = ReportBlocker(*model_, refs, hit, target_, &out);
    if (args_.kind == Kind::kHitTest) {
      return Finish(std::move(out));
    }
    if (blocker >= 0 && !args_.force) {
      ++CliCounts().clicks_blocked;
      out.Set("clicked", false);
      return Finish(std::move(out));
    }
    if (hit < 0 && !args_.force) {
      ++CliCounts().clicks_unverified;
      out.Set("clicked", false);
      out.Set("reason", "unverified");
      return Finish(std::move(out));
    }
    if (HitFrameRefused(web_contents(), *model_, hit)) {
      out.Set("clicked", false);
      out.Set("reason", "refused");
      return Finish(std::move(out));
    }
    if (target_ >= 0) {
      recheck_frame_ = model_->frames[model_->items[target_].frame].token;
      recheck_dom_ = model_->items[target_].dom;
    }
    if (hit >= 0) {
      first_hit_frame_ = model_->frames[model_->items[hit].frame].token;
      first_hit_dom_ = model_->items[hit].dom;
    }
    result_ = std::move(out);
    WaitForFrame();
  }
  void WaitForFrame() {
    waiting_frame_ = true;
    frame_timer_.Start(FROM_HERE, kFrameWait,
                       base::BindOnce(&TabOp::FrameReady,
                                      weak_factory_.GetWeakPtr(), false));
    web_contents()->GetPrimaryMainFrame()->InsertVisualStateCallback(
        base::BindOnce(&TabOp::FrameReady, weak_factory_.GetWeakPtr()));
  }

  void FrameReady(bool committed) {
    if (!waiting_frame_) {
      return;
    }
    waiting_frame_ = false;
    frame_timer_.Stop();
    Press("mouseMoved");
  }

  void Recheck() {
    rechecking_ = false;
    target_ = -1;
    if (!recheck_frame_.empty()) {
      const int frame = model_->FrameWithToken(recheck_frame_);
      target_ = frame >= 0 ? model_->Find(frame, recheck_dom_) : -1;
      if (target_ < 0) {
        return Rechecked(-1);
      }
    }
    HitAt(point_, base::BindOnce(&TabOp::Rechecked, weak_factory_.GetWeakPtr()));
  }

  void Rechecked(int hit) {
    const bool same_hit =
        hit >= 0 && model_->frames[model_->items[hit].frame].token ==
                        first_hit_frame_ &&
                    model_->items[hit].dom == first_hit_dom_;
    const bool modal_blocks = hit >= 0 && model_->modal >= 0 &&
                              !model_->IsAncestor(model_->modal, hit);
    const bool moved =
        hit < 0 || (target_ >= 0 ? BlockerOf(*model_, hit, target_) >= 0
                                 : !same_hit || modal_blocks);
    if (!moved && !HitFrameRefused(web_contents(), *model_, hit)) {
      return Press("mousePressed");
    }
    ++CliCounts().clicks_blocked;
    RefStore::CreateForWebContents(web_contents());
    base::DictValue out =
        DescribeClick(*model_, RefStore::FromWebContents(web_contents()),
                      point_, hit, target_);
    out.Set("clicked", false);
    out.Set("reason", moved ? "moved" : "refused");
    Finish(std::move(out));
  }

  void Press(const std::string& type) {
    if (std::optional<std::string> refused = CliTabRefusal(web_contents())) {
      return Fail(*refused);
    }
    if (type == "mousePressed") {
      pressing_ = true;
      ++presses_;
    }
    base::DictValue params;
    params.Set("type", type);
    params.Set("x", point_.x());
    params.Set("y", point_.y());
    params.Set("modifiers", args_.modifiers);
    if (type != "mouseMoved") {
      params.Set("button", args_.button);
      params.Set("clickCount", presses_);
      params.Set("buttons", type == "mousePressed"
                                ? (args_.button == "right"    ? 2
                                   : args_.button == "middle" ? 4
                                                              : 1)
                                : 0);
    }
    probe_->Send("Input.dispatchMouseEvent", std::move(params),
                 base::BindOnce(&TabOp::Pressed, weak_factory_.GetWeakPtr(),
                                type));
  }

  void Pressed(std::string type, CdpResult result) {
    if (!result.has_value()) {
      return Fail("the click didn't reach the page: " +
                  ClippedUtf8(result.error(), 200));
    }
    if (type == "mouseMoved") {
      if (args_.force) {
        if (HitFrameRefused(web_contents(), *model_, -1)) {
          return Fail("a frame in this tab can't be used");
        }
        return Press("mousePressed");
      }
      rechecking_ = true;
      return TakeTree();
    }
    if (type == "mousePressed") {
      return Press("mouseReleased");
    }
    if (presses_ < args_.click_count) {
      const bool frame_gone =
          !first_hit_frame_.empty() &&
          !FrameWithToken(web_contents(), first_hit_frame_);
      if (frame_gone || CliAnyFrameRefused(web_contents())) {
        return StopRepeat();
      }
      hits_.ForgetScroll();
      return HitAt(point_, base::BindOnce(&TabOp::RepeatChecked,
                                          weak_factory_.GetWeakPtr()));
    }
    result_.Set("clicked", true);
    Finish(std::move(result_));
  }

  void RepeatChecked(int hit) {
    const bool other_frame =
        hit < 0 || model_->frames[model_->items[hit].frame].token !=
                       first_hit_frame_;
    const bool frame_gone = !first_hit_frame_.empty() &&
                            !FrameWithToken(web_contents(), first_hit_frame_);
    if (HitFrameRefused(web_contents(), *model_, hit) ||
        (!args_.force && other_frame) || frame_gone) {
      return StopRepeat();
    }
    Press("mousePressed");
  }

  void StopRepeat() {
    ++CliCounts().clicks_blocked;
    Fail(base::StringPrintf(
        "stopped after %d of %d clicks: the clicked frame went away or can't "
        "be used",
        presses_, args_.click_count));
  }

  bool ModelFrameRefused() {
    return model_ && ModelFramesRefused(web_contents(), *model_);
  }

  void FinishSnapshot() {
    if (ModelFrameRefused()) {
      return Fail("a frame in this tab can't be read");
    }
    RefStore::CreateForWebContents(web_contents());
    SnapshotRender render;
    render.scope = ScopeRoot();
    render.max_refs = args_.max_refs;
    render.max_text = args_.max_text;
    render.interactive_only = args_.interactive_only;
    render.occlusion = args_.occlusion;
    render.occlusion_unavailable = occlusion_unavailable_;
    render.checks = checks_.size();
    Finish(RenderSnapshot(*model_, RefStore::FromWebContents(web_contents()),
                          occluded_by_, render));
  }
  void Fail(const std::string& why) {
    if (args_.kind == Kind::kSnapshot) {
      ++CliCounts().snapshots_failed;
    }
    Finish(base::unexpected(why));
  }

  void Finish(Outcome outcome) {
    if (finished_) {
      return;
    }
    finished_ = true;
    deadline_.Stop();
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

  OpArgs args_;
  Reply out_;
  int op_id_ = 0;
  bool finished_ = false;
  double scale_ = 1.0;
  std::optional<PageModel> model_;
  std::unique_ptr<CdpSession> probe_;
  std::map<std::string, std::string> children_;
  FrameHitTester hits_;
  std::vector<int> checks_;
  size_t check_cursor_ = 0;
  std::map<int, int> occluded_by_;
  bool occlusion_unavailable_ = false;
  int target_ = -1;
  bool rebound_ = false;
  bool scrolled_ = false;
  int scroll_tries_ = 0;
  std::optional<gfx::RectF> last_box_;
  gfx::PointF point_;
  base::DictValue result_;
  base::OneShotTimer deadline_;
  base::OneShotTimer frame_timer_;
  base::ScopedClosureRunner drawing_;
  bool waiting_frame_ = false;
  bool pressing_ = false;
  int presses_ = 0;
  int empty_trees_ = 0;
  bool rechecking_ = false;
  std::string recheck_frame_;
  int recheck_dom_ = 0;
  std::string first_hit_frame_;
  int first_hit_dom_ = 0;
  std::unique_ptr<PageReader> reader_;
  std::unique_ptr<CliPolicyWatch> policy_;
  base::WeakPtrFactory<TabOp> weak_factory_{this};
};

}

void StartTabOp(content::WebContents* contents, TabOpArgs args, Reply out) {
  TabOp::Start(contents, std::move(args), std::move(out));
}

}
