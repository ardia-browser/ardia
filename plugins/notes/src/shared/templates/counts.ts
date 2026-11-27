export const GALLERY_SOURCES = ["sidebar", "empty", "database", "home", "menu", "onboarding", "command"] as const;
export type GallerySource = (typeof GALLERY_SOURCES)[number];

export const COUNT_EVENTS = [...GALLERY_SOURCES.map((s) => `template_gallery_opens_${s}` as const), "template_uses_yours", "template_uses_row", "template_saves", "template_searches", "template_previews"] as const;
export type CountEvent = (typeof COUNT_EVENTS)[number];

export const templateUseCount = (id: string) => `template_uses_${id.replace(/-/g, "_")}`;
