import { z } from 'zod';

const windowSchema = z.object({ usedPercent: z.number().finite().min(0), resetsAt: z.number().finite().nonnegative().nullable().optional() });
const snapshotSchema = z.object({
  primary: windowSchema.nullable().optional(), secondary: windowSchema.nullable().optional(),
  rateLimitReachedType: z.string().nullable().optional(), spendControlReached: z.boolean().nullable().optional(),
  individualLimit: z.object({ remainingPercent: z.number().finite(), resetsAt: z.number().finite() }).nullable().optional(),
});
export type Eligibility = { kind: 'available' | 'limited' | 'unknown'; resetAt: number | null };

export function eligibility(raw: unknown): Eligibility {
  const envelope = z.object({ rateLimits: z.unknown().optional(), rateLimitsByLimitId: z.record(z.string(), z.unknown()).nullable().optional() }).safeParse(raw);
  if (!envelope.success) return { kind: 'unknown', resetAt: null };
  const data = envelope.data;
  // Conservatively require every reported bucket to be usable. Never ignore a weekly/model bucket.
  const values = data.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length ? Object.values(data.rateLimitsByLimitId) : [data.rateLimits];
  let limited = false, unknown = false, missingReset = false;
  const resets: number[] = [];
  for (const value of values) {
    const parsed = snapshotSchema.safeParse(value);
    if (!parsed.success) { unknown = true; continue; }
    const bucket = parsed.data;
    const windows = [bucket.primary, bucket.secondary].filter(w => w != null);
    if (!windows.length) unknown = true;
    const exhausted = windows.filter(w => w.usedPercent >= 100);
    const spendingBlocked = bucket.spendControlReached === true || (bucket.individualLimit?.remainingPercent ?? 100) <= 0;
    if (exhausted.length || bucket.rateLimitReachedType || spendingBlocked) {
      limited = true;
      for (const w of exhausted) {
        if (w.resetsAt != null) resets.push(w.resetsAt * 1000); else missingReset = true;
      }
      if (spendingBlocked && bucket.individualLimit) resets.push(bucket.individualLimit.resetsAt * 1000);
      if (!exhausted.length && !bucket.individualLimit) missingReset = true;
      if (bucket.rateLimitReachedType && bucket.rateLimitReachedType !== 'rate_limit_reached') missingReset = true;
    }
  }
  return { kind: limited ? 'limited' : unknown ? 'unknown' : 'available', resetAt: resets.length && !missingReset ? Math.max(...resets) : null };
}

// Only explicit, timezone-bearing timestamps are accepted as hints from an error.
export function parseResetHint(text: string): number | null {
  const match = text.match(/(?:reset(?:s)?(?:\s+at)?|try again (?:at|after))\s*[:=]?\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i);
  const stamp = match?.[1] ? Date.parse(match[1]) : NaN;
  return Number.isFinite(stamp) ? stamp : null;
}
export function nextCheck(now: number, resetAt: number | null, graceMs: number, failures: number): number {
  if (resetAt !== null && resetAt + graceMs > now) return resetAt + graceMs;
  return now + Math.min(30 * 60_000, 15 * 60_000 * 2 ** Math.min(failures, 2));
}
