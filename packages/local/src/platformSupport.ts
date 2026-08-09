/**
 * Beta platform support: macOS + Windows only, per the decision in
 * https://github.com/memora-hq/memora-local/issues/12. `node-pty` has no Linux prebuilds
 * (issues/2) and compile-on-install does not count as supported behavior even when it happens
 * to succeed — Linux is refused outright, not degraded.
 */
const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32"]);

export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

export function unsupportedPlatformMessage(platform: NodeJS.Platform = process.platform): string {
  return [
    "Memora Local beta currently supports:",
    "  ✓ macOS",
    "  ✓ Windows",
    "",
    `Linux support is not available in this beta (detected platform: ${platform}).`,
    "",
    "Why?",
    "Memora Local depends on native terminal integration that does not",
    "yet have a reliable zero-setup Linux installation path.",
    "",
    "Follow Linux support:",
    "https://github.com/memora-hq/memora-local/issues/12",
  ].join("\n");
}
