const ROF_MACRO_MARKER = 'SWADE RoF Attack Pool and Damage Allocator';

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

const findRofMacro = macros => {
    const candidates=asArray(macros).filter(macro =>
        macro && (!macro.type || macro.type==='script')
    );

    const marked=candidates.find(macro =>
        String(macro.command ?? macro._source?.command ?? '')
            .includes(ROF_MACRO_MARKER)
    );
    if (marked){
        return marked;
    }

    const knownNames=new Set([
        'swade rof attack pool',
        'swade rof attack pool and damage allocator',
        'rof attack pool'
    ]);
    return candidates.find(macro =>
        knownNames.has(String(macro.name ?? '').trim().toLowerCase())
    ) ?? null;
};

const findActorToken = actor => {
    const belongsToActor = token =>
        token?.actor===actor ||
        token?.actor?.uuid===actor?.uuid ||
        (
            token?.actor?.id===actor?.id &&
            token?.actor?.id!==undefined
        );

    const controlled=asArray(canvas?.tokens?.controlled ?? []);
    const active=typeof actor.getActiveTokens==='function'
        ? asArray(actor.getActiveTokens())
        : [];
    return controlled.find(belongsToActor) ??
        active.find(belongsToActor) ??
        null;
};

export const launchRofMacro = async (actor,item) => {
    const selectedToken=findActorToken(actor);
    if (!selectedToken){
        ui.notifications.warn(
            'RoF kullanmadan once silahin sahibi olan tokeni sec.'
        );
        return false;
    }

    const macro=findRofMacro(game.macros);
    if (!macro || typeof macro.execute!=='function'){
        ui.notifications.warn(
            'Bu dunyada SWADE RoF Attack Pool makrosu bulunamadi. '+
            'Once en yeni RoF makrosunu olustur veya ice aktar.'
        );
        return false;
    }

    await macro.execute({
        actor,
        item,
        token:selectedToken,
        weapon:item,
        itemUuid:item.uuid
    });
    return true;
};

export default launchRofMacro;
