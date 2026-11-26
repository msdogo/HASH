import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'

/*
 * 应用图标生成器 v4 —— 「H 开头的动物」。
 *
 * v3 失败原因（诊断）：用一堆椭圆/三角形做并集，没有轮廓控制 ——
 * 拼不出「吻部收尖」「耳朵立起」这种决定物种的特征，结果只是一坨色块。
 *
 * v4 改用**闭合样条轮廓**：手给控制点 → Catmull-Rom 插值成平滑闭合曲线 →
 * 扫描线光栅化。轮廓是一笔连续的，该尖的能收尖、该圆的能鼓起来。
 *
 * 性能教训：v3 的写法是「每个子采样点对所有多边形做射线判定」，
 * 在 768²×16 的采样量下要跑几分钟（实测被超时杀掉两次）。
 * 扫描线法是 O(行 × 边)，同样的画质只需几十毫秒。
 */

const R = 768          // 3x 超采样后的渲染尺寸
const BASE = 256       // 逻辑坐标
const S = R / BASE

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const lerp = (a, b, t) => a + (b - a) * t

function sampleStops(stops, t) {
  t = clamp01(t)
  for (let i = 0; i < stops.length - 1; i++) {
    const [t0, c0] = stops[i]
    const [t1, c1] = stops[i + 1]
    if (t <= t1) {
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0)
      return [lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)]
    }
  }
  return stops[stops.length - 1][1]
}

/* ---------------- 扫描线多边形光栅化（抗锯齿） ---------------- */

/**
 * 把多边形（逻辑 256 坐标）画进浮点遮罩，值域 0..1。
 * 每条像素行取 4 条子扫描线，每条子扫描线求出若干 x 区间，
 * 再按小数覆盖累加到该行像素上 —— 这就是常见的「覆盖率 AA」，比点采样干净。
 */
function fillPolygon(size, pts, target, weight = 1) {
  const n = pts.length
  if (n < 3) return target
  const xs = pts.map((p) => p[0] * S)
  const ys = pts.map((p) => p[1] * S)
  let minY = Infinity, maxY = -Infinity
  for (const y of ys) { if (y < minY) minY = y; if (y > maxY) maxY = y }
  const y0 = Math.max(0, Math.floor(minY))
  const y1 = Math.min(size - 1, Math.ceil(maxY))

  const SUB = 4
  const rowCov = new Float32Array(size)
  for (let py = y0; py <= y1; py++) {
    rowCov.fill(0)
    for (let s = 0; s < SUB; s++) {
      const sy = py + (s + 0.5) / SUB
      // 求这条扫描线与所有边的交点
      const cross = []
      for (let i = 0; i < n; i++) {
        const ax = xs[i], ay = ys[i]
        const bx = xs[(i + 1) % n], by = ys[(i + 1) % n]
        if (ay === by) continue
        const lo = Math.min(ay, by), hi = Math.max(ay, by)
        if (sy < lo || sy >= hi) continue
        const t = (sy - ay) / (by - ay)
        cross.push(ax + (bx - ax) * t)
      }
      if (cross.length < 2) continue
      cross.sort((a, b) => a - b)
      for (let k = 0; k + 1 < cross.length; k += 2) {
        const xa = Math.max(0, cross[k])
        const xb = Math.min(size, cross[k + 1])
        if (xb <= xa) continue
        const ia = Math.floor(xa), ib = Math.floor(xb)
        if (ia === ib) { rowCov[ia] += xb - xa; continue }
        rowCov[ia] += ia + 1 - xa
        for (let x = ia + 1; x < ib; x++) rowCov[x] += 1
        if (ib < size) rowCov[ib] += xb - ib
      }
    }
    const rowBase = py * size
    for (let x = 0; x < size; x++) {
      const cov = rowCov[x] / SUB
      if (cov <= 0) continue
      const add = Math.min(1, cov) * weight
      if (add <= 0) continue
      const idx = rowBase + x
      target[idx] = Math.max(target[idx], Math.min(1, target[idx] + add))
    }
  }
  return target
}

function ellipsePoly(cx, cy, rx, ry, deg = 0, steps = 64) {
  const rad = (deg * Math.PI) / 180
  const cos = Math.cos(rad), sin = Math.sin(rad)
  const out = []
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 2
    const x = Math.cos(a) * rx, y = Math.sin(a) * ry
    out.push([cx + x * cos - y * sin, cy + x * sin + y * cos])
  }
  return out
}

function inSquircle(lx, ly, n, inset = 0) {
  const half = 128 - inset
  const dx = Math.abs(lx - 128) / half
  const dy = Math.abs(ly - 128) / half
  return Math.pow(dx, n) + Math.pow(dy, n) <= 1
}

function bakeCondition(size, fn) {
  const m = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hit = 0
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          if (fn((x + (sx + 0.5) / 4) / S, (y + (sy + 0.5) / 4) / S)) hit++
        }
      }
      m[y * size + x] = hit / 16
    }
  }
  return m
}

function blurMask(mask, size, radius) {
  if (radius <= 0) return mask
  let a = Float32Array.from(mask)
  const b = new Float32Array(size * size)
  const w = radius * 2 + 1
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < size; y++) {
      const row = y * size
      let sum = 0
      for (let x = -radius; x <= radius; x++) sum += a[row + Math.min(size - 1, Math.max(0, x))]
      for (let x = 0; x < size; x++) {
        b[row + x] = sum / w
        sum -= a[row + Math.min(size - 1, Math.max(0, x - radius))]
        sum += a[row + Math.min(size - 1, Math.max(0, x + radius + 1))]
      }
    }
    for (let x = 0; x < size; x++) {
      let sum = 0
      for (let y = -radius; y <= radius; y++) sum += b[Math.min(size - 1, Math.max(0, y)) * size + x]
      for (let y = 0; y < size; y++) {
        a[y * size + x] = sum / w
        sum -= b[Math.min(size - 1, Math.max(0, y - radius)) * size + x]
        sum += b[Math.min(size - 1, Math.max(0, y + radius + 1)) * size + x]
      }
    }
  }
  return a
}

/* ---------------- 样条 ---------------- */

function spline(pts, closed = true, segments = 10) {
  const n = pts.length
  const out = []
  const at = (i) => (closed ? pts[(i + n) % n] : pts[Math.min(n - 1, Math.max(0, i))])
  const last = closed ? n : n - 1
  for (let i = 0; i < last; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
    for (let s = 0; s < segments; s++) {
      const t = s / segments
      const t2 = t * t, t3 = t2 * t
      out.push([
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      ])
    }
  }
  return out
}

/* ---------------- 底 ---------------- */

function drawBase(c, theme) {
  const size = c.size
  /*
   * 底座形状 = 超椭圆本身。
   *
   * 修前这里先铺了一个整圆、再与超椭圆取交集 —— 交集就是那个圆，
   * 于是所有图标都变成了圆形（用户在拼图里看到的就是这个）。
   * 超椭圆沿对角线会伸到 128√2 附近，本来就该在画布外沿被裁掉，
   * 不需要再拿别的形状去裁。
   */
  const sq = []
  const n = 240
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    const ca = Math.cos(a), sa = Math.sin(a)
    // |x/r|^N + |y/r|^N = 1 → r = 1 / (|cos|^N + |sin|^N)^(1/N)
    const r = Math.pow(Math.pow(Math.abs(ca), theme.squircleN) + Math.pow(Math.abs(sa), theme.squircleN), -1 / theme.squircleN)
    sq.push([128 + ca * 128 * r, 128 + sa * 128 * r])
  }
  const mask = new Float32Array(size * size)
  fillPolygon(size, sq, mask)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = mask[y * size + x]
      if (a <= 0) continue
      const u = x / size, v = y / size
      const t = clamp01((u * 0.7 + v * 0.95) / 1.55)
      let rgb = sampleStops(theme.base, t)
      for (const b of theme.blooms) {
        const dx = u - b.cx, dy = v - b.cy
        const d = Math.sqrt(dx * dx + dy * dy) / b.r
        const k = Math.pow(clamp01(1 - d), b.falloff) * b.strength
        rgb = [lerp(rgb[0], b.color[0], k), lerp(rgb[1], b.color[1], k), lerp(rgb[2], b.color[2], k)]
      }
      // 该像素此刻是空的，直接写入（含 alpha）
      const i = (y * size + x) * 4
      c.px[i] = rgb[0]; c.px[i + 1] = rgb[1]; c.px[i + 2] = rgb[2]; c.px[i + 3] = a
    }
  }
  // 边缘受光
  const rim = bakeCondition(size, (lx, ly) => inSquircle(lx, ly, theme.squircleN) && !inSquircle(lx, ly, theme.squircleN, 1.2))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = rim[y * size + x] * (0.3 + 0.7 * (1 - y / size)) * 0.42
      if (a <= 0) continue
      blendPx(c, x, y, [255, 255, 255], a)
    }
  }
}

function blendPx(c, x, y, rgb, a) {
  const i = (y * c.size + x) * 4
  const dstA = c.px[i + 3]
  const outA = a + dstA * (1 - a)
  if (outA <= 0) return
  c.px[i] = (rgb[0] * a + c.px[i] * dstA * (1 - a)) / outA
  c.px[i + 1] = (rgb[1] * a + c.px[i + 1] * dstA * (1 - a)) / outA
  c.px[i + 2] = (rgb[2] * a + c.px[i + 2] * dstA * (1 - a)) / outA
  c.px[i + 3] = outA
}

function paintGlyph(c, mask, theme) {
  const size = c.size
  const dy = Math.round(5 * S)
  const shifted = new Float32Array(size * size)
  for (let y = 0; y < size; y++) {
    const sy = Math.min(size - 1, Math.max(0, y - dy))
    for (let x = 0; x < size; x++) shifted[y * size + x] = mask[sy * size + x]
  }
  const shadow = blurMask(shifted, size, Math.round(9 * S))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = shadow[y * size + x] * 0.5
      if (a > 0.002) blendPx(c, x, y, theme.shadowColor, a)
    }
  }
  const glow = blurMask(mask, size, Math.round(6 * S))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = glow[y * size + x] * theme.glowStrength
      if (a > 0.002) blendPx(c, x, y, theme.glowColor, a)
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const a = mask[y * size + x]
      if (a <= 0) continue
      const t = clamp01((x / size) * 0.55 + (y / size) * 0.7)
      blendPx(c, x, y, sampleStops(theme.glyph, t), a)
    }
  }
}

/* ---------------- 三只动物 ---------------- */

/** J 刺猬：吻尖朝右 + 弧形背刺 + 眼睛 + 浅色腹部。 */
/*
 * J 刺猬：侧视朝右。
 *
 * 第一版被认成「太阳 / 河豚」——原因是刺围着整个背均匀发散、身体又太圆。
 * 真实刺猬的轮廓是：**前半身是光滑的脸和吻**，刺只长在后背那半，
 * 而且越往后越短。这里据此重画：吻部收成一个明确的尖，刺只覆盖左上到右上，
 * 并在前端让位给光滑的额头。
 */
function artHedgehog() {
  /*
   * 第二版被认成「鱼」——因为那块浅色腹部画得太大（46×40），
   * 在橙身上糊出一个鱼肚白，加上吻部不够尖，整体轮廓变成鱼。
   * 这一版：浅色只留**脸颊那一小片**，身体明确「头小臀圆」，
   * 并补上四只脚 —— 有脚才像陆生动物，这是很划算的一个细节。
   */
  const body = spline([
    [208, 158],   // 吻尖（尖而短）
    [198, 146],
    [184, 138],   // 额头：刺从这里往后开始
    [166, 130],
    [142, 126],
    [116, 130],
    [92, 144],
    [76, 166],
    [70, 192],
    [80, 214],
    [102, 230],
    [134, 236],
    [166, 230],
    [190, 212],
    [202, 184],
  ], true, 10)

  // 刺：只覆盖背弧（190°→330°），短而密，根部宽 —— 密比长更像刺猬
  const spikes = []
  const cx = 128, cy = 188
  for (let i = 0; i < 15; i++) {
    const t = i / 14
    const ang = Math.PI * (1.0 + t * 0.86)
    const bx = cx + Math.cos(ang) * 72
    const by = cy + Math.sin(ang) * 70
    const len = 26 - t * 8
    const ex = cx + Math.cos(ang) * (72 + len)
    const ey = cy + Math.sin(ang) * (70 + len * 0.95)
    const nx = Math.cos(ang + Math.PI / 2) * 8
    const ny = Math.sin(ang + Math.PI / 2) * 8
    spikes.push([[bx + nx, by + ny], [bx - nx, by - ny], [ex, ey]])
  }

  // 四只小脚
  const feet = [
    ellipsePoly(104, 236, 15, 9, 0, 40),
    ellipsePoly(144, 240, 16, 9, 0, 40),
  ]

  return {
    polys: [body, ...feet, ...spikes],
    holes: [ellipsePoly(196, 158, 7, 7, 0, 48)],
    // 浅色只做「脸颊」：小、靠吻部，不越过身体中线
    belly: [ellipsePoly(190, 178, 30, 30, 0, 56)],
  }
}

/** K 野兔：长耳坐姿，朝左。 */
function artHare() {
  const body = spline([
    [150, 100], [134, 108], [122, 124], [114, 142], [106, 154],
    [114, 164], [126, 170], [132, 184], [134, 204], [146, 218],
    [168, 224], [192, 218], [202, 200], [198, 178], [184, 158],
    [174, 136], [172, 116], [162, 102],
  ], true, 10)
  const ear1 = spline([[144, 102], [134, 62], [132, 26], [146, 28], [158, 64], [158, 98]], true, 8)
  const ear2 = spline([[164, 100], [166, 64], [176, 34], [188, 44], [184, 76], [176, 102]], true, 8)
  const tail = spline([[198, 196], [214, 186], [220, 202], [210, 216], [196, 212]], true, 8)
  return {
    polys: [body, ear1, ear2, tail],
    holes: [ellipsePoly(132, 132, 6, 6, 0, 40)],
    belly: [ellipsePoly(152, 194, 32, 28, 0, 48)],
  }
}

/*
 * L 鹰：侧头朝右。
 *
 * 猛禽的签名是**钩喙**：上喙向下弯成一个尖，下喙短而平。缺了这个弯钩，
 * 不管身体画得多对，看起来都像鸭子（v4 第一版就是这个毛病）。
 * 所以这里喙单独用一条轮廓线画，尖端明确下勾。
 */
function artHawk() {
  /*
   * 第一版被认成「鸭子」——喙太短太钝，而且没有眉骨。
   * 猛禽的两个签名特征：**向下勾的尖喙** 与 **压在眼睛上方的眉脊**。
   * 这一版把喙伸出头部轮廓之外并明确下勾，再用一块深色眉脊把眼神压出来。
   */
  /*
   * 头：圆形但前额平，右侧留出喙的接口。
   * 上一版头太靠左、喙又长又细地垂下来，整体读成「大鼻子的人」。
   */
  const head = spline([
    [184, 128],
    [190, 110],
    [188, 92],
    [178, 78],
    [160, 70],
    [140, 72],   // 头顶
    [122, 82],
    [112, 100],
    [114, 120],
    [126, 138],
    [146, 148],
    [168, 146],
  ], true, 10)

  /*
   * 喙：短、宽根、明确向下勾。
   * 鹰喙的形状记忆点是「一条向下的弧 + 一个回勾」，长度只需要头的 1/3；
   * 上一版画成了头长的 2/3，于是更像长鼻。
   */
  const beak = [
    [184, 104],
    [198, 108],
    [210, 122],
    [212, 138],   // 尖端
    [198, 142],   // 回勾
    [200, 126],
    [190, 116],
    [180, 112],
  ]

  // 胸：窄而长，向下收
  const chest = spline([
    [128, 142], [112, 170], [104, 202], [114, 228], [142, 238],
    [174, 232], [192, 210], [192, 178], [176, 154], [152, 146],
  ], true, 10)

  // 眉脊：压在眼睛上方的一块楔形，是「凶」的来源
  const brow = [
    [150, 88],
    [188, 92],
    [190, 104],
    [152, 100],
  ]

  return {
    polys: [head, chest],
    beak,
    brow,
    holes: [ellipsePoly(168, 112, 7.5, 7.5, 0, 40)],
    belly: [ellipsePoly(152, 196, 38, 32, 0, 48)],
  }
}

const THEMES = {
  J: {
    name: '刺猬',
    art: artHedgehog,
    squircleN: 4.6,
    base: [[0, [30, 24, 50]], [0.55, [18, 20, 38]], [1, [10, 28, 36]]],
    blooms: [
      { cx: 0.22, cy: 0.16, r: 0.85, falloff: 2.1, strength: 0.5, color: [126, 62, 220] },
      { cx: 0.84, cy: 0.86, r: 0.78, falloff: 2.0, strength: 0.55, color: [22, 190, 190] },
    ],
    shadowColor: [4, 6, 14],
    glowColor: [255, 176, 96],
    glowStrength: 0.2,
    glyph: [[0, [255, 226, 160]], [0.5, [250, 186, 104]], [1, [238, 156, 96]]],
    bellyColor: [[0, [255, 246, 220]], [1, [252, 224, 178]]],
    holeColor: [46, 30, 30],
  },
  K: {
    name: '野兔',
    art: artHare,
    squircleN: 4.6,
    /*
     * 底色：亮色渐变（用户选定「品红→紫→蓝」）。
     *
     * 改前是深紫黑夜空 —— 用户反馈「太暗了，要鲜艳亮点」。
     * 亮底的关键约束不是好看，而是**白兔不能糊进底色**：
     * 兔身最亮到 (245,248,255)，底色一旦也落在高明度区间，
     * 缩到 16px 就成了白对白。所以这里取「饱和但中明度」的一段，
     * 并靠图形投影（paintGlyph 的第一层）把兔子从底上抠出来。
     */
    base: [[0, [236, 72, 153]], [0.5, [168, 85, 247]], [1, [59, 130, 246]]],
    blooms: [
      { cx: 0.2, cy: 0.14, r: 0.85, falloff: 2.0, strength: 0.55, color: [251, 146, 60] },
      { cx: 0.86, cy: 0.86, r: 0.8, falloff: 2.0, strength: 0.5, color: [129, 140, 248] },
    ],
    shadowColor: [4, 6, 14],
    glowColor: [200, 210, 255],
    glowStrength: 0.22,
    glyph: [[0, [245, 248, 255]], [0.5, [206, 218, 250]], [1, [160, 186, 240]]],
    bellyColor: [[0, [255, 255, 255]], [1, [232, 240, 255]]],
    holeColor: [34, 34, 58],
  },
  L: {
    name: '鹰',
    art: artHawk,
    squircleN: 4.6,
    base: [[0, [28, 24, 48]], [0.55, [16, 19, 36]], [1, [8, 26, 38]]],
    blooms: [
      { cx: 0.22, cy: 0.16, r: 0.86, falloff: 2.1, strength: 0.5, color: [100, 60, 220] },
      { cx: 0.84, cy: 0.86, r: 0.78, falloff: 2.0, strength: 0.52, color: [24, 200, 200] },
    ],
    shadowColor: [4, 6, 14],
    glowColor: [255, 210, 130],
    glowStrength: 0.22,
    glyph: [[0, [255, 240, 210]], [0.5, [246, 200, 140]], [1, [226, 160, 110]]],
    bellyColor: [[0, [255, 250, 235]], [1, [250, 228, 200]]],
    beakColor: [[0, [253, 186, 60]], [1, [226, 132, 40]]],
    holeColor: [44, 30, 26],
  },
}

function renderTheme(theme) {
  const c = { size: R, px: new Float32Array(R * R * 4) }
  drawBase(c, theme)
  const art = theme.art()

  const mask = new Float32Array(R * R)
  for (const p of art.polys) fillPolygon(R, p, mask)
  const holeMask = new Float32Array(R * R)
  for (const h of art.holes) fillPolygon(R, h, holeMask)
  for (let i = 0; i < mask.length; i++) mask[i] = Math.max(0, mask[i] - holeMask[i])

  paintGlyph(c, mask, theme)

  // 浅色分区（腹部/面部）
  const belly = new Float32Array(R * R)
  for (const b of art.belly) fillPolygon(R, b, belly)
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const i = y * R + x
      const a = Math.min(belly[i], mask[i]) * 0.85
      if (a <= 0) continue
      const t = clamp01((x / R) * 0.5 + (y / R) * 0.8)
      blendPx(c, x, y, sampleStops(theme.bellyColor, t), a)
    }
  }

  // 喙：单独用强调色，是「鹰」区别于其它鸟的唯一特征，必须能看出来
  if (art.beak !== undefined && theme.beakColor !== undefined) {
    const beakMask = new Float32Array(R * R)
    fillPolygon(R, art.beak, beakMask)
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const a = beakMask[y * R + x]
        if (a <= 0) continue
        const t = clamp01((x / R) * 0.4 + (y / R) * 0.8)
        blendPx(c, x, y, sampleStops(theme.beakColor, t), a)
      }
    }
  }

  // 眉脊：压在眼上，用深色。猛禽的「凶」全靠这一块，缺了就是可爱风
  if (art.brow !== undefined) {
    const browMask = new Float32Array(R * R)
    fillPolygon(R, art.brow, browMask)
    for (let y = 0; y < R; y++) {
      for (let x = 0; x < R; x++) {
        const a = browMask[y * R + x]
        if (a <= 0) continue
        blendPx(c, x, y, theme.holeColor, a * 0.92)
      }
    }
  }

  // 眼睛：深色实心（挖洞会露出底色，小尺寸看不见）
  for (let y = 0; y < R; y++) {
    for (let x = 0; x < R; x++) {
      const a = holeMask[y * R + x]
      if (a <= 0) continue
      blendPx(c, x, y, theme.holeColor, a)
    }
  }
  return c
}

function resample(src, target) {
  if (src.size === target) return src
  const ratio = src.size / target
  const out = { size: target, px: new Float32Array(target * target * 4) }
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0
      const y0 = Math.floor(y * ratio), y1 = Math.min(src.size, Math.ceil((y + 1) * ratio))
      const x0 = Math.floor(x * ratio), x1 = Math.min(src.size, Math.ceil((x + 1) * ratio))
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * src.size + sx) * 4
          const al = src.px[i + 3]
          r += src.px[i] * al; g += src.px[i + 1] * al; b += src.px[i + 2] * al
          a += al; n++
        }
      }
      const di = (y * target + x) * 4
      if (a <= 0 || n === 0) continue
      out.px[di] = r / a; out.px[di + 1] = g / a; out.px[di + 2] = b / a
      out.px[di + 3] = a / n
    }
  }
  return out
}

function encode(c) {
  const w = c.size, h = c.size
  const raw = Buffer.alloc(w * (h * 4 + 1))
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * 4
      const di = y * (w * 4 + 1) + 1 + x * 4
      raw[di] = Math.round(clamp01(c.px[si] / 255) * 255)
      raw[di + 1] = Math.round(clamp01(c.px[si + 1] / 255) * 255)
      raw[di + 2] = Math.round(clamp01(c.px[si + 2] / 255) * 255)
      raw[di + 3] = Math.round(clamp01(c.px[si + 3]) * 255)
    }
  }
  const crcTable = []
  for (let n = 0; n < 256; n++) { let v = n; for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; crcTable[n] = v >>> 0 }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    let crc = 0xffffffff
    for (const x of body) crc = crcTable[(crc ^ x) & 0xff] ^ (crc >>> 8)
    const cb = Buffer.alloc(4); cb.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([len, body, cb])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}

/*
 * 亮色底候选（用户反馈：现在的深紫黑夜空太暗，要「鲜艳亮点」）。
 *
 * 底变亮之后真正的风险不是好不好看，而是**白兔看不清**：
 * 兔身最亮是 (245,248,255)，如果底色也落在高明度区间，
 * 两者亮度差不够，缩小到 16px 就糊成一片白。
 * 所以四个候选都刻意把底色控制在「饱和但中明度」，
 * 并保留图形外圈的深色投影把兔子从底上「抠」出来。
 */
const BRIGHT_BASES = {
  'vivid-azure': {
    base: [[0, [37, 99, 235]], [0.5, [14, 165, 233]], [1, [6, 182, 212]]],
    blooms: [
      { cx: 0.18, cy: 0.14, r: 0.85, falloff: 2.0, strength: 0.55, color: [96, 165, 250] },
      { cx: 0.86, cy: 0.88, r: 0.8, falloff: 2.0, strength: 0.5, color: [45, 212, 191] },
    ],
  },
  'vivid-violet': {
    base: [[0, [139, 92, 246]], [0.5, [99, 102, 241]], [1, [14, 165, 233]]],
    blooms: [
      { cx: 0.2, cy: 0.16, r: 0.85, falloff: 2.0, strength: 0.55, color: [192, 132, 252] },
      { cx: 0.86, cy: 0.86, r: 0.8, falloff: 2.0, strength: 0.5, color: [34, 211, 238] },
    ],
  },
  'vivid-teal': {
    base: [[0, [13, 148, 136]], [0.5, [6, 182, 212]], [1, [59, 130, 246]]],
    blooms: [
      { cx: 0.2, cy: 0.16, r: 0.85, falloff: 2.0, strength: 0.55, color: [45, 212, 191] },
      { cx: 0.86, cy: 0.86, r: 0.8, falloff: 2.0, strength: 0.5, color: [96, 165, 250] },
    ],
  },
  'vivid-sunset': {
    base: [[0, [236, 72, 153]], [0.5, [168, 85, 247]], [1, [59, 130, 246]]],
    blooms: [
      { cx: 0.2, cy: 0.14, r: 0.85, falloff: 2.0, strength: 0.55, color: [251, 146, 60] },
      { cx: 0.86, cy: 0.86, r: 0.8, falloff: 2.0, strength: 0.5, color: [129, 140, 248] },
    ],
  },
}

if (process.argv.includes('--bright-preview')) {
  const previewDir = 'release/icon-preview'
  mkdirSync(previewDir, { recursive: true })
  const cells = []
  for (const [name, patch] of Object.entries(BRIGHT_BASES)) {
    const theme = { ...THEMES.K, ...patch }
    const big = resample(renderTheme(theme), 256)
    writeFileSync(previewDir + '/' + name + '-256.png', encode(big))
    writeFileSync(previewDir + '/' + name + '-64.png', encode(resample(big, 64)))
    writeFileSync(previewDir + '/' + name + '-16.png', encode(resample(big, 16)))
    cells.push({ name, img: big })
    console.log('bright ' + name + ' ok')
  }
  // 拼图：4 列 × 2 行（256 原尺寸 / 64 放大 3 倍）
  const CELL = 260
  const W = CELL * 4, H = CELL * 2
  const sheet = { size: W, px: new Float32Array(W * H * 4) }
  for (let i = 0; i < W * H; i++) { sheet.px[i * 4] = 246; sheet.px[i * 4 + 1] = 247; sheet.px[i * 4 + 2] = 250; sheet.px[i * 4 + 3] = 1 }
  cells.forEach((cell, col) => {
    const variants = [[256, 1], [64, 3]]
    variants.forEach(([size, zoom], row) => {
      const img = size === 256 ? cell.img : resample(cell.img, size)
      const shown = size * zoom
      const ox = col * CELL + Math.floor((CELL - shown) / 2)
      const oy = row * CELL + Math.floor((CELL - shown) / 2)
      for (let y = 0; y < shown; y++) {
        for (let x = 0; x < shown; x++) {
          const sx = Math.floor(x / zoom), sy = Math.floor(y / zoom)
          const si = (sy * size + sx) * 4
          const a = img.px[si + 3]
          if (a <= 0) continue
          const di = ((oy + y) * W + ox + x) * 4
          sheet.px[di] = img.px[si] * a + sheet.px[di] * (1 - a)
          sheet.px[di + 1] = img.px[si + 1] * a + sheet.px[di + 1] * (1 - a)
          sheet.px[di + 2] = img.px[si + 2] * a + sheet.px[di + 2] * (1 - a)
          sheet.px[di + 3] = a + sheet.px[di + 3] * (1 - a)
        }
      }
    })
  })
  writeFileSync(previewDir + '/bright-contact.png', encode(sheet))
  console.log('bright contact ok')
  process.exit(0)
}

const outDir = 'release/icon-preview'
mkdirSync(outDir, { recursive: true })
const sizes = [256, 64, 32, 16]
const rendered = {}
for (const [key, theme] of Object.entries(THEMES)) {
  const big = resample(renderTheme(theme), 256)
  rendered[key] = big
  for (const s of sizes) {
    const img = s === 256 ? big : resample(big, s)
    writeFileSync(outDir + '/v4-' + key + '-' + s + '.png', encode(img))
  }
  console.log('v4 ' + key + ' (' + theme.name + ') ok')
}

const CELL = 320
const W = CELL * 3, H = CELL * 3
const sheet = { size: W, px: new Float32Array(W * H * 4) }
for (let i = 0; i < W * H; i++) { sheet.px[i * 4] = 243; sheet.px[i * 4 + 1] = 245; sheet.px[i * 4 + 2] = 249; sheet.px[i * 4 + 3] = 1 }
const keys = Object.keys(THEMES)
const rows = [[256, 1], [64, 4], [16, 8]]
for (let col = 0; col < 3; col++) {
  for (let row = 0; row < 3; row++) {
    const [size, zoom] = rows[row]
    const img = size === 256 ? rendered[keys[col]] : resample(rendered[keys[col]], size)
    const shown = size * zoom
    const ox = col * CELL + Math.floor((CELL - shown) / 2)
    const oy = row * CELL + Math.floor((CELL - shown) / 2)
    for (let y = 0; y < shown; y++) {
      for (let x = 0; x < shown; x++) {
        const sx = Math.floor(x / zoom), sy = Math.floor(y / zoom)
        const si = (sy * size + sx) * 4
        const a = img.px[si + 3]
        if (a <= 0) continue
        const di = ((oy + y) * W + ox + x) * 4
        sheet.px[di] = img.px[si] * a + sheet.px[di] * (1 - a)
        sheet.px[di + 1] = img.px[si + 1] * a + sheet.px[di + 1] * (1 - a)
        sheet.px[di + 2] = img.px[si + 2] * a + sheet.px[di + 2] * (1 - a)
        sheet.px[di + 3] = a + sheet.px[di + 3] * (1 - a)
      }
    }
  }
}
writeFileSync(outDir + '/v4-contact.png', encode(sheet))
console.log('contact ok')

/*
 * 正式图标：用户选定「野兔」（K）。
 *
 * 为什么把「选定」写死在生成器里而不是手工复制 PNG：
 * electron-builder 的 Windows 图标要求源图 ≥256×256，且托盘/任务栏/安装包
 * 全都读这同一份文件。写死在这里，下次改形状只要重跑一次脚本，
 * 不会出现「换了设计但只换了预览、忘了换正式图」。
 */
const finalPng = encode(rendered.K)
writeFileSync('resources/icon.png', finalPng)
console.log('resources/icon.png written (' + rendered.K.size + 'px)')

/*
 * 同一份字节再写给顶栏用（src/assets/app-icon.png）。
 *
 * 为什么不在渲染层另画一套 SVG：exe/任务栏/托盘/顶栏必须是同一个形象，
 * 两处各存一份素材，改动时只要漏一处就变成「顶栏还是旧兔子」，
 * 而这种不一致要靠肉眼才发现。这里是**同一份 PNG**，物理上不可能漂移。
 * Vite 会把它 inline/emit 进 dist/assets，CSP 的 img-src 'self' 正好放行。
 */
mkdirSync('src/assets', { recursive: true })
writeFileSync('src/assets/app-icon.png', finalPng)
console.log('src/assets/app-icon.png written')

