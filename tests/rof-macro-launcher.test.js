import test from 'node:test';
import assert from 'node:assert/strict';

import {
    findActorToken,
    findRofAllocatorMacro
} from '../scripts/services/RofMacroLauncher.js';

test('findRofAllocatorMacro prefers the explicit module flag',()=>{
    const marked={
        name: 'Other',
        command: 'SWADE RoF Attack Pool and Damage Allocator'
    };
    const flagged={
        name: 'Custom RoF',
        getFlag: (scope,key) =>
            scope==='swade-tools' && key==='rofAllocator'
    };

    assert.equal(
        findRofAllocatorMacro([marked,flagged]),
        flagged
    );
});

test('findRofAllocatorMacro detects the distributed macro header',()=>{
    const macro={
        name: 'My Weapon Macro',
        command: [
            '/*',
            ' * SWADE RoF Attack Pool and Damage Allocator',
            ' */'
        ].join('\n')
    };

    assert.equal(findRofAllocatorMacro([macro]),macro);
});

test('findActorToken prefers a controlled token for the actor',()=>{
    const actor={id:'actor-1',uuid:'Actor.actor-1'};
    const active={id:'active',actor};
    const controlled={id:'controlled',actor};

    assert.equal(
        findActorToken(actor,[controlled],[active]),
        controlled
    );
});

test('findActorToken rejects tokens belonging to another actor',()=>{
    const actor={id:'actor-1',uuid:'Actor.actor-1'};
    const other={
        id:'other',
        actor:{id:'actor-2',uuid:'Actor.actor-2'}
    };

    assert.equal(findActorToken(actor,[other],[]),null);
});
