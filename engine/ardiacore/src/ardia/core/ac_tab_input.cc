// Copyright 2026 Ardia. Apache-2.0.

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/functional/callback_helpers.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/scoped_observation.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "ardia/core/ac_tab_input_internal.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/render_widget_host.h"
#include "content/public/browser/render_widget_host_observer.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "content/public/browser/weak_document_ptr.h"
#include "third_party/blink/public/common/input/web_input_event.h"
#include "third_party/blink/public/common/input/web_mouse_event.h"
#include "third_party/blink/public/common/input/web_mouse_wheel_event.h"
#include "ui/gfx/geometry/size.h"

namespace ardiacore {
namespace {

using blink::WebInputEvent;
using blink::WebMouseEvent;
using blink::WebMouseWheelEvent;
using tab_input_internal::Build;
using tab_input_internal::Built;
using tab_input_internal::NextStamp;
using tab_input_internal::Prepared;
using tab_input_internal::Refusal;
using tab_input_internal::Target;
using tab_input_internal::TargetOf;
using tab_input_internal::Viewport;

constexpr base::TimeDelta kAckDeadline = base::Seconds(2);
constexpr base::TimeDelta kPaintHold = base::Seconds(3);
constexpr base::TimeDelta kFirstFrameDeadline = base::Seconds(1);

struct Binding {
  content::WeakDocumentPtr main;
  content::WeakDocumentPtr focused;
  bool keyboard = false;
};

content::RenderFrameHost* FocusedOrMain(content::WebContents* contents) {
  content::RenderFrameHost* focused = contents->GetFocusedFrame();
  return focused ? focused : contents->GetPrimaryMainFrame();
}

class PaintHold : public content::WebContentsObserver,
                  public content::WebContentsUserData<PaintHold> {
 public:
  ~PaintHold() override = default;

  bool painting() const {
    return capture_ && painted_.AsRenderFrameHostIfValid() &&
           painted_.AsRenderFrameHostIfValid() == GetWebContents().GetPrimaryMainFrame();
  }

  int held() const { return held_; }
  bool transitioning() const { return transitioning_; }
  bool has_binding_room() const { return bindings_.size() < kMaxBindings; }
  uint64_t page_generation() const { return page_generation_; }
  void BeginTransition() { transitioning_ = true; }

  void EndTransition(uint64_t generation, int flag, bool pressing, bool acked) {
    transitioning_ = false;
    if (!acked || generation != page_generation_) {
      return;
    }
    held_ = pressing ? (held_ | flag) : (held_ & ~flag);
  }

  void Renew() {
    if (!capture_) {
      capture_ = GetWebContents().IncrementCapturerCount(
          gfx::Size(), true, false, false);
    }
    release_.Start(FROM_HERE, kPaintHold,
                   base::BindOnce(&PaintHold::Release, base::Unretained(this)));
  }

  int Bind(bool keyboard) {
    content::WebContents& contents = GetWebContents();
    if (bindings_.size() >= kMaxBindings) {
      return 0;
    }
    static int last_token = 0;
    const int token = ++last_token;
    bindings_.emplace(token, Binding{contents.GetPrimaryMainFrame()->GetWeakDocumentPtr(),
                                     FocusedOrMain(&contents)->GetWeakDocumentPtr(), keyboard});
    return token;
  }

  bool TakeBinding(int token, bool keyboard) {
    auto found = bindings_.find(token);
    if (found == bindings_.end()) {
      return false;
    }
    const Binding binding = found->second;
    bindings_.erase(found);
    content::WebContents& contents = GetWebContents();
    if (binding.keyboard != keyboard ||
        binding.main.AsRenderFrameHostIfValid() != contents.GetPrimaryMainFrame()) {
      return false;
    }
    return !keyboard || binding.focused.AsRenderFrameHostIfValid() == FocusedOrMain(&contents);
  }

  void WhenPainted(base::OnceCallback<void(bool)> done) {
    Renew();
    if (painting()) {
      return std::move(done).Run(true);
    }
    content::RenderFrameHost* primary = GetWebContents().GetPrimaryMainFrame();
    if (!waiting_.empty() && pending_.AsRenderFrameHostIfValid() != primary) {
      Settle(request_, false);
    }
    waiting_.push_back(std::move(done));
    if (waiting_.size() > 1) {
      return;
    }
    pending_ = primary ? primary->GetWeakDocumentPtr() : content::WeakDocumentPtr();
    const uint64_t request = ++request_;
    first_frame_.Start(FROM_HERE, kFirstFrameDeadline,
                       base::BindOnce(&PaintHold::Settle, base::Unretained(this), request, false));
    content::RenderFrameHost* main = GetWebContents().GetPrimaryMainFrame();
    if (main && main->IsRenderFrameLive()) {
      main->InsertVisualStateCallback(base::BindOnce(
          &PaintHold::Painted, weak_factory_.GetWeakPtr(), request, main->GetWeakDocumentPtr()));
    }
  }

 private:
  friend class content::WebContentsUserData<PaintHold>;

  explicit PaintHold(content::WebContents* contents)
      : content::WebContentsObserver(contents),
        content::WebContentsUserData<PaintHold>(*contents) {}

  void PrimaryPageChanged(content::Page& page) override {
    ++page_generation_;
    held_ = 0;
    painted_ = content::WeakDocumentPtr();
    bindings_.clear();
    Settle(request_, false);
  }

  void Painted(uint64_t request, content::WeakDocumentPtr document, bool painted) {
    if (!painted || !capture_ || request != request_ ||
        document.AsRenderFrameHostIfValid() != GetWebContents().GetPrimaryMainFrame()) {
      return;
    }
    painted_ = document;
    Settle(request, true);
  }

  void Settle(uint64_t request, bool painted) {
    if (request != request_) {
      return;
    }
    ++request_;
    first_frame_.Stop();
    std::vector<base::OnceCallback<void(bool)>> ready;
    ready.swap(waiting_);
    for (base::OnceCallback<void(bool)>& done : ready) {
      std::move(done).Run(painted);
    }
  }

  void Release() {
    Settle(request_, false);
    capture_.RunAndReset();
    painted_ = content::WeakDocumentPtr();
    bindings_.clear();
  }

  static constexpr size_t kMaxBindings = 16;

  base::ScopedClosureRunner capture_;
  base::OneShotTimer release_;
  base::OneShotTimer first_frame_;
  content::WeakDocumentPtr painted_;
  content::WeakDocumentPtr pending_;
  int held_ = 0;
  bool transitioning_ = false;
  uint64_t page_generation_ = 0;
  uint64_t request_ = 0;
  std::map<int, Binding> bindings_;
  std::vector<base::OnceCallback<void(bool)>> waiting_;
  base::WeakPtrFactory<PaintHold> weak_factory_{this};

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

WEB_CONTENTS_USER_DATA_KEY_IMPL(PaintHold);

class AckWaiter : public content::RenderWidgetHost::InputEventObserver,
                  public content::RenderWidgetHostObserver {
 public:
  AckWaiter(content::RenderWidgetHost* host,
            WebInputEvent::Type awaited,
            base::TimeTicks stamp,
            std::optional<base::TimeTicks> merged_stamp,
            base::DictValue reply,
            ardia::Reply out,
            base::OnceCallback<void(bool)> settled)
      : host_(host),
        awaited_(awaited),
        stamp_(stamp),
        merged_stamp_(merged_stamp),
        reply_(std::move(reply)),
        out_(std::move(out)),
        settled_(std::move(settled)) {
    host_->AddInputEventObserver(this);
    observation_.Observe(host_);
    deadline_.Start(FROM_HERE, kAckDeadline,
                    base::BindOnce(&AckWaiter::Finish, base::Unretained(this), false));
  }

  AckWaiter(const AckWaiter&) = delete;
  AckWaiter& operator=(const AckWaiter&) = delete;
  ~AckWaiter() override = default;

  void OnInputEventAck(const content::RenderWidgetHost&,
                       blink::mojom::InputEventResultSource source,
                       blink::mojom::InputEventResultState,
                       const WebInputEvent& event) override {
    if (event.GetType() != awaited_) {
      return;
    }
    bool ours = event.TimeStamp() == stamp_;
    if (!ours && merged_stamp_ && event.TimeStamp() == *merged_stamp_ &&
        event.GetType() == WebInputEvent::Type::kMouseWheel) {
      const auto& wheel = static_cast<const WebMouseWheelEvent&>(event);
      ours = wheel.delta_x != 0 || wheel.delta_y != 0;
    }
    if (ours) {
      Finish(source != blink::mojom::InputEventResultSource::kBrowser);
    }
  }

  void RenderWidgetHostDestroyed(content::RenderWidgetHost*) override {
    Finish(false);
  }

 private:
  void Finish(bool acked) {
    if (!host_) {
      return;
    }
    host_->RemoveInputEventObserver(this);
    observation_.Reset();
    host_ = nullptr;
    deadline_.Stop();
    if (settled_) {
      std::move(settled_).Run(acked);
    }
    reply_.Set("acked", acked);
    out_.Send(std::move(reply_));
    base::SequencedTaskRunner::GetCurrentDefault()->DeleteSoon(FROM_HERE, this);
  }

  raw_ptr<content::RenderWidgetHost> host_;
  WebInputEvent::Type awaited_;
  base::TimeTicks stamp_;
  std::optional<base::TimeTicks> merged_stamp_;
  base::DictValue reply_;
  ardia::Reply out_;
  base::OnceCallback<void(bool)> settled_;
  base::OneShotTimer deadline_;
  base::ScopedObservation<content::RenderWidgetHost,
                          content::RenderWidgetHostObserver>
      observation_{this};
};

content::RenderWidgetHost* CurrentWidget(const base::WeakPtr<content::WebContents>& weak, bool focused_frame) {
  std::optional<Target> target = TargetOf(weak.get(), focused_frame);
  return target ? target->widget.get() : nullptr;
}

void Primed(base::WeakPtr<content::WebContents> weak, bool keyboard, ardia::Reply out, bool painted) {
  PaintHold* hold = weak ? PaintHold::FromWebContents(weak.get()) : nullptr;
  if (!painted || !hold) {
    return out.Send(base::DictValue().Set("ok", true).Set("painted", false));
  }
  const int token = hold->Bind(keyboard);
  if (!token) {
    return out.Send(Refusal("busy", "Too many inputs are waiting for this tab; try again."));
  }
  out.Send(base::DictValue().Set("ok", true).Set("painted", true).Set("token", token));
}

void EndTransition(base::WeakPtr<content::WebContents> weak,
                   uint64_t generation,
                   int flag,
                   bool pressing,
                   bool acked) {
  PaintHold* hold = weak ? PaintHold::FromWebContents(weak.get()) : nullptr;
  if (hold) {
    hold->EndTransition(generation, flag, pressing, acked);
  }
}

void Dispatch(content::WebContents* contents,
              Prepared prepared,
              ardia::Reply out,
              base::OnceCallback<void(bool)> settled) {
  const base::WeakPtr<content::WebContents> weak = contents->GetWeakPtr();
  content::RenderWidgetHost* widget = prepared.target.widget;
  base::DictValue reply = base::DictValue().Set("ok", true).Set("viewport", Viewport(prepared.target));
  std::optional<WebMouseWheelEvent> end;
  if (prepared.wheel) {
    end = *prepared.wheel;
    end->SetTimeStamp(NextStamp());
    end->delta_x = 0;
    end->delta_y = 0;
    end->wheel_ticks_x = 0;
    end->wheel_ticks_y = 0;
    end->phase = WebMouseWheelEvent::kPhaseEnded;
    end->dispatch_type = WebInputEvent::DispatchType::kEventNonBlocking;
  }
  if (prepared.awaited) {
    new AckWaiter(widget, *prepared.awaited, prepared.stamp,
                  end ? std::optional<base::TimeTicks>(end->TimeStamp()) : std::nullopt,
                  std::move(reply), std::move(out), std::move(settled));
  }
  widget->Focus();
  const auto same = [&] { return CurrentWidget(weak, prepared.focused_frame) == widget; };
  for (const WebMouseEvent& event : prepared.mice) {
    if (!same()) {
      return;
    }
    widget->ForwardMouseEvent(event);
  }
  if (prepared.wheel && same()) {
    widget->ForwardWheelEvent(*prepared.wheel);
    if (same()) {
      widget->ForwardWheelEvent(*end);
    }
  }
  for (const input::NativeWebKeyboardEvent& event : prepared.keys) {
    if (!same()) {
      return;
    }
    widget->ForwardKeyboardEvent(event);
  }
  if (!prepared.awaited) {
    if (!prepared.text.empty() && weak) {
      weak->InsertText(prepared.text);
    }
    reply.Set("acked", false);
    reply.Set("sent", true);
    out.Send(std::move(reply));
  }
}

}
}

AC_ARGS_CALL(ac_tab_input) {
  ardia::Reply out = call.TakeReply();
  const base::DictValue& args = call.args();
  std::optional<int> tab = args.FindInt("tab");
  content::WebContents* contents = tab ? ardia::TabWithId(*tab) : nullptr;
  if (!contents) {
    return out.Send(ardiacore::tab_input_internal::Refusal("no_page", "That tab has no page loaded."));
  }
  if (contents->GetBrowserContext()->IsOffTheRecord()) {
    return out.Send(ardiacore::tab_input_internal::Refusal("private", "Private tabs take no input from programs."));
  }
  const base::Value* prime_value = args.Find("prime");
  const base::Value* token_value = args.Find("token");
  const std::string* action = args.FindString("action");
  const bool priming = prime_value && prime_value->is_bool() && prime_value->GetBool();
  const bool keyboard = action && (*action == "key" || *action == "text");
  ardiacore::PaintHold::CreateForWebContents(contents);
  ardiacore::PaintHold* hold = ardiacore::PaintHold::FromWebContents(contents);
  const bool bound = !priming && token_value && token_value->is_int() &&
                     hold->TakeBinding(token_value->GetInt(), keyboard);
  if ((prime_value && !prime_value->is_bool()) || (token_value && !token_value->is_int())) {
    return out.Send(ardiacore::tab_input_internal::Refusal("bad_request", "prime must be a boolean and token a whole number."));
  }
  if (priming && token_value) {
    return out.Send(ardiacore::tab_input_internal::Refusal("bad_request", "A prime takes no token."));
  }
  if (!action) {
    return out.Send(ardiacore::tab_input_internal::Refusal("bad_request", "action is required."));
  }
  const bool button_transition = *action == "down" || *action == "up" || *action == "click" || *action == "dblclick";
  if (button_transition && hold->transitioning()) {
    return out.Send(ardiacore::tab_input_internal::Refusal("busy", "A press or release is still reaching this tab; wait for its answer and send this again."));
  }
  ardiacore::tab_input_internal::Built built =
      ardiacore::tab_input_internal::Build(contents, args, *action, hold->held());
  if (!built.has_value()) {
    return out.Send(std::move(built.error()));
  }
  if (priming) {
    if (!hold->has_binding_room()) {
      return out.Send(ardiacore::tab_input_internal::Refusal("busy", "Too many inputs are waiting for this tab; try again."));
    }
    return hold->WhenPainted(base::BindOnce(&ardiacore::Primed, contents->GetWeakPtr(), keyboard, std::move(out)));
  }
  const ardiacore::tab_input_internal::Prepared& prepared = built.value();
  if (!bound) {
    return out.Send(ardiacore::tab_input_internal::Refusal("page_changed", "The tab's page or focused frame changed after prime, so nothing was sent."));
  }
  if (!hold->painting()) {
    return out.Send(ardiacore::tab_input_internal::Refusal("not_painting", "The tab's page stopped drawing after prime, so nothing was sent; try again."));
  }
  hold->Renew();
  base::OnceCallback<void(bool)> settled;
  if (prepared.transition) {
    hold->BeginTransition();
    settled = base::BindOnce(&ardiacore::EndTransition, contents->GetWeakPtr(),
                             hold->page_generation(), prepared.transition, prepared.pressing);
  }
  ardiacore::Dispatch(contents, std::move(built.value()), std::move(out), std::move(settled));
}
