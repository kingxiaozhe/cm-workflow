// Admission policy only, not evidence of native platform validation.
// Both targets require POSIX locks, no-follow opens and file/directory fsync.
// Keep this free of node:sqlite so CLI entrypoints can reject older Node first.
export function isSupportedExecutionPlatform(platform=process.platform,nodeVersion=process.versions.node) {
  const [major,minor]=nodeVersion.split('.').map(Number);
  return ['darwin','linux'].includes(platform) && (major>24 || (major===24 && minor>=14));
}
