import assert from 'node:assert/strict';
import test from 'node:test';

import PowerPointService from '../scripts/services/PowerPointService.js';

globalThis.game={
    settings: {
        get: (scope,key)=>
            scope==='swade' && key==='noPowerPoints' ? false : undefined
    }
};
globalThis.foundry={
    utils: {
        getProperty: (object,path)=>
            path.split('.').reduce((value,key)=>value?.[key],object)
    }
};

function makePower(value=10,cost=4) {
    const actor={
        id: 'actor-1',
        uuid: 'Actor.actor-1',
        system: {
            powerPoints: {
                magic: {value,max: 10}
            }
        },
        async update(changes) {
            this.system.powerPoints.magic.value=
                changes['system.powerPoints.magic.value'];
        }
    };
    const item={
        id: 'power-1',
        uuid: 'Actor.actor-1.Item.power-1',
        type: 'power',
        actor,
        system: {
            arcane: 'magic',
            pp: cost,
            ppModifiers: {cost}
        }
    };
    return {actor,item};
}

test('spends full PP on success and one PP on failure',async ()=>{
    const {actor,item}=makePower();
    let result=await PowerPointService.commitActivation(item,{
        success: true,
        transactionId: 'power-success'
    });
    assert.equal(result.consumed,4);
    assert.equal(actor.system.powerPoints.magic.value,6);

    result=await PowerPointService.commitActivation(item,{
        success: false,
        transactionId: 'power-failure'
    });
    assert.equal(result.consumed,1);
    assert.equal(actor.system.powerPoints.magic.value,5);
});

test('does not spend the same PP transaction twice',async ()=>{
    const {actor,item}=makePower();
    await Promise.all([
        PowerPointService.commitActivation(item,{
            success: true,
            transactionId: 'same-message'
        }),
        PowerPointService.commitActivation(item,{
            success: true,
            transactionId: 'same-message'
        })
    ]);

    assert.equal(actor.system.powerPoints.magic.value,6);
});
