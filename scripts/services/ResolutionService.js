import * as gb from '../gb.js';
import ItemRoll from '../class/ItemRoll.js';
import AutomationService from './AutomationService.js';
import WeaponResourceService from './WeaponResourceService.js';
import PowerPointService from './PowerPointService.js';
import AutomationSocketService from './AutomationSocketService.js';

export default class ResolutionService {
    static installed=false;
    static resourceQueues=new Map();
    static completedResourceTransactions=new Set();

    static install() {
        if (this.installed) {
            return;
        }

        this.installed=true;
        Hooks.on('swadeAction',(...args)=>this.handleSwadeAction(...args));
    }

    static async startItemWorkflow(actor,item) {
        const profile=AutomationService.getResolutionProfile(item);
        const actionActor=this.resolveActionActor(actor);

        if (profile.mode==='area-evasion') {
            const helper=game.swade?.itemChatCardHelper;

            if (!helper?.handleAction) {
                ui.notifications.error(gb.trans('NativeActionUnavailable'));
                return null;
            }

            if (!actionActor || actionActor.type==='vehicle') {
                ui.notifications.warn(gb.trans('VehicleOperatorMissing'));
                return null;
            }

            if (!this.preflightPowerPoints(item,profile)) {
                return null;
            }

            if (item.system?.innate) {
                await this.commitConfiguredPower(item,profile,{
                    total: 4,
                    messageId: `innate-${foundry.utils.randomID()}`
                });
                return gb.showTemplate(profile.templatePreset,item,{
                    profile,
                    activationResolved: true,
                    sourceTokenUuid:
                        this.getSourceToken(actor)?.document?.uuid ?? null
                });
            }

            const activationRoll=await helper.handleAction(
                item,
                actionActor,
                profile.activationAction || 'formula',
                {
                    additionalMods:
                        this.getActivationModifiers(item,profile),
                    event: null
                }
            );

            await this.commitConfiguredPower(item,profile,activationRoll);

            if (!activationRoll || activationRoll.isCritfail===true ||
                Number(activationRoll.total ?? 0)<4) {
                if (activationRoll) {
                    ui.notifications.warn(gb.trans('ActivationFailed'));
                }
                return activationRoll;
            }

            return gb.showTemplate(profile.templatePreset,item,{
                profile,
                activationResolved: true,
                sourceTokenUuid: this.getSourceToken(actor)?.document?.uuid ?? null
            });
        }

        if (['grenade','template-only'].includes(profile.mode)) {
            return gb.showTemplate(profile.templatePreset,item,{
                profile,
                sourceTokenUuid: this.getSourceToken(actor)?.document?.uuid ?? null
            });
        }

        if (profile.mode==='opposed') {
            const helper=game.swade?.itemChatCardHelper;

            if (!helper?.handleAction) {
                ui.notifications.error(gb.trans('NativeActionUnavailable'));
                return null;
            }

            if (!actionActor || actionActor.type==='vehicle') {
                ui.notifications.warn(gb.trans('VehicleOperatorMissing'));
                return null;
            }

            if (!this.preflightPowerPoints(item,profile)) {
                return null;
            }

            const roll=await helper.handleAction(
                item,
                actionActor,
                profile.activationAction || 'formula',
                {
                    additionalMods:
                        this.getActivationModifiers(item,profile),
                    event: null
                }
            );

            await this.commitConfiguredPower(item,profile,roll);
            return roll;
        }

        return item.show();
    }

    static getSourceToken(actor) {
        const synthetic=actor?.token?.object ?? actor?.token;

        if (synthetic?.document && synthetic?.center) {
            return synthetic;
        }

        const controlled=canvas.tokens?.controlled?.find(token=>
            token.actor?.uuid===actor?.uuid ||
            token.actor?.id===actor?.id
        );

        if (controlled) {
            return controlled;
        }

        for (const token of actor?.getActiveTokens?.(true,true) ?? []) {
            const placeable=token?.object ?? token;

            if (placeable?.document && placeable?.center) {
                return placeable;
            }
        }

        return null;
    }

    static resolveActionActor(actor) {
        if (actor?.type!=='vehicle') {
            return actor;
        }

        const operator=actor.system?.operator;
        return operator?.actor ?? operator ?? actor;
    }

    static getActivationModifiers(item,profile) {
        if (item?.type!=='power' ||
            !game.settings.get('swade','noPowerPoints')) {
            return [];
        }

        const cost=PowerPointService.resolveCost(item);
        const penalty=-Math.ceil(cost/2);

        if (!penalty) {
            return [];
        }

        return [{
            label: gb.trans('NoPowerPointsPenalty'),
            value: penalty
        }];
    }

    static preflightPowerPoints(item,profile) {
        if (item?.type!=='power' ||
            profile.autoSpendPowerPoints===false ||
            game.settings.get('swade','noPowerPoints')) {
            return true;
        }

        const validation=PowerPointService.validate(item);

        if (!validation.ok) {
            ui.notifications.warn(gb.trans('NotEnoughPP'));
            return false;
        }

        return true;
    }

    static async commitConfiguredPower(item,profile,roll) {
        if (!roll || item?.type!=='power' ||
            profile.autoSpendPowerPoints===false ||
            game.settings.get('swade','noPowerPoints')) {
            return {ok: true,consumed: 0};
        }

        const transactionId=
            roll.messageId ??
            roll.options?.messageId ??
            null;
        const result=await PowerPointService.commitActivation(item,{
            success: roll.isCritfail!==true && Number(roll.total ?? 0)>=4,
            transactionId: transactionId
                ? `power-${transactionId}`
                : null
        });

        if (!result.ok) {
            ui.notifications.warn(gb.trans('NotEnoughPP'));
        }

        return result;
    }

    static async handleSwadeAction(actor,item,action,roll,userId) {
        if (!actor || !item || !roll || (userId && userId!==game.user.id)) {
            return;
        }

        if (!(roll.messageId ?? roll.options?.messageId)) {
            return;
        }

        const profile=AutomationService.getResolutionProfile(item);
        const storedProfile=item.getFlag?.(gb.moduleName,'resolution');

        if (!storedProfile || profile.mode==='none' ||
            (profile.activationAction && action!==profile.activationAction)) {
            return;
        }

        await this.commitConfiguredPower(item,profile,roll);

        if (profile.mode!=='opposed') {
            return;
        }

        const targets=await this.getRollTargets(roll);

        if (!targets.length) {
            ui.notifications.warn(gb.trans('NoTarget'));
            return;
        }

        const attackerTotal=Number(roll.total ?? 0);
        const attackerValid=roll.isCritfail!==true && attackerTotal>=4;
        const results=[];

        for (const target of targets) {
            const defense=await this.rollTrait(
                target.actor,
                profile.defenseTrait,
                profile.defenseModifier,
                `${item.name}: ${gb.trans('OpposedDefense')}`
            );

            if (!defense.roll) {
                ui.notifications.warn(gb.trans('DefenseRollFailed'));
                return;
            }

            const delta=attackerTotal-defense.total;

            results.push({
                target,
                attackerTotal,
                defenderTotal: defense.total,
                success: attackerValid && !defense.critical && delta>0,
                raise: attackerValid && !defense.critical && delta>=4
            });
        }

        await this.postOpposedSummary(item,results);
    }

    static async getRollTargets(roll) {
        const messageId=roll?.messageId ?? roll?.options?.messageId;
        const message=messageId ? game.messages?.get(messageId) : null;
        const snapshots=message?.flags?.swade?.targets ?? [];

        if (!snapshots.length) {
            return Array.from(game.user.targets ?? []);
        }

        const targets=[];

        for (const snapshot of snapshots) {
            const document=await fromUuid(snapshot.uuid);
            const token=document?.object ?? canvas.tokens?.get(document?.id);

            if (token?.actor) {
                targets.push(token);
            }
        }

        return targets;
    }

    static async resolveArea(item,profile,targets) {
        const damageItem=profile.damageOnFailure
            ? await this.resolveLinkedItem(
                profile.damageSourceItemUuid,
                item
            )
            : null;

        if (profile.damageOnFailure &&
            !this.canRollDamage(damageItem,profile)) {
            ui.notifications.warn(gb.trans('NoDmgActionDefined'));
            return null;
        }

        if (profile.resourceSourceItemUuid) {
            const resourceItem=await this.resolveLinkedItem(
                profile.resourceSourceItemUuid,
                null
            );
            const consumed=await this.consumeItem(
                resourceItem,
                profile.resourcesUsed ?? 1,
                {transactionId: profile.transactionId}
            );

            if (!consumed) {
                return null;
            }
        }

        const results=[];

        for (const target of targets) {
            const defense=await this.rollTrait(
                target.actor,
                profile.defenseTrait,
                profile.defenseModifier,
                `${item.name}: ${gb.trans('AreaDefense')}`
            );

            if (!defense.roll) {
                ui.notifications.warn(gb.trans('DefenseRollFailed'));
                return null;
            }

            const success=!defense.critical &&
                defense.total>=Number(profile.targetNumber || 4);

            results.push({
                target,
                total: defense.total,
                critical: defense.critical,
                success
            });
        }

        await this.postAreaSummary(item,profile,results);

        if (profile.damageOnFailure) {
            const failedTargets=results
                .filter(result=>!result.success)
                .map(result=>result.target);
            const damageRoll=await this.rollDamageForTargets(
                damageItem,
                failedTargets,
                profile
            );

            if (failedTargets.length && !damageRoll) {
                return null;
            }
        }

        return results;
    }

    static async rollTrait(actor,traitName,modifier=0,flavor='') {
        return AutomationSocketService.rollTrait(
            actor,
            traitName,
            modifier,
            flavor
        );
    }

    static async resolveLinkedItem(uuid,fallback=null) {
        if (!uuid) {
            return fallback;
        }

        const linked=await fromUuid(uuid);
        return linked?.actor ? linked : null;
    }

    static async rollDamageForTargets(item,targets,profile={}) {
        if (!item?.actor || !targets.length) {
            return null;
        }

        const itemRoll=new ItemRoll(item.actor,item);
        itemRoll.useTarget(targets.map(target=>target.id).join(','));
        if (profile.raiseDamage) {
            itemRoll.raiseDmg();
        }
        itemRoll.addFlavor(
            `<div>${gb.trans('AreaTargets')}: `+
            `${targets.map(target=>foundry.utils.escapeHTML(target.name)).join(', ')}</div>`,
            true
        );

        const actionId=profile.damageAction;
        let roll;

        if (actionId && item.system?.actions?.additional?.[actionId]?.type==='damage') {
            roll=await itemRoll.rollAction(actionId);
        } else if (item.system?.damage) {
            roll=await itemRoll.rollBaseDamage();
        } else {
            const damageEntry=Object.entries(
                item.system?.actions?.additional ?? {}
            ).find(([,action])=>action?.type==='damage');

            if (damageEntry) {
                roll=await itemRoll.rollAction(damageEntry[0]);
            }
        }

        if (!roll) {
            ui.notifications.warn(`${item.name}: ${gb.trans('NoDmgActionDefined')}`);
            return null;
        }

        const message=await itemRoll.display();

        if (!message) {
            return null;
        }

        return roll;
    }

    static canRollDamage(item,profile={}) {
        if (!item?.actor) {
            return false;
        }

        if (profile.damageAction &&
            item.system?.actions?.additional?.[profile.damageAction]?.type===
                'damage') {
            return true;
        }

        return Boolean(
            item.system?.damage ||
            Object.values(item.system?.actions?.additional ?? {})
                .some(action=>action?.type==='damage')
        );
    }

    static getAvailableItemUnits(item) {
        if (!item) {
            return 0;
        }

        if (item.type==='weapon' &&
            WeaponResourceService.isManagedWeapon(item)) {
            return Infinity;
        }

        if (item.type==='consumable') {
            const charge=item.system?.charges?.default ??
                item.system?.charges?.charges?.[0] ??
                null;
            const quantity=Math.max(0,Number(item.system?.quantity ?? 0));
            const maximum=Math.max(0,Number(charge?.max ?? 0));
            const current=Math.max(0,Number(charge?.value ?? 0));

            if (maximum>0) {
                return Math.max(0,((quantity-1)*maximum)+current);
            }

            return quantity;
        }

        return Math.max(0,Number(item.system?.quantity ?? 0));
    }

    static canConsumeItem(item,resourcesUsed=1) {
        const cost=Math.max(0,Number(resourcesUsed) || 0);

        if (!cost) {
            return {ok: true,cost: 0};
        }

        if (!item || item.type==='power') {
            return {ok: false,cost,reason: 'unsupported'};
        }

        if (item.type==='weapon' &&
            WeaponResourceService.isManagedWeapon(item)) {
            return WeaponResourceService.validate(item,cost);
        }

        const available=this.getAvailableItemUnits(item);

        if (!Number.isFinite(available) || available<cost) {
            return {ok: false,cost,available,reason: 'insufficient'};
        }

        return {ok: true,cost,available};
    }

    static async consumeItem(item,resourcesUsed=1,{transactionId=null}={}) {
        const validation=this.canConsumeItem(item,resourcesUsed);
        const transactionKey=transactionId && item
            ? `${transactionId}:${item.uuid ?? item.id}`
            : null;

        if (transactionKey &&
            this.completedResourceTransactions.has(transactionKey)) {
            return true;
        }

        if (!validation.ok) {
            ui.notifications.warn(
                gb.trans(
                    validation.reason==='unsupported'
                        ? 'UnsupportedResourceItem'
                        : 'NotEnoughShots'
                )
            );
            return false;
        }

        if (validation.cost===0) {
            return true;
        }

        if (item.type==='weapon' &&
            WeaponResourceService.isManagedWeapon(item)) {
            const result=await WeaponResourceService.commit(
                item,
                validation.cost
            );

            if (result.ok && transactionKey) {
                this.completedResourceTransactions.add(transactionKey);
            }

            return result.ok;
        }

        const key=item.uuid ?? item.id;
        const previous=this.resourceQueues.get(key) ?? Promise.resolve();
        const task=previous.catch(()=>undefined).then(async ()=>{
            if (transactionKey &&
                this.completedResourceTransactions.has(transactionKey)) {
                return true;
            }

            const currentValidation=this.canConsumeItem(
                item,
                validation.cost
            );

            if (!currentValidation.ok) {
                return false;
            }

            const before=this.getAvailableItemUnits(item);

            if (['gear','consumable'].includes(item.type) &&
                typeof item.consume==='function') {
                await item.consume(validation.cost);
            } else {
                const quantity=Number(item.system?.quantity ?? 0);
                await item.update({
                    'system.quantity':
                        Math.max(0,quantity-validation.cost)
                });
            }

            const embedded=item.parent?.items?.get?.(item.id);
            const after=embedded
                ? this.getAvailableItemUnits(embedded)
                : (item.parent?.items ? 0 : this.getAvailableItemUnits(item));
            const consumed=after<=Math.max(0,before-validation.cost);

            if (consumed && transactionKey) {
                this.completedResourceTransactions.add(transactionKey);
            }

            return consumed;
        });

        this.resourceQueues.set(key,task);

        try {
            const consumed=await task;

            if (!consumed) {
                ui.notifications.warn(gb.trans('ResourceConsumeFailed'));
            }

            return consumed;
        } finally {
            if (this.resourceQueues.get(key)===task) {
                this.resourceQueues.delete(key);
            }
        }
    }

    static async postOpposedSummary(item,results) {
        const content=`
            <div class="swade-tools-resolution-summary">
                <h3>${foundry.utils.escapeHTML(item.name)}: ${gb.trans('OpposedResult')}</h3>
                <ul>
                    ${results.map(result=>`
                        <li>
                            ${foundry.utils.escapeHTML(result.target.name)}:
                            ${result.attackerTotal} / ${result.defenderTotal} —
                            ${gb.trans(result.raise ? 'SuccessRaise' : (result.success ? 'Success' : 'Failure'))}
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;

        await ChatMessage.create({
            user: game.user.id,
            speaker: ChatMessage.getSpeaker({actor: item.actor}),
            content
        });
    }

    static async postAreaSummary(item,profile,results) {
        const targetNumber=Number(profile.targetNumber || 4);
        const content=`
            <div class="swade-tools-resolution-summary">
                <h3>${foundry.utils.escapeHTML(item.name)}: ${gb.trans('AreaResult')}</h3>
                <ul>
                    ${results.map(result=>`
                        <li>
                            ${foundry.utils.escapeHTML(result.target.name)}:
                            ${result.total} / ${targetNumber} —
                            ${gb.trans(result.success ? 'Success' : 'Failure')}
                        </li>
                    `).join('')}
                </ul>
            </div>
        `;

        await ChatMessage.create({
            user: game.user.id,
            speaker: ChatMessage.getSpeaker({actor: item.actor}),
            content
        });
    }
}
