import { describe, expect, it } from "vitest";
import { getDisplayModeClassState } from "../displayMode";

describe("getDisplayModeClassState", () => {
  it("does not mark a regular Safari tab as edge-to-edge", () => {
    expect(
      getDisplayModeClassState({
        isStandalone: false,
        isTauri: false,
      }),
    ).toEqual({
      isStandalone: false,
      isTauri: false,
      isEdgeToEdge: false,
    });
  });

  it("marks standalone PWA as edge-to-edge", () => {
    expect(
      getDisplayModeClassState({
        isStandalone: true,
        isTauri: false,
      }).isEdgeToEdge,
    ).toBe(true);
  });

  it("marks Tauri mobile shell as edge-to-edge", () => {
    expect(
      getDisplayModeClassState({
        isStandalone: false,
        isTauri: true,
      }).isEdgeToEdge,
    ).toBe(true);
  });
});
