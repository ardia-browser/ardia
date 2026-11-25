// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_hit_probe.h"
#include "chrome/browser/ardia/ac_cli_hit_probe_internal.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/containers/span.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/location.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/strcat.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"

namespace ardia {
namespace {

using cli_hit_probe_internal::Clipped;
using cli_hit_probe_internal::FrameWithId;
using cli_hit_probe_internal::IsClickType;
using cli_hit_probe_internal::IsDocumentElement;
using cli_hit_probe_internal::kGroup;
using cli_hit_probe_internal::kInside;
using cli_hit_probe_internal::kPath;
using cli_hit_probe_internal::kWorld;
using cli_hit_probe_internal::ObjectId;
using cli_hit_probe_internal::ProbeCounts;
using cli_hit_probe_internal::ScrollOf;

using Outcome = base::expected<base::DictValue, std::string>;

constexpr base::TimeDelta kProbeDeadline = base::Seconds(3);
constexpr size_t kMaxAncestors = 32;
constexpr int kMaxProbesInFlight = 4;
constexpr int kMaxRescrolls = 3;
void Answer(PageSignalReply reply, Outcome outcome) {
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(std::move(reply), std::move(outcome)));
}

class HitProbe : public content::DevToolsAgentHostClient,
                 public content::WebContentsObserver {
 public:
  static base::ScopedClosureRunner Start(content::WebContents* contents,
                                         double x,
                                         double y,
                                         std::optional<int> target,
                                         PageSignalReply reply) {
    if (ProbeCounts().in_flight >= kMaxProbesInFlight) {
      Answer(std::move(reply),
             base::unexpected("ardia: too many hit tests are running"));
      return base::ScopedClosureRunner();
    }
    ++ProbeCounts().hit_tests;
    HitProbe* probe = new HitProbe(contents, x, y, target, std::move(reply));
    base::ScopedClosureRunner cancel(
        base::BindOnce(&HitProbe::Cancel, probe->weak_factory_.GetWeakPtr()));
    probe->Begin();
    return cancel;
  }

  void DispatchProtocolMessage(content::DevToolsAgentHost* agent_host,
                               base::span<const uint8_t> message) override {
    if (done_) {
      return;
    }
    std::optional<cli_hit_probe_internal::ProbeReply> reply =
        cli_hit_probe_internal::ParseProbeReply(base::as_string_view(message));
    auto it = reply ? steps_.find(reply->id) : steps_.end();
    if (it == steps_.end()) {
      return;
    }
    Step step = std::move(it->second);
    steps_.erase(it);
    if (reply->error) {
      return std::move(step.failed).Run(*reply->error);
    }
    std::move(step.done).Run(std::move(reply->result));
  }

  void AgentHostClosed(content::DevToolsAgentHost* agent_host) override {
    host_ = nullptr;
    Fail("ardia: the tab's target closed");
  }

  bool MayAttachToURL(const GURL& url, bool is_webui) override {
    return !is_webui;
  }
  bool IsTrusted() override { return false; }
  bool MayReadLocalFiles() override { return false; }
  bool MayWriteLocalFiles() override { return false; }

  void WebContentsDestroyed() override { Fail("ardia: the tab closed"); }

  void DidFinishNavigation(content::NavigationHandle* navigation) override {
    if (!navigation->HasCommitted() || navigation->IsSameDocument()) {
      return;
    }
    content::RenderFrameHost* frame = navigation->GetRenderFrameHost();
    if (navigation->IsInPrimaryMainFrame() ||
        (frame && !frame_id_.empty() &&
         frame->GetDevToolsFrameToken().ToString() == frame_id_)) {
      Fail("ardia: the page navigated during the hit test");
    }
  }

  void PrimaryMainFrameRenderProcessGone(
      base::TerminationStatus status) override {
    Fail("ardia: the page's process went away");
  }

  ~HitProbe() override {
    ReleaseSlot();
    if (host_) {
      scoped_refptr<content::DevToolsAgentHost> host = std::move(host_);
      host->DetachClient(this);
    }
  }

 private:
  using Next = base::OnceCallback<void(base::DictValue)>;
  using Failed = base::OnceCallback<void(const std::string&)>;

  struct Step {
    Next done;
    Failed failed;
  };

  HitProbe(content::WebContents* contents,
           double x,
           double y,
           std::optional<int> target,
           PageSignalReply reply)
      : content::WebContentsObserver(contents),
        x_(x),
        y_(y),
        target_(target),
        reply_(std::move(reply)) {
    ++ProbeCounts().in_flight;
  }

  void ReleaseSlot() {
    if (slot_held_) {
      slot_held_ = false;
      --ProbeCounts().in_flight;
    }
  }

  void Cancel() {
    if (done_) {
      return;
    }
    ++ProbeCounts().cancelled;
    done_ = true;
    deadline_.Stop();
    steps_.clear();
    reply_.Reset();
    ReleaseSlot();
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, this);
  }

  void Begin() {
    content::WebContents* contents = web_contents();
    if (!contents || contents->IsBeingDestroyed()) {
      return Fail("ardia: the tab closed");
    }
    host_ = content::DevToolsAgentHost::GetOrCreateFor(contents);
    if (!host_ || !host_->AttachClient(this)) {
      host_ = nullptr;
      return Fail("ardia: can't inspect this tab");
    }
    deadline_.Start(FROM_HERE, kProbeDeadline,
                    base::BindOnce(&HitProbe::Fail, base::Unretained(this),
                                   std::string("ardia: the page didn't answer "
                                               "in time")));
    Send("Page.getLayoutMetrics", base::DictValue(),
         base::BindOnce(&HitProbe::GotMetrics, weak_factory_.GetWeakPtr()));
  }

  void Send(const std::string& method, base::DictValue params, Next next) {
    Send(method, std::move(params), std::move(next),
         base::BindOnce(&HitProbe::StepFailed, weak_factory_.GetWeakPtr(),
                        method));
  }

  void Send(const std::string& method,
            base::DictValue params,
            Next next,
            Failed failed) {
    if (done_ || !host_) {
      return;
    }
    const int id = next_id_++;
    std::optional<std::string> json =
        base::WriteJson(base::DictValue()
                            .Set("id", id)
                            .Set("method", method)
                            .Set("params", std::move(params)));
    if (!json) {
      return Fail("ardia: couldn't write a command");
    }
    steps_[id] = Step{std::move(next), std::move(failed)};
    scoped_refptr<content::DevToolsAgentHost> host = host_;
    host->DispatchProtocolMessage(this, base::as_byte_span(*json));
  }

  void StepFailed(const std::string& method, const std::string& error) {
    Fail(base::StrCat({"ardia: ", method, " failed: ", Clipped(error, 256)}));
  }

  void GotMetrics(base::DictValue result) {
    const auto [page_x, page_y] = ScrollOf(result);
    scroll_ = {page_x, page_y};
    const double doc_x = std::round(page_x + x_);
    const double doc_y = std::round(page_y + y_);
    if (!std::isfinite(doc_x) || !std::isfinite(doc_y) ||
        std::abs(doc_x) > kMaxHitCoordinate ||
        std::abs(doc_y) > kMaxHitCoordinate) {
      return Fail("ardia: that point is outside the page");
    }
    Send("DOM.getNodeForLocation",
         base::DictValue()
             .Set("x", static_cast<int>(doc_x))
             .Set("y", static_cast<int>(doc_y))
             .Set("includeUserAgentShadowDOM", false)
             .Set("ignorePointerEventsNone", false),
         base::BindOnce(&HitProbe::GotHit, weak_factory_.GetWeakPtr()));
  }

  void GotHit(base::DictValue result) {
    std::optional<int> hit = result.FindInt("backendNodeId");
    const std::string* frame = result.FindString("frameId");
    if (!hit || !frame) {
      return Fail("ardia: nothing is drawn at that point");
    }
    hit_ = *hit;
    frame_id_ = *frame;
    Send("Page.getLayoutMetrics", base::DictValue(),
         base::BindOnce(&HitProbe::CheckedScroll, weak_factory_.GetWeakPtr()));
  }

  void CheckedScroll(base::DictValue result) {
    if (ScrollOf(result) != scroll_) {
      if (++rescrolls_ > kMaxRescrolls) {
        return Fail("ardia: the page kept scrolling during the hit test");
      }
      return GotMetrics(std::move(result));
    }
    content::RenderFrameHost* frame = FrameWithId(web_contents(), frame_id_);
    if (!frame || !cli_hit_probe_internal::FrameInspectable(frame)) {
      return Fail("ardia: DevTools can't inspect the frame at that point");
    }
    out_.Set(
        "hit",
        base::DictValue().Set("backendNodeId", hit_).Set("frameId", frame_id_));
    Send("DOM.describeNode", base::DictValue().Set("backendNodeId", hit_),
         base::BindOnce(&HitProbe::GotHitNode, weak_factory_.GetWeakPtr()));
  }

  void GotHitNode(base::DictValue result) {
    const base::DictValue* node = result.FindDict("node");
    const std::string* owned = node ? node->FindString("frameId") : nullptr;
    content::RenderFrameHost* child =
        owned ? FrameWithId(web_contents(), *owned) : nullptr;
    if (child && child->IsCrossProcessSubframe()) {
      ++ProbeCounts().remote_frames;
      out_.Set("remoteFrame", base::DictValue().Set("frameId", *owned));
      out_.Set("unsupported", "remote-frame");
      if (target_ && *target_ == hit_) {
        out_.Set("occluded", false);
      }
      return End(std::move(out_));
    }
    Send("Page.createIsolatedWorld",
         base::DictValue()
             .Set("frameId", frame_id_)
             .Set("worldName", kWorld)
             .Set("grantUniveralAccess", false),
         base::BindOnce(&HitProbe::GotWorld, weak_factory_.GetWeakPtr()));
  }

  void GotWorld(base::DictValue result) {
    std::optional<int> context = result.FindInt("executionContextId");
    if (!context) {
      return Fail("ardia: couldn't reach the frame at that point");
    }
    world_ = *context;
    Send("DOM.resolveNode",
         base::DictValue()
             .Set("backendNodeId", hit_)
             .Set("executionContextId", world_)
             .Set("objectGroup", kGroup),
         base::BindOnce(&HitProbe::GotHitObject, weak_factory_.GetWeakPtr()));
  }

  void GotHitObject(base::DictValue result) {
    const std::string* object = ObjectId(result);
    if (!object) {
      return Fail("ardia: the node at that point is gone");
    }
    hit_object_ = *object;
    if (!target_) {
      return WalkPath();
    }
    if (*target_ == hit_) {
      out_.Set("occluded", false);
      return WalkPath();
    }
    if (!cli_hit_probe_internal::ReachableFramesInspectable(web_contents())) {
      return Fail(
          "ardia: DevTools can't inspect every frame that node may be in");
    }
    Send("DOM.getDocument", base::DictValue().Set("depth", 0),
         base::BindOnce(&HitProbe::PushTarget, weak_factory_.GetWeakPtr()));
  }

  void PushTarget(base::DictValue result) {
    Send("DOM.pushNodesByBackendIdsToFrontend",
         base::DictValue().Set("backendNodeIds",
                               base::ListValue().Append(*target_)),
         base::BindOnce(&HitProbe::ResolveTarget, weak_factory_.GetWeakPtr()));
  }

  void ResolveTarget(base::DictValue result) {
    const base::ListValue* ids = result.FindList("nodeIds");
    if (!ids || ids->size() != 1 || !(*ids)[0].is_int() ||
        (*ids)[0].GetInt() <= 0) {
      return Fail("ardia: that backendNodeId isn't a node of this tab");
    }
    target_node_ = (*ids)[0].GetInt();
    Send(
        "DOM.resolveNode",
        base::DictValue()
            .Set("nodeId", target_node_)
            .Set("executionContextId", world_)
            .Set("objectGroup", kGroup),
        base::BindOnce(&HitProbe::GotTargetObject, weak_factory_.GetWeakPtr()),
        base::BindOnce(&HitProbe::TargetElsewhere, weak_factory_.GetWeakPtr()));
  }

  void TargetElsewhere(const std::string& error) {
    Send("DOM.resolveNode",
         base::DictValue()
             .Set("nodeId", target_node_)
             .Set("objectGroup", kGroup),
         base::BindOnce(&HitProbe::TargetInOtherFrame,
                        weak_factory_.GetWeakPtr()),
         base::BindOnce(&HitProbe::TargetGone, weak_factory_.GetWeakPtr()));
  }

  void TargetInOtherFrame(base::DictValue result) {
    if (!ObjectId(result)) {
      return TargetGone(std::string());
    }
    MarkOccluded(true, false);
    WalkPath();
  }

  void TargetGone(const std::string& error) {
    Fail("ardia: there's no node with that backendNodeId");
  }

  void GotTargetObject(base::DictValue result) {
    const std::string* object = ObjectId(result);
    if (!object) {
      return TargetGone(std::string());
    }
    Send("Runtime.callFunctionOn",
         base::DictValue()
             .Set("objectId", *object)
             .Set("functionDeclaration", kInside)
             .Set("arguments", base::ListValue().Append(base::DictValue().Set(
                                   "objectId", hit_object_)))
             .Set("returnByValue", true)
             .Set("silent", true),
         base::BindOnce(&HitProbe::GotInside, weak_factory_.GetWeakPtr()));
  }

  void GotInside(base::DictValue result) {
    const base::DictValue* value = result.FindDict("result");
    if (!value || result.FindDict("exceptionDetails")) {
      return Fail(
          "ardia: couldn't compare the node with the one at that point");
    }
    const std::string* frame = value->FindString("value");
    if (frame && *frame == "other-frame") {
      MarkOccluded(true, false);
      return WalkPath();
    }
    MarkOccluded(!value->FindBool("value").value_or(false), true);
    WalkPath();
  }

  void MarkOccluded(bool occluded, bool target_found) {
    out_.Set("occluded", occluded);
    if (!target_found) {
      out_.Set("targetInOtherFrame", true);
    }
    if (occluded) {
      ++ProbeCounts().occluded;
      if (const base::DictValue* hit = out_.FindDict("hit")) {
        out_.Set("blockedBy", hit->Clone());
      }
    }
  }

  void WalkPath() {
    Send("Runtime.callFunctionOn",
         base::DictValue()
             .Set("objectId", hit_object_)
             .Set("functionDeclaration", kPath)
             .Set("returnByValue", false)
             .Set("objectGroup", kGroup)
             .Set("silent", true),
         base::BindOnce(&HitProbe::GotPath, weak_factory_.GetWeakPtr()));
  }

  void GotPath(base::DictValue result) {
    const std::string* array = ObjectId(result);
    if (!array || result.FindDict("exceptionDetails")) {
      return Fail("ardia: couldn't read the nodes at that point");
    }
    Send("Runtime.getProperties",
         base::DictValue().Set("objectId", *array).Set("ownProperties", true),
         base::BindOnce(&HitProbe::GotAncestors, weak_factory_.GetWeakPtr()));
  }

  void GotAncestors(base::DictValue result) {
    ancestors_ = cli_hit_probe_internal::AncestorObjects(result, kMaxAncestors);
    NextAncestor();
  }

  void NextAncestor() {
    if (depth_ >= ancestors_.size()) {
      return Finish();
    }
    Send(
        "DOM.describeNode",
        base::DictValue().Set("objectId", ancestors_[depth_]),
        base::BindOnce(&HitProbe::GotAncestorNode, weak_factory_.GetWeakPtr()));
  }

  void GotAncestorNode(base::DictValue result) {
    const base::DictValue* node = result.FindDict("node");
    std::optional<int> backend =
        node ? node->FindInt("backendNodeId") : std::nullopt;
    const std::string* name = node ? node->FindString("nodeName") : nullptr;
    if (!backend || !name) {
      ++depth_;
      return NextAncestor();
    }
    if (depth_ == 0) {
      if (base::DictValue* hit = out_.FindDict("hit")) {
        hit->Set("nodeName", Clipped(*name, 64));
      }
      if (base::DictValue* blocked = out_.FindDict("blockedBy")) {
        blocked->Set("nodeName", Clipped(*name, 64));
      }
    }
    current_backend_ = *backend;
    current_name_ = Clipped(*name, 64);
    Send("DOM.resolveNode",
         base::DictValue()
             .Set("backendNodeId", current_backend_)
             .Set("objectGroup", kGroup),
         base::BindOnce(&HitProbe::GotMainWorldObject,
                        weak_factory_.GetWeakPtr()));
  }

  void GotMainWorldObject(base::DictValue result) {
    const std::string* object = ObjectId(result);
    if (!object) {
      ++depth_;
      return NextAncestor();
    }
    Send("DOMDebugger.getEventListeners",
         base::DictValue().Set("objectId", *object),
         base::BindOnce(&HitProbe::GotListeners, weak_factory_.GetWeakPtr()));
  }

  void GotListeners(base::DictValue result) {
    base::ListValue types;
    if (const base::ListValue* listeners = result.FindList("listeners")) {
      for (const base::Value& listener : *listeners) {
        const base::DictValue* dict = listener.GetIfDict();
        const std::string* type = dict ? dict->FindString("type") : nullptr;
        if (type && IsClickType(*type) && !types.contains(*type)) {
          types.Append(*type);
        }
      }
    }
    if (!types.empty()) {
      base::DictValue holder = base::DictValue()
                                   .Set("backendNodeId", current_backend_)
                                   .Set("nodeName", current_name_)
                                   .Set("depth", static_cast<int>(depth_))
                                   .Set("types", std::move(types));
      if (!IsDocumentElement(current_name_)) {
        out_.Set("hasClickListener", true);
        out_.Set("listener", std::move(holder));
        return Finish();
      }
      if (!out_.Find("delegatedTo")) {
        out_.Set("delegatedTo", std::move(holder));
      }
    }
    ++depth_;
    NextAncestor();
  }

  void Finish() {
    if (done_) {
      return;
    }
    if (!out_.Find("hasClickListener")) {
      out_.Set("hasClickListener", false);
    }
    out_.Set("delegated",
             out_.Find("delegatedTo") != nullptr &&
                 !out_.FindBool("hasClickListener").value_or(false));
    out_.Set("ancestorsChecked",
             static_cast<int>(std::min(depth_ + 1, ancestors_.size())));
    End(std::move(out_));
  }

  void Fail(std::string error) {
    if (done_) {
      return;
    }
    ++ProbeCounts().hit_tests_failed;
    End(base::unexpected(std::move(error)));
  }

  void End(Outcome outcome) {
    done_ = true;
    deadline_.Stop();
    steps_.clear();
    ReleaseSlot();
    if (reply_) {
      Answer(std::move(reply_), std::move(outcome));
    }
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, this);
  }

  const double x_;
  const double y_;
  const std::optional<int> target_;
  PageSignalReply reply_;
  scoped_refptr<content::DevToolsAgentHost> host_;
  std::map<int, Step> steps_;
  int next_id_ = 1;
  bool done_ = false;
  bool slot_held_ = true;
  int target_node_ = 0;
  std::pair<double, double> scroll_;
  int rescrolls_ = 0;
  int hit_ = 0;
  std::string frame_id_;
  int world_ = 0;
  std::string hit_object_;
  std::vector<std::string> ancestors_;
  size_t depth_ = 0;
  int current_backend_ = 0;
  std::string current_name_;
  base::DictValue out_;
  base::OneShotTimer deadline_;
  base::WeakPtrFactory<HitProbe> weak_factory_{this};
};

}

base::ScopedClosureRunner StartHitProbe(content::WebContents* contents,
                                        double x,
                                        double y,
                                        std::optional<int> target,
                                        PageSignalReply reply) {
  return HitProbe::Start(contents, x, y, target, std::move(reply));
}

}
