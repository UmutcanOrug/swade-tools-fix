const ROF_SCRIPT_PATH =
    'modules/swade-tools/scripts/services/rof-attack-pool.js';

let compiledRofAttackPool = null;

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

const getBundledRofAttackPool = async () => {
    if (compiledRofAttackPool){
        return compiledRofAttackPool;
    }

    const route=foundry.utils.getRoute(ROF_SCRIPT_PATH);
    const moduleVersion=
        game.modules.get('swade-tools')?.version ?? '2.1.7';
    const response=await fetch(
        `${route}?v=${encodeURIComponent(moduleVersion)}`,
        {cache:'no-store'}
    );
    if (!response.ok){
        throw new Error(
            `Bundled RoF script could not be loaded (${response.status}).`
        );
    }

    const source=await response.text();
    if (
        !source.includes(
            'SWADE RoF Attack Pool and Damage Allocator'
        )
    ){
        throw new Error('Bundled RoF script marker is missing.');
    }

    const AsyncFunction=foundry.utils.AsyncFunction;
    compiledRofAttackPool=new AsyncFunction('scope',source);
    return compiledRofAttackPool;
};

export const launchRofMacro = async (actor,item,vehicle=null) => {
    const firingActor=vehicle ?? actor;
    const selectedToken=findActorToken(firingActor);
    if (!selectedToken){
        ui.notifications.warn(
            'RoF kullanmadan once silahin sahibi olan tokeni sec.'
        );
        return false;
    }

    try {
        const execute=await getBundledRofAttackPool();
        await execute({
            actor,
            item,
            token:selectedToken,
            weapon:item,
            itemUuid:item.uuid,
            weaponActor:item.actor ?? item.parent ?? firingActor,
            vehicle
        });
        return true;
    } catch (error){
        console.error(
            'SWADE Tools | Bundled RoF attack failed',
            error
        );
        ui.notifications.error(
            'Modun RoF sistemi calistirilamadi. '+
            'Ayrinti icin F12 konsolunu kontrol et.'
        );
        return false;
    }
};

export default launchRofMacro;
