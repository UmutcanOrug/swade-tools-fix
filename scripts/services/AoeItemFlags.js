export const AOE_FLAG_SCOPE = 'swade-tools';
export const AOE_ENABLED_FLAG = 'aoeEnabled';
export const AOE_ITEM_TYPES = new Set(['weapon', 'consumable', 'gear']);

export const canEnableAoe = item => Boolean(
    item && AOE_ITEM_TYPES.has(item.type)
);

// Existing grenade inventories retain their automatic button. An explicit
// unchecked AoE box always wins over the legacy name/category fallback.
export const isLegacyGrenadeItem = item => Boolean(
    item && ['weapon', 'consumable', 'gear'].includes(item.type) && (
        /grenade|throwable/i.test(String(item.system?.category ?? '')) ||
        /grenade|detonator/i.test(String(item.name ?? ''))
    )
);

export const getAoeEnabledFlag = item => {
    const flag = typeof item?.getFlag === 'function'
        ? item.getFlag(AOE_FLAG_SCOPE, AOE_ENABLED_FLAG)
        : item?.flags?.[AOE_FLAG_SCOPE]?.[AOE_ENABLED_FLAG];
    return typeof flag === 'boolean' ? flag : undefined;
};

export const isAoeItem = item => {
    if (!canEnableAoe(item)) return false;
    return getAoeEnabledFlag(item) ?? isLegacyGrenadeItem(item);
};

export const setAoeEnabled = async (item, enabled) => {
    if (!canEnableAoe(item)) {
        throw new Error('This item type cannot use AoE attacks.');
    }
    if (!item.isOwner) {
        throw new Error('You do not own this item.');
    }
    const value = Boolean(enabled);
    if (typeof item.setFlag === 'function') {
        await item.setFlag(AOE_FLAG_SCOPE, AOE_ENABLED_FLAG, value);
    } else {
        await item.update({
            [`flags.${AOE_FLAG_SCOPE}.${AOE_ENABLED_FLAG}`]: value
        });
    }
    return value;
};

const readFlag = (item, key) => typeof item?.getFlag === 'function'
    ? item.getFlag(AOE_FLAG_SCOPE, key)
    : item?.flags?.[AOE_FLAG_SCOPE]?.[key];

const readAmmoCost = item => {
    const value = Number(readFlag(item, 'aoeAmmoCost'));
    return Number.isSafeInteger(value) && value >= 1 ? value : 1;
};

export const getAoeConsumptionMode = item => {
    const mode = readFlag(item, 'aoeConsumeMode');
    if (['ammo','item','none'].includes(mode)) return mode;
    if (readFlag(item, 'aoeConsume') === false) return 'none';
    const owner = item?.actor ?? item?.parent;
    if (owner?.type === 'vehicle') return 'ammo';
    if (['gear','consumable'].includes(item?.type)) return 'item';
    const trait = String(item?.system?.actions?.trait ?? '').trim().toLowerCase();
    const handThrown = isLegacyGrenadeItem(item) && (
        /throwable|thrown/i.test(String(item?.system?.category ?? '')) || trait === 'athletics'
    );
    return handThrown || item?.system?.reloadType === 'self' ? 'item' : 'ammo';
};

export const getAoeItemSettings = item => ({
    // Use the same native Trait as normal SWADE Tools attacks. Old aoeSkill
    // flags must not silently override a later change to the weapon's Trait.
    skill: String(item?.system?.actions?.trait ?? '').trim(),
    blastSize: ['small', 'medium', 'large'].includes(readFlag(item, 'aoeBlastSize'))
        ? readFlag(item, 'aoeBlastSize')
        : ['small', 'medium', 'large'].find(size => item?.system?.templates?.[size]) ?? 'medium',
    consumeMode: getAoeConsumptionMode(item),
    consume: getAoeConsumptionMode(item) !== 'none',
    damageAction: String(readFlag(item, 'aoeDamageAction') ?? ''),
    ammoCost: readAmmoCost(item)
});

export const saveAoeItemSettings = async (item, settings) => {
    if (!canEnableAoe(item) || !item.isOwner) {
        throw new Error('You do not own an eligible AoE item.');
    }
    if (!['small', 'medium', 'large'].includes(settings?.blastSize)) {
        throw new Error('Choose a valid blast template size.');
    }
    const ammoCost = Number(settings?.ammoCost ?? 1);
    if (!Number.isSafeInteger(ammoCost) || ammoCost < 1) {
        throw new Error('Uses per Attack must be a positive whole number.');
    }
    const damageAction = String(settings.damageAction ?? '');
    if (damageAction && item.system?.actions?.additional?.[damageAction]?.type !== 'damage') {
        throw new Error('The selected damage action is no longer available.');
    }
    const consumeMode = settings.consumeMode ?? (settings.consume === false ? 'none' : getAoeConsumptionMode(item));
    if (!['ammo','item','none'].includes(consumeMode)) {
        throw new Error('Choose a valid resource consumption mode.');
    }
    const saved = {
        skill: String(item?.system?.actions?.trait ?? '').trim(),
        blastSize: settings.blastSize,
        consumeMode,
        consume: consumeMode !== 'none',
        damageAction,
        ammoCost
    };
    await item.update({
        'flags.swade-tools.aoeBlastSize': saved.blastSize,
        'flags.swade-tools.aoeConsume': saved.consume,
        'flags.swade-tools.aoeConsumeMode': saved.consumeMode,
        'flags.swade-tools.aoeDamageAction': saved.damageAction,
        'flags.swade-tools.aoeAmmoCost': saved.ammoCost
    });
    return saved;
};
