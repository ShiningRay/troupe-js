/**
 * 一致性哈希环（DESIGN §6.3，M2）：xxh32 纯 JS 实现（零原生依赖）+ 虚拟节点。
 * 参考实现：hashring/hash_ring.rb 的移植（每 Stage 160 虚拟节点）。
 */

const PRIME1 = 2654435761;
const PRIME2 = 2246822519;
const PRIME3 = 3266489917;
const PRIME4 = 668265263;
const PRIME5 = 374761393;

function rotl(x: number, r: number): number {
  return ((x << r) | (x >>> (32 - r))) >>> 0;
}

function imul32(a: number, b: number): number {
  return Math.imul(a, b) >>> 0;
}

const encoder = new TextEncoder();

/** XXH32（seed=0）——与常见实现向量兼容：""→0x02CC5D05，"abc"→0x32D153FF */
export function xxh32(input: string | Uint8Array): number {
  const b = typeof input === "string" ? encoder.encode(input) : input;
  const n = b.length;
  let i = 0;
  let h: number;

  const read4 = (o: number): number =>
    (b[o] + b[o + 1] * 0x100 + b[o + 2] * 0x10000 + b[o + 3] * 0x1000000) >>> 0;

  if (n >= 16) {
    let v1 = (PRIME1 + PRIME2) >>> 0;
    let v2 = PRIME2;
    let v3 = 0;
    let v4 = (0 - PRIME1) >>> 0;
    for (; i + 16 <= n; i += 16) {
      v1 = imul32(rotl((v1 + imul32(read4(i), PRIME2)) >>> 0, 13), PRIME1);
      v2 = imul32(rotl((v2 + imul32(read4(i + 4), PRIME2)) >>> 0, 13), PRIME1);
      v3 = imul32(rotl((v3 + imul32(read4(i + 8), PRIME2)) >>> 0, 13), PRIME1);
      v4 = imul32(rotl((v4 + imul32(read4(i + 12), PRIME2)) >>> 0, 13), PRIME1);
    }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) >>> 0;
  } else {
    h = PRIME5;
  }

  h = (h + n) >>> 0;
  for (; i + 4 <= n; i += 4) {
    h = imul32(rotl((h + imul32(read4(i), PRIME3)) >>> 0, 17), PRIME4);
  }
  for (; i < n; i++) {
    h = imul32(rotl((h + imul32(b[i], PRIME5)) >>> 0, 11), PRIME1);
  }

  h ^= h >>> 15;
  h = imul32(h, PRIME2);
  h ^= h >>> 13;
  h = imul32(h, PRIME3);
  h ^= h >>> 16;
  return h >>> 0;
}

interface RingPoint {
  h: number;
  node: string;
}

export class HashRing {
  private readonly points: RingPoint[];
  readonly nodes: readonly string[];

  constructor(nodes: Iterable<string>, private readonly replicas = 160) {
    this.nodes = [...new Set(nodes)].sort();
    const pts: RingPoint[] = [];
    for (const node of this.nodes) {
      for (let r = 0; r < replicas; r++) {
        pts.push({ h: xxh32(`${node}#${r}`), node });
      }
    }
    pts.sort((a, b) => a.h - b.h);
    this.points = pts;
  }

  /** key → 归属节点；空环返回 null */
  get(key: string): string | null {
    if (this.points.length === 0) return null;
    const h = xxh32(key);
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.points[mid].h < h) lo = mid + 1;
      else hi = mid;
    }
    const idx = lo === this.points.length ? 0 : lo; // 回绕
    return this.points[idx].node;
  }

  /** 从 hash(node) 位置向后取 k 个不同的其它节点（Roster 探测目标） */
  successors(node: string, k: number): string[] {
    if (this.nodes.length <= 1) return [];
    const h = xxh32(node);
    let lo = 0;
    let hi = this.points.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.points[mid].h < h) lo = mid + 1;
      else hi = mid;
    }
    const out: string[] = [];
    for (let i = 0; i < this.points.length && out.length < k; i++) {
      const cand = this.points[(lo + i) % this.points.length].node;
      if (cand !== node && !out.includes(cand)) out.push(cand);
    }
    return out;
  }
}
