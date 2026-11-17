import {isPrimaryAoeGm} from './AoeAuthority.js';
import {validatePowerCastSnapshot, powerDamageFormula, escapePowerHTML, getPowerLingeringFormula} from './PowerModifiers.js';
import {createAoeFireDamageCard} from './AoeFireDamage.js';

const SCOPE='swade-tools', SETTING='powerModifierLedger';
const values=collection=>Array.from(collection?.contents ?? collection?.values?.() ?? collection ?? []);
const clone=value=>JSON.parse(JSON.stringify(value));
const gameOf=runtime=>runtime.gameRef ?? globalThis.game;
const stateOf=effect=>effect?.flags?.[SCOPE]?.powerModifier;
const queues=new WeakMap(), registrations=new WeakSet();
const serial=(runtime,task)=>{
    const game=gameOf(runtime);
    if(!game || !isPrimaryAoeGm(game)) return Promise.resolve(null);
    const next=(queues.get(game) ?? Promise.resolve()).catch(()=>{}).then(task);
    queues.set(game,next);
    return next.finally(()=>{if(queues.get(game)===next)queues.delete(game);});
};
const ledgerOf=runtime=>clone(gameOf(runtime).settings.get(SCOPE,SETTING) ?? {version:1,events:{}});
const save=(ledger,runtime)=>gameOf(runtime).settings.set(SCOPE,SETTING,ledger);
const eventKey=(cast,target)=>encodeURIComponent(JSON.stringify([cast.id,target.uuid]));
const owns=(actor,user)=>user?.isGM || actor?.testUserPermission?.(user,'OWNER')===true ||
    Number(actor?.ownership?.[user?.id] ?? actor?.ownership?.default ?? 0)>=3;
const effectsOf=actor=>values(actor?.effects).filter(effect=>!effect.disabled && !effect.isSuppressed && stateOf(effect)?.version===1);
const turnOf=combat=>({combatId:combat?.id,round:Number(combat?.round),turn:Number(combat?.turn),
    combatantId:combat?.combatant?.id,actorUuid:combat?.combatant?.actor?.uuid,
    tokenUuid:combat?.combatant?.token?.uuid});
const turnKey=turn=>`${turn.combatId}:${turn.round}:${turn.combatantId}`;
const targetTurn=(state,turn,actor)=>turn.tokenUuid ? turn.tokenUuid===state.targetUuid : turn.actorUuid===actor.uuid;
const privacyOf=message=>({whisper:values(message.whisper).map(user=>typeof user==='string'?user:user.id),blind:message.blind===true});
const hasEffects=cast=>Boolean(cast.choices.fatigue || cast.choices.light || cast.choices.pace || cast.choices.lingering);

export const lingeringDamageFormula=getPowerLingeringFormula;

const stealthChange=(actor,value)=>{
    const skill=values(actor.items).find(item=>item.type==='skill' &&
        (String(item.system?.swid).toLowerCase()==='stealth' || /^stealth$/i.test(item.name)));
    return skill ? [{key:`@skill{${skill.id}}[system.die.modifier]`,mode:2,value:String(value)}] : [];
};
export const buildPowerModifierEffects=({cast,target,message,actor,game})=>{
    const c=cast.choices, combat=game.combat, turn=turnOf(combat);
    const sources=values(combat?.combatants).filter(combatant=>combatant.actor?.uuid===actor.uuid);
    const sourceCombatant=cast.sourceTokenUuid ? sources.find(combatant=>combatant.token?.uuid===cast.sourceTokenUuid)
        : sources.length===1 ? sources[0] : null;
    const common={version:1,castId:cast.id,itemUuid:cast.itemUuid,sourceMessageId:message.id,targetUuid:target.uuid,actorUuid:target.actor.uuid,
        sourceActorUuid:actor.uuid,sourceTokenUuid:cast.sourceTokenUuid ?? '',durationSeconds:cast.duration.seconds,
        createdTurn:turnKey(turn),combatId:combat?.id ?? null,instant:cast.duration.instant,
        expiresRound:cast.duration.instant ? null : Number(combat?.round ?? 0)+(cast.duration.seconds ?? 0)/6,
        sourceCombatantId:sourceCombatant?.id ?? null,
        expiresAt:!combat || cast.duration.seconds>=60 ? Number(game.time?.worldTime ?? 0)+cast.duration.seconds : null,
        ...privacyOf(message)};
    const effects=[];
    const add=(kind,name,changes,extra={})=>effects.push({name:`${name} (${message.speaker?.alias ?? 'Power'})`,
        img:'icons/svg/aura.svg',origin:cast.itemUuid,transfer:false,disabled:false,changes,
        // The module handles exact caster/target-turn expiry; native duration
        // must not delete a lingering effect before its start-turn damage.
        duration:{},flags:{[SCOPE]:{powerModifier:{...common,kind,...extra}}}});
    if(c.fatigue) add('fatigue','Fatigue',[{key:'system.fatigue.value',mode:0,value:'1',priority:1000}]);
    if(c.light==='glow') add('glow','Glow',stealthChange(target.actor,-2));
    if(c.light==='shroud') add('shroud','Shroud',stealthChange(target.actor,1));
    if(c.pace) add(c.pace,c.pace==='hinder'?'Hinder':'Hurry',[{key:'system.pace.ground',mode:0,value:c.pace==='hinder'?'-2':'2',priority:60}]);
    if(c.lingering) add('lingering','Lingering Damage',[],{formula:lingeringDamageFormula(powerDamageFormula(cast,cast.lingeringBaseDamage ?? cast.damage)),
        ap:cast.lingeringAp ?? cast.ap,heavyWeapon:cast.lingeringHeavyWeapon ?? cast.heavyWeapon,done:false});
    return effects;
};

export const applyPowerModifierChange=(actor,change,_current,_delta,changes)=>{
    const state=stateOf(change.effect);
    if(state?.version!==1) return;
    if(change.key==='system.fatigue.value' && state.kind==='fatigue'){
        const current=Number(actor.system.fatigue.value),max=Number(actor.system.fatigue.max);
        if(!Number.isFinite(current) || !Number.isFinite(max))return;
        const next=current>=max ? current : current+1;
        actor.system.fatigue.value=next;changes[change.key]=next;
    } else if(change.key==='system.pace.ground' && ['hinder','hurry'].includes(state.kind)){
        const effects=effectsOf(actor).filter(effect=>['hinder','hurry'].includes(stateOf(effect).kind)).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
        if(effects[0]?.id!==change.effect.id)return;
        const delta=(effects.some(effect=>stateOf(effect).kind==='hinder')?-2:0)+(effects.some(effect=>stateOf(effect).kind==='hurry')?2:0);
        const next=Math.max(0,Number(actor.system.pace.ground)+delta);
        actor.system.pace.ground=next;changes[change.key]=next;
    }
};
export const powerTargetDefense=(actor,illuminationPenalty=0,excludeCastId='')=>{
    const kinds=new Set(effectsOf(actor).filter(effect=>stateOf(effect).castId!==excludeCastId).map(effect=>stateOf(effect).kind));
    return (kinds.has('shroud')?1:0)-(kinds.has('glow') && Number(illuminationPenalty)>0?1:0);
};

export const resolvePowerModifierTarget=(input,runtime={})=>serial(runtime,async()=>{
    const {message,actor,item}=input,target=input.target?.document ?? input.target;
    const cast=validatePowerCastSnapshot(message?.flags?.[SCOPE]?.powerCast);
    if(!hasEffects(cast) || input.outcome!=='hit' && input.outcome!=='raise' || input.critical ||
        !message?.id || message.isContentVisible===false || item?.type!=='power' ||
        cast.itemUuid!==item.uuid || cast.actorUuid!==actor?.uuid || item.actor?.uuid!==actor.uuid ||
        !cast.targets.some(bound=>bound.uuid===target?.uuid && bound.actorUuid===target?.actor?.uuid) ||
        Number(message.rolls?.[0]?.total)+Number(message.flags?.[SCOPE]?.gmmod ?? 0)!==input.total ||
        (input.total<4 && !(input.innate && cast.innate && message.flags?.[SCOPE]?.powerCastActivation)))return null;
    const game=gameOf(runtime), author=game.users.get(message.author?.id ?? message.user?.id ?? message.user);
    if(!author || !owns(actor,author))return null;
    const original=await (runtime.fromUuid ?? globalThis.fromUuid)?.(target.uuid);
    if(original?.actor?.uuid!==target.actor.uuid || original.actor.type==='vehicle' || original.hidden && !author.isGM)return null;
    const ledger=ledgerOf(runtime);ledger.events ??= {};
    const key=eventKey(cast,target), existing=ledger.events[key];
    if(existing && existing.status!=='pending')return existing;
    if(Object.keys(ledger.events).length>=12000 && !existing)throw new Error('Power Modifier history is full. Remove old casting messages before resolving new effects.');
    // Non-damaging powers can be resisted. The GM confirms that the power
    // actually affected this target rather than equating activation with that.
    if(!cast.damage && input.confirmed!==true){
        const pending={status:'pending',messageId:message.id,castId:cast.id,targetUuid:target.uuid,actorUuid:target.actor.uuid};
        ledger.events[key]=pending;await save(ledger,runtime);return pending;
    }
    const entry={status:'claimed',messageId:message.id,castId:cast.id,targetUuid:target.uuid,actorUuid:target.actor.uuid,
        itemUuid:item.uuid,actorUuid:target.actor.uuid,effectIds:[]};
    ledger.events[key]=entry;await save(ledger,runtime);
    try {
        const data=buildPowerModifierEffects({cast,target,message,actor,game});
        entry.fatiguePending=Boolean(cast.damage && cast.choices.fatigue && !cast.choices.light && !cast.choices.pace);
        if(entry.fatiguePending)entry.fatigueData=data.find(effect=>stateOf(effect).kind==='fatigue');
        for(const effect of data){
            const state=stateOf(effect);
            if(entry.fatiguePending && state.kind==='fatigue')continue;
            if(['glow','shroud'].includes(state.kind) && effectsOf(target.actor).some(current=>stateOf(current).kind===state.kind))effect.changes=[];
            const created=await target.actor.createEmbeddedDocuments('ActiveEffect',[effect]);
            if(!created?.[0])throw new Error('A Power Modifier effect could not be created.');
            entry.effectIds.push(created[0].id);
        }
        await synchronizePowerStealth(target.actor,runtime);
        await synchronizePowerGlow(target,runtime);
        entry.status='applied';await save(ledger,runtime);
        return entry;
    } catch(error){entry.status='review';entry.reason=error.message;await save(ledger,runtime);throw error;}
});

// Called after the native GM Apply Damage/Soak path has actually affected the
// victim. Merely rolling damage against armor does not grant free Fatigue.
export const resolvePowerModifierDamage=(input,runtime={})=>serial(runtime,async()=>{
    const {message}=input,target=input.target?.document ?? input.target;
    const fire=message?.flags?.[SCOPE]?.aoeFire;
    const lingering=fire?.kind==='powerLingering' ? gameOf(runtime).messages.get(fire.powerModifierMessageId) : null;
    const rawCast=message?.flags?.[SCOPE]?.powerCast ?? message?.flags?.[SCOPE]?.powerModifierSource?.cast ?? lingering?.flags?.[SCOPE]?.powerCast;
    if(fire?.kind==='powerLingering' && rawCast?.id!==fire.powerModifierCastId)return null;
    const cast=validatePowerCastSnapshot(rawCast);
    const resolve=runtime.fromUuid ?? globalThis.fromUuid;
    const actor=input.actor ?? await resolve?.(cast.actorUuid),item=input.item ?? await resolve?.(cast.itemUuid);
    if(!cast.choices.fatigue || !cast.damage || cast.itemUuid!==item?.uuid || cast.actorUuid!==actor?.uuid)return null;
    const ledger=ledgerOf(runtime),entry=ledger.events?.[eventKey(cast,target)];
    if(entry?.status!=='applied' || !entry.fatiguePending || entry.actorUuid!==target.actor?.uuid || entry.itemUuid!==item.uuid)return entry;
    const original=gameOf(runtime).messages.get(entry.messageId);
    if(original?.flags?.[SCOPE]?.powerCast?.id!==cast.id || Number(original.rolls?.[0]?.total)+Number(original.flags?.[SCOPE]?.gmmod ?? 0)<4)return null;
    const document=await (runtime.fromUuid ?? globalThis.fromUuid)?.(target.uuid);
    if(document?.actor?.uuid!==target.actor.uuid)return null;
    entry.fatiguePending=false;entry.fatigueStatus='claimed';await save(ledger,runtime);
    const created=await target.actor.createEmbeddedDocuments('ActiveEffect',[entry.fatigueData]);
    entry.effectIds.push(...(created ?? []).map(effect=>effect.id));
    entry.fatigueStatus='applied';delete entry.fatigueData;await save(ledger,runtime);
    return entry;
});

export const synchronizePowerGlow=async(target,runtime={})=>{
    if(!isPrimaryAoeGm(gameOf(runtime)) || !target?.update || !target.actor)return;
    const glows=effectsOf(target.actor).filter(effect=>stateOf(effect).kind==='glow' && stateOf(effect).targetUuid===target.uuid);
    const stored=target.flags?.[SCOPE]?.powerModifierLight;
    if(glows.length && !stored){
        const radius=Number(target.parent?.grid?.distance ?? 1);
        if(Number(target.light?.dim ?? 0)>=radius || Number(target.light?.bright ?? 0)>=radius)return;
        const before={dim:target.light?.dim ?? 0,bright:target.light?.bright ?? 0};
        const applied={dim:radius,bright:0};
        await target.update({'light.dim':radius,'light.bright':0,[`flags.${SCOPE}.powerModifierLight`]:{before,applied}});
    } else if(!glows.length && stored){
        const update={[`flags.${SCOPE}.-=powerModifierLight`]:null};
        for(const key of ['dim','bright'])if(Number(target.light?.[key])===stored.applied[key])update[`light.${key}`]=stored.before[key];
        await target.update(update);
    }
};

export const synchronizePowerStealth=async(actor,runtime={})=>{
    if(!isPrimaryAoeGm(gameOf(runtime)))return;
    for(const [kind,value]of [['glow',-2],['shroud',1]]){
        const all=values(actor.effects).filter(effect=>stateOf(effect)?.kind===kind);
        const first=all.find(effect=>!effect.disabled && !effect.isSuppressed);
        for(const effect of all){
            const desired=effect===first ? stealthChange(actor,value) : [];
            if(JSON.stringify(effect.changes ?? [])!==JSON.stringify(desired))await effect.update({changes:desired});
        }
    }
};

const allActors=game=>{
    const actors=[...values(game.actors),...values(game.scenes).flatMap(scene=>values(scene.tokens).map(token=>token.actor))];
    return [...new Map(actors.filter(Boolean).map(actor=>[actor.uuid,actor])).values()];
};
const deleteEffect=async(effect,runtime)=>{
    const state=stateOf(effect);
    await effect.delete();
    await synchronizePowerStealth(effect.parent,runtime);
    const target=await (runtime.fromUuid ?? globalThis.fromUuid)?.(state.targetUuid);
    if(target)await synchronizePowerGlow(target,runtime);
};
export const endPowerModifierCast=(message,runtime={})=>serial(runtime,async()=>{
    const cast=validatePowerCastSnapshot(message?.flags?.[SCOPE]?.powerCast);
    for(const actor of allActors(gameOf(runtime)))for(const effect of values(actor.effects))
        if(stateOf(effect)?.castId===cast.id && stateOf(effect)?.itemUuid===cast.itemUuid)await deleteEffect(effect,runtime);
    const ledger=ledgerOf(runtime);
    for(const entry of Object.values(ledger.events))if(entry.castId===cast.id){entry.status='ended';entry.fatiguePending=false;delete entry.fatigueData;}
    await save(ledger,runtime);
    return true;
});
export const rollPowerLingering=async(effect,runtime={})=>{
    const game=gameOf(runtime),state=stateOf(effect);
    if(!isPrimaryAoeGm(game) || state?.version!==1 || state.kind!=='lingering' || state.done || effect.disabled || effect.isSuppressed)return false;
    const target=await (runtime.fromUuid ?? globalThis.fromUuid)?.(state.targetUuid);
    if(target?.actor?.uuid!==state.actorUuid)return false;
    // Claim durably before dice/chat so a refresh or second GM never repeats it.
    await effect.update({[`flags.${SCOPE}.powerModifier.done`]:true});
    const Roll=runtime.RollClass ?? globalThis.Roll;
    const damage=new Roll(state.formula);await damage.evaluate();
    await (runtime.createDamageCard ?? createAoeFireDamageCard)({actor:target.actor,targetUuid:target.uuid,damage,
        flavor:`<div><strong>Lingering Damage</strong>: ${escapePowerHTML(state.formula)} [AP: ${state.ap}]</div>`,
        privacy:state,damageContext:{ap:state.ap,heavyWeapon:state.heavyWeapon},fireFlags:{kind:'powerLingering',
            powerModifierMessageId:state.sourceMessageId,powerModifierCastId:state.castId}},runtime);
    await deleteEffect(effect,runtime);
    return true;
};
export const advancePowerModifierTurns=(previous,current,runtime={})=>serial(runtime,async()=>{
    const game=gameOf(runtime);
    if(!current.combatId || !(current.round>=1) || turnKey(previous)===turnKey(current))return;
    for(const actor of allActors(game))for(const effect of effectsOf(actor)){
        let state=stateOf(effect);
        if(!state.combatId){
            const sources=values(game.combat?.combatants).filter(combatant=>combatant.actor?.uuid===state.sourceActorUuid);
            const source=state.sourceTokenUuid ? sources.find(combatant=>combatant.token?.uuid===state.sourceTokenUuid)
                : sources.length===1 ? sources[0] : null;
            const remaining=Math.max(6,(state.expiresAt ?? Number(game.time?.worldTime ?? 0)+state.durationSeconds)-Number(game.time?.worldTime ?? 0));
            state={...state,combatId:current.combatId,sourceCombatantId:source?.id ?? null,
                expiresRound:state.instant ? null : current.round+Math.ceil(remaining/6),
                expiresAt:state.instant || source ? null : state.expiresAt};
            await effect.update({[`flags.${SCOPE}.powerModifier`]:state});
        }
        if(state.combatId && state.combatId!==current.combatId)continue;
        if(state.kind==='lingering' && targetTurn(state,current,actor) && turnKey(current)!==state.createdTurn){
            await rollPowerLingering(effect,runtime);continue;
        }
        if(state.instant){
            if(state.nextTurn===turnKey(previous) && targetTurn(state,previous,actor)){await deleteEffect(effect,runtime);continue;}
            if(targetTurn(state,current,actor) && turnKey(current)!==state.createdTurn && !state.nextTurn)
                await effect.update({[`flags.${SCOPE}.powerModifier.nextTurn`]:turnKey(current)});
        } else if(state.expiresRound!==null && previous.combatantId===state.sourceCombatantId && previous.round>=state.expiresRound){
            await deleteEffect(effect,runtime);
        }
    }
    const ledger=ledgerOf(runtime);let changed=false;
    for(const entry of Object.values(ledger.events ?? {})){
        const state=entry.fatigueData && stateOf(entry.fatigueData);
        if(!entry.fatiguePending || !state)continue;
        if(!state.combatId){
            const sources=values(game.combat?.combatants).filter(combatant=>combatant.actor?.uuid===state.sourceActorUuid);
            const source=state.sourceTokenUuid ? sources.find(combatant=>combatant.token?.uuid===state.sourceTokenUuid)
                : sources.length===1 ? sources[0] : null;
            const remaining=Math.max(6,(state.expiresAt ?? Number(game.time?.worldTime ?? 0)+state.durationSeconds)-Number(game.time?.worldTime ?? 0));
            Object.assign(state,{combatId:current.combatId,sourceCombatantId:source?.id ?? null,
                expiresRound:state.instant ? null : current.round+Math.ceil(remaining/6),expiresAt:state.instant || source ? null : state.expiresAt});
            changed=true;
        }
        if(state.combatId!==current.combatId)continue;
        if(state.instant){
            if(state.nextTurn===turnKey(previous)){
                entry.fatiguePending=false;entry.fatigueStatus='expired';delete entry.fatigueData;changed=true;
            }else if(targetTurn(state,current,{uuid:entry.actorUuid}) && turnKey(current)!==state.createdTurn && !state.nextTurn){
                state.nextTurn=turnKey(current);changed=true;
            }
        }else if(previous.combatantId===state.sourceCombatantId && previous.round>=state.expiresRound){
            entry.fatiguePending=false;entry.fatigueStatus='expired';delete entry.fatigueData;changed=true;
        }
    }
    if(changed)await save(ledger,runtime);
});
export const expirePowerModifierTime=(time,runtime={})=>serial(runtime,async()=>{
    for(const actor of allActors(gameOf(runtime)))for(const effect of effectsOf(actor)){
        const state=stateOf(effect);
        if(!state.combatId && Number(gameOf(runtime).combat?.round)>=1)continue;
        if(state.expiresAt!==null && Number(time)>=state.expiresAt){
            if(state.kind==='lingering')await rollPowerLingering(effect,runtime);
            else await deleteEffect(effect,runtime);
        }
    }
    const ledger=ledgerOf(runtime);let changed=false;
    for(const entry of Object.values(ledger.events ?? {})){
        const state=entry.fatigueData && stateOf(entry.fatigueData);
        if(!state?.combatId && Number(gameOf(runtime).combat?.round)>=1)continue;
        if(entry.fatiguePending && state?.expiresAt!==null && Number(time)>=state?.expiresAt){
            entry.fatiguePending=false;entry.fatigueStatus='expired';delete entry.fatigueData;changed=true;
        }
    }
    if(changed)await save(ledger,runtime);
});
export const registerPowerModifierEffects=(runtime={})=>{
    const hooks=runtime.hooks ?? globalThis.Hooks;
    if(!hooks?.on || registrations.has(hooks))return;
    registrations.add(hooks);
    const previous=new Map();
    const report=error=>{console.error('SWADE Tools | Power Modifiers',error);(runtime.notifications ?? globalThis.ui?.notifications)?.warn(`Power Modifiers need GM review: ${error.message}`);};
    hooks.on('applyActiveEffect',applyPowerModifierChange);
    hooks.on('preUpdateCombat',combat=>{previous.set(combat.id,turnOf(combat));});
    hooks.on('updateCombat',(combat,change)=>{
        if(!Object.hasOwn(change,'round') && !Object.hasOwn(change,'turn'))return;
        const history=combat.previous;
        const oldCombatant=history?.combatantId ? combat.combatants?.get?.(history.combatantId) : null;
        const before=history ? {combatId:combat.id,round:history.round,turn:history.turn,
            combatantId:history.combatantId,actorUuid:oldCombatant?.actor?.uuid,tokenUuid:oldCombatant?.token?.uuid}
            : previous.get(combat.id) ?? {},current=turnOf(combat);
        previous.set(combat.id,current);
        void advancePowerModifierTurns(before,current,runtime).catch(report);
    });
    hooks.on('updateWorldTime',time=>{void expirePowerModifierTime(time,runtime).catch(report);});
    hooks.on('deleteCombat',combat=>{
        void serial(runtime,async()=>{
            const game=gameOf(runtime),now=Number(game.time?.worldTime ?? 0);
            for(const actor of allActors(game))for(const effect of effectsOf(actor)){
                const state=stateOf(effect);
                if(state.combatId!==combat.id)continue;
                const remaining=state.instant || state.kind==='lingering' ? 6 : Math.max(6,(state.expiresRound-Number(combat.round))*6);
                await effect.update({[`flags.${SCOPE}.powerModifier`]:{...state,combatId:null,expiresAt:now+remaining}});
            }
            const ledger=ledgerOf(runtime);let changed=false;
            for(const entry of Object.values(ledger.events ?? {})){
                const state=entry.fatigueData && stateOf(entry.fatigueData);
                if(!entry.fatiguePending || state?.combatId!==combat.id)continue;
                const remaining=state.instant ? 6 : Math.max(6,(state.expiresRound-Number(combat.round))*6);
                Object.assign(state,{combatId:null,expiresAt:now+remaining});changed=true;
            }
            if(changed)await save(ledger,runtime);
        }).catch(report);
    });
    const reconcile=effect=>{
        if(!['glow','shroud'].includes(stateOf(effect)?.kind) || !isPrimaryAoeGm(gameOf(runtime)))return;
        void serial(runtime,async()=>{
            await synchronizePowerStealth(effect.parent,runtime);
            const target=await (runtime.fromUuid ?? globalThis.fromUuid)?.(stateOf(effect).targetUuid);
            if(target)await synchronizePowerGlow(target,runtime);
        }).catch(report);
    };
    hooks.on('deleteActiveEffect',reconcile);
    hooks.on('updateActiveEffect',reconcile);
    hooks.on('deleteChatMessage',message=>{
        if(!message.flags?.[SCOPE]?.powerCast)return;
        void serial(runtime,async()=>{
            const ledger=ledgerOf(runtime),castId=message.flags[SCOPE].powerCast.id;
            if(values(gameOf(runtime).messages).some(card=>card.id!==message.id && card.flags?.[SCOPE]?.powerCast?.id===castId))return;
            for(const [key,entry]of Object.entries(ledger.events))if(entry.castId===castId)delete ledger.events[key];
            await save(ledger,runtime);
        }).catch(report);
    });
};
