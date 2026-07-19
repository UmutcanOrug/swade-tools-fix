import { resolveActionResourceCost } from './AttackModeResolver.js';

export default class WeaponResourceService {
    static pending=new Set();

    static resolveCost(action = {}, rof = 1) {
        return resolveActionResourceCost(action, rof);
    }

    static isMixedWeapon(item) {
        return item?.type==='weapon' &&
            item.system?.isMelee===true &&
            item.system?.isRanged===true;
    }

    static isRangedAttack(
        item,
        traitName,
        {fightingSkill='',shootingSkill=''}={}
    ) {
        if (item?.type!=='weapon') {
            return false;
        }

        const isRanged=item.system?.isRanged===true ||
            (item.system?.isMelee!==true &&
                item.isMeleeWeapon!==true);

        if (!isRanged) {
            return false;
        }

        if (!this.isMixedWeapon(item)) {
            return true;
        }

        const trait=String(traitName ?? '').trim().toLowerCase();
        const fighting=String(fightingSkill ?? '').trim().toLowerCase();
        const shooting=String(shootingSkill ?? '').trim().toLowerCase();

        if (fighting && trait===fighting) {
            return false;
        }

        if (shooting && trait===shooting) {
            return true;
        }

        // A mixed weapon's non-Fighting trait (for example Athletics on a
        // thrown weapon) represents its ranged use.
        return true;
    }

    static isManagedWeapon(item,{rangedAttack=null}={}) {
        if (item?.type!=='weapon' ||
            game.settings.get('swade','ammoManagement')!==true) {
            return false;
        }

        if (this.isMixedWeapon(item)) {
            // A mixed weapon can use Fighting without spending ammunition.
            // Explicit resource workflows have no trait context and therefore
            // intentionally default to the ranged side of the weapon.
            return rangedAttack!==false;
        }

        return item.system?.isRanged===true ||
            item.isMeleeWeapon!==true;
    }

    static getMixedWeaponAvailability(item) {
        const reloadType=String(
            item.system?.reloadType ?? ''
        ).toLowerCase();

        if (reloadType==='none') {
            const usesInventory=
                item.usesAmmoFromInventory ??
                item.system?.usesAmmoFromInventory ??
                false;

            if (!usesInventory) {
                return Infinity;
            }

            const ammo=item.actor?.items?.getName?.(item.system?.ammo);

            if (!ammo) {
                return 0;
            }

            return Math.max(0,Number(
                ammo.system?.charges?.value ??
                ammo.system?.charges?.default?.value ??
                ammo.system?.quantity ??
                0
            ));
        }

        if (reloadType==='self') {
            const shots=Math.max(0,Number(item.system?.shots ?? 0));
            const quantity=Math.max(0,Number(item.system?.quantity ?? 0));
            const current=Math.max(
                0,
                Number(item.system?.currentShots ?? 0)
            );
            return Math.max(0,(shots*Math.max(0,quantity-1))+current);
        }

        return Math.max(0,Number(item.system?.currentShots ?? 0));
    }

    static validate(item,resourcesUsed=1,options={}) {
        const cost = Number(resourcesUsed);

        if (!this.isManagedWeapon(item,options) ||
            !Number.isFinite(cost) || cost <= 0) {
            return {ok: true,cost: 0};
        }

        if (typeof item.canExpendResources!=='function' ||
            typeof item.consume!=='function') {
            return {ok: false,cost,reason: 'unsupported'};
        }

        if (this.isMixedWeapon(item)) {
            const available=this.getMixedWeaponAvailability(item);

            if (available<cost) {
                return {ok: false,cost,available,reason: 'insufficient'};
            }

            // Reload type "none" without inventory tracking represents
            // unlimited ammunition and SWADE intentionally performs no
            // resource update for it.
            if (!Number.isFinite(available)) {
                return {ok: true,cost: 0,available};
            }
        } else if (!item.canExpendResources(cost)) {
            return {ok: false,cost,reason: 'insufficient'};
        }

        return {ok: true,cost};
    }

    static async commit(item,resourcesUsed=1,options={}) {
        const validation=this.validate(item,resourcesUsed,options);

        if (!validation.ok || validation.cost===0) {
            return {
                ok: validation.ok,
                consumed: 0,
                reason: validation.reason
            };
        }

        const key=item.uuid ?? item.id;

        if (this.pending.has(key)) {
            return {ok: false,consumed: 0,reason: 'busy'};
        }

        this.pending.add(key);

        try {
            const currentValidation=this.validate(
                item,
                validation.cost,
                options
            );

            if (!currentValidation.ok) {
                return {
                    ok: false,
                    consumed: 0,
                    reason: currentValidation.reason
                };
            }

            await item.consume(validation.cost);
            return {ok: true,consumed: validation.cost};
        } finally {
            this.pending.delete(key);
        }
    }

    static async expend(item,resourcesUsed=1,options={}) {
        const validation=this.validate(item,resourcesUsed,options);

        if (!validation.ok) {
            return {ok: false,consumed: 0,reason: validation.reason};
        }

        return this.commit(item,resourcesUsed,options);
    }
}
