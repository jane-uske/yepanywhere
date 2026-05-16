export interface DisplayModeEnvironment {
  isStandalone: boolean;
  isTauri: boolean;
}

export interface DisplayModeClassState extends DisplayModeEnvironment {
  isEdgeToEdge: boolean;
}

type WindowWithStandaloneAndTauri = Window & {
  navigator: Navigator & { standalone?: boolean };
  __TAURI__?: unknown;
  __TAURI_INTERNALS__?: unknown;
};

export function getDisplayModeClassState(
  environment: DisplayModeEnvironment,
): DisplayModeClassState {
  return {
    ...environment,
    isEdgeToEdge: environment.isStandalone || environment.isTauri,
  };
}

export function readDisplayModeEnvironment(
  targetWindow: Window = window,
): DisplayModeEnvironment {
  const currentWindow = targetWindow as WindowWithStandaloneAndTauri;
  const standaloneMedia = currentWindow.matchMedia?.(
    "(display-mode: standalone)",
  );

  return {
    isStandalone:
      standaloneMedia?.matches === true ||
      currentWindow.navigator.standalone === true,
    isTauri:
      currentWindow.__TAURI__ !== undefined ||
      currentWindow.__TAURI_INTERNALS__ !== undefined,
  };
}

export function applyDisplayModeClasses(
  root: HTMLElement,
  state: DisplayModeClassState,
) {
  root.classList.toggle("is-standalone", state.isStandalone);
  root.classList.toggle("is-tauri", state.isTauri);
  root.classList.toggle("is-edge-to-edge", state.isEdgeToEdge);
}

export function initializeDisplayModeClasses(
  targetDocument: Document = document,
  targetWindow: Window = window,
) {
  const update = () => {
    applyDisplayModeClasses(
      targetDocument.documentElement,
      getDisplayModeClassState(readDisplayModeEnvironment(targetWindow)),
    );
  };

  update();

  targetWindow
    .matchMedia?.("(display-mode: standalone)")
    .addEventListener?.("change", update);
}
