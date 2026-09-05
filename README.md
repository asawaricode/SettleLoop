# SettleLoop — Razorpay Payment Recovery System

A deterministic, AI-assisted payment recovery simulation system built for the Razorpay Buildathon.

> **Note:** This is a simulation and research tool. It does not process real payments, does not connect to live banking rails, and is not production-ready. All payment outcomes are deterministically simulated from a seed.

---

## Problem

Recurring mandate payments fail for many reasons — insufficient balance, bank downtime, soft declines. Without intelligent retry logic, merchants lose recoverable revenue and customers experience involuntary churn.

**SettleLoop** evaluates three recovery strategies in a controlled, repeatable simulation:

| Arm | Strategy |
|-----|----------|
| **Control** | No retry — accept the failure |
| **Baseline** | Fixed schedule retry (deterministic, no AI) |
| **Smart** | AI-proposed retry via Gemini → Guardrails → optional Human Approval → RPC execution |

---

## Prerequisites

- Node.js 18+
- A Supabase project with the SettleLoop schema applied
- A Google Gemini API key (for the Smart arm; Control and Baseline work without it)

---

## Setup

```bash
npm install
cp .env.example .env
# Fill in SUPABASE_URL, SUPABASE_SECRET_KEY, and GEMINI_API_KEY in .env
```

---

## Required Environment Variables

```
SUPABASE_URL          — Your Supabase project URL
SUPABASE_SECRET_KEY   — Supabase service-role secret key (server-side only, never exposed to clients)
GEMINI_API_KEY        — Google Gemini API key (server-side only, never logged or returned by any API)
```

---

## Start the Server

```bash
npm start
# Server starts at http://localhost:3000
```

---

## Dashboard

A visual judge-facing dashboard is served at:

```
http://localhost:3000/dashboard/
```

The dashboard lets you:
1. Create a simulation (seed, mandate count, max virtual days)
2. Run the full simulation (Control + Baseline + Smart arms)
3. Compare recovery rates, amounts, and attempt metrics per arm
4. View Smart arm lift vs Control and Baseline (backend-calculated)
5. See the safety audit result (violations tracked by the backend)
6. Understand the virtual clock and AI → Guardrails → RPC architecture

No secrets are sent to the browser. The dashboard communicates only with the Express REST API.

---

## API Usage

### 1. Create a simulation

```bash
curl -X POST http://localhost:3000/api/simulations \
  -H "Content-Type: application/json" \
  -d '{ "seed": 20001, "mandateCount": 9, "maxDays": 7 }'
```

Returns `{ "runId": "<uuid>", "mandateIds": [...] }`

### 2. Retrieve simulation state

```bash
curl http://localhost:3000/api/simulations/<runId>
```

Returns `{ "runId", "currentDay", "maxDays", "status" }`

### 3. Run the full simulation (all three arms)

```bash
curl -X POST http://localhost:3000/api/simulations/<runId>/run
```

Runs Control + Baseline + Smart recovery across all virtual days up to `maxDays`.  
The Smart arm calls Gemini for each failed mandate. Falls back to a deterministic heuristic if Gemini is unavailable.

### 4. Retrieve final metrics

```bash
curl http://localhost:3000/api/simulations/<runId>/metrics
```

Returns per-arm recovery rates, attempt counts, time-to-recovery, lift vs Control and Baseline, and safety violation counts.

---

## Simulated Clock

The system uses a **virtual day counter** stored in Supabase (`simulation_runs.current_day`).  
No real time passes — the clock jumps directly to the next due mandate's day.  
This allows a multi-day simulation to complete in seconds.

---

## Architecture Overview

```
Synthetic Data Generator  (src/generators/syntheticDataGenerator.js)
        ↓
Supabase (simulation_runs + mandates)
        ↓
Recovery Runner            (src/recovery/recoveryRunner.js)
        ↓  iterates virtual days
Recovery Engine            (src/recovery/recoveryEngine.js)
        ↓  routes by experiment_arm
   ┌────┴──────────────────────────────┐
   │                                   │
Control Policy           Baseline Policy           Smart Policy
(src/recovery/           (src/recovery/            (src/recovery/
 controlPolicy.js)        baselinePolicy.js)         smartPolicy.js)
   │                         │                          │
   │                         │                   Failure Classifier
   │                         │                   (failureClassifier.js)
   │                         │                          │
   │                         │                   Smart Agent → Gemini API
   │                         │                   (smartAgent.js)
   │                         │                          │
   │                         │                   Guardrails (deterministic)
   │                         │                   (guardrails.js)
   │                         │                          │
   │                         │              ┌───────────┴──────────┐
   │                         │         allowed?               human_review?
   │                         │              │                       │
   │                         │        RPC execution          Human Approval
   │                         │        (execute_attempt)      (humanApproval.js)
   │                         │        (complete_attempt)
   └────────────────────────────────────────┘
                    ↓
           Audit Logger (src/utils/auditLogger.js)
                    ↓
           Metrics Layer (src/evaluation/metrics.js)
                    ↓
           Express API (src/api/routes.js / server.js)
```

---

## Control vs Baseline vs Smart

### Control
- **Policy:** Do nothing after a failure.
- **Retries:** Zero.
- **Purpose:** Establishes the recovery baseline — "what happens if we don't try?"
- **Deterministic:** Yes.

### Baseline
- **Policy:** Fixed schedule: retry every 2 days, up to 4 attempts maximum.
- **Retries:** Up to 4 (enforced by RPC, not JS).
- **Purpose:** Establishes a simple deterministic retry benchmark.
- **Deterministic:** Yes (given the same seed).

### Smart
- **Policy:** Failure-aware, AI-proposed recovery.
- **Flow:**
  1. Classify the failure (hard / soft / unknown).
  2. Call Gemini to propose an action (`retry` / `stand_down` / `human_review`).
  3. Pass proposal through deterministic Guardrails.
  4. If Guardrails approve → execute via RPC.
  5. If Guardrails return `human_review` → create approval request, pause mandate.
  6. If approved → resume; if rejected/expired → stand down.
- **Retries:** Up to 4 (enforced by RPC idempotency, not AI).
- **Deterministic:** Control/Baseline/Payment Simulation are seed-deterministic. Gemini reasoning is **not** bit-for-bit reproducible. Guardrails and RPC execution remain deterministic.

---

## Smart Agent

- Uses Gemini 2.0 Flash via the REST API.
- Temperature = 0 (reduces — but does not eliminate — non-determinism).
- Returns a structured JSON proposal: `{ action, retryDelayDays, reasoning }`.
- If Gemini is unavailable or times out (10 s), falls back to a deterministic heuristic (mirrors Baseline logic).
- The GEMINI_API_KEY is **never** logged, returned in API responses, or exposed to the frontend.
- Fallback output is clearly labeled `source: "fallback"` in audit logs.

---

## Guardrails

Pure, stateless, deterministic safety validation (no DB access, no API calls):

| Rule | Outcome |
|------|---------|
| Hard or unknown failure → retry proposed | `stand_down` |
| Attempts exhausted (≥ 4) → retry proposed | `stand_down` |
| Confidence < 0.70 | `human_review` |
| Payment link + no contact consent | `human_review` |
| Invalid action or missing required fields | `stand_down` |
| All rules pass | proposal action allowed |

---

## Human Approval

When Guardrails return `human_review`:
1. An `approval_requests` record is created in Supabase.
2. The mandate status becomes `pending_human_approval`.
3. No payment attempt is created.
4. Approval expires after 2 virtual days (bounded by `max_days`).
5. **Approved:** mandate returns to `pending`, next retry scheduled.
6. **Rejected:** mandate becomes `stood_down`.
7. **Expired:** mandate becomes `stood_down`.

---

## Safety Guarantees

- **Hard/unknown failures are never auto-retried** (Guardrails + Smart Agent internal check).
- **Maximum 4 attempts per mandate** (enforced by PostgreSQL RPC, not JavaScript).
- **Idempotent execution** (idempotency key per attempt prevents duplicate charges).
- **No actions beyond `max_days`** (simulated clock boundary, enforced by runner).
- **Contact consent enforced** (payment_link only sent when `contact_consent = true`).
- **AI never directly executes payments** — it only proposes; RPCs execute atomically.

---

## Running Tests

```bash
# Run all steps
node --test tests/**/*.test.js

# Run a specific step
node --test tests/step16.test.js

# Step 19 (integration + stress, ~5 min)
node --test tests/step19.test.js
```

**Test summary (all steps passing):**
| Step | Description | Tests |
|------|-------------|-------|
| 10 | Recovery Engine | ✔ |
| 11 | Recovery Runner (Control + Baseline) | ✔ |
| 12 | Failure Classifier | ✔ |
| 13 | Smart Agent | ✔ |
| 14 | Guardrails | ✔ |
| 15 | Human Approval | ✔ |
| 16 | Metrics / Evaluation | ✔ |
| 17 | Express API | ✔ |
| 18 | Smart Integration (all arms) | ✔ 18/18 |
| 19 | Stress Test + Integration Pass | ✔ 10/10 |

---

## Determinism Note

| Component | Deterministic? |
|-----------|---------------|
| Synthetic data generator | ✅ Yes — same seed → identical mandates |
| Payment simulator | ✅ Yes — deterministic hash of seed + mandate + attempt |
| Control policy | ✅ Yes |
| Baseline policy | ✅ Yes |
| Guardrails | ✅ Yes — pure function, no randomness |
| RPC execution / idempotency | ✅ Yes — atomic PostgreSQL |
| Smart Gemini reasoning | ⚠️ Not guaranteed bit-for-bit reproducible |
| Smart fallback heuristic | ✅ Yes |

---

## Security

- `.env` is in `.gitignore` and never committed.
- `SUPABASE_SECRET_KEY` and `GEMINI_API_KEY` remain server-side at all times.
- No secrets appear in API responses, logs, or audit records.
- The frontend (if any) never receives credentials.
