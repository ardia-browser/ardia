// Copyright 2026 Ardia. Apache-2.0.

#include <cmath>
#include <set>
#include <string>
#include <utility>
#include <vector>

#include "chrome/browser/ardia/ac_cli_ops.h"
#include "chrome/browser/ardia/ac_cli_page_model.h"
#include "chrome/browser/ardia/ac_cli_tab_ops.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"

namespace ardia {
namespace {

constexpr size_t kDismissChoices = 4;

}

std::vector<int> OcclusionCandidates(const PageModel& model,
                                     int scope,
                                     size_t limit) {
  std::vector<int> found;
  for (size_t i = 0; i < model.items.size() && found.size() < limit; ++i) {
    const int index = static_cast<int>(i);
    const AxItem& item = model.items[i];
    if (item.interactive && !item.hidden && model.InViewport(index) &&
        model.IsAncestor(scope, index)) {
      found.push_back(index);
    }
  }
  return found;
}

content::RenderFrameHost* FrameWithToken(content::WebContents* contents,
                                         const std::string& token) {
  content::RenderFrameHost* found = nullptr;
  contents->GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&](content::RenderFrameHost* frame) {
        if (!found && frame->GetDevToolsFrameToken().ToString() == token) {
          found = frame;
        }
      });
  return found;
}

bool HitFrameRefused(content::WebContents* contents,
                     const PageModel& model,
                     int hit) {
  if (hit < 0) {
    return CliAnyFrameRefused(contents);
  }
  content::RenderFrameHost* frame =
      FrameWithToken(contents, model.frames[model.items[hit].frame].token);
  return !frame || CliFrameRefused(frame);
}

bool ModelFramesRefused(content::WebContents* contents, const PageModel& model) {
  for (size_t f = 0; f < model.frames.size(); ++f) {
    if (f > 0 && model.frames[f].host < 0) {
      continue;
    }
    content::RenderFrameHost* frame = FrameWithToken(contents, model.frames[f].token);
    if (frame && CliFrameRefused(frame)) {
      return true;
    }
  }
  return false;
}

base::DictValue DescribeClick(const PageModel& model,
                              RefStore* refs,
                              gfx::PointF point,
                              int hit,
                              int target) {
  base::DictValue out;
  out.Set("point", base::ListValue()
                       .Append(std::round(point.x() * 10) / 10)
                       .Append(std::round(point.y() * 10) / 10));
  out.Set("verified", hit >= 0);
  if (hit >= 0) {
    out.Set("hit", DescribeItem(model, refs, hit));
  }
  if (target >= 0) {
    out.Set("target", DescribeItem(model, refs, target));
  }
  ReportBlocker(model, refs, hit, target, &out);
  return out;
}

base::DictValue DescribeItem(const PageModel& model, RefStore* refs, int item) {
  const AxItem& data = model.items[item];
  base::DictValue out;
  out.Set("ref", refs->RefFor(model, item));
  out.Set("role", data.role);
  out.Set("name", data.name);
  out.Set("box", BoxValue(data.box));
  if (data.frame > 0) {
    out.Set("frame", data.frame);
  }
  return out;
}

int ReportBlocker(const PageModel& model,
                  RefStore* refs,
                  int hit,
                  int target,
                  base::DictValue* out) {
  int blocker = -1;
  if (target >= 0) {
    blocker = BlockerOf(model, hit, target);
  } else if (hit >= 0 && model.modal >= 0 && !model.IsAncestor(model.modal, hit)) {
    blocker = model.modal;
  }
  out->Set("blocked", blocker >= 0);
  if (blocker < 0) {
    return blocker;
  }
  out->Set("blocker", DescribeItem(model, refs, blocker));
  std::vector<DismissChoice> choices =
      DismissChoices(model, blocker, kDismissChoices);
  if (choices.empty() && model.modal >= 0 && blocker != model.modal &&
      model.IsAncestor(model.modal, hit)) {
    choices = DismissChoices(model, model.modal, kDismissChoices);
  }
  base::ListValue listed;
  for (const DismissChoice& choice : choices) {
    base::DictValue described = DescribeItem(model, refs, choice.item);
    described.Set("kind", choice.kind);
    listed.Append(std::move(described));
  }
  if (!choices.empty()) {
    ++CliCounts().dismiss_found;
    out->Set("dismiss", listed.front().Clone());
  }
  out->Set("choices", std::move(listed));
  return blocker;
}

base::DictValue RenderSnapshot(const PageModel& model,
                               RefStore* refs,
                               const std::map<int, int>& occluded_by,
                               const SnapshotRender& render) {
  const int scope = render.scope;
  base::ListValue listed;
  std::set<int> blockers;
  for (const auto& [item, blocker] : occluded_by) {
    blockers.insert(blocker);
  }
  size_t bytes = 0;
  bool truncated = model.items_truncated;
  int interactive = 0;
  const int base_depth = model.items[scope].depth;
  for (size_t i = 0; i < model.items.size(); ++i) {
    const int index = static_cast<int>(i);
    const AxItem& item = model.items[i];
    if (item.hidden || !model.IsAncestor(scope, index)) {
      continue;
    }
    if (item.interactive) {
      ++interactive;
    }
    const bool blocker = blockers.contains(index);
    bool include = item.interactive || blocker;
    if (!include && !render.interactive_only) {
      include = item.structural || item.frame_host ||
                (item.text && !(item.parent >= 0 &&
                                (model.items[item.parent].interactive ||
                                 model.items[item.parent].role ==
                                     "heading") &&
                                model.items[item.parent].name == item.name));
    }
    if (!include) {
      continue;
    }
    if (listed.size() >= render.max_refs || bytes >= render.max_text) {
      truncated = true;
      break;
    }
    base::DictValue row;
    row.Set("ref", refs->RefFor(model, index));
    row.Set("role", item.text ? std::string("text") : item.role);
    if (!item.name.empty()) {
      row.Set("name", item.name);
    }
    if (!item.value.empty() && item.value != item.name) {
      row.Set("value", item.value);
    }
    if (item.redacted) {
      row.Set("redacted", true);
    }
    row.Set("box", BoxValue(item.box));
    row.Set("depth", item.depth - base_depth);
    if (item.frame > 0) {
      row.Set("frame", item.frame);
    }
    if (item.disabled) {
      row.Set("disabled", true);
    }
    if (item.checked >= 0) {
      if (item.checked == 2) {
        row.Set("checked", "mixed");
      } else {
        row.Set("checked", item.checked == 1);
      }
    }
    if (item.expanded >= 0) {
      row.Set("expanded", item.expanded == 1);
    }
    if (item.focused) {
      row.Set("focused", true);
    }
    if (!model.InViewport(index)) {
      row.Set("offscreen", true);
    }
    if (item.interactive) {
      row.Set("fp", Fingerprint(item));
      if (item.dom > 0) {
        row.Set("node", item.dom);
      }
    }
    auto occluded = occluded_by.find(index);
    if (occluded != occluded_by.end()) {
      row.Set("occludedBy", refs->RefFor(model, occluded->second));
    }
    if (blocker) {
      row.Set("blocker", true);
    }
    bytes += item.name.size() + item.value.size() + 48;
    listed.Append(std::move(row));
  }
  CliCounts().snapshot_refs += listed.size();
  base::DictValue out;
  out.Set("generation", refs->generation());
  out.Set("viewport", base::ListValue()
                          .Append(std::round(model.viewport.width()))
                          .Append(std::round(model.viewport.height())));
  out.Set("scope", scope == 0 ? "page" : "modal");
  if (scope != 0) {
    ++CliCounts().snapshots_modal;
    base::DictValue modal;
    modal.Set("ref", refs->RefFor(model, scope));
    modal.Set("name", model.items[scope].name);
    out.Set("modal", std::move(modal));
  }
  if (model.focus >= 0 && !model.items[model.focus].hidden) {
    out.Set("focused", refs->RefFor(model, model.focus));
  }
  out.Set("refs", std::move(listed));
  out.Set("truncated", truncated);
  out.Set("counts", base::DictValue()
                        .Set("nodes", static_cast<int>(model.items.size()))
                        .Set("frames", static_cast<int>(model.frames.size()))
                        .Set("interactive", interactive)
                        .Set("occluded",
                             static_cast<int>(occluded_by.size()))
                        .Set("framesTruncated", model.frames_truncated));
  if (render.occlusion_unavailable) {
    out.Set("occlusion", "unavailable");
  } else if (render.occlusion) {
    out.Set("occlusion", static_cast<int>(render.checks));
  }
  return out;
}

}
