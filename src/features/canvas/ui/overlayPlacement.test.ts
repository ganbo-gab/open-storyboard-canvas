import { describe, expect, it } from "vitest";
import { placeNodeOverlay, placePanelAnchor } from "./overlayPlacement";

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

describe("node tool panels open where they fit", () => {
  // Panels render at (trigger left, trigger bottom + 6).
  const panelTop = (anchor: { y: number; height: number }) => anchor.y + anchor.height + 6;
  const trigger = { x: 100, y: 600, width: 80, height: 30 };
  const viewport = { width: 1000, height: 900 };

  it("keeps the trigger when the panel fits below it", () => {
    expect(placePanelAnchor({ ...trigger, y: 100 }, { width: 300, height: 300 }, viewport)).toEqual({ ...trigger, y: 100 });
  });

  it("opens above the trigger when the panel would run off the bottom", () => {
    const top = panelTop(placePanelAnchor(trigger, { width: 300, height: 400 }, viewport));
    expect(top).toBe(600 - 6 - 400);
  });

  it("pins a panel taller than either side to the bottom inset", () => {
    const top = panelTop(placePanelAnchor({ ...trigger, y: 300 }, { width: 300, height: 700 }, viewport));
    expect(top).toBe(900 - 8 - 700);
  });

  it("slides a panel opened near the right edge back inside the viewport", () => {
    expect(placePanelAnchor({ ...trigger, x: 900, y: 100 }, { width: 320, height: 300 }, viewport).x).toBe(1000 - 8 - 320);
  });
});
