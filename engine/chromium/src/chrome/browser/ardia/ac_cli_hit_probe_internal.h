// Copyright 2026 Ardia. Apache-2.0.

#ifndef CHROME_BROWSER_ARDIA_AC_CLI_HIT_PROBE_INTERNAL_H_
#define CHROME_BROWSER_ARDIA_AC_CLI_HIT_PROBE_INTERNAL_H_

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/values.h"

namespace content {
class RenderFrameHost;
class WebContents;
}

namespace ardia {
namespace cli_hit_probe_internal {

inline constexpr char kWorld[] = "ardia-signals";
inline constexpr char kGroup[] = "ardia-signals";
inline constexpr char kInside[] =
    "function(n){if((this.nodeType===9?this:this.ownerDocument)!==document)"
    "return \"other-frame\";"
    "for(let i=0;n&&i<4096;i++){if(n===this)return true;"
    "n=n.assignedSlot||n.parentNode||(n instanceof "
    "ShadowRoot?n.host:null)}return false}";
inline constexpr char kPath[] =
    "function(){const a=[];let n=this;for(let i=0;n&&a.length<32&&i<4096;i++)"
    "{if(n.nodeType===1)a.push(n);"
    "n=n.assignedSlot||n.parentNode||(n instanceof "
    "ShadowRoot?n.host:null)}return a}";

struct HitProbeCounts {
  uint64_t hit_tests = 0;
  uint64_t hit_tests_failed = 0;
  uint64_t occluded = 0;
  uint64_t cancelled = 0;
  uint64_t remote_frames = 0;
  int in_flight = 0;
};

HitProbeCounts& ProbeCounts();

bool IsClickType(const std::string& type);

std::string Clipped(const std::string& text, size_t bytes);

bool IsDocumentElement(const std::string& name);

bool FrameInspectable(content::RenderFrameHost* frame);

bool ReachableFramesInspectable(content::WebContents* contents);

content::RenderFrameHost* FrameWithId(content::WebContents* contents,
                                      const std::string& frame_id);

const std::string* ObjectId(const base::DictValue& result);

std::pair<double, double> ScrollOf(const base::DictValue& metrics);

struct ProbeReply {
  int id = 0;
  std::optional<std::string> error;
  base::DictValue result;
};

std::optional<ProbeReply> ParseProbeReply(std::string_view message);

std::vector<std::string> AncestorObjects(const base::DictValue& properties,
                                         size_t limit);

}
}

#endif
