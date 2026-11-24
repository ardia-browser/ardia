// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_hit_tester.h"

#include <cmath>
#include <optional>
#include <utility>

#include "base/functional/bind.h"

namespace ardia {
namespace {

constexpr int kMaxHitDepth = 24;

}

FrameHitTester::FrameHitTester() = default;

FrameHitTester::~FrameHitTester() = default;

void FrameHitTester::Use(CdpSession* probe, const PageModel* model) {
  if (probe_ != probe || model_ != model) {
    scrolls_.clear();
  }
  probe_ = probe;
  model_ = model;
}

void FrameHitTester::HitAt(gfx::PointF global, HitDone done) {
  if (!probe_ || !model_) {
    return std::move(done).Run(-1);
  }
  HitIn(0, global, 0, std::move(done));
}

void FrameHitTester::HitIn(int frame, gfx::PointF global, int depth, HitDone done) {
  const std::string session = model_->frames[frame].session;
  auto scroll = scrolls_.find(session);
  if (scroll != scrolls_.end()) {
    return Locate(frame, global, depth, scroll->second, std::move(done));
  }
  probe_->Send("Page.getLayoutMetrics", base::DictValue(),
               base::BindOnce(&FrameHitTester::GotMetrics, weak_factory_.GetWeakPtr(),
                              frame, global, depth, std::move(done)),
               session);
}

void FrameHitTester::GotMetrics(int frame,
                gfx::PointF global,
                int depth,
                HitDone done,
                CdpResult result) {
  gfx::Vector2dF scroll;
  if (result.has_value()) {
    if (const base::DictValue* visual =
            result->FindDict("cssVisualViewport")) {
      scroll.set_x(visual->FindDouble("pageX").value_or(0));
      scroll.set_y(visual->FindDouble("pageY").value_or(0));
    }
  }
  scrolls_[model_->frames[frame].session] = scroll;
  Locate(frame, global, depth, scroll, std::move(done));
}

void FrameHitTester::Locate(int frame,
            gfx::PointF global,
            int depth,
            gfx::Vector2dF scroll,
            HitDone done) {
  const AxFrame& at = model_->frames[frame];
  const float zoom = frame == 0 || !(at.zoom > 0) ? 1.0f : at.zoom;
  const gfx::Vector2dF origin = frame == 0 ? gfx::Vector2dF() : at.origin;
  const double x =
      std::round((global.x() - origin.x()) / zoom + scroll.x());
  const double y =
      std::round((global.y() - origin.y()) / zoom + scroll.y());
  if (!std::isfinite(x) || !std::isfinite(y) || std::abs(x) > 1e6 ||
      std::abs(y) > 1e6) {
    return std::move(done).Run(-1);
  }
  probe_->Send("DOM.getNodeForLocation",
               base::DictValue()
                   .Set("x", static_cast<int>(x))
                   .Set("y", static_cast<int>(y))
                   .Set("includeUserAgentShadowDOM", false)
                   .Set("ignorePointerEventsNone", false),
               base::BindOnce(&FrameHitTester::Located, weak_factory_.GetWeakPtr(),
                              frame, global, depth, std::move(done)),
               model_->frames[frame].session);
}

void FrameHitTester::Located(int frame,
             gfx::PointF global,
             int depth,
             HitDone done,
             CdpResult result) {
  if (!result.has_value()) {
    return std::move(done).Run(-1);
  }
  std::optional<int> node = result->FindInt("backendNodeId");
  const std::string* token = result->FindString("frameId");
  const int in_frame = token ? model_->FrameWithToken(*token) : -1;
  const int item =
      node && in_frame >= 0 ? model_->Find(in_frame, *node) : -1;
  if (item < 0 || depth >= kMaxHitDepth) {
    return std::move(done).Run(item);
  }
  const int child = model_->items[item].frame_host
                        ? model_->ChildFrameOfHost(item)
                        : -1;
  if (child > 0 && model_->frames[child].reachable &&
      model_->frames[child].session != model_->frames[frame].session) {
    return HitIn(child, global, depth + 1, std::move(done));
  }
  std::move(done).Run(item);
}

}
