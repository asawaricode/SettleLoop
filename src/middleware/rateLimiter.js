// src/middleware/rateLimiter.js
//
// Phase 4 — Express rate-limiter configurations.
//
// Three named limiters exported, each tuned to its route class:
//   apiLimiter         → /api/*        (100 req / 15 min in production)
//   webhookLimiter     → webhook route (30  req / min   in production)
//   manualOrderLimiter → order route   (10  req / 15 min in production)
//
// Limits are only enforced in NODE_ENV=production.
// In all other environments (development, test, unset) the limit is 10 000,
// so existing tests are never throttled.
//
// createLimiter() is exported for test-specific tight instances (429 tests).

import { rateLimit } from 'express-rate-limit';

const isProd = process.env.NODE_ENV === 'production';

/**
 * General API rate limiter — applied to all /api/* routes.
 * Production : 100 requests per 15 minutes per IP.
 * Other envs : 10 000 (effectively unlimited for test runs).
 */
export const apiLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             isProd ? 100 : 10_000,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Too many requests, please try again later.' },
});

/**
 * Razorpay webhook rate limiter — applied to POST /api/v1/webhooks/razorpay.
 * Production : 30 requests per minute per IP.
 */
export const webhookLimiter = rateLimit({
  windowMs:        60 * 1000,
  max:             isProd ? 30 : 10_000,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Too many webhook requests, please try again later.' },
});

/**
 * Manual Razorpay order limiter — applied to POST /api/v1/razorpay/orders.
 * Production : 10 requests per 15 minutes per IP.
 * More restrictive than apiLimiter: this endpoint is strictly operator-only.
 */
export const manualOrderLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             isProd ? 10 : 10_000,
  standardHeaders: 'draft-7',
  legacyHeaders:   false,
  message:         { error: 'Too many manual order requests, please try again later.' },
});

/**
 * Factory for creating custom rate-limiter instances.
 * Used in Phase 4 tests to create tight limiters that verify 429 behaviour.
 *
 * @param {import('express-rate-limit').Options} opts
 * @returns {import('express').RequestHandler}
 */
export function createLimiter(opts) {
  return rateLimit({
    standardHeaders: 'draft-7',
    legacyHeaders:   false,
    message:         { error: 'Too many requests, please try again later.' },
    ...opts,
  });
}
