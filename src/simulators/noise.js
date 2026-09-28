// src/simulators/noise.js
//
// Phase 4: Shared Deterministic Seeded Noise.
//
// Generates reproducible, independent pseudo-random values in [0, 1) using
// a cryptographically strong hash (SHA-256) over canonical domain keys.
//
// Guarantees:
// 1. Determinism: same (seed, mandate, day, slot, purpose) => identical float in [0, 1).
// 2. Stream Independence: different purposes ('bank_uptime', 'balance_shock', etc.)
//    yield completely uncorrelated pseudo-random streams via SHA-256 avalanche effect.
// 3. Paired Comparisons: all experimental arms observing the same mandate on the
//    same virtual day and slot receive the exact same underlying simulated luck.

import crypto from 'node:crypto';

/**
 * Derives a deterministic uniform float in [0, 1) from simulation coordinates.
 *
 * @param {number} seed - Simulation run seed (uint32 or integer)
 * @param {string|object} mandate - Mandate identifier string or mandate object
 * @param {number} day - Virtual simulation day (integer >= 0)
 * @param {string|number} slot - Execution slot identifier (e.g. '14:00', 'morning', 0)
 * @param {string} purpose - Distinct domain purpose stream
 * @returns {number} Uniform float in [0, 1)
 */
export function noise(seed, mandate, day, slot, purpose) {
  if (seed === undefined || seed === null || isNaN(Number(seed))) {
    throw new TypeError('noise: seed must be a valid number');
  }

  const mandateId = typeof mandate === 'object' && mandate !== null
    ? (mandate.mandate_id || mandate.id || String(mandate))
    : String(mandate ?? '');

  if (!mandateId || mandateId.trim() === '') {
    throw new TypeError('noise: mandate identifier must be non-empty string');
  }

  const dayInt = Math.floor(Number(day) || 0);
  const slotStr = String(slot ?? 'default');
  const purposeStr = String(purpose || 'general');

  // Build canonical key with delimiters to prevent adjacent field collisions
  const canonicalKey = `${Math.floor(Number(seed))}:${mandateId.trim()}:${dayInt}:${slotStr}:${purposeStr}`;

  // SHA-256 produces a 256-bit uniform hash
  const hash = crypto.createHash('sha256').update(canonicalKey, 'utf8').digest();

  // Read the first 4 bytes as an unsigned 32-bit big-endian integer
  const uint32 = hash.readUInt32BE(0);

  // Map onto [0, 1)
  return uint32 / 4294967296;
}
