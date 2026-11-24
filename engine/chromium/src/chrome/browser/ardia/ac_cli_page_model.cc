// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_page_model.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <set>
#include <string_view>
#include <tuple>
#include <utility>

#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/stringprintf.h"
#include "base/hash/hash.h"

namespace ardia {
namespace {

constexpr size_t kMaxNameBytes = 200;
constexpr size_t kMaxItems = 20000;

constexpr auto kInteractiveRoles = std::to_array<std::string_view>({
    "button",         "checkbox",          "combobox",    "link",
    "menuitem",       "menuitemcheckbox",  "menuitemradio", "option",
    "radio",          "searchbox",         "slider",      "spinbutton",
    "switch",         "tab",               "textbox",     "treeitem",
    "PopUpButton",    "ToggleButton",      "DisclosureTriangle",
    "ColorWell",      "Date",              "DateTime",    "InputTime",
    "ComboBoxSelect", "ComboBoxMenuButton", "MenuListOption",
});

constexpr auto kStructuralRoles = std::to_array<std::string_view>({
    "heading", "dialog", "alertdialog", "alert", "main", "navigation",
    "banner", "contentinfo", "search", "complementary",
});

constexpr auto kNamedStructuralRoles =
    std::to_array<std::string_view>({"form", "region", "img", "image",
                                     "figure"});

constexpr auto kEditableRoles = std::to_array<std::string_view>({
    "textbox", "searchbox", "combobox", "spinbutton", "TextFieldWithComboBox",
});

constexpr auto kNonInteractiveContainers = std::to_array<std::string_view>({
    "RootWebArea", "StaticText", "InlineTextBox", "LineBreak", "Iframe",
    "IframePresentational",
});

template <size_t N>
bool In(const std::array<std::string_view, N>& list, std::string_view value) {
  return std::find(list.begin(), list.end(), value) != list.end();
}

std::string Lowered(const std::string& text) {
  return base::ToLowerASCII(base::TrimWhitespaceASCII(text, base::TRIM_ALL));
}

bool Contains(const std::string& text, std::string_view part) {
  return text.find(part) != std::string::npos;
}

std::string ValueText(const base::DictValue* holder, std::string_view key) {
  const base::DictValue* field = holder ? holder->FindDict(key) : nullptr;
  const base::Value* value = field ? field->Find("value") : nullptr;
  if (!value) {
    return std::string();
  }
  if (value->is_string()) {
    return value->GetString();
  }
  if (value->is_bool()) {
    return value->GetBool() ? "true" : "false";
  }
  if (value->is_int()) {
    return base::NumberToString(value->GetInt());
  }
  return std::string();
}

std::map<std::string, std::string> Properties(const base::DictValue& node) {
  std::map<std::string, std::string> out;
  if (const base::ListValue* list = node.FindList("properties")) {
    for (const base::Value& property : *list) {
      const base::DictValue* dict = property.GetIfDict();
      const std::string* name = dict ? dict->FindString("name") : nullptr;
      if (name) {
        out[*name] = ValueText(dict, "value");
      }
    }
  }
  return out;
}

}

bool SensitiveAutocomplete(std::string_view value) {
  for (const std::string& token :
       base::SplitString(base::ToLowerASCII(value), " \t\n\r\f",
                         base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    if (token.starts_with("cc-") || token == "one-time-code" ||
        token == "current-password" || token == "new-password") {
      return true;
    }
  }
  return false;
}

std::string ClippedUtf8(const std::string& text, size_t bytes) {
  std::string out;
  base::TruncateUTF8ToByteSize(text, bytes, &out);
  return out;
}

bool PageModel::IsAncestor(int ancestor, int item) const {
  for (int at = item; at >= 0; at = items[at].parent) {
    if (at == ancestor) {
      return true;
    }
  }
  return false;
}

int PageModel::Find(int frame, int dom) const {
  if (dom <= 0) {
    return -1;
  }
  auto it = by_dom.find({frame, dom});
  return it == by_dom.end() ? -1 : it->second;
}

int PageModel::FrameWithToken(const std::string& token) const {
  for (size_t i = 0; i < frames.size(); ++i) {
    if (!token.empty() && frames[i].token == token) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

int PageModel::ChildFrameOfHost(int host) const {
  for (size_t i = 1; i < frames.size(); ++i) {
    if (frames[i].host == host) {
      return static_cast<int>(i);
    }
  }
  return -1;
}

bool PageModel::InViewport(int item) const {
  const AxItem& data = items[item];
  if (data.offscreen || data.box.IsEmpty()) {
    return false;
  }
  gfx::RectF visible = data.visible;
  visible.Intersect(gfx::RectF(viewport));
  return visible.width() >= 1 && visible.height() >= 1;
}

gfx::PointF PageModel::ClickPoint(int item) const {
  gfx::RectF visible = items[item].visible;
  visible.Intersect(gfx::RectF(viewport));
  if (visible.IsEmpty()) {
    visible = items[item].box;
  }
  return visible.CenterPoint();
}

std::optional<PageModel> BuildPageModel(const std::vector<FrameRead>& frames,
                                        const std::map<std::string, DocRead>& docs,
                                        double scale,
                                        gfx::SizeF viewport,
                                        std::string* error) {
  if (frames.empty() || frames[0].ax_nodes.empty()) {
    *error = "the page has no accessibility tree yet";
    return std::nullopt;
  }
  PageModel model;
  model.scale = scale > 0 ? scale : 1.0;
  model.viewport = viewport;
  struct FrameIndex {
    std::map<std::string, const base::DictValue*> nodes;
    const base::DictValue* root = nullptr;
  };
  std::vector<FrameIndex> indexes(frames.size());
  std::map<std::pair<int, int>, int> owned;
  for (size_t f = 0; f < frames.size(); ++f) {
    AxFrame frame;
    frame.token = frames[f].token;
    frame.parent = frames[f].parent;
    model.frames.push_back(frame);
    for (const base::Value& value : frames[f].ax_nodes) {
      const base::DictValue* node = value.GetIfDict();
      const std::string* id = node ? node->FindString("nodeId") : nullptr;
      if (!id) {
        continue;
      }
      indexes[f].nodes[*id] = node;
      if (!indexes[f].root && !node->FindString("parentId")) {
        indexes[f].root = node;
      }
    }
    if (f > 0 && frames[f].parent >= 0 && frames[f].owner_dom > 0) {
      owned[{frames[f].parent, frames[f].owner_dom}] = static_cast<int>(f);
    }
  }
  if (!indexes[0].root) {
    *error = "the page has no accessibility tree yet";
    return std::nullopt;
  }
  std::vector<const DocRead*> frame_docs(frames.size(), nullptr);
  std::vector<bool> skipped(frames.size(), false);
  for (size_t f = 0; f < frames.size(); ++f) {
    if (!indexes[f].root) {
      continue;
    }
    auto found = docs.find(model.frames[f].token);
    const DocRead* doc = found == docs.end() ? nullptr : &found->second;
    const std::map<std::string, std::string> root_props =
        Properties(*indexes[f].root);
    auto url = root_props.find("url");
    const bool ax_known = url != root_props.end() && !url->second.empty();
    const bool dom_known = doc && !doc->url.empty();
    const bool same = ax_known && dom_known && url->second == doc->url;
    if (f > 0 && !same) {
      skipped[f] = true;
      model.frames_truncated = true;
      continue;
    }
    if (f == 0 && ax_known && dom_known && !same) {
      *error = "the page changed while Ardia read it";
      return std::nullopt;
    }
    if (same && doc->classified) {
      frame_docs[f] = doc;
    }
  }
  std::vector<gfx::Vector2dF> origins(frames.size());
  std::vector<float> zooms(frames.size(), 1.0f);
  std::vector<gfx::RectF> clips(frames.size());
  clips[0] = gfx::RectF(viewport);
  struct Pending {
    const base::DictValue* node;
    int parent;
    int depth;
    int frame;
    bool secret;
  };
  std::vector<Pending> stack{{indexes[0].root, -1, 0, 0, false}};
  while (!stack.empty() && model.items.size() < kMaxItems) {
    const Pending at = stack.back();
    stack.pop_back();
    const base::DictValue& node = *at.node;
    const int index = static_cast<int>(model.items.size());
    const DocRead* doc = frame_docs[at.frame];
    AxItem item;
    item.parent = at.parent;
    item.depth = at.depth;
    item.frame = at.frame;
    item.dom = node.FindInt("backendDOMNodeId").value_or(0);
    item.role = ValueText(&node, "role");
    const std::map<std::string, std::string> early_props = Properties(node);
    const std::map<std::string, std::string>& props = early_props;
    const bool unclassified = !doc;
    const bool editable = In(kEditableRoles, item.role) ||
                          early_props.contains("editable");
    const bool sensitive =
        (doc && item.dom > 0 && doc->sensitive.contains(item.dom)) ||
        (unclassified && editable);
    item.redacted = sensitive;
    if (!at.secret) {
      item.name = ClippedUtf8(ValueText(&node, "name"), kMaxNameBytes);
    }
    if (!at.secret && !sensitive && !unclassified) {
      item.value = ClippedUtf8(ValueText(&node, "value"), kMaxNameBytes);
    }
    if (doc && item.dom > 0) {
      auto rect = doc->rects.find(item.dom);
      if (rect != doc->rects.end()) {
        gfx::RectF box = rect->second;
        box.Offset(-doc->scroll.x(), -doc->scroll.y());
        box.Scale(static_cast<float>(zooms[at.frame] / model.scale));
        box.Offset(origins[at.frame]);
        item.box = box;
      }
    }
    item.visible = item.box;
    item.visible.Intersect(clips[at.frame]);
    item.offscreen = item.visible.IsEmpty();
    item.hidden = node.FindBool("ignored").value_or(false) || at.secret;
    item.disabled = props.contains("disabled") && props.at("disabled") == "true";
    item.focused = props.contains("focused") && props.at("focused") == "true";
    const std::string checked = props.contains("checked") ? props.at("checked")
                                : props.contains("pressed") ? props.at("pressed")
                                                            : std::string();
    item.checked = checked == "true" ? 1 : checked == "false" ? 0
                   : checked == "mixed" ? 2 : -1;
    if (props.contains("expanded")) {
      item.expanded = props.at("expanded") == "true" ? 1 : 0;
    }
    item.modal = (item.role == "dialog" || item.role == "alertdialog") &&
                 props.contains("modal") && props.at("modal") == "true";
    const bool clickable = doc && item.dom > 0 && doc->clickable.contains(item.dom);
    const float area = item.box.width() * item.box.height();
    const bool large = area >= 0.5f * viewport.width() * viewport.height();
    item.interactive =
        In(kInteractiveRoles, item.role) ||
        (clickable && !In(kNonInteractiveContainers, item.role) &&
         !(item.role == "generic" && large));
    item.structural = In(kStructuralRoles, item.role) ||
                      (In(kNamedStructuralRoles, item.role) && !item.name.empty());
    item.text = item.role == "StaticText" && !item.name.empty();
    if (item.focused) {
      model.focus = index;
    }
    if (item.dom > 0) {
      model.by_dom.emplace(std::make_pair(item.frame, item.dom), index);
    }
    if (at.parent >= 0) {
      model.items[at.parent].children.push_back(index);
    }
    if (item.role == "RootWebArea" && at.frame > 0 &&
        model.frames[at.frame].root == 0) {
      model.frames[at.frame].root = index;
    }
    const bool secret = at.secret || sensitive;
    std::vector<Pending> children;
    if (const base::ListValue* ids = node.FindList("childIds")) {
      for (const base::Value& id : *ids) {
        auto child = id.is_string() ? indexes[at.frame].nodes.find(id.GetString())
                                    : indexes[at.frame].nodes.end();
        if (child != indexes[at.frame].nodes.end()) {
          children.push_back({child->second, index, at.depth + 1, at.frame, secret});
        }
      }
    }
    auto hosted = item.dom > 0 ? owned.find({at.frame, item.dom}) : owned.end();
    if (hosted != owned.end() && indexes[hosted->second].root &&
        !skipped[hosted->second]) {
      const int child_frame = hosted->second;
      item.frame_host = true;
      model.frames[child_frame].host = index;
      gfx::RectF client;
      if (doc) {
        auto found = doc->client.find(item.dom);
        if (found != doc->client.end()) {
          client = found->second;
        }
      }
      const float layout_width = client.width() + 2 * client.x();
      const float parent_zoom = zooms[at.frame];
      float zoom =
          layout_width > 0 ? item.box.width() / layout_width : parent_zoom;
      if (!(zoom > 0.01f) || std::abs(zoom / parent_zoom - 1.0f) < 0.01f) {
        zoom = parent_zoom;
      }
      zooms[child_frame] = zoom;
      origins[child_frame] = gfx::Vector2dF(item.box.x() + client.x() * zoom,
                                            item.box.y() + client.y() * zoom);
      model.frames[child_frame].origin = origins[child_frame];
      model.frames[child_frame].zoom = zooms[child_frame];
      clips[child_frame] = item.visible;
      children.push_back(
          {indexes[child_frame].root, index, at.depth + 1, child_frame, secret});
    }
    model.items.push_back(std::move(item));
    for (auto it = children.rbegin(); it != children.rend(); ++it) {
      stack.push_back(*it);
    }
  }
  model.items_truncated = !stack.empty();
  for (size_t f = 1; f < model.frames.size(); ++f) {
    if (model.frames[f].host < 0) {
      model.frames_truncated = true;
    }
  }
  for (size_t i = 0; i < model.items.size(); ++i) {
    const AxItem& item = model.items[i];
    if (item.modal && !item.hidden && !item.visible.IsEmpty()) {
      model.modal = static_cast<int>(i);
    }
  }
  return model;
}

std::string Fingerprint(const AxItem& item) {
  const std::string key = base::StrCat({item.role, "\n", item.name});
  const uint32_t hash = base::PersistentHash(key);
  return base::StringPrintf("%08x", hash);
}

int BlockerOf(const PageModel& model, int hit, int target) {
  if (hit < 0 || target < 0 || model.IsAncestor(target, hit)) {
    return -1;
  }
  std::set<int> chain;
  for (int at = target; at >= 0; at = model.items[at].parent) {
    chain.insert(at);
  }
  int last = hit;
  for (int at = hit; at >= 0 && !chain.contains(at);
       at = model.items[at].parent) {
    last = at;
  }
  return last;
}

std::vector<DismissChoice> DismissChoices(const PageModel& model,
                                          int layer,
                                          size_t limit) {
  std::vector<DismissChoice> found;
  if (layer < 0) {
    return found;
  }
  std::vector<int> stack{layer};
  size_t visited = 0;
  while (!stack.empty() && visited < 4000) {
    const int at = stack.back();
    stack.pop_back();
    ++visited;
    const AxItem& item = model.items[at];
    for (auto it = item.children.rbegin(); it != item.children.rend(); ++it) {
      stack.push_back(*it);
    }
    if (!item.interactive || item.hidden || item.disabled ||
        item.box.IsEmpty()) {
      continue;
    }
    if (item.role != "button" && item.role != "link" &&
        item.role != "menuitem" && item.role != "ToggleButton") {
      continue;
    }
    const std::string name = Lowered(item.name);
    if (name.empty()) {
      continue;
    }
    DismissChoice choice;
    choice.item = at;
    if (name == "x" || name == "\xC3\x97" || name == "\xE2\x9C\x95" ||
        name == "\xE2\x9C\x96" || name == "\xE2\x95\xB3" ||
        Contains(name, "close") || Contains(name, "dismiss") ||
        name == "no thanks" || name == "no, thanks" || name == "not now" ||
        name == "skip" || name == "maybe later" || name == "later" ||
        name == "cancel") {
      choice.kind = "close";
      choice.score = 30;
    } else if (Contains(name, "reject") || Contains(name, "decline") ||
               Contains(name, "deny") || Contains(name, "only necessary") ||
               Contains(name, "necessary only") ||
               Contains(name, "essential only") || Contains(name, "refuse") ||
               Contains(name, "disagree")) {
      choice.kind = "reject";
      choice.score = 20;
    } else if (Contains(name, "accept") || Contains(name, "agree") ||
               Contains(name, "allow") || name == "got it" || name == "ok" ||
               name == "okay" || Contains(name, "i understand") ||
               name == "continue" || Contains(name, "consent") ||
               name == "understood") {
      choice.kind = "accept";
      choice.score = 10;
    } else {
      continue;
    }
    if (item.role == "button") {
      choice.score += 2;
    }
    found.push_back(choice);
  }
  std::stable_sort(found.begin(), found.end(),
                   [](const DismissChoice& a, const DismissChoice& b) {
                     return a.score > b.score;
                   });
  if (found.size() > limit) {
    found.resize(limit);
  }
  return found;
}

base::ListValue BoxValue(const gfx::RectF& box) {
  return base::ListValue()
      .Append(std::round(box.x() * 10) / 10)
      .Append(std::round(box.y() * 10) / 10)
      .Append(std::round(box.width() * 10) / 10)
      .Append(std::round(box.height() * 10) / 10);
}
}
