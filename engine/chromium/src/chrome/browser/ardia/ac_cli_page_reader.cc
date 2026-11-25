// Copyright 2026 Ardia. Apache-2.0.

#include "chrome/browser/ardia/ac_cli_page_reader.h"

#include <algorithm>
#include <set>
#include <utility>

#include "base/functional/bind.h"
#include "base/location.h"
#include "chrome/browser/ardia/ac_cli_ops.h"
#include "chrome/browser/ardia/ac_cli_tab_ops.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"

namespace ardia {
namespace {

constexpr base::TimeDelta kSessionPoll = base::Milliseconds(25);
constexpr int kMaxSessionPolls = 40;
constexpr size_t kMaxOwnersPerSession = 48;

std::string TokenOf(content::RenderFrameHost* frame) {
  return frame->GetDevToolsFrameToken().ToString();
}

const std::string* StringAt(const base::ListValue& strings,
                            const base::Value* index) {
  if (!index || !index->is_int() || index->GetInt() < 0 ||
      static_cast<size_t>(index->GetInt()) >= strings.size() ||
      !strings[index->GetInt()].is_string()) {
    return nullptr;
  }
  return &strings[index->GetInt()].GetString();
}

std::optional<gfx::RectF> RectAt(const base::ListValue* list, size_t at) {
  if (!list || at >= list->size() || !(*list)[at].is_list()) {
    return std::nullopt;
  }
  const base::ListValue& rect = (*list)[at].GetList();
  if (rect.size() != 4) {
    return std::nullopt;
  }
  for (const base::Value& value : rect) {
    if (!value.is_double() && !value.is_int()) {
      return std::nullopt;
    }
  }
  return gfx::RectF(rect[0].GetDouble(), rect[1].GetDouble(),
                    rect[2].GetDouble(), rect[3].GetDouble());
}

}

PageReader::PageReader(content::WebContents* contents,
                       CdpSession* probe,
                       const std::map<std::string, std::string>* children,
                       double scale)
    : content::WebContentsObserver(contents),
      contents_(contents),
      probe_(probe),
      children_(children),
      scale_(scale) {}

PageReader::~PageReader() = default;

void PageReader::DidFinishNavigation(content::NavigationHandle* navigation) {
  if (!navigation->HasCommitted() || navigation->IsSameDocument()) {
    return;
  }
  if (content::RenderFrameHost* frame = navigation->GetRenderFrameHost()) {
    stale_tokens_.insert(TokenOf(frame));
  }
}

void PageReader::Read(Done done) {
  done_ = std::move(done);
  if (!Plan()) {
    return Fail("this page can't be read");
  }
  WaitForSessions();
}

bool PageReader::Plan() {
  planned_.clear();
  truncated_ = false;
  content::RenderFrameHost* main = contents_->GetPrimaryMainFrame();
  if (!main || CliFrameRefused(main)) {
    return false;
  }
  const std::string main_token = TokenOf(main);
  std::map<std::string, int> index_of;
  main->ForEachRenderFrameHostWithAction([&](content::RenderFrameHost* frame) {
    if (planned_.size() >= kMaxPageFrames) {
      truncated_ = true;
      return content::RenderFrameHost::FrameIterationAction::kStop;
    }
    if (!frame->IsRenderFrameLive() || CliFrameRefused(frame)) {
      truncated_ = truncated_ || frame != main;
      return content::RenderFrameHost::FrameIterationAction::kSkipChildren;
    }
    Planned planned;
    planned.token = TokenOf(frame);
    content::RenderFrameHost* parent = frame->GetParentOrOuterDocument();
    if (parent) {
      auto found = index_of.find(TokenOf(parent));
      if (found == index_of.end()) {
        return content::RenderFrameHost::FrameIterationAction::kSkipChildren;
      }
      planned.parent = found->second;
    }
    content::RenderFrameHost* root = frame;
    while (root->GetParentOrOuterDocument() && !root->IsCrossProcessSubframe()) {
      root = root->GetParentOrOuterDocument();
    }
    planned.local_root = TokenOf(root);
    planned.reachable = planned.local_root == main_token;
    index_of[planned.token] = static_cast<int>(planned_.size());
    planned_tokens_.insert(planned.token);
    planned_.push_back(std::move(planned));
    return content::RenderFrameHost::FrameIterationAction::kContinue;
  });
  return !planned_.empty();
}

void PageReader::WaitForSessions() {
  const std::string& main_token = planned_[0].token;
  bool missing = false;
  for (Planned& planned : planned_) {
    if (planned.local_root == main_token) {
      continue;
    }
    auto found = children_->find(planned.local_root);
    planned.reachable = found != children_->end();
    planned.session = planned.reachable ? found->second : std::string();
    missing = missing || !planned.reachable;
  }
  if (missing && ++session_polls_ <= kMaxSessionPolls) {
    poll_.Start(FROM_HERE, kSessionPoll,
                base::BindOnce(&PageReader::WaitForSessions,
                               weak_factory_.GetWeakPtr()));
    return;
  }
  ReadMetrics();
}

void PageReader::ReadMetrics() {
  probe_->Send("Page.getLayoutMetrics", base::DictValue(),
               base::BindOnce(&PageReader::GotMetrics,
                              weak_factory_.GetWeakPtr()));
}

void PageReader::GotMetrics(CdpResult result) {
  const base::DictValue* visual =
      result.has_value() ? result->FindDict("cssVisualViewport") : nullptr;
  if (!visual) {
    return Fail("the page's viewport couldn't be read");
  }
  viewport_ = gfx::SizeF(visual->FindDouble("clientWidth").value_or(0),
                         visual->FindDouble("clientHeight").value_or(0));
  frames_.clear();
  frames_.resize(planned_.size());
  phase_ = 0;
  Step();
}

void PageReader::Step() {
  if (waiting_ > 0) {
    return;
  }
  switch (phase_++) {
    case 0: {
      std::set<std::string> sessions;
      for (const Planned& planned : planned_) {
        if (planned.reachable) {
          sessions.insert(planned.session);
        }
      }
      waiting_ = static_cast<int>(sessions.size());
      for (const std::string& session : sessions) {
        probe_->Send("DOMSnapshot.captureSnapshot",
                     base::DictValue()
                         .Set("computedStyles", base::ListValue())
                         .Set("includeDOMRects", true),
                     base::BindOnce(&PageReader::GotSnapshot,
                                    weak_factory_.GetWeakPtr(), session),
                     session);
      }
      break;
    }
    case 1: {
      for (size_t i = 0; i < planned_.size(); ++i) {
        if (!planned_[i].reachable) {
          continue;
        }
        ++waiting_;
        probe_->Send("Accessibility.getFullAXTree",
                     base::DictValue().Set("frameId", planned_[i].token),
                     base::BindOnce(&PageReader::GotTree,
                                    weak_factory_.GetWeakPtr(), i),
                     planned_[i].session);
      }
      break;
    }
    case 2: {
      for (size_t i = 1; i < planned_.size(); ++i) {
        const int parent = planned_[i].parent;
        if (!planned_[i].reachable || parent < 0 ||
            !planned_[parent].reachable) {
          continue;
        }
        ++waiting_;
        probe_->Send("DOM.getFrameOwner",
                     base::DictValue().Set("frameId", planned_[i].token),
                     base::BindOnce(&PageReader::GotFrameOwner,
                                    weak_factory_.GetWeakPtr(), i),
                     planned_[parent].session);
      }
      break;
    }
    case 3: {
      std::set<std::string> unresolved;
      for (size_t i = 1; i < planned_.size(); ++i) {
        const int parent = planned_[i].parent;
        if (planned_[i].reachable && parent >= 0 && !frames_[i].owner_dom) {
          unresolved.insert(planned_[parent].session);
        }
      }
      if (!unresolved.empty()) {
        for (const auto& [session, owners] : owners_by_session_) {
          if (!unresolved.contains(session)) {
            continue;
          }
          for (int owner : owners) {
            ++waiting_;
            probe_->Send("DOM.describeNode",
                         base::DictValue().Set("backendNodeId", owner),
                         base::BindOnce(&PageReader::GotOwner,
                                        weak_factory_.GetWeakPtr(), owner,
                                        session),
                         session);
          }
        }
      }
      break;
    }
    default:
      return Finish();
  }
  if (waiting_ == 0) {
    Step();
  }
}

void PageReader::GotSnapshot(std::string session, CdpResult result) {
  --waiting_;
  const base::ListValue* documents =
      result.has_value() ? result->FindList("documents") : nullptr;
  const base::ListValue* strings =
      result.has_value() ? result->FindList("strings") : nullptr;
  for (size_t d = 0; documents && strings && d < documents->size(); ++d) {
    const base::DictValue* document = (*documents)[d].GetIfDict();
    const std::string* frame =
        document ? StringAt(*strings, document->Find("frameId")) : nullptr;
    const base::DictValue* nodes =
        document ? document->FindDict("nodes") : nullptr;
    const base::DictValue* layout =
        document ? document->FindDict("layout") : nullptr;
    const base::ListValue* ids = nodes ? nodes->FindList("backendNodeId") : nullptr;
    if (!frame || !ids || !planned_tokens_.contains(*frame)) {
      continue;
    }
    DocRead read;
    if (const std::string* url =
            StringAt(*strings, document->Find("documentURL"))) {
      read.url = *url;
    }
    read.scroll = gfx::Vector2dF(document->FindDouble("scrollOffsetX").value_or(0),
                                 document->FindDouble("scrollOffsetY").value_or(0));
    const auto id_at = [&](const base::Value& index) {
      return index.is_int() && index.GetInt() >= 0 &&
                     static_cast<size_t>(index.GetInt()) < ids->size() &&
                     (*ids)[index.GetInt()].is_int()
                 ? (*ids)[index.GetInt()].GetInt()
                 : 0;
    };
    const base::ListValue* names = nodes->FindList("nodeName");
    const base::ListValue* attributes = nodes->FindList("attributes");
    std::vector<int>& owners = owners_by_session_[session];
    for (size_t i = 0; i < ids->size(); ++i) {
      const int id = (*ids)[i].is_int() ? (*ids)[i].GetInt() : 0;
      const std::string* name =
          names && i < names->size() ? StringAt(*strings, &(*names)[i]) : nullptr;
      if (name && (*name == "IFRAME" || *name == "FRAME") &&
          owners.size() < kMaxOwnersPerSession) {
        owners.push_back(id);
      }
      const base::ListValue* pairs =
          attributes && i < attributes->size() ? (*attributes)[i].GetIfList()
                                               : nullptr;
      for (size_t a = 0; pairs && a + 1 < pairs->size(); a += 2) {
        const std::string* key = StringAt(*strings, &(*pairs)[a]);
        const std::string* value = StringAt(*strings, &(*pairs)[a + 1]);
        if (key && value &&
            ((*key == "type" && base::EqualsCaseInsensitiveASCII(*value, "password")) ||
             (*key == "autocomplete" && SensitiveAutocomplete(*value)))) {
          read.sensitive.insert(id);
        }
      }
    }
    if (const base::DictValue* clickable = nodes->FindDict("isClickable")) {
      if (const base::ListValue* indexes = clickable->FindList("index")) {
        for (const base::Value& index : *indexes) {
          read.clickable.insert(id_at(index));
        }
      }
    }
    std::map<int, size_t> node_of;
    for (size_t i = 0; i < ids->size(); ++i) {
      if ((*ids)[i].is_int()) {
        node_of.emplace((*ids)[i].GetInt(), i);
      }
    }
    const auto id_index = [&](int id) {
      auto found = node_of.find(id);
      return found == node_of.end() ? ids->size() : found->second;
    };
    const base::ListValue* layout_nodes =
        layout ? layout->FindList("nodeIndex") : nullptr;
    const base::ListValue* bounds = layout ? layout->FindList("bounds") : nullptr;
    const base::ListValue* client = layout ? layout->FindList("clientRects") : nullptr;
    for (size_t k = 0; layout_nodes && k < layout_nodes->size(); ++k) {
      const int id = id_at((*layout_nodes)[k]);
      std::optional<gfx::RectF> rect = RectAt(bounds, k);
      if (id <= 0 || !rect) {
        continue;
      }
      auto [it, added] = read.rects.emplace(id, *rect);
      if (!added) {
        it->second.Union(*rect);
      }
      if (std::optional<gfx::RectF> inner = RectAt(client, k)) {
        read.client.emplace(id, *inner);
      }
      if (read.frame_size.IsEmpty() && names &&
          static_cast<size_t>(id_index(id)) < names->size()) {
        const std::string* name = StringAt(*strings, &(*names)[id_index(id)]);
        if (name && *name == "#document") {
          read.frame_size = rect->size();
        }
      }
    }
    read.classified = !ids->empty() && names && names->size() == ids->size() &&
                      attributes && attributes->size() == ids->size() &&
                      layout_nodes && !layout_nodes->empty() && bounds &&
                      bounds->size() == layout_nodes->size() && !read.url.empty() &&
                      !read.rects.empty();
    docs_[*frame] = std::move(read);
  }
  Step();
}

void PageReader::GotTree(size_t frame, CdpResult result) {
  --waiting_;
  if (result.has_value()) {
    if (base::ListValue* nodes = result->FindList("nodes")) {
      frames_[frame].ax_nodes = std::move(*nodes);
    }
  }
  Step();
}

void PageReader::GotFrameOwner(size_t frame, CdpResult result) {
  --waiting_;
  if (result.has_value()) {
    frames_[frame].owner_dom = result->FindInt("backendNodeId").value_or(0);
  }
  Step();
}

void PageReader::GotOwner(int owner, std::string session, CdpResult result) {
  --waiting_;
  const base::DictValue* node =
      result.has_value() ? result->FindDict("node") : nullptr;
  const std::string* frame = node ? node->FindString("frameId") : nullptr;
  for (size_t i = 1; frame && i < planned_.size(); ++i) {
    const int parent = planned_[i].parent;
    if (planned_[i].token == *frame && parent >= 0 && !frames_[i].owner_dom &&
        planned_[parent].session == session) {
      frames_[i].owner_dom = owner;
    }
  }
  Step();
}

void PageReader::Finish() {
  for (size_t i = 0; i < planned_.size(); ++i) {
    frames_[i].token = planned_[i].token;
    frames_[i].parent = planned_[i].parent;
    if (stale_tokens_.contains(planned_[i].token)) {
      if (i == 0) {
        return Fail("the page navigated while Ardia read it");
      }
      frames_[i].ax_nodes.clear();
      truncated_ = true;
    }
    content::RenderFrameHost* live = FrameWithToken(contents_, planned_[i].token);
    if (!live || CliFrameRefused(live)) {
      if (i == 0) {
        return Fail("this page can't be read");
      }
      frames_[i].ax_nodes.clear();
      truncated_ = true;
    }
  }
  std::string error;
  std::optional<PageModel> model =
      BuildPageModel(frames_, docs_, scale_, viewport_, &error);
  if (!model) {
    return Fail(error);
  }
  for (size_t i = 0; i < planned_.size() && i < model->frames.size(); ++i) {
    model->frames[i].local_root = planned_[i].local_root;
    model->frames[i].session = planned_[i].session;
    model->frames[i].reachable = planned_[i].reachable;
  }
  model->frames_truncated = model->frames_truncated || truncated_;
  std::move(done_).Run(std::move(*model));
}

void PageReader::Fail(const std::string& why) {
  if (done_) {
    std::move(done_).Run(base::unexpected(why));
  }
}

}
