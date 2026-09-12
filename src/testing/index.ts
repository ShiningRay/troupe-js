import { Troupe, type TroupeOptions } from "../troupe.js";
import type { Actor, ActorCtor } from "../core/actor.js";
import type { Agent } from "../core/agent.js";
import type { TroupeEvent, RoleMetricsSnapshot } from "../core/events.js";
import { InMemoryPropStore } from "../props/memory.js";

/**
 * Rehearsal（DESIGN §2 测试集群）：强制 InMemoryPropStore 的 Troupe 包装。
 * NODE_ENV=test 下 Troupe.form() 同样零配置全 InMemory（DESIGN §8.2）。
 */
export class Rehearsal {
  private constructor(readonly troupe: Troupe) {}

  static async form(opts: TroupeOptions = {}): Promise<Rehearsal> {
    const troupe = await Troupe.form({
      ...opts,
      propStore: opts.propStore ?? new InMemoryPropStore(),
    });
    return new Rehearsal(troupe);
  }

  cast<T extends Actor<any>>(ctor: ActorCtor<T>, stageName: string): Agent<T>;
  cast<T extends Actor<any>>(roleId: string, stageName: string): Agent<T>;
  cast<T extends Actor<any>>(first: ActorCtor<T> | string, stageName: string): Agent<T> {
    return this.troupe.cast(first as ActorCtor<T>, stageName);
  }

  get events() {
    return this.troupe.events;
  }

  metrics(): Record<string, RoleMetricsSnapshot> {
    return this.troupe.metrics.snapshot();
  }

  onEvent(listener: (e: TroupeEvent) => void): () => void {
    return this.troupe.events.on(listener);
  }

  repertoire(): string[] {
    return this.troupe.repertoire();
  }

  off(roleId: string, stageName: string): Promise<void> {
    return this.troupe.off(roleId, stageName);
  }

  async drainAll(): Promise<void> {
    await this.troupe.drainAll();
  }

  slots(): ReturnType<Troupe["slots"]> {
    return this.troupe.slots();
  }
}
