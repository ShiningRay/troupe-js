import { HashRing } from "./hash-ring.js";

/**
 * Playbill（DESIGN §6.3）：纯一致性哈希寻址，无目录。
 * HashRing 只回答"候选归谁"；所有权确认在生产集群由 §6.5 契约承担（M3）。
 */
export class Playbill {
  private ring: HashRing;

  constructor(
    private readonly namespace: string,
    nodes: string[] = [],
  ) {
    this.ring = new HashRing(nodes);
  }

  setMembers(nodes: string[]): void {
    this.ring = new HashRing(nodes);
  }

  ownerOf(roleId: string, stageName: string): string | null {
    return this.ring.get(`${this.namespace}:${roleId}:${stageName}`);
  }

  /** 任意原始键的归属（Show 话题等：`show:<topic>`） */
  ownerOfKey(rawKey: string): string | null {
    return this.ring.get(`${this.namespace}:${rawKey}`);
  }

  /** 候选序列（ADR 0004 §3：首候选发起冷键 claim；环不做归属裁决） */
  candidates(roleId: string, stageName: string): string[] {
    return this.ring.candidates(`${this.namespace}:${roleId}:${stageName}`);
  }
}
