// Bouba/kiki identicons: 100 deterministic glyphs indexed by seed 0-99.
// Even seeds render smooth organic blobs ("bouba"), odd seeds sharp radial
// stars ("kiki") — after the sound-symbolism experiment. The SAME algorithm is
// implemented in Swift on the Apple clients (BoubaKiki.swift); the golden
// values in __tests__/artifacts.test.ts pin this implementation so the two
// can't silently drift.

export const BOUBA_KIKI_GLYPH_COUNT = 100;

// SplitMix64 — deterministic PRNG. Never substitute Math.random(): seed N must
// render the identical glyph on iOS, macOS, and this web gallery.
class SplitMix64 {
  private state: bigint;

  constructor(seed: number) {
    this.state = BigInt(seed) & 0xffffffffffffffffn;
  }

  next(): bigint {
    this.state = (this.state + 0x9e3779b97f4a7c15n) & 0xffffffffffffffffn;
    let z = this.state;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & 0xffffffffffffffffn;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & 0xffffffffffffffffn;
    return z ^ (z >> 31n);
  }

  // Uniform in [0, 1)
  next01(): number {
    return Number(this.next() >> 11n) / 9007199254740992; // 2^53
  }

  nextInt(bound: number): number {
    return Number(this.next() % BigInt(bound));
  }
}

interface Point {
  x: number;
  y: number;
}

function radialPoints(
  rng: SplitMix64,
  n: number,
  radiusFor: (index: number) => number,
  jitterFraction: number
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < n; i++) {
    const base = (2 * Math.PI * i) / n;
    const jitter = (rng.next01() * 2 - 1) * jitterFraction * ((2 * Math.PI) / n);
    const angle = base + jitter;
    const r = radiusFor(i);
    points.push({ x: 0.5 + r * Math.cos(angle), y: 0.5 + r * Math.sin(angle) });
  }
  return points;
}

function fmt(value: number): string {
  return value.toFixed(4).replace(/\.?0+$/, "") || "0";
}

// Closed Catmull-Rom spline through the points, emitted as cubic Béziers
// (tension 0.5) — a smooth blob with no corners anywhere.
function boubaPath(rng: SplitMix64, size: number): string {
  const n = 7 + rng.nextInt(5); // 7-11 points
  const radii: number[] = [];
  for (let i = 0; i < n; i++) radii.push(0.28 + 0.16 * rng.next01());
  const pts = radialPoints(rng, n, (i) => radii[i], 0.25).map((p) => ({
    x: p.x * size,
    y: p.y * size,
  }));

  let d = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n];
    const p1 = pts[i];
    const p2 = pts[(i + 1) % n];
    const p3 = pts[(i + 2) % n];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${fmt(c1x)} ${fmt(c1y)}, ${fmt(c2x)} ${fmt(c2y)}, ${fmt(p2.x)} ${fmt(p2.y)}`;
  }
  return `${d} Z`;
}

// Alternating outer/inner radial points joined by straight segments — a
// spiky star with corners everywhere.
function kikiPath(rng: SplitMix64, size: number): string {
  const spikes = 5 + rng.nextInt(6); // 5-10 spikes
  const outer = 0.42 + 0.06 * rng.next01();
  const inner = 0.1 + 0.1 * rng.next01();
  const pts = radialPoints(rng, spikes * 2, (i) => (i % 2 === 0 ? outer : inner), 0.15).map(
    (p) => ({ x: p.x * size, y: p.y * size })
  );

  let d = `M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) {
    d += ` L ${fmt(pts[i].x)} ${fmt(pts[i].y)}`;
  }
  return `${d} Z`;
}

// SVG path `d` for glyph `seed` in a size×size viewbox (default unit square).
export function boubaKikiPath(seed: number, size = 1): string {
  const index = ((seed % BOUBA_KIKI_GLYPH_COUNT) + BOUBA_KIKI_GLYPH_COUNT) % BOUBA_KIKI_GLYPH_COUNT;
  const rng = new SplitMix64(index);
  return index % 2 === 0 ? boubaPath(rng, size) : kikiPath(rng, size);
}

// Golden-angle hue walk keeps neighboring seeds visually distinct.
export function boubaKikiColor(seed: number, dark = false): string {
  const hue = (seed * 137.508) % 360;
  return dark ? `hsl(${hue.toFixed(1)}, 70%, 65%)` : `hsl(${hue.toFixed(1)}, 65%, 55%)`;
}

// Stable per-artifact glyph: FNV-1a 64-bit of the id, mod 100. Mirrored in
// Swift (boubaKikiSeed(for:)).
export function boubaKikiSeedForId(id: string): number {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < id.length; i++) {
    hash ^= BigInt(id.charCodeAt(i) & 0xff);
    hash = (hash * prime) & 0xffffffffffffffffn;
  }
  return Number(hash % BigInt(BOUBA_KIKI_GLYPH_COUNT));
}

export function boubaKikiSvg(seed: number, sizePx: number, dark = false): string {
  const d = boubaKikiPath(seed, 100);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${sizePx}" height="${sizePx}" viewBox="0 0 100 100"><path d="${d}" fill="${boubaKikiColor(seed, dark)}"/></svg>`;
}
