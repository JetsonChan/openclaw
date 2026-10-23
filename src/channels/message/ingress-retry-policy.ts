/**
 * Generic ingress retry backoff and dead-letter decisions.
 *
 * Channel-specific non-retryable classification stays out of core; pass it in.
 */
import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { PreparedModelRuntimeRecoveryError } from "../../agents/prepared-model-runtime-admission-errors.js";
import { SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE } from "../../config/sessions/work-start-error.js";
import { computeBackoff } from "../../infra/backoff.js";
import { decodeIngressRetryError } from "./ingress-queue.codec.js";
import type { ChannelIngressRetryState } from "./ingress-queue.types.js";

export const DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS = 8;
export const DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_INGRESS_RETRY_BASE_MS = 1_000;
export const DEFAULT_INGRESS_RETRY_MAX_MS = 3 * 60_000;

export type IngressRetryPolicyConfig = {
  maxAttempts?: number;
  deadLetterMinAgeMs?: number;
  baseMs?: number;
  maxMs?: number;
};

type IngressRetryEventFacts = {
  receivedAt: number;
  attempts?: number;
  lastAttemptAt?: number;
  lastError?: string;
  retry?: ChannelIngressRetryState;
};

export type IngressNonRetryableFailure = {
  reason: string;
  message: string;
};

type IngressFailureDisposition =
  | {
      kind: "fail";
      reason: string;
      message: string;
      attempt: number;
    }
  | {
      kind: "release";
      attempt: number;
      message: string;
      recordAttempt?: boolean;
      retry?: ChannelIngressRetryState;
    };

/** Remaining backoff delay before a released event may be claimed again. */
export function resolveIngressRetryDelayMs(
  event: IngressRetryEventFacts,
  config?: IngressRetryPolicyConfig,
  now = Date.now(),
): number {
  const retry = event.retry ?? decodeIngressRetryError(event.lastError).retry;
  if (retry?.nextEligibleAt !== undefined) {
    return Math.max(0, retry.nextEligibleAt - now);
  }
  const baseMs = config?.baseMs ?? DEFAULT_INGRESS_RETRY_BASE_MS;
  const maxMs = config?.maxMs ?? DEFAULT_INGRESS_RETRY_MAX_MS;
  const attempts = event.attempts ?? 0;
  if (!event.lastError || event.lastAttemptAt === undefined || attempts <= 0) {
    return 0;
  }
  const delayMs = computeBackoff(
    { initialMs: baseMs, maxMs, factor: 2, jitter: 0 },
    Math.min(attempts, 9),
  );
  return Math.max(0, event.lastAttemptAt + delayMs - now);
}

/**
 * Dead-letter requires BOTH attempt floor and minimum age.
 * Over-limit events keep retrying at the capped delay until age is met.
 */
export function shouldDeadLetterRetryableIngressEvent(
  event: IngressRetryEventFacts,
  attempt: number,
  config?: IngressRetryPolicyConfig,
  now = Date.now(),
): boolean {
  const maxAttempts = config?.maxAttempts ?? DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS;
  const deadLetterMinAgeMs =
    config?.deadLetterMinAgeMs ?? DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS;
  return attempt >= maxAttempts && now - event.receivedAt >= deadLetterMinAgeMs;
}

/** Resolve release vs fail for a dispatch error using optional non-retryable hook. */
export function resolveIngressFailureDisposition(params: {
  err: unknown;
  event: IngressRetryEventFacts;
  formatError: (err: unknown) => string;
  resolveNonRetryableFailure?: (err: unknown) => IngressNonRetryableFailure | null;
  config?: IngressRetryPolicyConfig;
  now?: number;
}): IngressFailureDisposition {
  const now = params.now ?? Date.now();
  const attempt = (params.event.attempts ?? 0) + 1;
  const message = params.formatError(params.err);
  const nonRetryable = params.resolveNonRetryableFailure?.(params.err) ?? null;
  if (nonRetryable) {
    return {
      kind: "fail",
      reason: nonRetryable.reason,
      message: nonRetryable.message,
      attempt,
    };
  }
  const errors = collectNestedErrorCandidates(params.err);
  const previousRetry = params.event.retry ?? decodeIngressRetryError(params.event.lastError).retry;
  const recovery = errors.find(
    (error): error is PreparedModelRuntimeRecoveryError =>
      error instanceof PreparedModelRuntimeRecoveryError,
  );
  if (recovery) {
    const attempted = recovery.reason === "attempt-failed";
    const recoveryFailures = (previousRetry?.recoveryFailures ?? 0) + (attempted ? 1 : 0);
    if (attempted && recoveryFailures >= 2) {
      return { kind: "fail", reason: "runtime-recovery-failed", message, attempt };
    }
    return {
      kind: "release",
      attempt: attempted ? attempt : (params.event.attempts ?? 0),
      message,
      recordAttempt: attempted,
      retry: { recoveryFailures, nextEligibleAt: recovery.nextEligibleAt },
    };
  }
  const errorCodes = new Set(errors.map(extractErrorCode));
  // Retrying this terminal generation blocks the authorized reset behind it.
  const reason = errorCodes.has(SESSION_RESTART_RECOVERY_TOMBSTONE_ERROR_CODE)
    ? "restart-recovery-tombstone"
    : shouldDeadLetterRetryableIngressEvent(params.event, attempt, params.config, now)
      ? "retry-limit-exceeded"
      : undefined;
  return reason
    ? { kind: "fail", reason, message, attempt }
    : {
        kind: "release",
        attempt,
        message,
        ...(previousRetry ? { retry: { recoveryFailures: previousRetry.recoveryFailures } } : {}),
      };
}
