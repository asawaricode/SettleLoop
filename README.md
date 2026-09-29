# SettleLoop

**Payment recovery evaluation engine comparing Control, Fixed Schedule, Salary-Aware, and Smart recovery policies in a simulation environment, with an isolated Razorpay Test Mode integration.**

Built for the **Razorpay Buildathon**.

<p align="left">
  <a href="https://settleloop-gamma.vercel.app">
    <img src="https://img.shields.io/badge/🚀_Live_Demo-settleloop--gamma.vercel.app-0052FF?style=for-the-badge" alt="Live Demo" />
  </a>
  <a href="https://github.com/asawaricode/SettleLoop">
    <img src="https://img.shields.io/badge/GitHub-Repository-181717?style=for-the-badge&logo=github" alt="GitHub" />
  </a>
</p>

<p align="left">
  <img src="https://img.shields.io/badge/Node.js-18+-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Express-5.x-000000?style=flat-square&logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/Supabase-PostgreSQL-3ECF8E?style=flat-square&logo=supabase&logoColor=white" alt="Supabase" />
  <img src="https://img.shields.io/badge/Google_Gemini-2.0_Flash-4285F4?style=flat-square&logo=google&logoColor=white" alt="Gemini" />
  <img src="https://img.shields.io/badge/Deployed_on-Vercel-000000?style=flat-square&logo=vercel&logoColor=white" alt="Vercel" />
</p>

---

## 1. Project Positioning & System Scope

SettleLoop is an experimental research and benchmarking platform designed to study recurring payment recovery policies under controlled conditions. The project is **not** production payment infrastructure, does not connect to live banking rails, and does not process real customer funds.

The codebase consists of **two strictly separated worlds**:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        WORLD A: SYNTHETIC EXPERIMENT                  │
│                                                                        │
│  Deterministic PRNG ──► Virtual Clock ──► Causal Payment Simulator     │
│                              │                                         │
│                              ▼                                         │
│      Control  │  Fixed Schedule  │  Salary-Aware  │  Smart Policy      │
│                              │                                         │
│                              ▼                                         │
│         Failure Classifier ──► AI / Fallback ──► Guardrails            │
│                              │                                         │
│                              ▼                                         │
│      In-Process Paired Benchmark (Seeds 11–40, df=29)                  │
│           & Optional PostgreSQL RPC Execution                          │
│                              │                                         │
│                              ▼                                         │
│      Synthetic Experiment Metrics & Statistical Robustness (CIs)       │
└────────────────────────────────────────────────────────────────────────┘
                                 ▲
                          STRICT ISOLATION
                    (Verified by Integration Tests)
                                 ▼
┌────────────────────────────────────────────────────────────────────────┐
│                   WORLD B: REAL RAZORPAY TEST MODE                     │
│                                                                        │
│  Inbound Webhooks (HMAC-SHA256) ──► webhook_events (Idempotent)        │
│                                                                        │
│  Operator Dashboard ──► Manual Orders API ──► Real Test Mode Artifact  │
│                                                                        │
│  * Note: This creates a real Razorpay Test Mode order artifact.        │
│    It is not a payment retry and does not execute a payment.           │
└────────────────────────────────────────────────────────────────────────┘
```

### Core Decision Boundary
Across all intelligent recovery flows, SettleLoop enforces a strict structural separation of concerns:
$$\textbf{AI / Heuristic Proposes} \longrightarrow \textbf{Zod Boundary Validates} \longrightarrow \textbf{Deterministic Guardrails Decide}$$
The AI layer produces advisory proposals only. Proposals are parsed through strict Zod schemas and filtered by immutable deterministic safety guardrails before execution.

---

## 2. One-Command Reproducible Benchmark

The benchmark runner executes as a **pure in-process simulation**. It requires:
- **NO Supabase connection**
- **NO database/RPC credentials**
- **NO Razorpay API keys**
- **NO Gemini API keys**
- **NO external network calls**
- **NO environment variables**

### Execution Command
From a fresh clone:
```bash
git clone https://github.com/asawaricode/SettleLoop.git
cd SettleLoop
npm install
npm run benchmark
```
*(Or run directly: `node scripts/run-benchmark.js`)*

### Execution Properties
- **Execution Time:** ~0.3 seconds.
- **Seeds Evaluated:** Frozen evaluation seeds `11–40` ($N = 30$, degrees of freedom $df = 29$).
- **Mandates per Seed:** 10 mandates ($300$ mandates per arm, $1{,}200$ mandate simulations per run).
- **Configurations Evaluated:** Baseline (default simulator assumptions), Alternative Assumption Set A (Stressed Bank), and Alternative Assumption Set B (High Volatility).
- **Published LLM Mode:** `--llm=mock` (used strictly for pipeline, causal noise, and invariant validation).
- **Authentic Gemini Replay Status:** Formally **BLOCKED** because no valid cached real Gemini outputs exist in the repository or runtime cache. The mock results are **NOT** presented as evidence of real Gemini performance.

---

## 3. Four Headline Experiment Arms

All four arms execute against the exact same mandate cohort and shared causal simulator noise stream for a given evaluation seed:

| Arm | Description | Attempt Limits | Decision Mechanism |
|:---|:---|:---|:---|
| **1. Control / Holdout** | Observes cohort without intervention | 1 initial attempt (**0 recovery retries**) | Immediate stand-down on initial failure. Measures natural recovery and provides the baseline for lift and break-even calculations. |
| **2. Fixed Schedule** | Unassisted calendar baseline | Max 4 total attempts (1 initial + 3 retries) | Retries on fixed schedule: $D \rightarrow D+1 \rightarrow D+3 \rightarrow D+6$. Context-blind to salary day, decline reason, or bank uptime. |
| **3. Salary-Aware** | Heuristic aligning with customer cash-flow | Max 4 total attempts (1 initial + 3 retries) | Evaluates public Observation noisy payday hint (`noisyPaydayHint`) and current virtual day. Schedules retries around expected liquidity spikes without accessing hidden traits. |
| **4. Smart Policy** | Adaptive AI decisioning with safety guardrails | Max 4 total attempts (1 initial + 3 retries) | Classifies failure code $\to$ prompts Gemini 2.0 Flash (or deterministic fallback) $\to$ validates via Zod $\to$ filters through deterministic guardrails. |

### Observation-Only Boundary & Trait Shielding
To guarantee experimental validity, **no arm receives or reads hidden simulator traits** (`salaryDay`, `balanceDynamics`, `bankReliability`, `balanceVolatility`). All policy decisions pass through the allowlisted `Observation` boundary (`mandateId`, `attemptsUsed`, `maxAttempts`, `amount`, `category`, `retryEligible`, `declineCode`, `noisyPaydayHint`, `bankId`, `currentDay`, `cycleState`).

---

## 4. Real Razorpay Test Mode Integration

The repository implements a genuine Razorpay Test Mode integration interacting with Razorpay's live servers in Test Mode, without installing third-party SDK wrappers.

### Exact Razorpay Flows Verified from Code

#### 1. Inbound Signed Webhook Ingestion (`POST /api/v1/webhooks/razorpay`)
- **Raw-Body Buffer Capture:** Route-level middleware `express.raw({ type: 'application/json' })` captures unprocessed request body bytes before JSON parsing.
- **HMAC-SHA256 Verification:** `verifyRazorpaySignature()` calculates `crypto.createHmac('sha256', secret).update(rawBody).digest('hex')` and validates it against the `X-Razorpay-Signature` header.
- **Timing-Safe Comparison:** Compares calculated hash and header signature using `crypto.timingSafeEqual` to eliminate timing side-channel attacks.
- **Deduplication & Idempotency:** Stored in the `webhook_events` PostgreSQL table with a unique index on `event_id`. Duplicate deliveries return HTTP 200 `{ received: true, duplicate: true }`.
- **Known Event Handling:** Recognizes `payment.failed`, `payment.authorized`, `payment.captured`, `order.paid`, `subscription.charged`, `subscription.halted`, `subscription.cancelled`, `subscription.paused`, `subscription.resumed`, and `payment.dispute.created`.
- **Atomic Rollback:** Supports transactional effect execution with rollback on error.
- **Zero Simulation Contamination:** Inbound webhooks never write to `mandates` or `attempts`, never trigger retries, and never alter simulation metrics.

#### 2. Manual Test Mode Order Creation (`POST /api/v1/razorpay/orders`)
- **Manual-Only Trigger:** Dedicated operator endpoint requiring explicit invocation. Blocked if incoming request headers include `x-automated-batch: 1` with HTTP 403.
- **Preflight Guards:** Validates targeted mandate: (1) belongs to `smart` arm, (2) has `next_action === 'retry'`, (3) has `attempts_used < 4`, (4) has `amount > 0`.
- **REST API Call:** Issues direct HTTPS POST to `https://api.razorpay.com/v1/orders` using HTTP Basic Authentication (`RAZORPAY_KEY_ID:RAZORPAY_KEY_SECRET`).
- **Sanitized Payload:** Sends only `amount` (converted to paise for INR) and `currency`. Customer PII (`name`, `email`, `contact`) is never transmitted, and `notify` is never set to true.
- **Audit Persistence:** Stored in `audit_logs` table (`decision_type = 'razorpay_order_created'`).
- **Mandatory Disclosure:** Every response returns the disclosure:
  > *"This creates a real Razorpay Test Mode order artifact. It is not a payment retry and does not execute a payment."*
- **Zero Attempt Creation:** Does not create an attempt row in `attempts`, does not increment `attempts_used`, and does not alter simulation recovery metrics.

### What is NOT Exercised / What Has NOT Been Built
- **NO Live AutoPay Debit Execution:** The system does NOT execute live recurring AutoPay debits through Razorpay. The simulator models recurring payment dynamics in virtual days.
- **NO Customer-Facing Checkout:** No Razorpay Standard Checkout UI is rendered or triggered for customer card/UPI entry.
- **NO Subscriptions API Mandate Registration:** Razorpay Subscriptions API (`/v1/subscriptions`) or recurring token authorization flows are NOT registered.
- **NO Live Credentials:** Only Test Mode key IDs (`rzp_test_...`) and webhook secrets are supported; live keys are never used.

---

## 5. Phase 6 Benchmark Results & Sensitivity Analysis

All metrics below were computed across the frozen evaluation seeds `11–40` ($N = 30$, $df = 29$, $t_{\text{critical}} = 2.04523$, `assumedRetryFee = ₹15.00`):

### 1. Headline Arm Performance Across Assumption Sets

| Assumption Set | Arm | Recovery Rate | Recovered ₹ | Total Attempts / Seed (10 mandates) | Per-Mandate Mean Attempts | Mean Recovery Retries / Seed | Cond. Days to Recovery | Overrides | Net Value (₹15 fee) |
|:---|:---|:---|:---|:---|:---|:---|:---|:---|:---|
| **Baseline** | Control | 65.67% | ₹18,124.23 | 10.0000 | 1.0000 | 0.0000 | 0.0000 | 0 | ₹17,974.23 |
| | Fixed Schedule | 89.67% | ₹23,919.10 | 14.3000 | 1.4300 | 4.3000 | 0.7042 | 0 | ₹23,704.60 |
| | Salary-Aware | 90.33% | ₹23,984.70 | 14.2667 | 1.4267 | 4.2667 | 0.8135 | 0 | ₹23,770.70 |
| | Smart (mock) | 88.00% | ₹23,404.10 | 14.0333 | 1.4033 | 4.0333 | 0.7479 | 28 | ₹23,193.60 |
| **Set A (Stressed Bank)** | Control | 55.33% | ₹15,295.97 | 10.0000 | 1.0000 | 0.0000 | 0.0000 | 0 | ₹15,145.97 |
| | Fixed Schedule | 85.33% | ₹22,930.57 | 16.6333 | 1.6633 | 6.6333 | 1.0927 | 0 | ₹22,681.07 |
| | Salary-Aware | 86.00% | ₹23,074.40 | 16.5667 | 1.6567 | 6.5667 | 1.1578 | 0 | ₹22,825.90 |
| | Smart (mock) | 85.00% | ₹22,597.83 | 15.6000 | 1.5600 | 5.6000 | 1.0827 | 40 | ₹22,363.83 |
| **Set B (High Volatility)** | Control | 10.67% | ₹2,969.27 | 10.0000 | 1.0000 | 0.0000 | 0.0000 | 0 | ₹2,819.27 |
| | Fixed Schedule | 28.33% | ₹7,355.70 | 32.0333 | 3.2033 | 22.0333 | 3.6644 | 0 | ₹6,875.20 |
| | Salary-Aware | 30.33% | ₹7,872.97 | 31.6000 | 3.1600 | 21.6000 | 3.3934 | 0 | ₹7,398.97 |
| | Smart (mock) | 28.33% | ₹7,173.87 | 30.6000 | 3.0600 | 20.6000 | 3.4473 | 104 | ₹6,714.87 |

### 2. Pairwise Comparisons (Diff ± 95% CI) Across Assumption Sets

| Comparison | Assumption Set | Δ Recovery Rate (95% CI) | Δ Recovered ₹ (95% CI) | Δ Total Attempts (95% CI) | Δ Net Value (95% CI) | Break-Even Fee |
|:---|:---|:---|:---|:---|:---|:---|
| **Fixed vs Control** | Baseline | +24.00% [+17.70%, +30.30%] | +₹5,794.87 [+₹4,271.74, +₹7,318.00] | +4.3000 [+3.6841, +4.9159] | +₹5,730.37 [+₹4,213.19, +₹7,247.55] | ₹1,347.64 |
| | Set A | +30.00% [+23.80%, +36.20%] | +₹7,634.60 [+₹5,992.83, +₹9,276.37] | +6.6333 [+5.8943, +7.3723] | +₹7,535.10 [+₹5,897.66, +₹9,172.54] | ₹1,150.95 |
| | Set B | +17.67% [+12.06%, +23.27%] | +₹4,386.43 [+₹2,999.03, +₹5,773.83] | +22.0333 [+20.5739, +23.4927] | +₹4,055.93 [+₹2,683.41, +₹5,428.45] | ₹199.08 |
| **Salary-Aware vs Control** | Baseline | +24.67% [+18.30%, +31.04%] | +₹5,860.47 [+₹4,297.80, +₹7,423.14] | +4.2667 [+3.6669, +4.8665] | +₹5,796.47 [+₹4,239.51, +₹7,353.43] | ₹1,373.54 |
| | Set A | +30.67% [+24.09%, +37.24%] | +₹7,778.43 [+₹6,050.27, +₹9,506.59] | +6.5667 [+5.8118, +7.3216] | +₹7,679.93 [+₹5,956.12, +₹9,403.74] | ₹1,184.53 |
| | Set B | +19.67% [+14.08%, +25.26%] | +₹4,903.70 [+₹3,478.47, +₹6,328.93] | +21.6000 [+20.0883, +23.1117] | +₹4,579.70 [+₹3,169.34, +₹5,990.06] | ₹227.02 |
| **Smart vs Control** | Baseline | +22.33% [+16.59%, +28.08%] | +₹5,279.87 [+₹3,889.37, +₹6,670.37] | +4.0333 [+3.4682, +4.5984] | +₹5,219.37 [+₹3,833.87, +₹6,604.87] | ₹1,309.07 |
| | Set A | +29.67% [+23.35%, +35.98%] | +₹7,301.86 [+₹5,699.98, +₹8,903.74] | +5.6000 [+4.9213, +6.2787] | +₹7,217.86 [+₹5,619.66, +₹8,816.06] | ₹1,303.90 |
| | Set B | +17.67% [+12.51%, +22.83%] | +₹4,204.60 [+₹2,933.14, +₹5,476.06] | +20.6000 [+19.1672, +22.0328] | +₹3,895.60 [+₹2,638.16, +₹5,153.04] | ₹204.11 |
| **Smart vs Salary-Aware** | Baseline | -2.33% [-5.01%, +0.35%] | -₹580.60 [-₹1,269.96, +₹108.76] | -0.2333 [-0.5960, +0.1293] | -₹577.10 [-₹1,263.85, +₹109.65] | N/A |
| | Set A | -1.00% [-4.00%, +2.00%] | -₹476.57 [-₹1,269.43, +₹316.29] | -0.9667 [-1.4395, -0.4939] | -₹462.07 [-₹1,254.91, +₹330.77] | N/A |
| | Set B | -2.00% [-5.01%, +1.01%] | -₹699.10 [-₹1,475.29, +₹77.09] | -1.0000 [-1.5833, -0.4167] | -₹684.10 [-₹1,458.74, +₹90.54] | N/A |

### 3. Ordering Invariance
Under all three assumption sets, the pairwise ordering of recovery policies remains **completely invariant**:
$$\text{Recovery Rate: } \text{Salary-Aware} > \text{Fixed Schedule} \ge \text{Smart} > \text{Control}$$
$$\text{Net Value: } \text{Salary-Aware} > \text{Fixed Schedule} > \text{Smart} > \text{Control}$$

---

## 6. Assumptions & Regulatory Evidence Boundary

SettleLoop preserves a strict evidence boundary between sourced regulatory rules and project modeling assumptions (detailed in [`ASSUMPTIONS.md`](ASSUMPTIONS.md)):

| Field / Claim | Status | Basis & Source | Impact on Benchmark |
|:---|:---|:---|:---|
| **24-Hour Pre-Debit Notice** | `sourced` | RBI E-Mandate Circulars (see `ASSUMPTIONS.md` §2 Rule A) | Enforced via `preDebitNoticeMinHours = 24`. Dispatch times within 24h of notice are blocked by guardrails. |
| **Minimum Retry Gap (`minRetryGapHours`)** | `assumed` | Project parameter (`minRetryGapHours = 0`) | No regulation mandates an inter-retry gap. The simulator enforces no idle gap beyond notice. |
| **Fresh Notice per Retry (`freshNoticePerRetry`)** | `assumed` | Project parameter (`freshNoticePerRetry = false`) | Legal requirement for fresh notice per retry is unverified; benchmark assumes false. |
| **Assumed Retry Fee (`assumedRetryFee`)** | `assumed` | Project parameter (`assumedRetryFee = ₹15.00`) | Hypothetical gateway/processing cost per retry. NOT a Razorpay fee and NOT a regulatory fee. |
| **Bank Uptime & Decline Models** | `assumed` | Synthetic SHA-256 hash models | Generates comparative behavior; does not represent real-world bank decline distributions. |

> **Regulatory Invariant:** Any retry timing behavior beyond the sourced 24-hour pre-debit notification requirement is an explicit **benchmark assumption, NOT a regulatory claim**.

---

## 7. Known Limitations & What Is Not Built

### Known Limitations
1. **No Authentic Gemini Replay Evaluation Yet:** Real Gemini evaluation remains formally blocked pending cached real responses. The published benchmark uses deterministic mock proposals strictly for pipeline validation.
2. **Comparative Benchmark Under Assumptions:** Metric lift reflects comparative performance under explicitly stated assumptions, not absolute real-world recovery guarantees.
3. **Retry Timing Assumptions:** Inter-retry gap (`minRetryGapHours = 0`) and notice per retry (`freshNoticePerRetry = false`) are modeling choices.
4. **Test Mode Does Not Represent Live AutoPay:** Razorpay Test Mode verifies integration plumbing and idempotency; it does not process live recurring AutoPay debits.

### What Is Not Built
1. **No Production Auth / RBAC:** The web dashboard and REST APIs operate without multi-tenant authentication or role-based access control.
2. **No Production Outbox / Asynchronous Queues:** No Kafka, RabbitMQ, or BullMQ broker is implemented; recovery cycles execute within in-process virtual loops or atomic database RPCs.
3. **No Automated Reconciliation Engine:** External bank settlement sheets or refund reconciliation pipelines are not built.
4. **No Live Banking Rails:** No live NPCI UPI AutoPay or NACH rails are connected.

---

## 8. Automated Testing & Verification

The test suite runs on Node.js's native test runner (`node:test`) and contains **95 tests across 6 core suites** covering property testing, boundary hardening, causal simulation, experiment arms, and evaluation evidence:

```bash
# Execute all automated tests
npm test
```

### Core Test Suite Summary (95/95 Passing, 0 Failures)
- **Phase 6 Evaluation Evidence & Sensitivity (`tests/step29_phase6_evaluation.test.js` — 15 tests):** Frozen seeds 11–40, df=29 CIs, break-even fee formula, non-Smart zero overrides, conditional days to recovery, net value calculation, metric disambiguation (Control strictly 10 attempts/seed, 1.0/mandate, 0 retries), replay cache miss validation, and Alternative Sets A & B ordering preservation.
- **Phase 5 Experiment Arms & LLM Modes (`tests/step28_phase5_experiment_arms.test.js` — 20 tests):** All 4 arms against shared population, Control 0 retries, trait shielding Canary tests, <=4-attempt cap, 24h notice gap, non-peak dispatch, LLM modes (mock, replay, live), seed split immutability.
- **Synthetic Experiment Determinism (`tests/determinism.test.js` — 1 test):** Dual-run identical outcome verification across fresh database simulation runs.
- **Phase 2 Property Invariants (`tests/step25_phase2_properties.test.js` — 20 tests):** Guardrail ceiling, peak window boundary semantics (10:00–13:00, 17:00–21:30), state machine transitions, concurrent attempt database RPC ceiling.
- **Phase 3 Boundary Hardening (`tests/step26_phase3_boundary.test.js` — 29 tests):** Zod structural schema parsing, boundary vs guardrail separation, deterministic fallbacks, fast-check property fuzzing, Razorpay webhook raw-body HMAC verification, and database rollback.
- **Phase 4 Causal Simulator (`tests/step27_phase4_causal_simulator.test.js` — 10 tests):** Deterministic PRNG seeding, causal taxonomy causes, canary salary-day leak shield, strictly allowlisted Observation builder, shared paired noise streams.

---

## 9. Local Development & Full Stack Setup

### 1. Minimal Setup: Pure Benchmark (Zero Configuration)
```bash
git clone https://github.com/asawaricode/SettleLoop.git
cd SettleLoop
npm install
npm run benchmark
```

### 2. Optional Setup: Full Database & Dashboard Integration
To run the full Express backend, Supabase database, and dashboard:
1. Create a `.env` file from `.env.example`:
   ```bash
   cp .env.example .env
   ```
2. Configure required keys in `.env`:
   ```env
   # Required for Supabase Database Features
   SUPABASE_URL=https://<your-project-ref>.supabase.co
   SUPABASE_SECRET_KEY=<your-supabase-service-role-key>

   # Optional for Live Gemini Decisioning
   GEMINI_API_KEY=<your-gemini-api-key>

   # Optional for Real Razorpay Test Mode Ingestion & Orders
   RAZORPAY_KEY_ID=<your-test-mode-key-id>
   RAZORPAY_KEY_SECRET=<your-test-mode-key-secret>
   RAZORPAY_WEBHOOK_SECRET=<your-webhook-secret>

   PORT=3000
   NODE_ENV=development
   ```
3. Start the application:
   ```bash
   npm start
   ```
   Access the dashboard at `http://localhost:3000/dashboard/`.

---

## 10. Repository Structure

```
SettleLoop/
├── api/
│   └── index.js                      # Vercel serverless function entrypoint
├── db/
│   └── migrations/                   # PostgreSQL schema & stored procedure migrations
├── public/
│   └── dashboard/                    # Operator dashboard (HTML, CSS, vanilla JS)
├── scripts/
│   ├── run-benchmark.js              # One-command in-process benchmark runner
│   └── run-recovery-cli.js           # CLI runner for database simulation runs
├── src/
│   ├── api/
│   │   ├── razorpayOrder.js          # Manual Razorpay Test Mode order creation
│   │   ├── razorpayWebhook.js        # Inbound signed webhook ingestion handler
│   │   ├── routes.js                 # Express REST API endpoints
│   │   └── validation.js             # Zod request validation schemas
│   ├── config/
│   │   ├── benchmarkConfig.js        # Frozen evaluation seeds, arms, sensitivity sets
│   │   ├── recoveryPolicy.js         # Regulatory rules & assumed policy parameters
│   │   ├── simulatorConfig.js        # Baseline simulator configuration
│   │   └── supabase.js               # Supabase PostgreSQL client initialization
│   ├── evaluation/
│   │   ├── benchmarkEvaluator.js     # Paired benchmark evaluator (seeds 11–40, df=29)
│   │   ├── index.js                  # Evaluation module exports
│   │   └── metrics.js                # Database simulation run metrics computation
│   ├── generators/
│   │   └── syntheticDataGenerator.js # Deterministic mandate cohort generator
│   ├── middleware/
│   │   └── rateLimiter.js            # express-rate-limit configuration
│   ├── recovery/
│   │   ├── baselinePolicy.js         # Fixed Schedule policy (D+1, D+3, D+6)
│   │   ├── benchmarkRunner.js        # Four-arm paired simulation runner
│   │   ├── controlPolicy.js          # Control policy (0 recovery retries)
│   │   ├── failureClassifier.js      # Gateway decline categorization taxonomy
│   │   ├── guardrails.js             # Deterministic safety guardrail validation
│   │   ├── humanApproval.js          # Escalation creation and resolution
│   │   ├── llmCache.js               # Deterministic LLM cache keying & replay store
│   │   ├── recoveryRunner.js         # Database recovery runner & virtual clock stepping
│   │   ├── salaryAwarePolicy.js      # Salary-Aware policy (cash-flow alignment)
│   │   ├── smartAgent.js             # Gemini AI proposal & deterministic fallback
│   │   └── smartPolicy.js            # Smart recovery execution pipeline
│   ├── simulators/
│   │   ├── hiddenTraits.js           # Latent mandate traits (shielded from arms)
│   │   ├── noise.js                  # Shared causal simulator PRNG noise stream
│   │   ├── observation.js            # Allowlisted public Observation builder
│   │   └── paymentSimulator.js       # Deterministic causal payment outcome simulator
│   └── stateMachine/
│       └── mandateStateMachine.js    # Mandate lifecycle transition assertions
├── tests/
│   ├── determinism.test.js           # Dual-run determinism verification
│   ├── step25_phase2_properties.test.js  # Phase 2 property & regulatory invariant tests
│   ├── step26_phase3_boundary.test.js    # Phase 3 Zod boundary & webhook tests
│   ├── step27_phase4_causal_simulator.test.js # Phase 4 causal noise & observation tests
│   ├── step28_phase5_experiment_arms.test.js  # Phase 5 arms, LLM modes & seed split tests
│   └── step29_phase6_evaluation.test.js       # Phase 6 evaluation evidence & sensitivity tests
├── ASSUMPTIONS.md                    # Primary sources, simulator assumptions, sensitivity sets
├── DEMO.md                           # Interactive demonstration sequence & judge walkthrough
├── package.json                      # Dependencies, test, and benchmark scripts
├── server.js                         # Local Express server entrypoint
└── vercel.json                       # Vercel deployment routing configuration
```

---

## 11. Deployment

SettleLoop is configured for deployment on **Vercel**:
- **Live Deployment:** [https://settleloop-gamma.vercel.app](https://settleloop-gamma.vercel.app)
- **Static Dashboard:** `public/dashboard/` assets are served directly from Vercel's edge network.
- **Serverless API Bridge:** `api/index.js` wraps the Express application to execute `/api/*` endpoints as serverless functions.
- **Infrastructure Scope:** Deployment hosts the web application and API; no live payment rails or real funds are connected.
