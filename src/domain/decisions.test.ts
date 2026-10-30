import { describe, expect, test } from 'bun:test';

import { RecoveryChoiceSchema, budgetReport, type BudgetState } from './decisions';

describe('RecoveryChoiceSchema', () => {
  test.each([
    ['retry without a hint', { choice: 'retry' }, false],
    ['retry with an empty hint', { choice: 'retry', hint: '' }, false],
    ['retry with a hint', { choice: 'retry', hint: 'raise the check timeout' }, true],
    ['rebind without a profile', { choice: 'rebind', hint: 'try the small profile' }, false],
    ['rebind without a hint', { choice: 'rebind', profile: 'mozaik-small' }, false],
    ['rebind with a profile and a hint', { choice: 'rebind', profile: 'mozaik-small', hint: 'small' }, true],
    ['repair without a failing check id', { choice: 'repair', failingCheckIds: [] }, false],
    ['repair with a failing check id', { choice: 'repair', failingCheckIds: ['cli-help'] }, true],
    ['replan bare', { choice: 'replan' }, true],
    ['give_up without a reason', { choice: 'give_up' }, false],
    ['give_up with a reason', { choice: 'give_up', reason: 'the spec cannot be satisfied' }, true],
    ['an unknown choice', { choice: 'wish' }, false],
  ] as const)('%s (valid: %p)', (_name, input, valid) => {
    expect(RecoveryChoiceSchema.safeParse(input).success).toBe(valid);
  });
});

describe('budgetReport', () => {
  const state = (attemptsUsed: number, replansUsed = 0): BudgetState => ({
    attemptsUsed,
    attemptBudget: 3,
    replansUsed,
    replanBudget: 1,
  });

  test('the first attempt leaves recovery and the run re-plan', () => {
    expect(budgetReport(state(1))).toEqual({ recoveryLeft: true, replanAvailable: true });
  });

  test('a spent attempt budget leaves no recovery and still reports the re-plan state', () => {
    expect(budgetReport(state(3))).toEqual({ recoveryLeft: false, replanAvailable: true });
    expect(budgetReport(state(3, 1))).toEqual({ recoveryLeft: false, replanAvailable: false });
  });

  test('a used re-plan is not available again while attempts remain', () => {
    expect(budgetReport(state(1, 1))).toEqual({ recoveryLeft: true, replanAvailable: false });
  });

  test('a re-plan budget of 2 leaves a second re-plan after the first', () => {
    expect(budgetReport({ attemptsUsed: 3, attemptBudget: 3, replansUsed: 1, replanBudget: 2 }).replanAvailable).toBe(true);
    expect(budgetReport({ attemptsUsed: 3, attemptBudget: 3, replansUsed: 2, replanBudget: 2 }).replanAvailable).toBe(false);
  });

  test('a run whose options set the re-plan budget to 0 has no re-plan', () => {
    expect(budgetReport({ attemptsUsed: 3, attemptBudget: 3, replansUsed: 0, replanBudget: 0 })).toEqual({
      recoveryLeft: false,
      replanAvailable: false,
    });
  });

  test('an attempt budget raised by the run options leaves more recovery', () => {
    expect(budgetReport({ attemptsUsed: 3, attemptBudget: 5, replansUsed: 0, replanBudget: 1 }).recoveryLeft).toBe(true);
  });
});
