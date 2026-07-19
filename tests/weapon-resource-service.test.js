import assert from 'node:assert/strict';
import test from 'node:test';

import WeaponResourceService from '../scripts/services/WeaponResourceService.js';

globalThis.game={
    settings: {
        get: (scope,key)=>scope==='swade' && key==='ammoManagement'
    }
};

test('consumes the full resolved RoF cost through the SWADE item API',async ()=>{
    let consumed=0;
    const item={
        id: 'weapon-1',
        uuid: 'Actor.a.Item.weapon-1',
        type: 'weapon',
        canExpendResources: cost=>cost<=10,
        consume: async cost=>{
            consumed+=cost;
        }
    };
    const cost=WeaponResourceService.resolveCost({},3);
    const result=await WeaponResourceService.expend(item,cost);

    assert.equal(cost,10);
    assert.equal(result.ok,true);
    assert.equal(consumed,10);
});

test('does not roll resource consumption past the available ammunition',async ()=>{
    let consumed=0;
    const item={
        id: 'weapon-2',
        uuid: 'Actor.a.Item.weapon-2',
        type: 'weapon',
        canExpendResources: ()=>false,
        consume: async cost=>{
            consumed+=cost;
        }
    };
    const result=await WeaponResourceService.expend(item,5);

    assert.equal(result.ok,false);
    assert.equal(result.reason,'insufficient');
    assert.equal(consumed,0);
});

test('preflight validation never consumes ammunition',()=>{
    let consumed=0;
    const item={
        id: 'weapon-3',
        uuid: 'Actor.a.Item.weapon-3',
        type: 'weapon',
        canExpendResources: cost=>cost<=5,
        consume: async cost=>{
            consumed+=cost;
        }
    };
    const result=WeaponResourceService.validate(item,5);

    assert.equal(result.ok,true);
    assert.equal(consumed,0);
});

test('fails safely when the SWADE resource API is unavailable',async ()=>{
    const item={
        id: 'weapon-4',
        uuid: 'Actor.a.Item.weapon-4',
        type: 'weapon'
    };
    const result=await WeaponResourceService.commit(item,1);

    assert.equal(result.ok,false);
    assert.equal(result.reason,'unsupported');
});

test('mixed weapons spend ammunition only for their ranged attack context',async ()=>{
    const item={
        id: 'weapon-mixed',
        uuid: 'Actor.a.Item.weapon-mixed',
        type: 'weapon',
        isMeleeWeapon: true,
        system: {
            isMelee: true,
            isRanged: true,
            reloadType: 'full',
            shots: 10,
            currentShots: 6
        },
        canExpendResources: ()=>true,
        async consume(cost) {
            this.system.currentShots-=cost;
        }
    };

    let result=await WeaponResourceService.commit(
        item,
        5,
        {rangedAttack: false}
    );
    assert.equal(result.ok,true);
    assert.equal(result.consumed,0);
    assert.equal(item.system.currentShots,6);

    result=await WeaponResourceService.commit(
        item,
        5,
        {rangedAttack: true}
    );
    assert.equal(result.ok,true);
    assert.equal(result.consumed,5);
    assert.equal(item.system.currentShots,1);
});

test('mixed ranged attacks cannot bypass an insufficient magazine',()=>{
    const item={
        id: 'weapon-mixed-empty',
        type: 'weapon',
        isMeleeWeapon: true,
        system: {
            isMelee: true,
            isRanged: true,
            reloadType: 'full',
            shots: 10,
            currentShots: 4
        },
        canExpendResources: ()=>true,
        consume: async ()=>undefined
    };
    const result=WeaponResourceService.validate(
        item,
        5,
        {rangedAttack: true}
    );

    assert.equal(result.ok,false);
    assert.equal(result.reason,'insufficient');
});

test('Frenzy dice remain melee for a mixed Fighting weapon',()=>{
    const item={
        type: 'weapon',
        isMeleeWeapon: true,
        system: {
            isMelee: true,
            isRanged: true
        }
    };

    assert.equal(
        WeaponResourceService.isRangedAttack(
            item,
            'Fighting',
            {
                fightingSkill: 'Fighting',
                shootingSkill: 'Shooting'
            }
        ),
        false
    );
    assert.equal(
        WeaponResourceService.isRangedAttack(
            item,
            'Shooting',
            {
                fightingSkill: 'Fighting',
                shootingSkill: 'Shooting'
            }
        ),
        true
    );
});
