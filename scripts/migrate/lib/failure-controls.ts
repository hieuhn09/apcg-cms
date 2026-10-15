/**
 * `--stop-after-failures N` (consecutive create failures) and the media
 * failure budget (gtp-launch P4, 7.2 step 13, 7.5, A12-N08/G51). Pure.
 */
export const FAILURE_MESSAGES = {
  consecutive: (n: number) => `import: ${n} consecutive failures reached --stop-after-failures; stopping (exit 2).`,
  mediaBudget: (pct: number, failed: number, total: number) =>
    `import: media failures ${failed}/${total} exceed the failure budget of ${pct}% of unique images; stopping (exit 2).`,
} as const;

export class FailureControls {
  private consecutive = 0;
  mediaAttempts = 0;
  mediaFailures = 0;
  constructor(readonly stopAfter: number, readonly budgetPercent: number, readonly minMediaSample = 50) {}
  recordArticle(ok: boolean): void {
    this.consecutive = ok ? 0 : this.consecutive + 1;
  }
  recordMedia(ok: boolean): void {
    this.mediaAttempts++;
    if (!ok) this.mediaFailures++;
  }
  /** Returns a stop message or null. The budget is judged once at least `minMediaSample` unique images were attempted. */
  stopReason(): string | null {
    if (this.consecutive >= this.stopAfter) return FAILURE_MESSAGES.consecutive(this.stopAfter);
    if (this.mediaAttempts >= this.minMediaSample && this.mediaAttempts > 0) {
      if ((this.mediaFailures / this.mediaAttempts) * 100 > this.budgetPercent) {
        return FAILURE_MESSAGES.mediaBudget(this.budgetPercent, this.mediaFailures, this.mediaAttempts);
      }
    }
    return null;
  }
}
