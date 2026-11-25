import type { ImageProps } from "@expo/ui/swift-ui";
import type { SymbolName } from "./symbolPaths";

export type SFSymbolName = NonNullable<ImageProps["systemName"]>;

export const SF_SYMBOL_NAMES: Record<SymbolName, SFSymbolName | null> = {
  plus: "plus",
  xmark: "xmark",
  chevronUp: "chevron.up",
  checkmark: "checkmark",
  arrowUturnBackward: "arrow.uturn.backward",
  trash: "trash",
  archivebox: "archivebox",
  squareOnSquare: "square.on.square",
  ellipsis: "ellipsis",
  eyes: null,
  eyesClosed: null,
  chevronDown: "chevron.down",
  minus: "minus",
  link: "link",
  squareAndArrowUp: "square.and.arrow.up",
  docPlaintext: "doc.plaintext",
  textMagnifyingglass: "text.magnifyingglass",
  translate: "translate",
  moon: "moon",
  moonFill: "moon.fill",
  textformatSize: "textformat.size",
  desktop: "display",
  handRaised: "hand.raised",
  handPointUpLeftFill: "hand.point.up.left.fill",
  handRaisedSlash: "hand.raised.slash",
  plusSquareOnSquare: "plus.square.on.square",
  arrowDownCircle: "arrow.down.circle",
  exclamationmarkTriangle: "exclamationmark.triangle",
  exclamationmarkTriangleFill: "exclamationmark.triangle.fill",
  arrowDownCircleFill: "arrow.down.circle.fill",
  eyeglassesThin: "eyeglasses",
  eyeglasses: "eyeglasses",
  info: "info",
  paintpaletteFill: "paintpalette.fill",
  keyboardFill: "keyboard.fill",
  eraserFill: "eraser.fill",
  sparkles: "sparkles",
  line3HorizontalDecrease: "line.3.horizontal.decrease",
  checkmarkShield: "checkmark.shield",
  listBulletFill: "list.bullet.rectangle.portrait.fill",
  shieldLefthalf: "shield.lefthalf.filled",
  gearshape: "gearshape",
  gearshapeFill: "gearshape.fill",
  circleLefthalfFill: "circle.lefthalf.filled",
  squareOnSquareFill: "square.fill.on.square.fill",
  docText: "doc.text",
  code: "chevron.left.forwardslash.chevron.right",
  handWave: "hand.wave",
  arrowRight: "arrow.right",
  arrowRightCircle: "arrow.right.circle",
  chevronLeft: "chevron.left",
  chevronRight: "chevron.right",
  arrowClockwise: "arrow.clockwise",
  arrowUpForward: "arrow.up.forward",
  magnifyingglass: "magnifyingglass",
  sparkleMagnifyingglass: "sparkle.magnifyingglass",
  globe: "globe",
  laptop: "laptopcomputer",
  macDesktop: "desktopcomputer",
  iphone: "iphone",
  macStudio: "macstudio",
  macMini: "macmini",
  macAndPhone: "laptopcomputer.and.iphone",
  star: "star",
  starFill: "star.fill",
  paperplane: "paperplane",
  folderBadgeQuestionmark: "folder.badge.questionmark",
  exclamationmarkArrowTriangle2Circlepath: "exclamationmark.arrow.triangle.2.circlepath",
  exclamationmarkIcloud: "exclamationmark.icloud",
  folderFill: "folder.fill",
  lockFill: "lock.fill",
  lockOpenFill: "lock.open.fill",
  wifiSlash: "wifi.slash",
  printer: "printer",
  squareGrid2x2: "square.grid.2x2",
  squareStack: "square.stack",
  pinFill: "pin.fill",
  clockArrow: "clock.arrow.circlepath",
  textCursor: "character.cursor.ibeam",
  docOnDoc: "doc.on.doc",
  checkmarkCircle: "checkmark.circle",
  qrcodeViewfinder: "qrcode.viewfinder",
  equalCircleFill: "equal.circle.fill",
  xmarkCircleFill: "xmark.circle.fill",
  arrowUpForwardAppFill: "arrow.up.forward.app.fill",
  safariFill: "safari.fill",
  chevronUpChevronDown: "chevron.up.chevron.down",
  camera: "camera",
  video: "video",
  mic: "mic",
  micFill: "mic.fill",
  stopFill: "stop.fill",
  platterBottomArrowDown: "platter.filled.bottom.and.arrow.down.iphone",
  handDrawFill: "hand.draw.fill",
  paintbrushFill: "paintbrush.fill",
  sidebarLeft: "sidebar.left",
};

export const SF_POINT_SIZE_PER_SIDE = 0.78;

export const SF_WIDE_POINT_SIZE_PER_SIDE: Partial<Record<SymbolName, number>> = {
  eyeglasses: 0.56,
  eyeglassesThin: 0.6,
  macStudio: 0.6,
  macMini: 0.62,
  laptop: 0.62,
  macAndPhone: 0.68,
};

export const sfPointSizePerSide = (name: SymbolName) => SF_WIDE_POINT_SIZE_PER_SIDE[name] ?? SF_POINT_SIZE_PER_SIDE;

export function sfName(symbol: string | null | undefined): SFSymbolName | undefined {
  if (!symbol || !(symbol in SF_SYMBOL_NAMES)) return undefined;
  return SF_SYMBOL_NAMES[symbol as SymbolName] ?? undefined;
}

export const MENU_ONLY_SF_SYMBOL_NAMES: Partial<Record<SymbolName, SFSymbolName>> = {
  eyes: "eyes",
  eyesClosed: "eye.slash",
};

export function menuSfName(symbol: string | null | undefined): SFSymbolName | undefined {
  return sfName(symbol) ?? (symbol && symbol in MENU_ONLY_SF_SYMBOL_NAMES ? MENU_ONLY_SF_SYMBOL_NAMES[symbol as SymbolName] : undefined);
}
