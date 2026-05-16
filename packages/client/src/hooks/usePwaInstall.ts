import { useCallback, useEffect, useState } from "react";

/**
 * Hook to manage PWA installation prompt.
 *
 * The browser fires a `beforeinstallprompt` event when the app meets PWA criteria
 * and can be installed. We capture this event and provide a way to trigger the
 * native install prompt later (e.g., from a settings button).
 */

// Extend Window to include the beforeinstallprompt event
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

declare global {
  interface WindowEventMap {
    beforeinstallprompt: BeforeInstallPromptEvent;
  }
}

// Store the deferred prompt globally so it persists across component remounts
let deferredPrompt: BeforeInstallPromptEvent | null = null;

export interface PwaInstallEnvironment {
  hasNativePrompt: boolean;
  isAppleMobile: boolean;
  isStandalone: boolean;
}

export interface PwaInstallAvailability {
  canInstall: boolean;
  isInstalled: boolean;
  requiresManualInstall: boolean;
}

export function getPwaInstallAvailability({
  hasNativePrompt,
  isAppleMobile,
  isStandalone,
}: PwaInstallEnvironment): PwaInstallAvailability {
  if (isStandalone) {
    return {
      canInstall: false,
      isInstalled: true,
      requiresManualInstall: false,
    };
  }

  return {
    canInstall: hasNativePrompt,
    isInstalled: false,
    requiresManualInstall: !hasNativePrompt && isAppleMobile,
  };
}

function isAppleMobileBrowser() {
  const ua = navigator.userAgent;
  const platform = navigator.platform;
  return (
    /iPad|iPhone|iPod/.test(ua) ||
    (platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

export function usePwaInstall() {
  const [canInstall, setCanInstall] = useState(false);
  const [isInstalled, setIsInstalled] = useState(false);
  const [requiresManualInstall, setRequiresManualInstall] = useState(false);

  useEffect(() => {
    // Check if already installed (standalone mode)
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      // iOS Safari doesn't support display-mode, check navigator
      ("standalone" in navigator &&
        (navigator as { standalone?: boolean }).standalone === true);

    const updateAvailability = (hasNativePrompt: boolean) => {
      const availability = getPwaInstallAvailability({
        hasNativePrompt,
        isAppleMobile: isAppleMobileBrowser(),
        isStandalone,
      });
      setCanInstall(availability.canInstall);
      setIsInstalled(availability.isInstalled);
      setRequiresManualInstall(availability.requiresManualInstall);
    };

    updateAvailability(deferredPrompt !== null);

    if (isStandalone) return;

    // Listen for the install prompt event
    const handleBeforeInstallPrompt = (e: BeforeInstallPromptEvent) => {
      // Prevent the default browser install prompt
      e.preventDefault();
      // Store the event for later use
      deferredPrompt = e;
      updateAvailability(true);
    };

    // Listen for successful installation
    const handleAppInstalled = () => {
      setIsInstalled(true);
      setCanInstall(false);
      setRequiresManualInstall(false);
      deferredPrompt = null;
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener(
        "beforeinstallprompt",
        handleBeforeInstallPrompt,
      );
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferredPrompt) {
      return false;
    }

    // Show the native install prompt
    await deferredPrompt.prompt();

    // Wait for the user's response
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === "accepted") {
      setCanInstall(false);
      deferredPrompt = null;
      return true;
    }

    return false;
  }, []);

  return {
    /** Whether the app can be installed (prompt is available) */
    canInstall,
    /** Whether the app is already installed (running in standalone mode) */
    isInstalled,
    /** Whether this browser requires manual share-sheet installation */
    requiresManualInstall,
    /** Trigger the native install prompt */
    install,
  };
}
