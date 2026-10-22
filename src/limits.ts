// Every hard limit in the extension (implementation plan 2.6). Each is
// enforced by code and tested at its edge; change a value here and in the plan.

/** One re-parse per pause in typing. */
export const INDEX_DEBOUNCE_MS = 250;
/** Save All fires one save per file in a burst; lint each file once. */
export const LINT_DEBOUNCE_MS = 300;
/** At least 3x the slowest measured lint p95 (B2.5). */
export const LINT_TIMEOUT_MS = 20_000;
export const ACTIONS_TIMEOUT_MS = 20_000;
export const LIST_TIMEOUT_MS = 20_000;
/** A cold cargo or dotnet build of a binding. */
export const BUILD_TIMEOUT_MS = 600_000;
/** Build-Schema.ps1 regenerates a 10141-line schema. */
export const SCHEMA_TIMEOUT_MS = 120_000;
export const MAX_TOOL_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_STDERR_BYTES = 64 * 1024;
/** The largest real binding source is 179 KB and the largest suite 68 KB. */
export const MAX_INDEXED_FILE_BYTES = 1024 * 1024;
/** Files the initial scan reads at once: at start-up every extension opens files, and EMFILE was hit with no cap. */
export const INDEX_READ_CONCURRENCY = 8;
/** Runs of one read that fails with EMFILE/ENFILE/EBUSY/EAGAIN, pausing 50, 100, 200, 400, 800 ms between them. */
export const INDEX_READ_ATTEMPTS = 6;
export const INDEX_READ_RETRY_BASE_MS = 50;
/** After the scan, the files that still could not be read are read once more, this much later. */
export const INDEX_RESCAN_DELAY_MS = 3_000;
/** The format's own nesting limit (yml_suite_design.md DEC-Y10). */
export const META_DEPTH_LIMIT = 5;
export const KILL_GRACE_MS = 1_000;
export const LIVE_LINT_DEBOUNCE_MS = 400;
export const WORKER_LINT_TIMEOUT_MS = 5_000;
export const WORKER_MAX_CONSECUTIVE_FAILURES = 3;
export const LIBRARY_API_MAJOR = 1;
