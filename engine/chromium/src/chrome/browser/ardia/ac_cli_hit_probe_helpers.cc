// Copyright 2026 Ardia. Apache-2.0.

#include <algorithm>
#include <array>
#include <cstdint>
#include <limits>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/json/json_reader.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_cli_hit_probe.h"
#include "chrome/browser/ardia/ac_cli_hit_probe_internal.h"
#include "chrome/browser/devtools/devtools_availability_checker.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"

namespace ardia {
namespace cli_hit_probe_internal {

namespace {

constexpr std::array<std::string_view, 9> kClickTypes = {
    "click",       "auxclick",  "dblclick",   "mousedown", "mouseup",
    "pointerdown", "pointerup", "touchstart", "touchend"};

}

HitProbeCounts& ProbeCounts() {
  static HitProbeCounts counts;
  return counts;
}

bool IsClickType(const std::string& type) {
  return std::find(kClickTypes.begin(), kClickTypes.end(), type) !=
         kClickTypes.end();
}

std::string Clipped(const std::string& text, size_t bytes) {
  std::string out;
  base::TruncateUTF8ToByteSize(text, bytes, &out);
  return out;
}

bool IsDocumentElement(const std::string& name) {
  return name == "HTML" || name == "BODY" || name == "html" || name == "body";
}

content::RenderFrameHost* FrameWithId(content::WebContents* contents,
                                      const std::string& frame_id) {
  if (!contents || contents->IsBeingDestroyed()) {
    return nullptr;
  }
  content::RenderFrameHost* found = nullptr;
  contents->GetPrimaryMainFrame()->ForEachRenderFrameHost(
      [&](content::RenderFrameHost* frame) {
        if (!found && frame->GetDevToolsFrameToken().ToString() == frame_id) {
          found = frame;
        }
      });
  return found;
}

const std::string* ObjectId(const base::DictValue& result) {
  const base::DictValue* object = result.FindDict("object");
  if (!object) {
    object = result.FindDict("result");
  }
  return object ? object->FindString("objectId") : nullptr;
}

std::vector<std::string> AncestorObjects(const base::DictValue& properties,
                                         size_t limit) {
  std::vector<std::pair<int, std::string>> found;
  if (const base::ListValue* list = properties.FindList("result")) {
    for (const base::Value& property : *list) {
      const base::DictValue* dict = property.GetIfDict();
      const std::string* name = dict ? dict->FindString("name") : nullptr;
      const base::DictValue* value = dict ? dict->FindDict("value") : nullptr;
      const std::string* object =
          value ? value->FindString("objectId") : nullptr;
      int index = 0;
      if (name && object && base::StringToInt(*name, &index) && index >= 0 &&
          static_cast<size_t>(index) < limit) {
        found.emplace_back(index, *object);
      }
    }
  }
  std::sort(found.begin(), found.end());
  std::vector<std::string> objects;
  for (auto& [index, object] : found) {
    objects.push_back(std::move(object));
  }
  return objects;
}

std::optional<ProbeReply> ParseProbeReply(std::string_view message) {
  std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(message, base::JSON_PARSE_RFC);
  std::optional<int> id = parsed ? parsed->FindInt("id") : std::nullopt;
  if (!id) {
    return std::nullopt;
  }
  ProbeReply reply;
  reply.id = *id;
  if (const base::DictValue* error = parsed->FindDict("error")) {
    const std::string* text = error->FindString("message");
    reply.error = text ? *text : std::string("error");
  } else if (base::DictValue* result = parsed->FindDict("result")) {
    reply.result = std::move(*result);
  }
  return reply;
}

std::pair<double, double> ScrollOf(const base::DictValue& metrics) {
  const base::DictValue* visual = metrics.FindDict("cssVisualViewport");
  return {visual ? visual->FindDouble("pageX").value_or(0) : 0,
          visual ? visual->FindDouble("pageY").value_or(0) : 0};
}

bool ReachableFramesInspectable(content::WebContents* contents) {
  if (!contents || contents->IsBeingDestroyed()) {
    return false;
  }
  content::RenderFrameHost* main = contents->GetPrimaryMainFrame();
  bool inspectable = true;
  main->ForEachRenderFrameHostWithAction([&](content::RenderFrameHost* frame) {
    if (frame->IsCrossProcessSubframe()) {
      return content::RenderFrameHost::FrameIterationAction::kSkipChildren;
    }
    if (!FrameInspectable(frame)) {
      inspectable = false;
      return content::RenderFrameHost::FrameIterationAction::kStop;
    }
    return content::RenderFrameHost::FrameIterationAction::kContinue;
  });
  return inspectable;
}

bool FrameInspectable(content::RenderFrameHost* frame) {
  Profile* profile = Profile::FromBrowserContext(frame->GetBrowserContext());
  return !profile || IsInspectionAllowed(profile, frame);
}

}

namespace {

int Clamped(uint64_t count) {
  return count > static_cast<uint64_t>(std::numeric_limits<int>::max())
             ? std::numeric_limits<int>::max()
             : static_cast<int>(count);
}

}

base::DictValue HitProbeTotals() {
  const cli_hit_probe_internal::HitProbeCounts& counts =
      cli_hit_probe_internal::ProbeCounts();
  return base::DictValue()
      .Set("hitTests", Clamped(counts.hit_tests))
      .Set("hitTestsFailed", Clamped(counts.hit_tests_failed))
      .Set("occluded", Clamped(counts.occluded))
      .Set("hitTestsCancelled", Clamped(counts.cancelled))
      .Set("remoteFrames", Clamped(counts.remote_frames));
}

}
