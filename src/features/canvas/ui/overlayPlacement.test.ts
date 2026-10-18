import { describe, expect, it } from "vitest";
import { placeNodeOverlay } from "./overlayPlacement";

describe("node controls stay reachable at viewport boundaries", () => {
  for (const [x, y] of [
    [0, 0],
    [500, 0],
    [1000, 0],
    [0, 350],
    [500, 350],
    [1000, 350],
    [0, 700],
    [500, 700],
    [1000, 700],
  ]) {
    it(`keeps all actions inside the viewport at ${x},${y}`, () => {
      const result = placeNodeOverlay(
        { x, y, width: 200, height: 150 },
        { width: 640, height: 180 },
        { width: 1000, height: 700 },
        "bottom",
      );
      expect(result.x).toBeGreaterThanOrEqual(12);
      expect(result.x + result.width).toBeLessThanOrEqual(988);
      expect(result.y).toBeGreaterThanOrEqual(12);
      expect(result.y + 180).toBeLessThanOrEqual(688);
    });
  }
  it("flips from above to below when the node touches the top", () => {
    expect(
      placeNodeOverlay(
        { x: 200, y: 0, width: 300, height: 100 },
        { width: 400, height: 120 },
        { width: 1000, height: 700 },
        "top",
      ).y,
    ).toBe(116);
  });
  it("limits the control width in compact workspaces", () => {
    expect(
      placeNodeOverlay(
        { x: 0, y: 0, width: 100, height: 100 },
        { width: 1000, height: 120 },
        { width: 375, height: 600 },
        "bottom",
      ).width,
    ).toBe(351);
  });
});
