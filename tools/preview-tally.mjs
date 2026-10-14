// Tally rules for the HLS selection preview evidence run.
// A skipped check is never counted as executed success: "succeeded" only covers
// checks that actually ran, and "complete" additionally requires zero skips.
export function summarizeResults(results) {
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const item of results) {
    const status = item?.status === "passed" || item?.status === "failed" || item?.status === "skipped" ? item.status : "failed";
    counts[status] += 1;
  }
  return {
    ...counts,
    total: results.length,
    succeeded: counts.failed === 0 && counts.passed > 0,
    complete: counts.failed === 0 && counts.skipped === 0 && counts.passed === results.length && counts.passed > 0
  };
}
