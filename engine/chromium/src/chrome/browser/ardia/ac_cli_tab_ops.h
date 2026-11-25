// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_TAB_OPS_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_TAB_OPS_H_

#include <cstddef>
#include <map>
#include <optional>
#include <string>
#include <vector>

#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_page_model.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "ui/gfx/geometry/point_f.h"

namespace content {
class RenderFrameHost;
class WebContents;
}

namespace ardia {

enum class TabOpKind { kSnapshot, kHitTest, kClick };

struct TabOpArgs {
  TabOpKind kind = TabOpKind::kSnapshot;
  std::string owner;
  size_t max_refs = 400;
  size_t max_text = 64 * 1024;
  bool interactive_only = false;
  bool whole_page = false;
  bool occlusion = true;
  std::string ref;
  std::optional<gfx::PointF> point;
  bool force = false;
  std::string button = "left";
  int click_count = 1;
  int modifiers = 0;
};

void StartTabOp(content::WebContents* contents, TabOpArgs args, Reply out);

struct SnapshotRender {
  int scope = 0;
  size_t max_refs = 400;
  size_t max_text = 64 * 1024;
  bool interactive_only = false;
  bool occlusion = true;
  bool occlusion_unavailable = false;
  size_t checks = 0;
};

base::DictValue RenderSnapshot(const PageModel& model,
                               RefStore* refs,
                               const std::map<int, int>& occluded_by,
                               const SnapshotRender& render);

base::DictValue DescribeItem(const PageModel& model, RefStore* refs, int item);

std::vector<int> OcclusionCandidates(const PageModel& model,
                                     int scope,
                                     size_t limit);

content::RenderFrameHost* FrameWithToken(content::WebContents* contents,
                                         const std::string& token);

bool HitFrameRefused(content::WebContents* contents,
                     const PageModel& model,
                     int hit);

bool ModelFramesRefused(content::WebContents* contents, const PageModel& model);

base::DictValue DescribeClick(const PageModel& model,
                              RefStore* refs,
                              gfx::PointF point,
                              int hit,
                              int target);

int ReportBlocker(const PageModel& model,
                  RefStore* refs,
                  int hit,
                  int target,
                  base::DictValue* out);

}

#endif
