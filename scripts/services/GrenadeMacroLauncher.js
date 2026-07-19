const GRENADE_SCRIPT_PATH =
    'modules/swade-tools/scripts/services/grenade-attack.js';

let compiledGrenadeAttack = null;

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

export const isGrenadeItem = item => {
    if (
        !item ||
        !['weapon','consumable','gear'].includes(item.type)
    ){
        return false;
    }

    const category=String(item.system?.category ?? '');
    const name=String(item.name ?? '');
    return (
        /grenade|throwable/i.test(category) ||
        /grenade|detonator/i.test(name)
    );
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

const getBundledGrenadeAttack = async () => {
    if (compiledGrenadeAttack){
        return compiledGrenadeAttack;
    }

    const route=foundry.utils.getRoute(GRENADE_SCRIPT_PATH);
    const moduleVersion=
        game.modules.get('swade-tools')?.version ?? '2.1.7';
    const response=await fetch(
        `${route}?v=${encodeURIComponent(moduleVersion)}`,
        {cache:'no-store'}
    );
    if (!response.ok){
        throw new Error(
            `Bundled grenade script could not be loaded (${response.status}).`
        );
    }

    const source=await response.text();
    if (
        !source.includes(
            'SWADE Throw Grenade - Automatic Item Damage'
        )
    ){
        throw new Error('Bundled grenade script marker is missing.');
    }

    compiledGrenadeAttack=new foundry.utils.AsyncFunction(
        'scope',
        source
    );
    return compiledGrenadeAttack;
};

export const launchGrenadeMacro = async (actor,item) => {
    if (!isGrenadeItem(item)){
        ui.notifications.warn(
            'Bu oge el bombasi olarak algilanmadi.'
        );
        return false;
    }

    const selectedToken=findActorToken(actor);
    if (!selectedToken){
        ui.notifications.warn(
            'El bombasi kullanmadan once oge sahibinin tokenini sec.'
        );
        return false;
    }

    try {
        const execute=await getBundledGrenadeAttack();
        await execute({
            actor,
            item,
            token:selectedToken,
            weapon:item,
            itemUuid:item.uuid
        });
        return true;
    } catch (error){
        console.error(
            'SWADE Tools | Bundled grenade attack failed',
            error
        );
        ui.notifications.error(
            'Modun el bombasi sistemi calistirilamadi. '+
            'Ayrinti icin F12 konsolunu kontrol et.'
        );
        return false;
    }
};

export default launchGrenadeMacro;
