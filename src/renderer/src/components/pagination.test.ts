import { describe, expect, it } from "vitest";
import { getPaginationItems } from "./pagination";

describe("pagination helpers", () => {
  it("returns every page for a short list", () => {
    expect(getPaginationItems(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("keeps first and last pages while showing ellipses", () => {
    expect(getPaginationItems(10, 20)).toEqual([1, "ellipsis", 8, 9, 10, 11, 12, "ellipsis", 20]);
  });

  it("clamps the visible window near the end", () => {
    expect(getPaginationItems(20, 20)).toEqual([1, "ellipsis", 16, 17, 18, 19, 20]);
  });
});
