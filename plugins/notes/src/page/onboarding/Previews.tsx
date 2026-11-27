import type { CSSProperties } from "react";
import type { OnboardingTemplate } from "./templates";
import { TemplatePreview } from "../templates/TemplatePreview";

const initial = (name: string) => (name.trim()[0] ?? "Y").toUpperCase();

function Lines({ widths }: { widths: number[] }) {
  return (
    <>
      {widths.map((w, i) => (
        <span key={i} className="n-pv-line" style={{ width: `${w}%` }} />
      ))}
    </>
  );
}

export function WelcomePreview({ name, color }: { name: string; color: string }) {
  return (
    <div className="n-pv-stage">
      <div className="n-pv-page" style={{ ["--c" as string]: color } as CSSProperties}>
        <div className="n-pv-page-top">
          <span className="n-pv-crumb">Private</span>
          <span className="n-pv-crumb-sep">/</span>
          <span className="n-pv-crumb">Getting Started</span>
          <span className="n-pv-spacer" />
          <span className="n-pv-avatar" data-testid="onboarding-avatar">
            {initial(name)}
          </span>
        </div>
        <div className="n-pv-emoji">👋</div>
        <div className="n-pv-title">Getting Started</div>
        <Lines widths={[92, 78, 84]} />
        <div className="n-pv-typing">
          <span className="n-pv-line is-short" style={{ width: "38%" }} />
          <span className="n-pv-caret">
            <span className="n-pv-flag">{name}</span>
          </span>
        </div>
        <div className="n-pv-todo">
          <span className="n-pv-check is-on" />
          <span className="n-pv-line" style={{ width: "54%" }} />
        </div>
        <div className="n-pv-todo">
          <span className="n-pv-check" />
          <span className="n-pv-line" style={{ width: "62%" }} />
        </div>
      </div>
    </div>
  );
}

export function TemplatePreviewPane({ template }: { template: OnboardingTemplate }) {
  if (template.builtin)
    return (
      <div className="n-ob-live" key={template.id} data-testid="onboarding-template-preview">
        <div className="n-ob-live-label">Preview</div>
        <div className="n-ob-live-scale" inert>
          <TemplatePreview source={{ kind: "builtin", id: template.id }} />
        </div>
      </div>
    );
  return (
    <div className="n-pv-stage" key={template.id}>
      <div className="n-pv-page is-template">
        <div className="n-pv-emoji">👋</div>
        <div className="n-pv-title">Getting Started</div>
        <Lines widths={[90, 76, 84, 40]} />
        <div className="n-pv-todo">
          <span className="n-pv-check" />
          <span className="n-pv-line" style={{ width: "58%" }} />
        </div>
      </div>
    </div>
  );
}

export function TogetherPreview({ name, color, shared }: { name: string; color: string; shared: string | null }) {
  return (
    <div className="n-pv-stage">
      <div className="n-pv-together">
        <div className="n-pv-device" style={{ ["--c" as string]: color } as CSSProperties}>
          <span className="n-pv-avatar">{initial(name)}</span>
          <span className="n-pv-device-name">{name}</span>
          <span className="n-pv-device-sub">This Mac</span>
        </div>
        <div className="n-pv-link" aria-hidden="true">
          <span className="n-pv-dot" />
        </div>
        <div className="n-pv-folder">
          <span className="n-pv-folder-tab" />
          <span className="n-pv-folder-name">{shared ?? "Ardia Shared"}</span>
          <span className="n-pv-device-sub">iCloud Drive</span>
        </div>
        <div className="n-pv-link is-back" aria-hidden="true">
          <span className="n-pv-dot" />
        </div>
        <div className="n-pv-device" style={{ ["--c" as string]: "#3EB489" } as CSSProperties}>
          <span className="n-pv-avatar">A</span>
          <span className="n-pv-device-name">Someone you invite</span>
          <span className="n-pv-device-sub">Their Mac</span>
        </div>
        <ol className="n-ob-facts">
          <li>
            <span className="n-ob-fact-n">01</span>Lives in iCloud Drive › Ardia Shared
          </li>
          <li>
            <span className="n-ob-fact-n">02</span>Each Mac writes only its own files
          </li>
          <li>
            <span className="n-ob-fact-n">03</span>No server of ours in between
          </li>
        </ol>
      </div>
    </div>
  );
}
