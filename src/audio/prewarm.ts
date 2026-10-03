/**
 * Audio output warm-up. The first `new AudioContext()` of a browser session blocks the main thread while the
 * browser starts its audio service and queries the output device (~130-250 ms in Chromium on macOS). The
 * game creates its context inside the «В ЗАЕЗД» click (autoplay policy), so that cost used to freeze the
 * garage for a moment on start.
 *
 * `navigator.mediaDevices.enumerateDevices()` starts the same audio service asynchronously, needs no
 * permission and no user gesture, and shows no prompt or indicator (without a granted permission it only
 * lists anonymous default devices). Calling it during loading leaves the later context creation at a few ms.
 */

/** The part of `navigator` the warm-up uses (absent outside secure contexts and in node). */
export interface MediaDevicesHost {
  mediaDevices?: { enumerateDevices?: () => Promise<unknown> };
}

/** Starts the browser's audio output in the background. Never throws; a missing API is a no-op. */
export function prewarmAudioOutput(host: MediaDevicesHost | undefined = globalThis.navigator): void {
  try {
    const devices = host?.mediaDevices;
    if (typeof devices?.enumerateDevices !== 'function') return;
    devices.enumerateDevices().catch(() => {});
  } catch {
    // Warm-up only: the context is still created on unlock().
  }
}
