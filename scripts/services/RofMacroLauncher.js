import {isAoeItem,getAoeItemSettings,isLegacyGrenadeItem} from './AoeItemFlags.js';
import * as aoeLauncher from './AoeMacroLauncher.js';
import {aoeResource} from './AoeResourceService.js';
import {withSuppressedAoeAutomation} from './AoeAnimationService.js';
import * as shotgunRules from './ShotgunRules.js';
import {nativeWeaponDamageFormula} from './WeaponDamageModifier.js';

const ROF_SCRIPT_PATH =
    'modules/swade-tools/scripts/services/rof-attack-pool.js';

let compiledRofAttackPool = null;
const pendingRofLaunches = new Set();

const normalizeRuleName = value => String(value ?? '').trim().toLowerCase();
const normalizeSwid = value => normalizeRuleName(value).replace(/[\s_]+/g,'-');
const optionalSetting = (key,fallback) => {
    try {
        const value=game.settings.get('swade-tools',key);
        return typeof value==='string' && value.trim() ? value.trim() : fallback;
    } catch {
        return fallback;
    }
};

// Keep the compact native panel and the pool's inline validation in agreement.
// Rapid Fire applies to Shooting, as in the existing native Rapid Fire button.
export const getInlineRofMaximum = (actor,item) => {
    const raw=Number(item?.system?.rof ?? 1);
    const base=Number.isFinite(raw) ? Math.max(1,Math.floor(raw)) : 1;
    const reference=String(item?.system?.actions?.trait ?? '').trim();
    const skill=actor?.items?.find?.(entry => entry.type==='skill' && (
        entry.id===reference || normalizeRuleName(entry.name)===normalizeRuleName(reference) ||
        normalizeSwid(entry.system?.swid)===normalizeSwid(reference)
    ));
    const isShooting=skill && (
        normalizeRuleName(skill.name)===normalizeRuleName(optionalSetting('shootingSkill','Shooting')) ||
        normalizeSwid(skill.system?.swid)==='shooting'
    );
    const rapidName=normalizeRuleName(optionalSetting('RapidFireSetting','Rapid Fire'));
    const rapidFire=isShooting && actor?.items?.some?.(entry => ['edge','ability'].includes(entry.type) && (
        normalizeSwid(entry.system?.swid)==='rapid-fire' ||
        normalizeRuleName(entry.name)==='rapid fire' || normalizeRuleName(entry.name)===rapidName
    ));
    return Math.min(6,base+(rapidFire ? 1 : 0));
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

const belongsToActor = (token,actor) => {
    if (token?.actor===actor) return true;
    if (token?.actor?.uuid && actor?.uuid) return token.actor.uuid===actor.uuid;
    return Boolean(token?.actor?.id && token.actor.id===actor?.id);
};
const findActorToken = actor => {

    const controlled=asArray(canvas?.tokens?.controlled ?? []);
    const active=typeof actor.getActiveTokens==='function'
        ? asArray(actor.getActiveTokens())
        : [];
    const controlledMatches=controlled.filter(token=>belongsToActor(token,actor));
    if (controlledMatches.length) return controlledMatches.length===1 ? controlledMatches[0] : null;
    const activeMatches=active.filter(token=>belongsToActor(token,actor));
    return activeMatches.length===1 ? activeMatches[0] : null;
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

export const launchRofMacro = async (actor,item,vehicle=null,options={}) => {
    const firingActor=vehicle ?? item?.actor ?? item?.parent ?? actor;
    const explicitToken=options?.token?.object ?? options?.token;
    if (explicitToken && !belongsToActor(explicitToken,firingActor)){
        ui.notifications.warn('The selected source token does not own this weapon. Reopen its weapon panel.');
        return false;
    }
    const selectedToken=explicitToken ?? findActorToken(firingActor);
    if (!selectedToken){
        ui.notifications.warn(
            'Select exactly one source token that owns this weapon before using RoF.'
        );
        return false;
    }
    const launchKey=`${item?.uuid ?? `${actor?.uuid}.${item?.id}`}:${selectedToken.document?.uuid ?? selectedToken.id ?? 'token'}`;
    if (pendingRofLaunches.has(launchKey)){
        ui.notifications.warn('This weapon already has a RoF attack in progress. Finish or cancel it first.');
        return false;
    }
    pendingRofLaunches.add(launchKey);

    try {
        const execute=await getBundledRofAttackPool();
        await execute({
            actor,
            item,
            token:selectedToken,
            weapon:item,
            itemUuid:item.uuid,
            weaponActor:item.actor ?? item.parent ?? firingActor,
            vehicle,
            rofServices:{isAoeItem,getAoeItemSettings,isLegacyGrenadeItem,aoeResource,
                withSuppressedAoeAutomation,nativeWeaponDamageFormula,...aoeLauncher,...shotgunRules},
            ...(Object.hasOwn(options ?? {},'setup') ? {rofSetup:{
                weaponId:item.id,
                itemUuid:item.uuid,
                actorUuid:actor.uuid,
                weaponActorUuid:(item.actor ?? item.parent ?? firingActor).uuid,
                trait:String(item.system?.actions?.trait ?? '').trim(),
                ...options.setup
            }} : {})
        });
        return true;
    } catch (error){
        console.error(
            'SWADE Tools | Bundled RoF attack failed',
            error
        );
        ui.notifications.error(
            'The RoF attack could not be completed. '+
            'Check the F12 console for details.'
        );
        return false;
    } finally {
        pendingRofLaunches.delete(launchKey);
    }
};

export default launchRofMacro;
