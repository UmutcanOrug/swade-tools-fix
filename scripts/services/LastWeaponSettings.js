// Player-local, session-only UI preferences. No document flags, settings writes,
// sockets, or server requests are involved; reloading Foundry clears this Map.
const lastWeaponSettings = new Map();

export const LAST_WEAPON_SETTING_FIELDS = Object.freeze([
    'modifier', 'multiaction', 'cover', 'illumination', 'calledshots',
    'rof', 'recoil', 'drop', 'vulnerable', 'damageModifier', 'consumeAmmo',
    'shotgunMode', 'bothBarrels'
]);

export const getWeaponSettingsClickOptions = (event, sheet) => ({
    restoreLast: event?.shiftKey === true,
    token: sheet?.token ?? (sheet?.actor?.isToken
        ? sheet.actor.token ?? sheet.actor.parent : undefined)
});

const tokenDocument = token => token?.document ?? token;
const tokenUuid = token => {
    if (typeof token === 'string') {
        return /^Scene\.[^.]+\.Token\.[^.]+$/.test(token) ? token : '';
    }
    const document = tokenDocument(token);
    if (/^Scene\.[^.]+\.Token\.[^.]+$/.test(String(document?.uuid ?? ''))) {
        return document.uuid;
    }
    const scene = document?.parent ?? document?.scene ?? token?.scene;
    return scene?.id && document?.id
        ? `Scene.${scene.id}.Token.${document.id}` : '';
};

const belongsToActor = (token, actor) => {
    const tokenActor = token?.actor ?? tokenDocument(token)?.actor;
    if (tokenActor === actor) return true;
    if (tokenActor?.uuid && actor?.uuid) return tokenActor.uuid === actor.uuid;
    return false;
};

const asArray = collection => collection?.contents ?? Array.from(collection ?? []);
const resolveFiringToken = (weaponOwner, suppliedToken) => {
    if (suppliedToken) return suppliedToken;
    if (weaponOwner?.isToken) {
        const ownToken = weaponOwner.token ?? weaponOwner.parent;
        if (tokenUuid(ownToken)) return ownToken;
    }
    const controlled = asArray(globalThis.canvas?.tokens?.controlled)
        .filter(token => belongsToActor(token, weaponOwner));
    if (controlled.length === 1) return controlled[0];
    if (controlled.length > 1) return null;
    const active = typeof weaponOwner?.getActiveTokens === 'function'
        ? asArray(weaponOwner.getActiveTokens()).filter(token => belongsToActor(token, weaponOwner))
        : [];
    // Do not guess among multiple linked copies. An explicit sheet token is
    // preferred; an ambiguous actor sheet uses its own token-less scope.
    return active.length === 1 ? active[0] : null;
};

export const resolveWeaponSettingsContext = ({
    weaponOwner, operator, item, token, userId = globalThis.game?.user?.id
} = {}) => {
    const owner = weaponOwner ?? item?.actor ?? item?.parent;
    const weaponOwnerUuid = String(owner?.uuid ?? '');
    const itemUuid = String(item?.uuid ?? '');
    if (!userId || !weaponOwnerUuid || !itemUuid) return null;
    const operatorUuid = String(operator?.uuid ?? (owner?.type !== 'vehicle' ? owner?.uuid : '') ?? '');
    const context = {
        userId: String(userId), weaponOwnerUuid,
        tokenUuid: tokenUuid(resolveFiringToken(owner, token)),
        itemUuid, operatorUuid
    };
    context.key = JSON.stringify([
        context.userId, context.weaponOwnerUuid, context.tokenUuid,
        context.itemUuid, context.operatorUuid
    ]);
    return Object.freeze(context);
};

const cleanValues = values => {
    const cleaned = {};
    for (const field of LAST_WEAPON_SETTING_FIELDS) {
        const value = values?.[field];
        if (typeof value === 'string' || typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))) {
            cleaned[field] = value;
        }
    }
    return cleaned;
};

export const getLastWeaponSettings = context => {
    if (!context?.key) return null;
    const saved = lastWeaponSettings.get(context.key);
    return saved ? { ...saved } : null;
};

export const saveLastWeaponSettings = (context, values) => {
    if (!context?.key) return null;
    const saved = Object.freeze(cleanValues(values));
    lastWeaponSettings.set(context.key, saved);
    return { ...saved };
};

export const clearLastWeaponSettings = context => {
    if (context?.key) lastWeaponSettings.delete(context.key);
    else lastWeaponSettings.clear();
};
