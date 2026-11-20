import type { NativePagerConfig, PagerSnapshot, PagerStateEvent } from "@ardia/ardiacore";
import { statesLater, PagerMachine, type PagerClock } from "@ardia/ardiacore/src/pagerModel.ts";

export type { PagerClock, PagerSnapshot, PagerStateEvent };
export { OMEGA, REST_DISPLACEMENT, REST_SPEED, springAt } from "@ardia/ardiacore/src/pagerModel.ts";

export type PagerArea = {
  position(position: number, leading: number): boolean;
  state(event: PagerStateEvent): void;
};

export type PagerConfig = Omit<NativePagerConfig, "key" | "ack" | "width"> & Required<Pick<NativePagerConfig, "ack" | "width">>;

export class PagerRegistry {
  readonly clock: PagerClock;
  private pagers = new Map<string, Pager>();

  constructor(clock: PagerClock) {
    this.clock = clock;
  }

  named(key: string): Pager {
    let pager = this.pagers.get(key);
    if (!pager) this.pagers.set(key, (pager = new Pager(key, this)));
    return pager;
  }

  existing(key: string): Pager | null {
    return this.pagers.get(key) ?? null;
  }

  snapshot(key: string): PagerSnapshot | null {
    return this.pagers.get(key)?.snapshot() ?? null;
  }

  forget(pager: Pager) {
    if (this.pagers.get(pager.key) === pager) this.pagers.delete(pager.key);
  }
}

export class Pager extends PagerMachine {
  readonly key: string;
  private registry: PagerRegistry;
  private areas = new Set<PagerArea>();
  private pageWidth = 0;

  constructor(key: string, registry: PagerRegistry) {
    const relay: { pager?: Pager } = {};
    super(registry.clock, {
      position: (position, lead) => relay.pager?.sendPosition(position, lead),
      state: statesLater(() => relay.pager?.areas ?? new Set<PagerArea>(), (area, event) => area.state(event)),
    });
    relay.pager = this;
    this.key = key;
    this.registry = registry;
  }

  attach(area: PagerArea) {
    this.areas.add(area);
    if (this.configured) area.position(this.view.pagePosition, this.view.lead);
  }

  detach(area: PagerArea) {
    this.areas.delete(area);
    if (this.areas.size > 0 || this.registry.existing(this.key) !== this) return;
    this.stop();
    this.registry.forget(this);
  }

  override configure(config: PagerConfig) {
    this.pageWidth = config.width;
    super.configure(config);
  }

  override debug() {
    return { ...super.debug(), areas: this.areas.size, width: this.pageWidth };
  }

  private sendPosition(position: number, lead: number) {
    for (const area of this.areas) if (area.position(position, lead)) return;
  }
}
