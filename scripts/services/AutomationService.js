import * as gb from '../gb.js';

const RESOLUTION_DEFAULTS=Object.freeze({
    version: 1,
    mode: 'none',
    activationAction: 'formula',
    templatePreset: 'small',
    defenseTrait: 'Athletics',
    defenseModifier: 0,
    targetNumber: 4,
    autoTarget: true,
    damageOnFailure: true,
    damageEnabled: true,
    damageAction: '',
    damageSourceItemUuid: '',
    resourceSourceItemUuid: '',
    resourcesUsed: 1,
    autoSpendPowerPoints: true,
    targetFilter: 'all',
    includeSelf: false,
    useWalls: false
});

const COMBAT_RULE_DEFAULTS=Object.freeze({
    version: 1,
    enabled: false,
    role: 'defender',
    attackType: 'ranged',
    value: -2,
    group: 'cover',
    mode: 'best',
    requiresReadied: false
});

export default class AutomationService {
    static installed=false;

    static install() {
        if (this.installed) {
            return;
        }

        this.installed=true;
        Hooks.on(
            'swadeCalculateDefaultAttackMods',
            (...args)=>this.applyDefaultAttackModifiers(...args)
        );
    }

    static getResolutionProfile(item) {
        const stored=item?.getFlag?.(gb.moduleName,'resolution') ?? null;
        const defaults=foundry.utils.deepClone(RESOLUTION_DEFAULTS);
        const hasTemplate=Object.values(item?.system?.templates ?? {})
            .some(Boolean);

        if (!stored && hasTemplate) {
            // Target selection is safe as a default: it does not roll a
            // defense, spend resources, apply damage, or infer a power rule.
            defaults.mode='template-only';
        }

        return foundry.utils.mergeObject(
            defaults,
            stored ?? {},
            {inplace: true, insertKeys: true, overwrite: true}
        );
    }

    static getCombatRule(item) {
        const stored=item?.getFlag?.(gb.moduleName,'combatRule') ?? {};
        return foundry.utils.mergeObject(
            foundry.utils.deepClone(COMBAT_RULE_DEFAULTS),
            stored,
            {inplace: true, insertKeys: true, overwrite: true}
        );
    }

    static hasResolutionProfile(item) {
        return this.getResolutionProfile(item).mode!=='none';
    }

    static isGrenadeProfile(item) {
        return this.getResolutionProfile(item).mode==='grenade';
    }

    static applyDefaultAttackModifiers(
        sourceToken,
        targetToken,
        _skill,
        _attackItem,
        isRangedAttack,
        isMeleeAttack,
        additionalMods,
        bestNonStackingMods
    ) {
        const attackType=isRangedAttack
            ? 'ranged'
            : (isMeleeAttack ? 'melee' : 'other');
        const entries=[
            ...this.collectCombatRules(sourceToken?.actor,'attacker',attackType),
            ...this.collectCombatRules(targetToken?.actor,'defender',attackType)
        ];

        for (const entry of entries) {
            this.applyCombatRule(entry,additionalMods,bestNonStackingMods);
        }
    }

    static collectCombatRules(actor,role,attackType) {
        if (!actor?.items) {
            return [];
        }

        const entries=[];

        for (const item of actor.items) {
            const stored=item.getFlag?.(gb.moduleName,'combatRule');

            if (!stored) {
                continue;
            }

            const rule=this.getCombatRule(item);

            if (!rule.enabled || rule.role!==role ||
                !['all',attackType].includes(rule.attackType) ||
                !this.isRuleSourceActive(item,rule)) {
                continue;
            }

            entries.push({item,rule});
        }

        return entries;
    }

    static isRuleSourceActive(item,rule) {
        if (!rule.requiresReadied) {
            return true;
        }

        if (typeof item.isReadied==='boolean') {
            return item.isReadied;
        }

        return Number(item.system?.equipStatus ?? 0)===3;
    }

    static applyCombatRule(entry,additionalMods,bestNonStackingMods) {
        const {item,rule}=entry;
        const value=Number(rule.value);

        if (!Number.isFinite(value)) {
            return;
        }

        // When a configured item is also recognized by SWADE (for example
        // an Edge with SWID "dodge"), replace the native entry instead of
        // applying the same source twice.
        for (let index=additionalMods.length-1; index>=0; index-=1) {
            if (additionalMods[index]?.label===item.name) {
                additionalMods.splice(index,1);
            }
        }

        for (const key of ['bestCover','bestIllumination']) {
            if (bestNonStackingMods[key]?.label===item.name) {
                bestNonStackingMods[key]=undefined;
            }
        }

        const modifier={label: item.name,value};

        if (rule.group==='cover') {
            this.applyNonStackingRule(
                'bestCover',
                modifier,
                rule,
                bestNonStackingMods,
                additionalMods
            );
            return;
        }

        if (rule.group==='illumination') {
            this.applyNonStackingRule(
                'bestIllumination',
                modifier,
                rule,
                bestNonStackingMods,
                additionalMods
            );
            return;
        }

        if (value!==0) {
            additionalMods.push(modifier);
        }
    }

    static applyNonStackingRule(
        key,
        modifier,
        rule,
        bestNonStackingMods,
        additionalMods
    ) {
        if (rule.mode==='stack') {
            if (modifier.value!==0) {
                additionalMods.push(modifier);
            }
            return;
        }

        if (rule.mode==='replace') {
            bestNonStackingMods[key]=modifier.value===0 ? undefined : modifier;
            return;
        }

        const current=bestNonStackingMods[key];

        if (modifier.value!==0 &&
            (!current || Number(modifier.value)<Number(current.value))) {
            bestNonStackingMods[key]=modifier;
        }
    }

    static getLegacyIncomingAttackRules(actor,attackType) {
        return this.collectCombatRules(actor,'defender',attackType);
    }
}

export {
    COMBAT_RULE_DEFAULTS,
    RESOLUTION_DEFAULTS
};
