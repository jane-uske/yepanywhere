import { describe, expect, it } from "vitest";
import { getPwaInstallAvailability } from "../usePwaInstall";

describe("getPwaInstallAvailability", () => {
  it("shows manual install instructions on iOS when native prompt is unavailable", () => {
    expect(
      getPwaInstallAvailability({
        hasNativePrompt: false,
        isAppleMobile: true,
        isStandalone: false,
      }),
    ).toEqual({
      canInstall: false,
      isInstalled: false,
      requiresManualInstall: true,
    });
  });

  it("uses native install prompt when available", () => {
    expect(
      getPwaInstallAvailability({
        hasNativePrompt: true,
        isAppleMobile: false,
        isStandalone: false,
      }),
    ).toEqual({
      canInstall: true,
      isInstalled: false,
      requiresManualInstall: false,
    });
  });

  it("does not show install actions when already standalone", () => {
    expect(
      getPwaInstallAvailability({
        hasNativePrompt: true,
        isAppleMobile: true,
        isStandalone: true,
      }),
    ).toEqual({
      canInstall: false,
      isInstalled: true,
      requiresManualInstall: false,
    });
  });
});
