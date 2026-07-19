import * as gb from '../gb.js';

const AMMO_DAMAGE_DEFAULTS=Object.freeze({
    version: 1,
    enabled: false,
    modifier: ''
});

export default class AmmoDamageService {
    static installed=false;
    static nativeAttackSnapshots=new Map();

    static install() {
        if (this.installed) {
            return;
        }

        this.installed=true;
        Hooks.on(
            'swadeRollDamage',
            (_actor,item,_roll,modifiers)=>
                this.applyNativeDamageModifier(item,modifiers)
        );
    }

    static getRule(itemOrData) {
        const stored=itemOrData?.getFlag
            ? itemOrData.getFlag(gb.moduleName,'ammoDamage')
            : itemOrData?.flags?.[gb.moduleName]?.ammoDamage;

        return foundry.utils.mergeObject(
            foundry.utils.deepClone(AMMO_DAMAGE_DEFAULTS),
            stored ?? {},
            {inplace: true,insertKeys: true,overwrite: true}
        );
    }

    static getLoadedAmmo(weapon) {
        const loaded=weapon?.getFlag?.('swade','loadedAmmo');

        if (loaded) {
            return loaded;
        }

        const ammoName=weapon?.system?.ammo;
        return ammoName
            ? weapon.actor?.items?.getName?.(ammoName) ?? null
            : null;
    }

    static getDamageModifier(weapon) {
        if (weapon?.type!=='weapon') {
            return null;
        }

        const ammo=this.getLoadedAmmo(weapon);
        const rule=this.getRule(ammo);

        if (!ammo || !rule.enabled) {
            return null;
        }

        const modifier=this.normalizeModifier(rule.modifier);

        if (modifier===null) {
            return null;
        }

        return {
            label: ammo.name || gb.trans('LoadedAmmo'),
            value: modifier
        };
    }

    static normalizeSnapshot(snapshot) {
        if (!snapshot) {
            return null;
        }

        const value=this.normalizeModifier(snapshot.value);

        if (value===null) {
            return null;
        }

        return {
            label: String(snapshot.label || gb.trans('LoadedAmmo')),
            value
        };
    }

    static getNativeAttackKey(item,action) {
        return `${item?.uuid ?? item?.id ?? 'unknown'}:${action || 'formula'}`;
    }

    static beginNativeAttack(item,action) {
        const key=this.getNativeAttackKey(item,action);
        const record={
            key,
            token: Symbol(key),
            snapshot: this.normalizeSnapshot(
                this.getDamageModifier(item)
            )
        };
        const records=this.nativeAttackSnapshots.get(key) ?? [];
        records.push(record);
        this.nativeAttackSnapshots.set(key,records);
        return record;
    }

    static getNativeAttackSnapshot(item,action) {
        const records=this.nativeAttackSnapshots.get(
            this.getNativeAttackKey(item,action)
        );
        const record=records?.[records.length-1];

        return record
            ? {captured: true,snapshot: record.snapshot}
            : {captured: false,snapshot: null};
    }

    static endNativeAttack(record) {
        if (!record) {
            return;
        }

        const records=this.nativeAttackSnapshots.get(record.key) ?? [];
        const remaining=records.filter(
            entry=>entry.token!==record.token
        );

        if (remaining.length) {
            this.nativeAttackSnapshots.set(record.key,remaining);
        } else {
            this.nativeAttackSnapshots.delete(record.key);
        }
    }

    static normalizeModifier(value) {
        if (typeof value==='number') {
            return Number.isFinite(value) ? value : null;
        }

        const text=String(value ?? '').trim();

        if (!text) {
            return null;
        }

        const numeric=Number(text);

        if (Number.isFinite(numeric)) {
            return numeric;
        }

        const formula=text.replace(/^\+/,'');

        if (globalThis.Roll?.validate?.(formula)) {
            return text.startsWith('-') || text.startsWith('+')
                ? text
                : `+${text}`;
        }

        return null;
    }

    static applyNativeDamageModifier(item,modifiers) {
        const modifier=this.getDamageModifier(item);

        if (modifier) {
            modifiers.push(modifier);
        }
    }
}

export {AMMO_DAMAGE_DEFAULTS};
