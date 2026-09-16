/** static rpc 允许清单（§8.2 最小暴露面）：声明后仅列出的方法可远程调用 */
import { afterEach, describe, expect, it } from "vitest";
import { Actor, Troupe } from "../src/index.js";

class VaultActor extends Actor<{ secret: string }> {
  static initialProps = () => ({ secret: "" });
  /** 只暴露只读检查；写方法不进 RPC 面 */
  static rpc = ["peek"];

  async peek(): Promise<string> {
    return "ok";
  }

  async writeSecret(v: string): Promise<void> {
    this.props.secret = v;
    await this.saveProps();
  }
}

class OpenActor extends Actor<{ n: number }> {
  static initialProps = () => ({ n: 0 });
  async inc(): Promise<void> {
    this.props.n++;
  }
  async get(): Promise<number> {
    return this.props.n;
  }
}

let troupe: Troupe | undefined;
afterEach(async () => {
  if (troupe) {
    await troupe.drainAll();
    await troupe.shutdown();
    troupe = undefined;
  }
});

describe("static rpc 允许清单", () => {
  it("清单外的方法不暴露：本地 Agent 无此成员，wire 层拒绝（reason=whitelist）", async () => {
    troupe = await Troupe.form({ actors: [VaultActor, OpenActor] });
    const vault = troupe.cast(VaultActor, "v1");
    await expect(vault.peek()).resolves.toBe("ok");
    // Agent 代理按 rpcMethods 构建：清单外方法直接不存在（wire 远程调用则被
    // stage-manager 以 CallRejectedError("whitelist") 拒绝）
    expect((vault as unknown as Record<string, unknown>)["writeSecret"]).toBeUndefined();
    expect(troupe.methodsOf("Vault")).toEqual(["peek"]);

    // 未声明 static rpc 的角色保持默认：公开方法全可调用
    const open = troupe.cast(OpenActor, "o1");
    await open.inc();
    await expect(open.get()).resolves.toBe(1);
    expect(troupe.methodsOf("Open").sort()).toEqual(["get", "inc"]);
  });

  it("清单列出未知方法名 → form 阶段 fail-fast", async () => {
    class BadActor extends Actor<{ n: number }> {
      static initialProps = () => ({ n: 0 });
      static rpc = ["nope"];
      async go(): Promise<void> {}
    }
    await expect(Troupe.form({ actors: [BadActor] })).rejects.toBeInstanceOf(TypeError);
  });
});
