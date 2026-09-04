import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyFailure, VALID_CATEGORIES } from '../src/recovery/failureClassifier.js';
import { simulatePayment } from '../src/simulators/paymentSimulator.js';

test('STEP 12: FAILURE CLASSIFIER', async (t) => {

  await t.test('1. classifyFailure on success outcome returns isFailure: false, category: null, retryEligible: false', () => {
    const res = classifyFailure({
      outcome: 'success',
      declineCode: null,
      declineCategory: null,
      retryEligible: null,
    });

    assert.deepEqual(res, {
      isFailure: false,
      category: null,
      retryEligible: false,
      declineCode: null,
    });
  });

  await t.test('2. classifyFailure on soft failure returns category: soft, retryEligible: true', () => {
    const res = classifyFailure({
      outcome: 'failure',
      declineCode: 'SIM_SOFT_001',
      declineCategory: 'soft',
      retryEligible: true,
    });

    assert.deepEqual(res, {
      isFailure: true,
      category: 'soft',
      retryEligible: true,
      declineCode: 'SIM_SOFT_001',
    });
  });

  await t.test('3. classifyFailure on hard failure returns category: hard, retryEligible: false', () => {
    const res = classifyFailure({
      outcome: 'failure',
      declineCode: 'SIM_HARD_001',
      declineCategory: 'hard',
      retryEligible: false,
    });

    assert.deepEqual(res, {
      isFailure: true,
      category: 'hard',
      retryEligible: false,
      declineCode: 'SIM_HARD_001',
    });
  });

  await t.test('4. classifyFailure on unknown failure returns category: unknown, retryEligible: false', () => {
    const res = classifyFailure({
      outcome: 'failure',
      declineCode: 'SIM_UNKNOWN_001',
      declineCategory: 'unknown',
      retryEligible: false,
    });

    assert.deepEqual(res, {
      isFailure: true,
      category: 'unknown',
      retryEligible: false,
      declineCode: 'SIM_UNKNOWN_001',
    });
  });

  await t.test('5. classifyFailure normalizes hard/unknown failures to retryEligible: false even if retryEligible was true', () => {
    // Defensive guard against corrupted upstream flags
    const hardRes = classifyFailure({
      outcome: 'failure',
      declineCode: 'SIM_HARD_002',
      declineCategory: 'hard',
      retryEligible: true, // contradictory flag
    });
    assert.equal(hardRes.retryEligible, false);

    const unkRes = classifyFailure({
      outcome: 'failure',
      declineCode: 'SIM_UNKNOWN_001',
      declineCategory: 'unknown',
      retryEligible: true, // contradictory flag
    });
    assert.equal(unkRes.retryEligible, false);
  });

  await t.test('6. classifyFailure throws on invalid outcome or invalid category', () => {
    assert.throws(
      () => classifyFailure({ outcome: 'pending' }),
      /invalid outcome/
    );

    assert.throws(
      () => classifyFailure({ outcome: 'failure', declineCategory: 'fraud' }),
      /invalid or missing declineCategory/
    );

    assert.throws(
      () => classifyFailure({ outcome: 'failure', declineCategory: null }),
      /invalid or missing declineCategory/
    );
  });

  await t.test('7. classifyFailure seamlessly normalizes raw output from simulatePayment', () => {
    // Run simulatePayment and pipe directly to classifyFailure
    const simSuccess = simulatePayment({
      seed: 12345,
      mandateId: 'c0a80101-0000-0000-0000-000000000001',
      attemptNumber: 1,
      amount: 1000,
      balanceVolatility: 0.1,
      incomeDayOfMonth: 15,
    });

    const classifiedSuccess = classifyFailure(simSuccess);
    assert.equal(typeof classifiedSuccess.isFailure, 'boolean');
    if (!classifiedSuccess.isFailure) {
      assert.equal(classifiedSuccess.category, null);
      assert.equal(classifiedSuccess.retryEligible, false);
    } else {
      assert.ok(VALID_CATEGORIES.includes(classifiedSuccess.category));
    }
  });

  await t.test('8. Pure function validation: deterministic output and no DB/external dependency', () => {
    const input = {
      outcome: 'failure',
      declineCode: 'SIM_SOFT_002',
      declineCategory: 'soft',
      retryEligible: true,
    };

    const out1 = classifyFailure(input);
    const out2 = classifyFailure(input);

    assert.deepEqual(out1, out2);
    assert.equal(out1.category, 'soft');
    assert.equal(out1.retryEligible, true);
  });
});
