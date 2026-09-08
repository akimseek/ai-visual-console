import { describe, expect, it } from "vitest";
import { mergeKnownTarget } from "./use-provider-targets";
import type { AiTarget } from "../types";

const localTarget: AiTarget = {
  id: "codex:local",
  provider: "codex",
  label: "本地",
  kind: "local",
  available: true
};

describe("provider target tab synchronization", () => {
  it("merges a terminal tab target snapshot without discarding known targets", () => {
    const wslTarget: AiTarget = {
      id: "codex:wsl:Ubuntu",
      provider: "codex",
      label: "Ubuntu",
      kind: "wsl",
      distro: "Ubuntu",
      available: true
    };

    expect(mergeKnownTarget([localTarget], wslTarget)).toEqual([localTarget, wslTarget]);
  });

  it("replaces a stale target snapshot in memory", () => {
    const unavailable = { ...localTarget, available: false };
    expect(mergeKnownTarget([unavailable], localTarget)).toEqual([localTarget]);
  });
});
