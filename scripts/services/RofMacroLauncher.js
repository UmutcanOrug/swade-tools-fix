const ROF_MACRO_MARKER = 'SWADE RoF Attack Pool and Damage Allocator';
const ROF_MACRO_FLAG_SCOPE = 'swade-tools';
const ROF_MACRO_FLAG_KEY = 'rofAllocator';

const normalizeName = value =>
    String(value ?? '').trim().toLowerCase();

const localize = (key,fallback) => {
    const fullKey=`SWADETOOLS.${key}`;
    const translated=game.i18n.localize(fullKey);
    return translated===fullKey ? fallback : translated;
};

const asArray = collection => {
    if (!collection){
        return [];
    }
    if (Array.isArray(collection)){
        return collection;
    }
    if (Array.isArray(collection.contents)){
        return collection.contents;
    }
    return Array.from(collection);
};

export const findRofAllocatorMacro = macros => {
    const candidates = asArray(macros).filter(macro =>
        macro && (!macro.type || macro.type==='script')
    );

    const flagged = candidates.find(macro =>
        macro.getFlag?.(ROF_MACRO_FLAG_SCOPE,ROF_MACRO_FLAG_KEY)===true
    );
    if (flagged){
        return flagged;
    }

    const marked = candidates.find(macro =>
        String(macro.command ?? macro._source?.command ?? '')
            .includes(ROF_MACRO_MARKER)
    );
    if (marked){
        return marked;
    }

    const knownNames = new Set([
        'swade rof attack pool',
        'swade rof attack pool and damage allocator',
        'rof attack pool'
    ]);
    return candidates.find(macro =>
        knownNames.has(normalizeName(macro.name))
    ) ?? null;
};

export const findActorToken = (
    actor,
    controlledTokens=[],
    activeTokens=[]
) => {
    const belongsToActor = token =>
        token?.actor===actor ||
        token?.actor?.uuid===actor?.uuid ||
        (
            token?.actor?.id===actor?.id &&
            token?.actor?.id!==undefined
        );

    return asArray(controlledTokens).find(belongsToActor) ??
        asArray(activeTokens).find(belongsToActor) ??
        null;
};

export const launchRofAllocatorMacro = async (actor,item) => {
    if (!actor || !item){
        ui.notifications.error(
            localize(
                'RofWeaponOwnerMissing',
                'RoF could not resolve the weapon owner.'
            )
        );
        return false;
    }

    const activeTokens = typeof actor.getActiveTokens==='function'
        ? actor.getActiveTokens()
        : [];
    const selectedToken = findActorToken(
        actor,
        canvas?.tokens?.controlled ?? [],
        activeTokens
    );

    if (!selectedToken){
        ui.notifications.warn(
            localize(
                'RofSelectOwnerToken',
                'Select the token that owns this weapon before using RoF.'
            )
        );
        return false;
    }

    const macro = findRofAllocatorMacro(game.macros);
    if (!macro || typeof macro.execute!=='function'){
        ui.notifications.warn(
            localize(
                'RofAllocatorMacroMissing',
                'SWADE RoF Attack Pool macro was not found in this world. '+
                'Create or import the latest RoF macro first.'
            )
        );
        return false;
    }

    await macro.execute({
        actor,
        item,
        token: selectedToken,
        weapon: item,
        itemUuid: item.uuid
    });
    return true;
};

export default launchRofAllocatorMacro;
