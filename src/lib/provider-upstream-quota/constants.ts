/**
 * Shared limits and defaults for upstream quota scheduling.
 * Safe to import from client components (no server-only dependencies).
 */
export const UPSTREAM_QUOTA_THRESHOLD_PERCENT_RANGE = [1, 99] as const;
export const UPSTREAM_QUOTA_PROBE_INTERVAL_MINUTES_RANGE = [1, 1440] as const;

export const UPSTREAM_QUOTA_DEFAULT_THRESHOLD_PERCENT = 10;
export const UPSTREAM_QUOTA_DEFAULT_PROBE_INTERVAL_MINUTES = 10;

/** A snapshot older than this many probe intervals is treated as unknown (never excludes). */
export const UPSTREAM_QUOTA_STALE_INTERVAL_MULTIPLIER = 3;

/** Reactive exhaustion pause lasts this many probe intervals (cleared early by a healthy probe). */
export const UPSTREAM_QUOTA_REACTIVE_PAUSE_INTERVAL_MULTIPLIER = 2;
