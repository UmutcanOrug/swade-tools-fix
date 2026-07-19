import assert from 'node:assert/strict';
import test from 'node:test';

import {
    extractAttackDice
} from '../scripts/services/AttackDiceResolver.js';

test('keeps the best RoF results from a legacy pool including the Wild Die',()=>{
    const roll={
        terms: [{
            results: [
                {result: 3},
                {result: 7},
                {result: 11}
            ]
        }]
    };
    const dice=extractAttackDice(roll,2);

    assert.deepEqual(dice.map(die=>die.total),[11,7]);
    assert.equal(new Set(dice.map(die=>die.id)).size,2);
});

test('uses formatted active native SWADE results with modifiers included',()=>{
    const roll={
        _formatResultParts: ()=>[
            {die: true,result: 9},
            {die: true,result: 5}
        ],
        terms: [{
            results: [
                {result: 7},
                {result: 3},
                {result: 1,discarded: true}
            ]
        }]
    };
    const dice=extractAttackDice(roll,2);

    assert.deepEqual(dice.map(die=>die.total),[9,5]);
});
