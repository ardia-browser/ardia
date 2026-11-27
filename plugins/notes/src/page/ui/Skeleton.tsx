import { ghostOut, MOTION } from "./motion";

const skeletonExit = (el: HTMLDivElement | null) => (el ? () => ghostOut(el, "is-fading", MOTION.base, { force: true }) : undefined);

export function PageSkeleton({ nested = false }: { nested?: boolean }) {
  return (
    <div ref={nested ? undefined : skeletonExit} className="n-boot-main" aria-busy="true" data-testid="page-skeleton">
      <div className="n-boot-bar is-title" />
      <div className="n-boot-bar" style={{ width: "72%" }} />
      <div className="n-boot-bar" style={{ width: "64%" }} />
      <div className="n-boot-bar" style={{ width: "80%" }} />
    </div>
  );
}

export function BootSkeleton() {
  return (
    <div ref={skeletonExit} className="n-boot" aria-busy="true">
      <div className="n-boot-sidebar">
        <div className="n-boot-bar" style={{ width: "60%", height: 16 }} />
        <div className="n-boot-bar" style={{ width: "48%" }} />
        <div className="n-boot-bar" style={{ width: "52%" }} />
        <div className="n-boot-bar" style={{ width: "70%", marginTop: 18 }} />
        <div className="n-boot-bar" style={{ width: "64%" }} />
      </div>
      <PageSkeleton nested />
    </div>
  );
}
