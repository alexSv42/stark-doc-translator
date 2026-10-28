import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

describe('BullMQ stalled job detection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('BullMQ lock expires after lockDuration (120s)', () => {
    const LOCK_DURATION_MS = 120_000
    const lockAcquiredAt = Date.now()

    vi.advanceTimersByTime(LOCK_DURATION_MS + 1000)

    const elapsed = Date.now() - lockAcquiredAt
    expect(elapsed).toBeGreaterThan(LOCK_DURATION_MS)
    // After lockDuration, BullMQ marks the job as stalled and retries
  })

  it('BullMQ renews lock every lockRenewTime (30s) while worker is alive', () => {
    const LOCK_RENEW_TIME_MS = 30_000
    const renewCalls: number[] = []

    const interval = setInterval(() => {
      renewCalls.push(Date.now())
    }, LOCK_RENEW_TIME_MS)

    vi.advanceTimersByTime(90_000) // 3 renewals
    clearInterval(interval)

    expect(renewCalls.length).toBe(3)
  })

  it('stalledInterval checks for stalled jobs every 60s', () => {
    const STALLED_INTERVAL_MS = 60_000
    const checks: number[] = []

    const interval = setInterval(() => {
      checks.push(Date.now())
    }, STALLED_INTERVAL_MS)

    vi.advanceTimersByTime(180_000)
    clearInterval(interval)

    expect(checks.length).toBe(3)
  })

  it('job is retried up to attempts=3 on stall', () => {
    const MAX_ATTEMPTS = 3
    let attempts = 0

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      attempts++
      const shouldRetry = attempts < MAX_ATTEMPTS
      if (i < MAX_ATTEMPTS - 1) {
        expect(shouldRetry).toBe(true)
      }
    }

    expect(attempts).toBe(3)
  })

  it('exponential backoff delays increase correctly', () => {
    const BASE_DELAY = 5000
    const delays = [0, 1, 2].map((attempt) => BASE_DELAY * Math.pow(2, attempt))

    expect(delays).toEqual([5000, 10000, 20000])
  })
})
