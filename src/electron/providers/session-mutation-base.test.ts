import { describe, expect, it } from "vitest";
import { mutationBatchResult, planSessionMutationBatch } from "./session-mutation-base";

describe("session-mutation-base", () => {
  it("空批次不执行解析器", async () => {
    let called = false;
    const plans = await planSessionMutationBatch([], "active", async () => {
      called = true;
      throw new Error("不应执行");
    });

    expect(plans).toEqual([]);
    expect(called).toBe(false);
  });

  it("保持输入顺序并转换为批量结果", async () => {
    const plans = await planSessionMutationBatch(
      [{ id: "one" }, { id: "two" }],
      "active",
      async (session, view) => ({
        session,
        source: `${view}:${session.id}`,
        result: { ...session, filePath: `${view}:${session.id}`, movedTo: `trash:${session.id}` }
      })
    );

    expect(plans.map((plan) => plan.source)).toEqual(["active:one", "active:two"]);
    expect(mutationBatchResult(plans)).toEqual({
      processed: [
        { id: "one", filePath: "active:one", movedTo: "trash:one" },
        { id: "two", filePath: "active:two", movedTo: "trash:two" }
      ]
    });
  });
});
