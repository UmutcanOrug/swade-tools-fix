import RollControl from '../class/RollControl.js';
import {canUsePropertiesCombat} from './PropertiesCombat.js';
import {registerPropertyCandidate, renderPropertyCandidates, isPrimaryPropertiesGm} from './PropertiesEffects.js';

const registrations=new WeakSet();
const flagsOf=message=>message?.flags?.['swade-tools'] ?? {};
const gameOf=runtime=>runtime.gameRef ?? runtime.game ?? globalThis.game;
const targetOf=(uuid,runtime={})=>{
    const canvas=runtime.canvasRef ?? runtime.canvas ?? globalThis.canvas;
    const parts=String(uuid ?? '').split('.');
    if (parts.length!==4 || parts[0]!=='Scene' || parts[2]!=='Token' || parts[1]!==canvas?.scene?.id) return null;
    const token=canvas?.tokens?.get?.(parts[3]);
    return token?.document?.uuid===uuid && token.actor?.uuid ? token : null;
};

const poolEntry = (message,entry) => flagsOf(message).propertiesPool?.assignments?.find(candidate=>
    candidate.targetUuid===entry.targetUuid && candidate.targetActorUuid===entry.targetActorUuid &&
    String(candidate.hitKey)===String(entry.hitKey));
const validPoolOutcome = entry => {
    if (!entry || !Number.isFinite(entry.total) || !Number.isFinite(entry.modifier)) return null;
    const total=entry.total+entry.modifier;
    const outcome=total>=8 ? 'raise' : total>=4 ? 'hit' : 'miss';
    return entry.outcome===outcome ? outcome : null;
};

export const stagePropertyPool = async (message,runtime={}) => {
    const pool=flagsOf(message).propertiesPool;
    const game=gameOf(runtime), coreRuntime={...runtime,game};
    if (!isPrimaryPropertiesGm(game) || pool?.version!==1 || !Array.isArray(pool.assignments) || pool.assignments.length>6) return;
    const keys=pool.assignments.map(entry=>String(entry?.hitKey ?? ''));
    if (keys.some(key=>!key || key.length>80) || new Set(keys).size!==keys.length) return;
    const fromUuid=runtime.fromUuid ?? globalThis.fromUuid;
    if (typeof fromUuid!=='function') return;
    const [actor,item]=await Promise.all([fromUuid(pool.actorUuid),fromUuid(pool.itemUuid)]);
    const source=targetOf(pool.sourceTokenUuid,runtime);
    if (!canUsePropertiesCombat(item,message,coreRuntime) || !source || source.actor?.uuid!==actor?.uuid) return;
    for (const assignment of pool.assignments){
        const target=targetOf(assignment.targetUuid,runtime),outcome=validPoolOutcome(assignment);
        if (!target || target.actor?.uuid!==assignment.targetActorUuid || !outcome) continue;
        await (runtime.registerPropertyCandidate ?? registerPropertyCandidate)({message,actor,item,target,outcome,hitKey:assignment.hitKey,
            attackType:assignment.attackType,range:assignment.range},coreRuntime);
    }
};

// Fresh native target calculation, without rendering, rolling or applying an
// effect. AoE cards never enter this function.
export const resolveCurrentPropertyCandidate = ({message,actor,item,target,entry},runtime={}) => {
    if (!canUsePropertiesCombat(item,message,{...runtime,game:gameOf(runtime)})) return null;
    const targetDocument=target?.document ?? target;
    if (targetDocument?.uuid!==entry?.targetUuid || targetDocument.actor?.uuid!==entry?.targetActorUuid) return null;
    if (flagsOf(message).propertiesPool){
        const assignment=poolEntry(message,entry),outcome=validPoolOutcome(assignment);
        return outcome ? {outcome} : null;
    }
    if (flagsOf(message).rolltype!=='skill' || Number(flagsOf(message).userof ?? 1)>1) return null;
    if (!Number.isFinite(Number(message.rolls?.[0]?.total))) return null;
    const Control=runtime.RollControlClass ?? RollControl;
    const control=new Control(message,null,message.author);
    control.gmmod=Number(flagsOf(message).gmmod ?? 0) || 0;
    if (control.isCritical()) return null;
    control.attackTarget(target.object ?? target,Number(message.rolls?.[0]?.total),Number(entry.hitKey) || 1);
    const result=control.propertiesInputs.find(input=>input.target.document?.uuid===entry.targetUuid);
    return result ? {outcome:result.outcome} : null;
};

export const registerPropertiesPoolControls = (runtime={}) => {
    const hooks=runtime.Hooks ?? globalThis.Hooks;
    if (!hooks?.on || registrations.has(hooks)) return;
    registrations.add(hooks);
    hooks.on('renderChatMessageHTML',(message,html)=>{
        if (!flagsOf(message).propertiesPool) return;
        const root=html?.[0] ?? html;
        if (!root?.querySelector?.('.swadetools-properties-chat')) root?.insertAdjacentHTML?.('beforeend',renderPropertyCandidates(message,runtime));
        void stagePropertyPool(message,runtime).catch(error=>console.warn('SWADE Tools | Properties pool review unavailable',error));
    });
};
