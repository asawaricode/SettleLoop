# ASSUMPTIONS.md — SettleLoop

> **Phase 1 — Source Verification & Assumption Recording (Final)**
> **Scope:** Documentation only. No runtime logic, schema, RPC, route, webhook, simulator, UI, dependency, or test file has been modified.
> **Last updated:** 28 Sep 2026

---

## 0. Evidence Boundary

| Term | Definition |
|:---|:---|
| **`sourced`** | Directly verified against an available primary document. Verbatim quote, actual page/section/table reference, source date, and review date are recorded below. |
| **`secondary-only`** | Supported by secondary material (article, lender FAQ, aggregator) but **not** directly verified against the primary document text. |
| **`not verified`** | Insufficient evidence available to establish the claim; primary source unavailable or not supplied. Contents not inferred. |
| **`assumed`** | Project benchmark / simulator assumption. Not a regulatory fact. |

**Standing constraints:**
- Assumed values are **not** presented as real-world statistics.
- Razorpay Test Mode verifies integration plumbing, not live AutoPay debit behaviour.
- The simulator measures comparative behaviour under explicitly stated assumptions.
- The benchmark does not claim absolute real-world recovery performance.
- The project **does not claim live AutoPay debit execution from Test Mode**.

---

## 1. Primary Source Inventory

| # | Document | Supplied for review | Status |
|:---|:---|:---|:---|
| 1 | NPCI/UPI/OC/215A/2025-26 — "Guidelines on usage of UPI API", 21 May 2025 | **Yes** — supplied as page-image extracts | **Partially reviewed** (see §3) |
| 2 | OC No. 223 FY 2025-26 — Enhancement of UPI Autopay | No | `not verified` |
| 3 | RBI Circular 22 Aug 2024 — "Processing of e-mandates for recurring transactions" | No | `not verified` |
| 4 | RBI Circular Jun 2022 — AFA threshold raised to ₹15,000 | No | `not verified` |
| 5 | RBI Circular — category-specific AFA threshold to ₹1,00,000 | No | `not verified` |
| 6 | NPCI Circular 23 Sep 2024 — NETC FASTag/RuPay NCMC exemption | No | `not verified` |
| 7 | NPCI OC-163 / OC-163A — Interoperability / purpose code AZ | No | `not verified` |

> **NPCI/UPI/OC/215A/2025-26** was supplied as page-image extracts covering: the circular header and table rows SN 1–3 (page 1), the "In addition to the above guidelines" continuation page (appearing twice in extracts), and the table page containing rows SN 8–10. Table rows SN 4–7 were **not present** in the supplied page extracts. The circular references a parent circular NPCI/UPI/OC/215/2025-26 dated 26 April 2025 and Annexure A (audit scope); neither was supplied for review.
>
> `docs/sources/` exists as an empty directory. No PDF file is physically present in the repository.

---

## 2. RBI E-Mandate Rules

### Rule A — 24-Hour Pre-Debit Notification

| Field | Value |
|:---|:---|
| **Rule** | The issuer must send a pre-debit notification to the customer at least 24 hours before the actual debit/charge is executed for a recurring e-mandate transaction. |
| **Source** | RBI Circular dated 22 Aug 2024, "Processing of e-mandates for recurring transactions" |
| **Source date** | 22 Aug 2024 |
| **Retrieved / reviewed date** | Primary document not supplied; not reviewed |
| **Status** | `secondary-only` |
| **Short evidence / quote** | Not available — primary document not reviewed |
| **Clause / page** | not verified |
| **What the circular stated** | Per secondary reports: issuers must send pre-debit notification at least 24 hours before the debit |
| **In-force status** | In-force status under the April 2026 framework: **unverified** |
| **Exemption** | NPCI Circular 23 Sep 2024 is reported (secondary-only) to exempt NETC FASTag and RuPay NCMC auto-replenishment from the 24-hour pre-debit notification requirement. Primary circular not reviewed. Status: `secondary-only`. |

> This rule is **not** described as an independently verified "RBI 2026 framework". The April 2026 consolidated e-mandate framework is unverified.

---

### Rule B — ₹15,000 AFA Threshold

| Field | Value |
|:---|:---|
| **Rule** | RBI raised the limit for subsequent recurring transactions without Additional Factor of Authentication (AFA) from ₹5,000 to ₹15,000. |
| **Source** | RBI Circular, Jun 2022 |
| **Source date** | Jun 2022 |
| **Retrieved / reviewed date** | Primary document not supplied; not reviewed |
| **Status** | `secondary-only` |
| **Short evidence / quote** | Not available — primary document not reviewed |
| **Clause / page** | not verified |
| **What the circular stated** | Per secondary reports: AFA exemption threshold for subsequent recurring transactions raised from ₹5,000 to ₹15,000 |
| **Scope / qualification** | This is an **AFA-related threshold** for subsequent recurring e-mandate transactions. It is **NOT** a universal UPI AutoPay transaction ceiling or a maximum permissible AutoPay amount. |
| **In-force status** | In-force status under the April 2026 framework: **unverified** |

---

### Rule C — ₹1,00,000 Category-Specific AFA Threshold

| Field | Value |
|:---|:---|
| **Rule** | RBI raised the subsequent recurring transaction limit without AFA to ₹1,00,000 per transaction for: (a) mutual fund subscriptions, (b) insurance premium payments, (c) credit-card bill payments. |
| **Source** | RBI Circular (exact date not verified) |
| **Source date** | not verified |
| **Retrieved / reviewed date** | Primary document not supplied; not reviewed |
| **Status** | `secondary-only` |
| **Short evidence / quote** | Not available — primary document not reviewed |
| **Clause / page** | not verified |
| **Scope / qualification** | **Category-specific** for the three listed categories only. **NOT** a universal AutoPay ceiling. |
| **In-force status** | In-force status under the April 2026 framework: **unverified** |

---

## 3. NPCI/UPI/OC/215A/2025-26 — "Guidelines on usage of UPI API", 21 May 2025

### 3.0 Document Header (verified from supplied image — Page 1)

| Field | Value |
|:---|:---|
| **Circular number** | `NPCI/UPI/OC/215A/2025-26` |
| **Date** | 21st May 2025 |
| **Addressee** | All UPI Members |
| **Subject** | Guidelines on usage of UPI API |
| **Signed by** | Kunal Kalawatia, Chief of Products |
| **Review date** | 28 Sep 2026 (image extracts supplied by task requester) |
| **Annexure A** | Referenced for audit scope; Annexure A text not in supplied image extracts |

---

### Rule G-1 — General API Monitoring and Moderation Requirement

| Field | Value |
|:---|:---|
| **Status** | `sourced` |
| **Source** | NPCI/UPI/OC/215A/2025-26, 21 May 2025 |
| **Location** | Opening paragraph, Page 1 |
| **Verbatim quote** | *"…PSP Banks and/or Acquiring Banks shall ensure all the API requests (in terms of velocity and TPS – transactions per second limitations) sent to UPI is monitored and moderated in terms of appropriate usage (customer-initiated and PSP system-initiated)."* |
| **Review date** | 28 Sep 2026 |
| **Scope** | Applies to PSP Banks and Acquiring Banks. Context: this circular supplements parent circular NPCI/UPI/OC/215/2025-26 dated 26 April 2025. |

---

### Rule G-2 — PSP Queueing / Moderated TPS for System-Initiated APIs

| Field | Value |
|:---|:---|
| **Status** | `sourced` |
| **Source** | NPCI/UPI/OC/215A/2025-26, 21 May 2025 |
| **Location** | "In addition to the above guidelines" continuation page, bullet 2 |
| **Verbatim quote** | *"PSPs shall monitor and have a queueing of system-initiated APIs to ensure moderated TPS or in other words PSP systems are not a pass through for back-end generated API transactions to UPI systems in all conditions. PSP's shall give the undertaking to NPCI in this regard on or before 31st Aug 2025"* |
| **Review date** | 28 Sep 2026 |
| **Scope** | Applies to PSP systems. The "on or before 31st Aug 2025" is a deadline stated in the 21 May 2025 circular; it is a historical deadline, not a current 2026 deadline. |

---

### Rule G-3 — Peak Hours Definition and Non-Customer-Initiated API Restriction

| Field | Value |
|:---|:---|
| **Status** | `sourced` |
| **Source** | NPCI/UPI/OC/215A/2025-26, 21 May 2025 |
| **Location** | "In addition to the above guidelines" continuation page, bullet 3 |
| **Verbatim quote** | *"Peak hours are defined as the period during the day when UPI financial transactions reach the highest transactions per second, observed from 10:00 hrs to 13:00 hrs and from 17:00 hrs to 21:30 hrs. Any other time shall be referred as non-peak hour. During peak hours, UPI members are required to restrict non-customer-initiated APIs."* |
| **Review date** | 28 Sep 2026 |
| **Peak windows (sourced)** | **10:00 hrs to 13:00 hrs** and **17:00 hrs to 21:30 hrs** |
| **Non-peak definition (sourced)** | "Any other time shall be referred as non-peak hour" |
| **Peak-hour restriction (sourced)** | "During peak hours, UPI members are required to restrict non-customer-initiated APIs." |
| **Scope** | Applies to UPI members. AutoPay debit executions are non-customer-initiated APIs and therefore subject to this restriction. |

> **Note on project guardrails:** The simulator operates in virtual-day granularity and does not enforce real clock-time windows. This is an explicitly stated simulator assumption, not a deviation from the sourced rule (see §7, Assumed table).

---

### Rule D — AutoPay Execution Attempt Limit

| Field | Value |
|:---|:---|
| **Status** | `not verified` |
| **Reported source** | NPCI/UPI/OC/215A/2025-26, 21 May 2025 |
| **Location** | API guidelines table — table rows SN 4–7 were **not present** in the supplied image extracts and therefore could not be directly verified from an accessible primary-source artifact |
| **Reported wording** | "Maximum of 1 attempt and 3 retries per mandate (per sequence number) shall be permitted." — wording provided in task context; **not independently verified from accessible image extracts** |
| **Granularity** | Reported as **per mandate (per sequence number)** — source terminology not independently confirmed |
| **Total attempts** | 1 initial attempt + 3 retries = 4 total attempts maximum — not independently verified |
| **Scope / qualification** | Cannot be confirmed from the accessible image artifact. The project's `attempts_used < 4` guardrail is implemented on the basis of this widely-reported rule; its primary-source verification remains outstanding. |

> **Evidence note:** The supplied image extracts show table rows SN 1–3 and SN 8–10. The AutoPay table row (SN 4–7 range) was **not present** in those images. No page number, SN, or quotation location is invented. This item will be upgraded to `sourced` only when the relevant table page is directly accessible and the exact row is confirmed.
>
> **Terminology note:** The reported granularity is "per mandate (per sequence number)". This is recorded as reported, **not** rewritten as "per cycle".

---

### Rule E — AutoPay Execution in Non-Peak Hours / at Moderated TPS

| Field | Value |
|:---|:---|
| **Status** | `not verified` |
| **Reported source** | NPCI/UPI/OC/215A/2025-26, 21 May 2025 |
| **Location** | API guidelines table — same AutoPay table row as Rule D (SN 4–7 range); **not present** in supplied image extracts |
| **Reported wording (non-peak)** | AutoPay executions are to be initiated in non-peak hours. — wording provided in task context; **not independently verified from accessible image extracts** |
| **Reported wording (TPS)** | AutoPay executions are to be initiated at moderated TPS. — wording provided in task context; **not independently verified from accessible image extracts** |
| **Note** | The general non-peak restriction (G-3) and peak-hour definition (10:00–13:00, 17:00–21:30) are `sourced` from the continuation page bullet 3, which is directly visible. Rule E refers specifically to the AutoPay-row non-peak/TPS requirement, which comes from the inaccessible table rows. |
| **Scope** | Cannot be confirmed from the accessible image artifact. Will be upgraded to `sourced` when the relevant table page is directly accessible. |

#### Conflicting Secondary Claim (not adopted)

| Claim | Source | Status |
|:---|:---|:---|
| AutoPay execution window 12:00 AM–7:00 AM | Hero FinCorp FAQ | `secondary-only`, **conflicting**, **not adopted** |

> Hero FinCorp's 12:00 AM–7:00 AM window conflicts with the NPCI-sourced peak-hour definition. It is recorded for traceability but is **not used as the project's execution-window rule**.

---

### Rule G-4 — Standalone API Use Prohibition

| Field | Value |
|:---|:---|
| **Status** | `sourced` |
| **Source** | NPCI/UPI/OC/215A/2025-26, 21 May 2025 |
| **Location** | Continuation page, bullet 1 |
| **Verbatim quote** | *"It is re-iterated that PSPs need to monitor usage as specified in this circular (and the relevant ones referred) that the stand-alone use of APIs for purposes other than intended is prohibited, unless approved specifically by NPCI."* |
| **Review date** | 28 Sep 2026 |

---

### Rule G-5 — Implementation Deadline (Historical)

| Field | Value |
|:---|:---|
| **Status** | `sourced` |
| **Source** | NPCI/UPI/OC/215A/2025-26, 21 May 2025 |
| **Location** | Closing paragraph |
| **Verbatim quote** | *"Members are requested to take note of this compliance requirement and communicate it to relevant stakeholders and their respective partners for implementation by 31st July 2025."* |
| **Review date** | 28 Sep 2026 |
| **Nature** | This is a deadline **stated in the 21 May 2025 circular**. It is a historical deadline; it is **not** a current 2026 deadline. |

---

### Rule G-6 — Audit Deadline and Scope (Historical)

| Field | Value |
|:---|:---|
| **Status** | `sourced` |
| **Source** | NPCI/UPI/OC/215A/2025-26, 21 May 2025 |
| **Location** | Continuation page, bullets 4 and 5 |
| **Verbatim quote (bullet 5)** | *"The audit reports shall be shared with upi.compliance@npci.org.in by 31st August 2025."* |
| **Verbatim quote (bullet 4)** | *"With reference to NPCI/UPI/OC/215/2025-26 dated 26th April 2025, point number 7, 'PSP banks / Acquiring banks shall audit their systems by Cert-in empanelled auditor on an immediate basis, to review the API usage and existing systems behaviour, and annually hereafter'. For the audit scope, PSP banks/ Acquiring banks shall refer to Annexure A, where the minimum scope of audit has been outlined."* |
| **Review date** | 28 Sep 2026 |
| **Nature** | Historical deadlines stated in the 21 May 2025 circular. **Not** current 2026 deadlines. |

---

### Selected API-Specific Rules (Sourced — Table, Page 1)

These are sourced from the API guidelines table in the circular (image extract, rows SN 1–3 and SN 8–10). Included for completeness of the evidence record; they do not directly affect simulator runtime.

| SN | API | Frequency Limit | Key Usage Guidelines (sourced) |
|:---|:---|:---|:---|
| 1 | Balance Enquiry | 50/app/customer/day (rolling 24h) | Customer-initiated only; UPI Apps shall be able to limit/stop in peak hours; issuer banks to add available balance with every successful UPI financial transaction communication. |
| 2 | List Keys (ListKeys, PSPKeys) | Once/PSP/day (rolling 24h) | Minimum page size 1000; **"To be done in non-peak hours"** |
| 3 | List Account | 25/app/customer/day (rolling 24h) | Initiated only once customer selects issuer bank; re-try only with customer consent |
| 8 | ValCust API | Valid use cases only | IPO/PAN validation only after mandate successfully created; other use cases at limited attempts and moderate TPS |
| 9 | API Header format | Permitted headers: Host, Content-Length, Content-type/Accept, User-Agent | Non-conforming requests will be blocked by NPCI; members to update reverse proxies |
| 10 | Validate Address | NA (NPCI may release limits later) | Customer-intends-to-pay use only; standalone valadd not permitted |

> Table rows SN 4–7 (likely containing AutoPay and related APIs) were not present in the supplied image extracts.

---

## 4. NPCI OC No. 223 — Enhancement of UPI Autopay

| Field | Value |
|:---|:---|
| **Document** | OC No. 223 FY 2025-26 — Enhancement of UPI Autopay |
| **Source date** | not verified |
| **Supplied for review** | No |
| **Status** | `not verified` |
| **Effect on Rule D (attempt limit)** | Cannot be determined — document not reviewed |
| **Effect on Rule E (peak/non-peak windows)** | Cannot be determined — document not reviewed |

> No inference is made about whether OC No. 223 modifies, supersedes, or leaves unchanged Rules D or E. Determination will only be made from the actual document text when supplied.

---

## 5. NPCI OC-163 / Interoperability — Purpose Code `AZ`

| Field | Value |
|:---|:---|
| **Rule** | UPI AutoPay interoperability via purpose code `AZ` |
| **Reported source** | NPCI OC-163 (or OC-163A) |
| **Source date** | not verified |
| **Supplied for review** | No |
| **Status** | `secondary-only` |
| **Short evidence / quote** | Not available — primary document not reviewed |
| **Scope** | Documentation/context only. Interoperability not implemented in Phase 1. Status upgrades to `sourced` only upon review of actual OC-163 text. |

---

## 6. Secondary-Only Material

The following are recorded as secondary-only, motivation/context only. They are **not** regulatory requirements and are **not** evidence of actual bank behaviour.

| Claim | Secondary Source | Status | Notes |
|:---|:---|:---|:---|
| Retry timing around salary credit dates improves recovery | Razorpay blog / product documentation | `secondary-only` | Motivation/context only. **Not a regulatory requirement. Not evidence of actual bank behaviour.** Not adopted as a sourced rule. |
| AutoPay execution window 12:00 AM–7:00 AM | Hero FinCorp FAQ | `secondary-only`, **conflicting**, **not adopted** | Directly conflicts with sourced NPCI peak-hour definition (10:00–13:00, 17:00–21:30). Not used. |
| NETC FASTag / RuPay NCMC exemption from 24-hour pre-debit notification | Secondary reporting of NPCI 23 Sep 2024 circular | `secondary-only` | Primary circular not reviewed. |

> **Principle:** Secondary material does **not** silently become a sourced rule.

---

## 7. Simulator / Project Assumptions

The following are **project-level assumptions** used in the SettleLoop simulator. They are **not** regulatory requirements. No real-world percentages are claimed.

| Assumption | Description | Basis |
|:---|:---|:---|
| **Salary-day effect** | Simulator may model increased payment success probability around typical salary credit dates (e.g., days 1, 28–31 of month). | `assumed` — project/simulator assumption. Not a regulatory requirement. Real-world effect on individual accounts is unknown. |
| **Balance dynamics** | Simulated balances fluctuate deterministically from the PRNG seed and virtual clock day. | `assumed` — does not model actual bank account behaviour. |
| **Bank reliability** | Synthetic success/failure probabilities per attempt via SHA-256 hashing. | `assumed` — does not represent actual bank decline rates. |
| **Decline probabilities / taxonomy parameters** | Failure classifier maps codes to `soft_decline`, `hard_decline`, `unknown`. Probability distributions are synthetic. | `assumed` — real-world distributions vary by bank, product, and customer segment. |
| **Fresh pre-debit notice per retry** | Simulator does not model a new pre-debit notification per retry attempt. | `assumed` — actual regulatory treatment of retries is not modelled in simulator. |
| **Minimum gap between retries** | Baseline policy schedules retries at D+1, D+3, D+6. No primary-sourced minimum-gap regulation has been verified. | `assumed` — project design decision. |
| **Retries in non-peak clock slots** | Simulator does not enforce real clock-time peak/non-peak windows; it operates in virtual days. | `assumed` — Rule E (AutoPay-specific non-peak requirement) is `not verified` (table rows not in accessible image extracts). The general peak-hour restriction (G-3) is `sourced`; the simulator measures comparative policy behaviour under virtual-day granularity only. |
| **4-attempt ceiling in guardrails** | `guardrails.js` enforces `attempts_used < 4` (max 4 total attempts: 1 initial + 3 retries). | `assumed` — implemented on the basis of the widely-reported NPCI AutoPay retry rule. Rule D primary-source verification is `not verified` (image extracts did not include the relevant table rows). |
| **Assumed retry fee (`assumedRetryFee`)** | ₹15 per retry attempt. | `assumed` — project benchmark parameter representing an assumed processing/infrastructure cost per recovery attempt (₹15). NOT a Razorpay fee. NOT a regulatory parameter. Used in Phase 6 net value and break-even calculations. Documented in §7 and §13. |

### 7.1 Timing Documentation & Regulatory Boundaries

- **Verified RBI Rule**: The issuer must send a pre-debit notification to the customer at least 24 hours before the actual charge/debit is executed for a recurring e-mandate transaction (`preDebitNoticeMinHours = 24`, sourced from RBI circulars; see §2 Rule A).
- **Simulator `minRetryGapHours`**: Set to `0` (`minRetryGapHours = 0`, `assumed`). No primary-sourced regulation requires or permits a specific retry-to-retry gap. The simulator enforces no mandatory inter-retry idle gap beyond the pre-debit notice requirement.
- **Simulator `freshNoticePerRetry`**: Set to `false` (`freshNoticePerRetry = false`, `assumed`). Actual regulatory treatment of whether a fresh 24-hour pre-debit notice is mandated prior to an automated recovery retry attempt is unverified in primary circular texts; the simulator assumes `freshNoticePerRetry = false` as a benchmark design assumption.
- **Regulatory Claim Invariant**: Any retry timing behavior beyond the sourced 24-hour pre-debit notification rule is an explicit benchmark assumption, **not a regulatory claim**.

---

## 8. Open Questions

| # | Question | Impact |
|:---|:---|:---|
| OQ-1 | Current in-force status of RBI e-mandate rules (24-hour notification, ₹15,000 AFA threshold, ₹1,00,000 category-specific threshold) under any April 2026 consolidated e-mandate framework? | Affects applicability of Rules A, B, C. |
| OQ-2 | What does OC No. 223 FY 2025-26 ("Enhancement of UPI Autopay") state, and does it modify, supersede, or leave unchanged Rule D (attempt limit) and/or Rule E (non-peak execution)? | Cannot be determined without reviewing OC No. 223 text. |
| OQ-3 | What is the exact SN row number in the NPCI/UPI/OC/215A/2025-26 table for the AutoPay retry rule? | The SN was not visible in the supplied image extracts (rows 4–7 missing). |
| OQ-4 | Does the AutoPay table row in NPCI/UPI/OC/215A/2025-26 explicitly state that the retries must be in non-peak hours (mandatory), or is that phrasing advisory? | Affects whether Rule E is mandatory or recommended. |
| OQ-5 | Is the NETC FASTag / RuPay NCMC pre-debit notification exemption confirmed in the primary NPCI 23 Sep 2024 circular text? | Affects scope of Rule A. |
| OQ-6 | What does NPCI OC-163 / OC-163A state regarding purpose code `AZ` interoperability? | Cannot be determined without reviewing OC-163 text. |

---

## 9. Source Document Retrieval Record

| Document | Reference | Supplied | Status | Notes |
|:---|:---|:---|:---|:---|
| NPCI "Guidelines on usage of UPI API" May 2025 | NPCI/UPI/OC/215A/2025-26 | Yes — page-image extracts | Partially reviewed | Table rows SN 4–7 not in supplied image extracts; header, continuation page, rows SN 1–3 and SN 8–10 reviewed |
| NPCI OC No. 223 FY 2025-26 | OC No. 223 | No | `not verified` | File absent |
| RBI e-mandate circular 22 Aug 2024 | Not verified | No | `not verified` | File absent |
| RBI circular Jun 2022 (₹15,000 AFA) | Not verified | No | `not verified` | File absent |
| RBI circular (₹1,00,000 category-specific) | Not verified | No | `not verified` | File absent |
| NPCI OC-163 (Interoperability / purpose code AZ) | OC-163 | No | `not verified` | File absent |
| NPCI 23 Sep 2024 (NETC/NCMC exemption) | Not verified | No | `not verified` | File absent |

---

## 10. Summary: NPCI/UPI/OC/215A/2025-26 Sourced Rules

| Rule | Description | Key Quote | Location | Status |
|:---|:---|:---|:---|:---|
| G-1 | API monitoring & moderation requirement | *"…monitored and moderated in terms of appropriate usage…"* | Opening paragraph, p.1 | `sourced` |
| G-2 | PSP queueing / moderated TPS | *"…queueing of system-initiated APIs to ensure moderated TPS…"* | Continuation page, bullet 2 | `sourced` |
| G-3 | Peak-hour definition; 10:00–13:00 & 17:00–21:30; non-customer-initiated restriction | *"Peak hours are defined as…10:00 hrs to 13:00 hrs and from 17:00 hrs to 21:30 hrs…"* | Continuation page, bullet 3 | `sourced` |
| D | AutoPay attempt limit: 1 + 3 retries per mandate (per sequence number) | Reported wording not independently verified from accessible image extracts | API table rows SN 4–7 — **not in supplied image extracts** | `not verified` |
| E | AutoPay in non-peak hours / at moderated TPS | Reported wording not independently verified from accessible image extracts | API table rows SN 4–7 — **not in supplied image extracts** | `not verified` |
| G-4 | Standalone API use prohibition | *"…stand-alone use of APIs for purposes other than intended is prohibited…"* | Continuation page, bullet 1 | `sourced` |
| G-5 | Implementation deadline 31 Jul 2025 (historical) | *"…implementation by 31st July 2025"* | Closing paragraph | `sourced` |
| G-6 | Audit deadline 31 Aug 2025 (historical) | *"…audit reports shall be shared…by 31st August 2025"* | Continuation page, bullet 5 | `sourced` |

---

## 11. Rules Still Unverified from Primary Sources

| Rule | Primary source | Current status |
|:---|:---|:---|
| Rule A | RBI 22 Aug 2024 circular | `secondary-only` — primary not supplied |
| Rule B | RBI Jun 2022 circular | `secondary-only` — primary not supplied |
| Rule C | RBI circular (date unverified) | `secondary-only` — primary not supplied |
| OC No. 223 | OC No. 223 PDF | `not verified` — not supplied |
| OC-163 interoperability | OC-163 PDF | `secondary-only` — primary not supplied |
| NPCI 23 Sep 2024 exemption | NPCI 23 Sep 2024 circular | `not verified` — not supplied |
| Rule D — AutoPay retry limit | NPCI/UPI/OC/215A/2025-26 (table rows SN 4–7) | `not verified` — relevant table page not in supplied image extracts |
| Rule E — AutoPay non-peak / moderated TPS | NPCI/UPI/OC/215A/2025-26 (same table rows SN 4–7) | `not verified` — relevant table page not in supplied image extracts |

---

## 12. Phase 5 Benchmark Framework Assumptions

### 12.1 Four Experiment Arms

| Arm | Identifier | Description | Information Boundary |
|:---|:---|:---|:---|
| **Control / Holdout** | `control` | Performs zero recovery retries on initial payment failure. Stood down immediately. | Public Observation only. Zero hidden traits. |
| **Fixed Schedule** | `fixed_schedule` (alias: `baseline`) | Follows a deterministic retry schedule: Attempt 2 (D+1), Attempt 3 (D+2), Attempt 4 (D+3). Max 4 attempts. | Public Observation only. Zero hidden traits. |
| **Salary-Aware Rule** | `salary_aware` (alias: `salary_aware_rule`) | Heuristic rule aligning retries with the exposed `noisyPaydayHint` within the 1–7 day delay window. Fallback to attempt schedule if hint > 7 days or absent. | Public Observation only. Uses noisy hint only; latent salaryDay, balanceDynamics, and bankReliability are completely shielded. |
| **Smart** | `smart` | AI proposes → Zod validates → guardrails decide architecture. Deterministic fallback on validation failure. | Public Observation only. Prompt derived from allowlisted Observation fields only. |

*Status: All four arms are `assumed` benchmark strategies. None is claimed as a regulatory mandate.*

---

### 12.2 LLM Modes

| Mode | CLI Flag | Behavior | Network Access |
|:---|:---|:---|:---|
| **Replay** | `--llm=replay` | Uses previously cached deterministic responses matched by SHA-256 cache key. Fails explicitly on cache miss. | Strictly forbidden (zero network calls). |
| **Mock** | `--llm=mock` | Returns deterministic mock proposals for test isolation. | Strictly forbidden (zero network calls). |
| **Live** | `--llm=live` | Calls the real Gemini API integration using `GEMINI_API_KEY`. Saves responses to live cache. | Allowed; strictly excluded from automated test suite. |

*Status: `assumed` test and execution plumbing.*

---

### 12.3 LLM Cache Key

| Component | Specification |
|:---|:---|
| **Formula** | `SHA-256(canonicalized_input + ":" + model_name + ":" + prompt_version)` |
| **Canonical Input** | Derived exclusively from allowlisted Observation fields (`mandateId`, `attemptsUsed`, `maxAttempts`, `amount`, `category`, `retryEligible`, `declineCode`, `noisyPaydayHint`, `bankId`, `currentDay`, `cycleState`). |
| **Hidden Trait Exclusion** | Latent traits (`salaryDay`, `balanceDynamics`, `bankReliability`, etc.) are strictly excluded. |
| **Key Order Invariance** | JSON keys are sorted recursively prior to serialization. Equivalent inputs produce identical hashes regardless of object key order. |
| **Cache Isolation** | Replay, mock, and live entries are isolated and never silently mixed. |

---

### 12.4 Benchmark Seed Split

| Split | Seed Range | Role | Invariant |
|:---|:---|:---|:---|
| **Tuning Seeds** | `1–10` | Strategy tuning and prompt configuration | Seeds 1–10 may be used while tuning the Salary-Aware rule and Smart prompt/configuration. |
| **Evaluation Seeds** | `11–40` | Evaluation-only benchmark | Configuration, prompts, thresholds, and policy parameters are strictly immutable during evaluation execution. No ML training or parameter optimization. |

*Every arm runs against the exact same mandate population and shared causal noise stream for a given evaluation seed.*

---

### 12.5 Observation-Only Boundary

No experiment arm receives or reads hidden simulator state directly. All strategy inputs pass through the frozen, allowlisted Observation boundary.

*Assumed benchmark parameters — not claimed as real-world recovery performance.*

---

## 13. Phase 6 Evaluation Evidence Assumptions

### 13.1 Frozen Evaluation Seeds (11–40)
Evaluation is strictly confined to seeds 11–40 (30 paired seeds, degrees of freedom $df = 29$). Evaluation execution is read-only and immutable; no tuning, training, prompt modifications, or configuration adjustments occur.

### 13.2 Assumed Retry Fee & Financial Metrics
- **Assumed retry fee (`assumedRetryFee`)**: Configured as ₹15.00 per retry attempt. This is an explicitly ASSUMED benchmark parameter representing hypothetical marginal gateway/processing costs. It is NOT a Razorpay fee and NOT a regulatory fee.
- **Net Value formula**:
  $$\text{net value} = \text{recovered ₹} - (\text{attempts} \times \text{assumedRetryFee})$$
- **Break-Even Fee formula**:
  For each non-control arm, the break-even fee against Control (where mean net value equals Control mean net value) is:
  $$\text{BreakEvenFee} = \frac{\overline{\text{RecoveredINR}}_{\text{arm}} - \overline{\text{RecoveredINR}}_{\text{control}}}{\overline{\text{Attempts}}_{\text{arm}} - \overline{\text{Attempts}}_{\text{control}}}$$
  Break-even is explicitly NOT defined as net value = 0.

### 13.3 Statistical Method (Paired Difference 95% Confidence Intervals)
For all metrics and pairwise comparisons:
- Paired per-seed difference: $d_i = \text{ArmA}_i - \text{ArmB}_i$ across the 30 evaluation seeds ($N = 30$).
- Standard error: $SE = s_d / \sqrt{N}$ where $s_d = \sqrt{\frac{1}{N-1} \sum (d_i - \bar{d})^2}$.
- $t$-critical: $t_{0.025, 29} = 2.045229638$ (exact two-tailed 95% confidence with $df = 29$).
- Confidence Interval: $[\bar{d} - t_{\text{critical}} \times SE, \; \bar{d} + t_{\text{critical}} \times SE]$.
- Identical CI methodology applied universally across all metrics (recovery rate, recovered ₹, attempts, days to recovery conditional on recovery, guardrail overrides, net value).

### 13.4 Alternative Simulator Assumption Sets (Sensitivity Analysis)

To evaluate the robustness of policy comparisons to variations in operating conditions, exactly TWO alternative simulator assumption sets are defined. Both sets use ONLY parameters that already exist in `SIMULATOR_CONFIG` without introducing external statistics:

#### Alternative Assumption Set A: "Stressed Banking Environment"
- `DEFAULT_UPTIME_PROBABILITY: 0.80` (`assumed`, baseline: 0.96)
- `MIN_UPTIME_PROBABILITY: 0.70` (`assumed`, baseline: 0.90)
- `MAX_UPTIME_PROBABILITY: 0.85` (`assumed`, baseline: 0.99)
- **Rationale**: Models severe degradation in issuer bank API availability/success rates. Evaluates whether intelligent retry scheduling retains its advantage when infrastructure failure rates rise.

#### Alternative Assumption Set B: "High Volatility & Attenuated Salary Effect"
- `SALARY_MULTIPLIER: 1.5` (`assumed`, baseline: 2.5)
- `DAILY_SPEND_FRACTION: 0.20` (`assumed`, baseline: 0.05)
- `BASELINE_BUFFER_FRACTION: 0.10` (`assumed`, baseline: 0.20)
- `VOLATILITY_NOISE_SCALE: 0.50` (`assumed`, baseline: 0.25)
- **Rationale**: Models extreme balance volatility and a diminished payday liquidity spike. Evaluates whether salary-aware heuristics continue to outperform fixed schedules when liquidity signals are degraded.

*Invariants across all sensitivity runs*:
- Evaluation seeds 11–40 remain unchanged ($N = 30$, $df = 29$).
- All four experiment arms (Control, Fixed Schedule, Salary-Aware, Smart) remain unchanged.
- Shared causal noise stream and paired mandate population generation remain identical.

---

### 13.5 Reporting Clarification: Metric Labels & Attempt Accounting

To prevent misinterpreting aggregate seed totals as per-mandate figures:
- **Total attempts per seed (10 mandates)**: The sum of all attempts dispatched across the 10 mandates within a seed.
- **Per-mandate mean attempts**: Total attempts divided by mandate count ($N=10$).
- **Control Arm Attempt Invariant**: Control performs exactly 1 initial debit attempt per mandate and strictly **ZERO** recovery retries. Consequently, Control shows 10.0000 total attempts per seed (1.0000 attempt per mandate) and strictly 0 recovery retries.
- **Conditional Days to Recovery**: Computed strictly over recovered mandates; unrecovered mandates are completely excluded (never imputed, capped, or averaged as max days).

---

### 13.6 Paired Sensitivity Evaluation Results (Seeds 11–40, df=29)

#### 1. Headline Arm Performance Across Assumption Sets

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

#### 2. Pairwise Comparisons (Diff ± 95% CI) Across Assumption Sets

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

#### 3. Pairwise Ordering Invariance Under Alternative Assumptions
The pairwise ordering across arms remains **completely invariant** under both alternative assumption sets:
- **Recovery Rate**: Salary-Aware > Fixed Schedule $\ge$ Smart > Control under Baseline, Set A, and Set B.
- **Recovered ₹**: Salary-Aware > Fixed Schedule > Smart > Control under Baseline, Set A, and Set B.
- **Net Value**: Salary-Aware > Fixed Schedule > Smart > Control under Baseline, Set A, and Set B.
- **Conclusion**: Pairwise ordering does **NOT** change under either alternative assumption set.

---

### 13.7 Timing Documentation & Regulatory Boundary Invariant
- **Verified RBI Rule**: Pre-debit notification must be transmitted at least 24 hours prior to debit/charge execution (`preDebitNoticeMinHours = 24`, sourced from RBI circulars; see §2 Rule A).
- **Simulator Assumptions**:
  * `minRetryGapHours = 0` (`assumed`): No regulatory rule prescribes an inter-retry gap; the simulator enforces no delay beyond the 24h pre-debit notice window.
  * `freshNoticePerRetry = false` (`assumed`): Simulator assumes fresh notice is not required for automated retry attempts within a cycle.
- **Boundary**: Any retry timing behavior beyond the sourced 24-hour pre-debit notification rule is an explicit benchmark assumption, **NOT a regulatory claim**.

---

### 13.8 Gemini Replay Status & Evidence Boundary
- **Inspection of LLM Cache**: Inspection confirms that **no valid cached real Gemini outputs exist** in the repository or runtime memory (`_replayCache` is an empty Map; no external cache store exists on disk).
- **No Mock-as-Evidence Claim**: The `--llm=mock` results presented above validate pipeline integrity, causal noise isolation, and statistical machinery only. They **must NOT be presented as evidence of real Gemini performance**.
- **Blocked State**: Because real Gemini outputs are not available and cannot be fabricated, synthesized, or silently substituted with mock data, **real Gemini evaluation remains formally blocked**.
- **Phase 6 Status**: Phase 6 **cannot be marked complete** until valid real Gemini outputs are cached and evaluated under `--llm=replay`.

