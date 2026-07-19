import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildAttackModes,
    getStandardRofResourceCost,
    normalizeRof,
    resolveActionResourceCost
} from '../scripts/services/AttackModeResolver.js';

test('normalizes invalid RoF values to one', () => {
    assert.equal(normalizeRof(undefined), 1);
    assert.equal(normalizeRof(-4), 1);
    assert.equal(normalizeRof('3'), 3);
});

test('uses the standard SWADE RoF resource table', () => {
    assert.equal(getStandardRofResourceCost(1), 1);
    assert.equal(getStandardRofResourceCost(2), 5);
    assert.equal(getStandardRofResourceCost(3), 10);
    assert.equal(getStandardRofResourceCost(6), 50);
    assert.equal(getStandardRofResourceCost(7), null);
});

test('prefers an explicit action resource cost', () => {
    assert.equal(resolveActionResourceCost({ resourcesUsed: 3 }, 3), 3);
    assert.equal(resolveActionResourceCost({ resourcesUsed: 0 }, 3), 0);
    assert.equal(resolveActionResourceCost({}, 3), 10);
});

test('caps generated standard buttons while leaving explicit actions available', () => {
    const modes = buildAttackModes(9999, 1);
    assert.equal(modes.length, 6);
    assert.equal(modes.at(-1).rof, 6);
    assert.equal(resolveActionResourceCost({resourcesUsed: 75},7), 75);
});
