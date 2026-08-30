// budget.ts — a ceiling on writes, per principal.
//
// Not a defence against an attacker: anyone holding a key can read all day. It
// is a defence against a *looping agent* — the failure mode where a model
// retries a create in a tight loop and fills a project with rubbish before
// anyone notices. Two windows, because the shapes differ: a burst is a minute
// problem, a stuck loop is a day problem.

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

interface Window {
  startedAt: number;
  count: number;
}

export class WriteBudget {
  private readonly minute = new Map<string, Window>();
  private readonly day = new Map<string, Window>();

  constructor(
    private readonly perMinute: number,
    private readonly perDay: number,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Records one write, or refuses it.
   *
   * Both windows are checked before either is charged, so a call rejected by
   * the daily ceiling does not quietly spend a minute's allowance too.
   */
  consume(principal: string): void {
    this.check(this.minute, principal, 60_000, this.perMinute, "per minute");
    this.check(this.day, principal, 86_400_000, this.perDay, "per day");
    this.commit(this.minute, principal, 60_000);
    this.commit(this.day, principal, 86_400_000);
  }

  /** Remaining allowance, for diagnostics. */
  remaining(principal: string): { minute: number; day: number } {
    return {
      minute: this.perMinute - this.used(this.minute, principal, 60_000),
      day: this.perDay - this.used(this.day, principal, 86_400_000),
    };
  }

  private check(
    windows: Map<string, Window>,
    principal: string,
    spanMs: number,
    limit: number,
    label: string,
  ): void {
    const now = this.now();
    const current = windows.get(principal);
    if (!current || now - current.startedAt >= spanMs) return;

    if (current.count >= limit) {
      const retryIn = Math.ceil((current.startedAt + spanMs - now) / 1000);
      throw new RateLimitError(
        `Write limit reached (${limit} ${label}). Try again in ${retryIn}s.`,
      );
    }
  }

  private commit(windows: Map<string, Window>, principal: string, spanMs: number): void {
    const now = this.now();
    const current = windows.get(principal);
    if (!current || now - current.startedAt >= spanMs) {
      windows.set(principal, { startedAt: now, count: 1 });
      return;
    }
    current.count += 1;
  }

  private used(windows: Map<string, Window>, principal: string, spanMs: number): number {
    const current = windows.get(principal);
    if (!current || this.now() - current.startedAt >= spanMs) return 0;
    return current.count;
  }
}
