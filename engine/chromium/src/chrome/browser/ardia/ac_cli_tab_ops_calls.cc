// Copyright 2026 Ardia. Apache-2.0.

#include <cmath>
#include <optional>
#include <string>
#include <utility>

#include "chrome/browser/ardia/ac_cli_ops.h"
#include "chrome/browser/ardia/ac_cli_tab_ops.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "content/public/browser/web_contents.h"

namespace ardia {
namespace {

content::WebContents* TabFrom(const base::DictValue& args) {
  std::optional<int> tab = args.FindInt("tab");
  content::WebContents* contents = tab ? TabWithId(*tab) : nullptr;
  return contents && !contents->IsBeingDestroyed() ? contents : nullptr;
}

bool ReadOwner(const ArgsCall& call, TabOpArgs* args, std::string* error) {
  args->owner = call.String("owner");
  if (!args->owner.empty() && !ValidCliOwner(args->owner)) {
    *error = "bad owner";
    return false;
  }
  return true;
}

bool ReadTarget(const ArgsCall& call, TabOpArgs* args, std::string* error) {
  args->ref = call.String("ref");
  if (args->ref.size() > 32) {
    *error = "bad ref";
    return false;
  }
  const std::optional<double> x = call.args().FindDouble("x");
  const std::optional<double> y = call.args().FindDouble("y");
  if (x.has_value() != y.has_value()) {
    *error = "give both x and y";
    return false;
  }
  if (x) {
    if (!std::isfinite(*x) || !std::isfinite(*y) || std::abs(*x) > 1e6 ||
        std::abs(*y) > 1e6) {
      *error = "that point is outside the page";
      return false;
    }
    args->point = gfx::PointF(*x, *y);
  }
  if (args->ref.empty() == !args->point.has_value()) {
    *error = "give a ref or a point (x, y), not both";
    return false;
  }
  return true;
}

}
}

AC_ARGS_CALL(ac_cli_snapshot) {
  ardia::Reply out = call.TakeReply();
  content::WebContents* contents = ardia::TabFrom(call.args());
  if (!contents) {
    return out.Error("no such tab");
  }
  ardia::TabOpArgs args;
  std::string error;
  if (!ardia::ReadOwner(call, &args, &error)) {
    return out.Error(error);
  }
  args.kind = ardia::TabOpKind::kSnapshot;
  if (std::optional<int> limit = call.args().FindInt("maxRefs")) {
    if (*limit < 1 || *limit > 2000) {
      return out.Error("maxRefs must be 1 to 2000");
    }
    args.max_refs = static_cast<size_t>(*limit);
  }
  if (std::optional<int> limit = call.args().FindInt("maxTextBytes")) {
    if (*limit < 1024 || *limit > 512 * 1024) {
      return out.Error("maxTextBytes must be 1024 to 524288");
    }
    args.max_text = static_cast<size_t>(*limit);
  }
  args.interactive_only = call.Bool("interactiveOnly");
  args.whole_page = call.Bool("wholePage");
  args.occlusion = call.Bool("occlusion", true);
  ardia::StartTabOp(contents, std::move(args), std::move(out));
}

AC_ARGS_CALL(ac_cli_hit_test) {
  ardia::Reply out = call.TakeReply();
  content::WebContents* contents = ardia::TabFrom(call.args());
  if (!contents) {
    return out.Error("no such tab");
  }
  ardia::TabOpArgs args;
  std::string error;
  if (!ardia::ReadOwner(call, &args, &error) ||
      !ardia::ReadTarget(call, &args, &error)) {
    return out.Error(error);
  }
  args.kind = ardia::TabOpKind::kHitTest;
  ardia::StartTabOp(contents, std::move(args), std::move(out));
}

AC_ARGS_CALL(ac_cli_click) {
  ardia::Reply out = call.TakeReply();
  content::WebContents* contents = ardia::TabFrom(call.args());
  if (!contents) {
    return out.Error("no such tab");
  }
  ardia::TabOpArgs args;
  std::string error;
  if (!ardia::ReadOwner(call, &args, &error) ||
      !ardia::ReadTarget(call, &args, &error)) {
    return out.Error(error);
  }
  args.kind = ardia::TabOpKind::kClick;
  args.force = call.Bool("force");
  const std::string button = call.String("button");
  if (!button.empty()) {
    if (button != "left" && button != "right" && button != "middle") {
      return out.Error("button must be left, right or middle");
    }
    args.button = button;
  }
  if (std::optional<int> count = call.args().FindInt("clickCount")) {
    if (*count < 1 || *count > 3) {
      return out.Error("clickCount must be 1 to 3");
    }
    args.click_count = *count;
  }
  if (std::optional<int> modifiers = call.args().FindInt("modifiers")) {
    if (*modifiers < 0 || *modifiers > 15) {
      return out.Error("modifiers must be 0 to 15");
    }
    args.modifiers = *modifiers;
  }
  ardia::StartTabOp(contents, std::move(args), std::move(out));
}
