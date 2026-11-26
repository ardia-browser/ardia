type Break = "CR" | "LF" | "Control" | "Extend" | "ZWJ" | "RI" | "Prepend" | "SpacingMark" | "L" | "V" | "T" | "LV" | "LVT" | "Other";
type Ranges = [number, number][];

const ranges = (encoded: string): Ranges =>
  encoded.split(",").map((part) => {
    const [from, span] = part.split("-");
    const start = parseInt(from!, 36);
    return [start, start + (span ? parseInt(span, 36) : 0)];
  });

const within = (table: Ranges, cp: number): boolean => {
  let low = 0;
  let high = table.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const [from, to] = table[mid]!;
    if (cp < from) high = mid - 1;
    else if (cp > to) low = mid + 1;
    else return true;
  }
  return false;
};

const CONTROL = ranges("0-9,b-1,e-h,3j-w,4t,17g,4r2,6bv,6by-1,6co-6,6e8-f,16o0-1kv,1edb,1ek0-b,1ovk-f,2fts-3,2jxv-7,jny8-v,jo1s-3j,joc0-2rz");
const EXTEND = ranges(
  "lc-33,w3-6,13l-18,14v,14x-1,150-1,153-2,174-a,18r-k,19s,1cm-6,1cv-5,1d3-1,1d6-3,1e9,1f4-q,1ie-a,1kb-8,1kt,1li-3,1ln-8,1lx-2,1m1-4,1nd-2,1p3-8,1qi-n," +
  "1r7-v,1tm,1to,1tt-7,1u5,1u9-6,1uq-1,1vl,1x8,1xa,1xd-3,1xp,1xz,1ya-1,1z2,1z5-1,20s,20x-1,213-1,217-2,21d,228-1,22d,22p-1,24c,24h-4,24n-1,24t,25e-1," +
  "262-5,269,27w,27y-1,281-3,28d,28j-4,28y-1,29u,2bi,2bk,2bx,2c7,2dc,2dg,2f0,2f2-2,2fa-2,2fe-3,2fp-1,2g2-1,2gx,2ik,2in-1,2iq,2iu-2,2iy-3,2j9-1,2jm-1," +
  "2kg-1,2m3-1,2m6,2m9-3,2ml,2mv,2n6-1,2o1,2q2,2q7,2qa-2,2qe,2qn,2sx,2t0-6,2tj-7,2wh,2wk-8,2x4-6,2zc-1,305,307,309,31t-d,328-4,32e-1,32l-a,32x-z,346," +
  "371-3,376-5,37d-1,37h-1,388-1,38e-2,38x-3,39e,39h-1,39p,3a5,3tp-2,4k2-3,4ky-2,4lu-1,4mq-1,4ok-1,4on-6,4p2,4p5-a,4pp,4qz-2,4r3,4ud-1,4vd,4yo-2,4yv-1," +
  "4z6,4zd-2,55j-1,55n,57a,57c-6,57k,57m,57p-7,583-9,58f,59s-1s,5c0-3,5dg-9,5du-2,5ez-8,5fk-1,5gi-3,5go-5,5ie,5ig-1,5il,5in-4,5kc-7,5km-1,5ow-2,5p0-c," +
  "5pe-6,5pp,5pw,5q0-1,5vk-1r,6bw,6hc-w,8vj-2,8zj,928-v,9ii-5,9ll-1,wvj-3,wvo-9,wwu-1,wz4-1,x6q,x6u,x6z,x7p-1,x7w,xc4-1,xcw-h,xdr,xeu-7,xfr-a,xg3,xhc-2," +
  "xir,xiu-3,xj0-1,xj4,xk5,xm1-5,xm9-1,xmd-1,xmr,xn0,xoc,xps,xpu-2,xpz-1,xq6-1,xq9,xrg-1,xrq,xyd,xyg,xyl,1dlq,1e68-f,1e74-f,1ehq-1,1eyl,1f4w,1f92-4," +
  "1gjl-2,1gjp-1,1gjw-3,1gl4-2,1glb,1gpx-1,1h5w-3,1h7t-4,1hgr-1,1hhn-4,1hio-f,1hl2-a,1hmq-3,1hq9,1hrs-e,1htc,1htf-1,1htr-2,1hv7-3,1hvd-1,1hvm,1hxc-2," +
  "1hyf-4,1hyl-7,1i0j,1i0w-1,1i2e-8,1i2o,1i2x-3,1i33,1i5r-2,1i5w-3,1i66,1i69,1ian,1iar-7,1ibk-1,1id7-1,1ida,1idc,1idp,1idz,1iee-6,1ieo-4,1igo,1igr-5," +
  "1igy,1ih1,1ih3-2,1iha-2,1ihe,1iht-1,1ik8-7,1iki-2,1ikm,1ila,1ink,1inn-5,1inu,1inx,1inz-1,1io2-1,1iun,1iuq-3,1iv0-1,1iv3-1,1ivw-1,1iyb-7,1iyl,1iyn-1," +
  "1j1n,1j1p,1j1s-7,1j4t,1j4v,1j4y-3,1j53-4,1jcf-8,1jcp-1,1jjk,1jjv-3,1jk3,1jo4-3,1joa-1,1jog,1jpd-9,1jqr-5,1jqz-3,1jrb,1jrl-5,1jrt-2,1jt6-c,1jtk-1,1jz4," +
  "1jz6-2,1jza,1k4w-6,1k54-5,1k5b,1k7m-l,1k8a-6,1k8i-1,1k8l-1,1kc1-5,1kca,1kcc-1,1kcf-6,1kcn,1keo-1,1ket,1kev,1khc,1koj-1,1kow-1,1kqe-4,1kqo-2,1kre,1ow0," +
  "1ow7-e,1xr2-b,1xrh-2,1zow-4,1zqo-6,20jz,20lr-3,20o4,20og-1,2ftp-1,2jgg-19,2jhs-m,2jvr-1,2jxh-4,2jxp-5,2jy3-7,2jyd-6,2jze-3,2k3m-2,2k40-2,2k4b-1,2k4f," +
  "2k5c-1,2lmo-1i,2lob-1d,2lpx,2lqc,2lqz-4,2lr5-e,2mtc-6,2mtk-g,2mu3-6,2mub-1,2mue-4,2mxb,2n1s-6,2nce,2ne4-3,2nsc-3,2nzi-1,2o6b,2o6e,2o6m-1,2o6t,2ok0-6," +
  "2on8-6,2qrf-4,jnz4-2n,jo5c-6n",
);
const PICTOGRAPHIC = ranges(
  "4p,4u,6d8,6dl,6jm,6k9,6ms-5,6nd-1,6xm-1,6y0,72n,73d-a,73s-2,79e,7fu-1,7g6,7gg,7i3-3,7i8-4,7im,7ip,7is-1,7iw,7j1,7j4,7j6-1,7ja,7je,7ji-1,7js-2,7k0,7k2," +
  "7k8-b,7kv-1,7kz,7l1-1,7l4,7ln,7lq-1,7ma-5,7mh,7mj-1,7mo-1,7mv,7my-1,7n4-1,7nh-1,7no-1,7ns,7ny-1,7o1,7o3-1,7op-1,7ow-5,7p3-3,7p9,7pe,7ph,7pk-5,7pr,7pu," +
  "7pw,7py,7q5,7q9,7qg,7qr-1,7r8,7rb,7rg,7ri,7rn-2,7rr,7s3-1,7th-2,7tt,7u8,7un,850-1,8hx-2,8ij-1,8k0,8k5,9io,9j1,9zr,9zt,2pz8,2q0c-3,2q38-b,2q3z-1,2q4g," +
  "2q4v-1,2q5y-9,2q9c-1,2q9q-1,2qa6,2qa9-9,2qb3-1i,2qdd-e,2qe2,2qen,2qeq-8,2qf0-3,2qfd-m,2qg6-57,2qlg-33,2qom-1,2qop-2,2qou-2a,2qr7-2,2qrb-3,2qrk-71," +
  "2qyn-1q,2r0p-5,2r0w-n,2r1r-1,2r1v-7,2r2f,2r2i-3,2r2o,2r2t-1,2r38-1,2r3c,2r3l-1,2r3w,2r42-2,2r4h-2,2r4s-2,2r4x,2r4z,2r54,2r5b,2r5f,2r5m-2d,2r9c-1x," +
  "2rbf-7,2rbp-g,2rc9,2rcb-5,2rcj-c,2rj0-k,2rkc-3,2rm0-7,2rmi-5,2rns-7,2rou-1,2rp8-3,2rpe-d,2rq1-12,2rrg-1a,2rss-9,2rt3-54,2s0o-7,2s1a-41,2scg-sd",
);
const PREPEND = ranges("16o-5,1ct,1e7,1ow-1,1r6,2mm,1hvh,1hvx,1i2q-1,1ihd,1jjz,1jk1,1jt0-5,1kcm,1koy");
const SPACING_MARK = ranges(
  "1s3,1tn,1tq-2,1u1-3,1u6-1,1vm-1,1xb-1,1xj-1,1xn-1,1z7,20u-2,22r,24e-2,24p,24r-1,26a-1,280,287-1,28b-1,2bj,2bl-1,2bq-2,2bu-2,2dd-2,2f5-3,2gy-1,2im,2ip," +
  "2ir-1,2k3,2ki-1,2m7-1,2me-2,2mi-2,2o2-1,2q8-1,2qg-6,2r6-1,2sz,2wj,30e-1,327,375,37f-1,386-1,39g,4om,4ou-7,4p3-1,4yr-3,4yx-2,4z4-1,4z7-5,55l-1,579,57b," +
  "57x-5,5c4,5dq-3,5fm,5gh,5gm-1,5if,5ii-2,5im,5k4-7,5kk-1,5pd,5pz,x7n-1,x7r,xa8-1,xbo-f,xg2,xhf,xis-1,xiy-1,xj2-1,xm7-1,xmb-1,xn1,xrf,xri-1,xrp,xyb-1," +
  "xye-1,xyh-1,xyk,1hq8,1hqa,1htu,1hv4-2,1hvb-1,1hyk,1hz9-1,1i0y,1i2b-2,1i2n,1i32,1i5o-2,1i5u-1,1iao-2,1ibm-1,1idb,1idd-3,1idj-1,1idn-1,1iea-1,1igp-1," +
  "1ih6,1ih8-1,1ik5-2,1ikg-1,1ikl,1inl-1,1int,1inv-1,1iny,1io1,1iuo-1,1iuw-3,1iv2,1iy8-2,1iyj-1,1iym,1j1o,1j1q-1,1j4u,1j52,1jcc-2,1jco,1jjl-4,1jjr-1," +
  "1jk0,1jk2,1jo1-2,1joc-3,1jok,1jqx,1jrr-1,1jtj,1jz5,1jz9,1jzb,1k4v,1k5a,1k89,1k8h,1k8k,1kei-4,1ker-1,1keu,1kol-1,1koz,1kqc-1,1kqm-1,1xre-2,20k1-1i",
);
const INCB_CONSONANT = ranges(
  "1sl-10,1ug-7,1vc-7,1w5-j,1wq-6,1wy,1x2-3,1y4-1,1y7,1yo-1,239-j,23u-6,242-1,245-4,261,26t-j,27e-6,27m-1,27p-4,28s-1,28v,29d,2dx-j,2ei-f,2fs-2,2l1-11," +
  "35s-16,37j,380-5,38a-3,38h,38l-1,38u-2,391-c,39q,4n4-1f,55s-1g,5cb-1,5cj-w,5dx-7,5fn-t,5gu-1,5h7-2,xhl-2,xhr-z,xk0-4,xk7-8,xkq-4,xnk-f,xo1-2,xoa," +
  "xoe-1,xr4-a,xxc-q,1gjk,1gk0-3,1gk5-2,1gk9-s,1hxf-z,1hz8,1hzb,1if4-9,1iff,1ifi,1ifk-11,1ji8-6,1jih,1jik-7,1jit-1,1jiw-n,1jpc,1jpn-13,1jrk,1jrw-13,1jwq," +
  "1khd,1kp0-c,1kpe-x",
);
const INCB_LINKER = ranges("1u5,1xp,24t,28d,2fh,2ml,37d,4pe,57k,5dw,5gr,5px-1,xj4,xrq,1glb,1hyr,1ihc,1jjy,1jqy,1jrb,1jtl,1kqq");
const NOT_INCB_EXTEND = ranges("6bw");
const ZWJ = 0x200d;

export const isControl = (cp: number): boolean => within(CONTROL, cp);
const isPictographicPoint = (cp: number): boolean => within(PICTOGRAPHIC, cp);

function breakOf(cp: number): Break {
  if (cp === 0x0d) return "CR";
  if (cp === 0x0a) return "LF";
  if (cp === ZWJ) return "ZWJ";
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return "RI";
  if (within(PREPEND, cp)) return "Prepend";
  if (within(EXTEND, cp)) return "Extend";
  if (isControl(cp)) return "Control";
  if (within(SPACING_MARK, cp)) return "SpacingMark";
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)) return "L";
  if ((cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6) || cp === 0x16d63 || (cp >= 0x16d67 && cp <= 0x16d6a)) return "V";
  if ((cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)) return "T";
  if (cp >= 0xac00 && cp <= 0xd7a3) return (cp - 0xac00) % 28 === 0 ? "LV" : "LVT";
  return "Other";
}

const isLinker = (cp: number) => within(INCB_LINKER, cp);
const isConsonant = (cp: number) => within(INCB_CONSONANT, cp);
const isConjunctExtend = (kind: Break, cp: number) => kind === "ZWJ" || (kind === "Extend" && !isLinker(cp) && !within(NOT_INCB_EXTEND, cp));

type Run = { prev: Break | null; regional: number; pictographic: 0 | 1 | 2; conjunct: 0 | 1 | 2 };

function joins(run: Run, now: Break, cp: number): boolean {
  const { prev } = run;
  if (prev === null) return false;
  if (prev === "CR" && now === "LF") return true;
  if (prev === "CR" || prev === "LF" || prev === "Control" || now === "CR" || now === "LF" || now === "Control") return false;
  if (prev === "L" && (now === "L" || now === "V" || now === "LV" || now === "LVT")) return true;
  if ((prev === "LV" || prev === "V") && (now === "V" || now === "T")) return true;
  if ((prev === "LVT" || prev === "T") && now === "T") return true;
  if (now === "Extend" || now === "ZWJ" || now === "SpacingMark" || prev === "Prepend") return true;
  if (run.conjunct === 2 && isConsonant(cp)) return true;
  if (prev === "ZWJ" && run.pictographic === 2 && isPictographicPoint(cp)) return true;
  return prev === "RI" && now === "RI" && run.regional % 2 === 1;
}

function advance(run: Run, now: Break, cp: number) {
  run.regional = now === "RI" ? run.regional + 1 : 0;
  if (isPictographicPoint(cp)) run.pictographic = 1;
  else if (run.pictographic === 1 && now === "Extend") run.pictographic = 1;
  else run.pictographic = run.pictographic === 1 && now === "ZWJ" ? 2 : 0;
  if (isLinker(cp)) run.conjunct = 2;
  else if (isConsonant(cp)) run.conjunct = 1;
  else if (!(run.conjunct && isConjunctExtend(now, cp))) run.conjunct = 0;
  run.prev = now;
}

export function graphemeClusters(text: string): string[] {
  const out: string[] = [];
  const run: Run = { prev: null, regional: 0, pictographic: 0, conjunct: 0 };
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    const now = breakOf(cp);
    if (joins(run, now, cp)) out[out.length - 1] += char;
    else out.push(char);
    advance(run, now, cp);
  }
  return out;
}

export const startsCluster = (cluster: string): boolean => {
  const kind = breakOf(cluster.codePointAt(0)!);
  return kind !== "Extend" && kind !== "ZWJ" && kind !== "SpacingMark";
};

export const isPictographic = (char: string): boolean => isPictographicPoint(char.codePointAt(0) ?? -1);
