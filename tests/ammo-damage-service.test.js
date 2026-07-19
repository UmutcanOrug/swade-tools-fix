import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.foundry={
    utils: {
        deepClone: value=>structuredClone(value),
        mergeObject: (target,source)=>{
            Object.assign(target,source);
            return target;
        }
    }
};
globalThis.Roll={
    validate: formula=>formula==='1d6x'
};

const {default: AmmoDamageService}=
    await import('../scripts/services/AmmoDamageService.js');

function rule(enabled,modifier) {
    return {
        'swade-tools': {
            ammoDamage: {enabled,modifier}
        }
    };
}

test('uses the ammunition snapshot loaded by SWADE magazine handling',()=>{
    const weapon={
        type: 'weapon',
        getFlag: (scope,key)=>
            scope==='swade' && key==='loadedAmmo'
                ? {name: 'AP Magazine',flags: rule(true,'+2')}
                : undefined
    };

    assert.deepEqual(AmmoDamageService.getDamageModifier(weapon),{
        label: 'AP Magazine',
        value: 2
    });
});

test('uses the selected loose-ammo inventory item',()=>{
    const ammunition={
        name: 'Incendiary Rounds',
        getFlag: (scope,key)=>
            scope==='swade-tools' && key==='ammoDamage'
                ? {enabled: true,modifier: '+1d6x'}
                : undefined
    };
    const weapon={
        type: 'weapon',
        system: {ammo: ammunition.name},
        actor: {
            items: {
                getName: name=>name===ammunition.name ? ammunition : null
            }
        },
        getFlag: ()=>undefined
    };

    assert.deepEqual(AmmoDamageService.getDamageModifier(weapon),{
        label: ammunition.name,
        value: '+1d6x'
    });
});

test('keeps the ammunition damage snapshot from the moment of attack',()=>{
    let loaded={
        name: 'AP Magazine',
        flags: rule(true,'+2')
    };
    const weapon={
        id: 'weapon-snapshot',
        uuid: 'Actor.a.Item.weapon-snapshot',
        type: 'weapon',
        getFlag: (scope,key)=>
            scope==='swade' && key==='loadedAmmo'
                ? loaded
                : undefined
    };
    const record=AmmoDamageService.beginNativeAttack(weapon,'formula');
    loaded={
        name: 'Training Magazine',
        flags: rule(false,'')
    };

    assert.deepEqual(
        AmmoDamageService.getNativeAttackSnapshot(
            weapon,
            'formula'
        ),
        {
            captured: true,
            snapshot: {
                label: 'AP Magazine',
                value: 2
            }
        }
    );

    AmmoDamageService.endNativeAttack(record);
    assert.equal(
        AmmoDamageService.getNativeAttackSnapshot(
            weapon,
            'formula'
        ).captured,
        false
    );
});
