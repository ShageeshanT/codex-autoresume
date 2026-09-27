import { z } from 'zod';

export const statusSchema = z.enum(['RUNNING', 'WAITING_FOR_RESET', 'AWAITING_RESET_INFO', 'VERIFYING', 'RESUMING', 'PAUSED', 'COMPLETED', 'CANCELLED']);
export type Status = z.infer<typeof statusSchema>;
export const stateSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  status: statusSchema,
  cwd: z.string(),
  codexPath: z.string(),
  codexVersion: z.string(),
  codexArgs: z.array(z.string()),
  autoContinue: z.boolean(),
  sessionId: z.string().nullable(),
  turnId: z.string().nullable(),
  detectedAt: z.number().finite().nullable(),
  resetAt: z.number().finite().nullable(),
  nextCheckAt: z.number().finite().nullable(),
  resumeAttempts: z.number().int().nonnegative(),
  verificationFailures: z.number().int().nonnegative(),
  fingerprint: z.string().nullable(),
  threadStamp: z.string().nullable(),
  policyStamp: z.string().nullable().default(null),
  claim: z.string().nullable(),
  claimedTurnIds: z.array(z.string()).default([]),
  controlId: z.string().nullable().default(null),
  reason: z.string().nullable(),
  updatedAt: z.number().finite(),
});
export type SessionState = z.infer<typeof stateSchema>;
const transitions: Record<Status, Status[]> = {
  RUNNING: ['WAITING_FOR_RESET', 'AWAITING_RESET_INFO', 'COMPLETED', 'PAUSED', 'CANCELLED'],
  WAITING_FOR_RESET: ['VERIFYING', 'PAUSED', 'CANCELLED'],
  AWAITING_RESET_INFO: ['VERIFYING', 'PAUSED', 'CANCELLED'],
  VERIFYING: ['WAITING_FOR_RESET', 'AWAITING_RESET_INFO', 'RESUMING', 'PAUSED', 'CANCELLED'],
  RESUMING: ['RUNNING', 'PAUSED', 'CANCELLED'],
  PAUSED: ['CANCELLED'], COMPLETED: [], CANCELLED: [],
};
export function transition(state: SessionState, status: Status, patch: Partial<SessionState> = {}): SessionState {
  if (status !== state.status && !transitions[state.status].includes(status)) {
    throw new Error(`Invalid transition: ${state.status} -> ${status}`);
  }
  return stateSchema.parse({ ...state, ...patch, status, updatedAt: Date.now() });
}
export function isWaiting(state: SessionState): boolean {
  return ['WAITING_FOR_RESET', 'AWAITING_RESET_INFO', 'VERIFYING'].includes(state.status);
}
