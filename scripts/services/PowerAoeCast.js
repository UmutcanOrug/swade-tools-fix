import { placePowerAoeTemplate } from './PowerAoeTemplate.js';
import { playAoeAnimation, withSuppressedAoeAutomation } from './AoeAnimationService.js';

const pendingCasts = new WeakSet();
const pendingCorrections = new WeakSet();

// Match the native Power panel: base PP + enabled Power Modifiers + Extra PP.
// Never use weapon ammo, quantity, range bands or grenade deviation for powers.
export const getPowerAoeCost = (item, extraPP = 0, actionId = '') => {
    const extra = extraPP === '' ? 0 : Number(extraPP);
    const base = Number(item?.system?.pp ?? 0);
    const modifiers = Array.from(item?.effects ?? [])
        .filter(effect => effect.type === 'modifier' && !effect.disabled)
        .reduce((sum, effect) => sum + Number(effect.system?.cost ?? 0), 0);
    const action = item?.system?.actions?.additional?.[actionId];
    const override = action?.type === 'trait' ? Number(action.resourcesUsed ?? 0) : 0;
    if (![extra, base, modifiers, override].every(Number.isSafeInteger)) {
        throw new Error('Power Point costs and Extra PP must be whole numbers.');
    }
    return override > 0 ? override : Math.max(0, base + modifiers + extra);
};

export const getPowerAoeTargets = (snapshot, canvasRef = globalThis.canvas) => {
    if (!snapshot || snapshot.sceneId !== canvasRef?.scene?.id) return [];
    return [...new Set(snapshot.targetIds ?? [])]
        .map(id => canvasRef.tokens?.get(id)).filter(token => token?.actor);
};

// GM correction is not a new cast. A failed activation already spent 1 PP;
// when corrected to success, settle only its native outstanding cost once.
export const settlePowerAoeCorrection = async ({message, rawTotal, modifier, criticalFailure,
    getAvailablePP, spendPP, failedPpHtml = ''}) => {
    const flags=message.flags?.['swade-tools'];
    const value=Number(modifier);
    if (!Number.isFinite(value)) throw new Error('Enter a numeric GM modifier.');
    const update={'flags.swade-tools.gmmod':value};
    if (!flags?.powerAoe || flags.rolltype!=='skill' || Number(rawTotal)+value<4) return update;
    if (criticalFailure) throw new Error('A Critical Failure cannot be changed into a hit by a modifier.');
    const debt=flags.arcanefail;
    if (!debt?.arcaneItem) return update;
    if (pendingCorrections.has(message)) throw new Error('A Power Point correction is already pending.');
    const remaining=Number(debt.pp ?? 0);
    if (debt.arcaneItem!==flags.itemroll || !Number.isSafeInteger(remaining) || remaining<0) {
        throw new Error('The original Power Point cost could not be verified.');
    }
    pendingCorrections.add(message);
    try {
        if (remaining>0){
            const available=Number(getAvailablePP());
            if (!Number.isFinite(available) || available<remaining) throw new Error(`Not enough Power Points (${remaining} remaining).`);
            await spendPP(remaining,debt.arcaneItem);
        }
        flags.arcanefail={};
        update['flags.swade-tools.arcanefail']={};
        if (failedPpHtml) update.flavor=String(message.flavor ?? '').replace(failedPpHtml,'');
        return update;
    } finally { pendingCorrections.delete(message); }
};

// Casting remains a single native ItemRoll. Its normal success/failure PP and
// Benny bookkeeping are deliberately not duplicated by this adapter.
export const runPowerAoe = async (context, runtime = {}) => {
    const {actor, item, token, shape, extraPP = 0, actionType = 'skill', actionId = '',
        createRoll, prepareRoll, performRoll, getActualPP, noPowerPoints = false} = context;
    const notify = runtime.notify ?? (message => globalThis.ui?.notifications?.warn(message));
    const place = runtime.place ?? placePowerAoeTemplate;
    const suppress = runtime.suppress ?? withSuppressedAoeAutomation;
    const animate = runtime.animate ?? playAoeAnimation;
    const damageOnly = actionType === 'damage';
    if (!item?.isOwner || !actor?.isOwner || item.type !== 'power') {
        notify('You must own the caster and power to use this AoE attack.');
        return false;
    }
    if (pendingCasts.has(item)) {
        notify('Finish or cancel the current power placement first.');
        return false;
    }
    pendingCasts.add(item);
    let placement;
    let rollStarted = false;
    try {
        let cost = damageOnly || noPowerPoints ? 0 : getPowerAoeCost(item, extraPP, actionId);
        const checkPP = () => {
            if (damageOnly || noPowerPoints) return;
            const available = Number(getActualPP());
            if (!Number.isFinite(available) || available < cost) {
                throw new Error(`Not enough Power Points (${cost} required).`);
            }
        };
        checkPP();
        placement = await place({actor, item, token, shape});
        if (!placement) return false;
        // The sheet or PP pool can change while the cursor is being placed.
        if (!item.isOwner || !actor.isOwner) throw new Error('Power ownership changed.');
        cost = damageOnly || noPowerPoints ? 0 : getPowerAoeCost(item, extraPP, actionId);
        checkPP();
        const snapshot = {
            sceneId: placement.sceneId, templateId: placement.templateDocument.id,
            sourceTokenId: placement.sourceToken.id,
            targetIds: [...placement.targetIds], shape: placement.shape
        };
        const roll = createRoll();
        if (await prepareRoll(roll) === false) return false;
        roll.addFlag('powerAoe', snapshot);
        roll.useTarget(snapshot.targetIds.join(','));
        if (!damageOnly && !noPowerPoints && cost === 0) roll.manageshots = false;
        await suppress([item], async () => {
            rollStarted = true;
            await performRoll(roll);
            await roll.display();
        });
        const innate = !damageOnly && item.system?.innate === true && roll.canCast !== false;
        const success = innate || (roll.canCast !== false && !roll.dontDisplay &&
            (damageOnly || roll.raiseCount() >= 0));
        // Innate powers have no activation die/card. Roll their damage once,
        // with the frozen area targets, without charging a second casting cost.
        if (innate && item.system?.damage) {
            const damage = createRoll();
            damage.addFlag('powerAoe', snapshot);
            damage.useTarget(snapshot.targetIds.join(','));
            damage.manageshots = false;
            if (roll.dmgraise) damage.raiseDmg();
            await suppress([item], async () => {
                const damageAction=roll.flagUpdate?.damageaction;
                if (damageAction) await damage.rollAction(damageAction);
                else await damage.rollBaseDamage();
                await damage.display();
            });
        }
        if (!damageOnly && success) await animate({
            sourceToken: placement.sourceToken, item,
            templateDocument: placement.templateDocument,
            targets: getPowerAoeTargets(snapshot, runtime.canvasRef ?? globalThis.canvas),
            success: true, throwProjectile: false, allowFallback: false
        });
        return {roll, snapshot, success};
    } catch (error) {
        (runtime.logger ?? console).warn('SWADE Tools | Power AoE could not complete', error);
        notify(error.message || 'The AoE power could not be used.');
        return false;
    } finally {
        // No cast or resource use should leave an abandoned confirmed template.
        if (placement && !rollStarted) {
            try { await placement.templateDocument.delete(); }
            catch (error) { (runtime.logger ?? console).warn('SWADE Tools | Power preview cleanup failed', error); }
        }
        pendingCasts.delete(item);
    }
};
