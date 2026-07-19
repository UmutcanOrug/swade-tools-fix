import * as gb from './../gb.js';
import AutomationService from '../services/AutomationService.js';
import ResolutionService from '../services/ResolutionService.js';

export default class TemplateControl {
    static activeTransactions=new Set();

    constructor(templateDocument) {
        this.document=templateDocument;
        this.flags=templateDocument.flags?.[gb.moduleName] ?? {};
        this.template=templateDocument.object ?? canvas.templates?.get(templateDocument.id);
        this.item=null;
        this.profile=null;
    }

    static async handleCreate(templateDocument,_options,userId) {
        const flags=templateDocument.flags?.[gb.moduleName] ?? {};

        if ((flags.user && flags.user!==userId) ||
            (userId && game.user.id!==userId)) {
            return;
        }

        const control=new TemplateControl(templateDocument);
        control.item=await control.getItem();

        if (!control.item) {
            return;
        }

        control.profile=AutomationService.getResolutionProfile(control.item);
        control.profile=foundry.utils.mergeObject(
            control.profile,
            flags.profileSnapshot ?? {},
            {inplace: false,insertKeys: true,overwrite: true}
        );
        control.profile.mode=flags.resolutionMode ?? control.profile.mode;

        const explicitWorkflow=Boolean(
            flags.explicitWorkflow &&
            flags.transactionId &&
            flags.itemUuid
        );

        if (!explicitWorkflow) {
            // A native SWADE template button may carry flags.swade.origin,
            // but it must never bypass a configured activation roll.
            control.profile.mode='template-only';
        } else if (control.profile.mode==='area-evasion' &&
            flags.activationResolved!==true) {
            control.profile.mode='template-only';
            ui.notifications.warn(gb.trans('UseWorkflowButtonForActivation'));
        }

        if (control.profile.mode==='none') {
            return;
        }

        await control.run();
    }

    static async confirm(sceneId,templateId) {
        const scene=game.scenes?.get(sceneId);
        const document=scene?.templates?.get(templateId);

        if (!document || scene?.id!==canvas.scene?.id) {
            ui.notifications.warn(gb.trans('TemplateSceneUnavailable'));
            return false;
        }

        const control=new TemplateControl(document);
        control.item=await control.getItem();

        if (!control.item) {
            ui.notifications.warn(gb.trans('TemplateItemMissing'));
            return false;
        }

        control.profile=AutomationService.getResolutionProfile(control.item);
        control.profile=foundry.utils.mergeObject(
            control.profile,
            control.flags.profileSnapshot ?? {},
            {inplace: false,insertKeys: true,overwrite: true}
        );
        await control.waitForTemplateObject();
        return control.confirmDeviation();
    }

    async run() {
        await this.waitForTemplateObject();

        if (!this.template?.shape) {
            ui.notifications.warn(gb.trans('TemplateShapeMissing'));
            return;
        }

        const targets=this.getTokensInTemplate();

        if (this.profile.mode==='template-only') {
            if (this.profile.autoTarget) {
                this.targetTokens(targets);
            }
            this.notifyTargetCount(targets);
            return;
        }

        if (this.profile.mode==='area-evasion') {
            if (!targets.length) {
                ui.notifications.warn(gb.trans('NoTarget'));
                return;
            }

            if (!await this.beginTransaction(['placed'])) {
                return;
            }

            try {
                if (this.profile.autoTarget) {
                    this.targetTokens(targets);
                }
                const results=await ResolutionService.resolveArea(
                    this.item,
                    {
                        ...this.profile,
                        transactionId: this.flags.transactionId
                    },
                    targets
                );

                if (results===null) {
                    throw new Error('Area resources could not be consumed');
                }

                await this.document.update({
                    [`flags.${gb.moduleName}.workflowState`]: 'completed'
                });
            } catch (error) {
                await this.document.update({
                    [`flags.${gb.moduleName}.workflowState`]: 'placed'
                });
                console.error(`${gb.moduleName} | Area resolution failed`,error);
                ui.notifications.error(gb.trans('AutomationResolutionFailed'));
            } finally {
                this.endTransaction();
            }
            return;
        }

        if (this.profile.mode==='grenade') {
            await this.resolveGrenade(targets);
        }
    }

    async getItem() {
        const uuid=this.flags.itemUuid ?? this.document.flags?.swade?.origin;

        if (!uuid) {
            return null;
        }

        return fromUuid(uuid);
    }

    async waitForTemplateObject() {
        await gb.waitFor(()=>{
            this.template=this.document.object ?? canvas.templates?.get(this.document.id);
            return !!this.template?.shape;
        },20,50);
    }

    get transactionKey() {
        return this.flags.transactionId ?? this.document.uuid;
    }

    async beginTransaction(allowedStates) {
        if (TemplateControl.activeTransactions.has(this.transactionKey)) {
            return false;
        }

        const state=this.document.getFlag(
            gb.moduleName,
            'workflowState'
        ) ?? 'placed';

        if (!allowedStates.includes(state)) {
            return false;
        }

        TemplateControl.activeTransactions.add(this.transactionKey);
        await this.document.update({
            [`flags.${gb.moduleName}.workflowState`]: 'resolving'
        });
        return true;
    }

    endTransaction() {
        TemplateControl.activeTransactions.delete(this.transactionKey);
    }

    async resetTransaction() {
        await this.document.update({
            [`flags.${gb.moduleName}.workflowState`]: 'placed'
        });
    }

    getTokensInTemplate() {
        const sourceToken=this.getSourceToken();

        return canvas.tokens.placeables.filter(token=>{
            if (!token?.actor || token.document?.hidden) {
                return false;
            }

            if (!this.profile.includeSelf &&
                sourceToken?.document?.uuid===token.document?.uuid) {
                return false;
            }

            if (!this.matchesDisposition(token,sourceToken)) {
                return false;
            }

            if (this.profile.useWalls &&
                this.hasWallCollision(token)) {
                return false;
            }

            return this.tokenIntersectsTemplate(token);
        });
    }

    getSourceToken() {
        const uuid=this.flags.sourceTokenUuid;
        const direct=uuid ? globalThis.fromUuidSync?.(uuid) : null;

        return direct?.object ??
            direct ??
            ResolutionService.getSourceToken(this.item?.actor);
    }

    matchesDisposition(token,sourceToken) {
        if (!sourceToken || this.profile.targetFilter==='all') {
            return true;
        }

        const relation=Number(sourceToken.document?.disposition ?? 0) *
            Number(token.document?.disposition ?? 0);

        if (this.profile.targetFilter==='enemies') {
            return relation<0;
        }

        if (this.profile.targetFilter==='allies') {
            return relation>0;
        }

        return true;
    }

    hasWallCollision(targetToken) {
        if (!targetToken) {
            return false;
        }

        const backend=CONFIG.Canvas?.polygonBackends?.sight;

        if (typeof backend?.testCollision!=='function') {
            return false;
        }

        try {
            return backend.testCollision(
                {
                    x: Number(this.document.x),
                    y: Number(this.document.y)
                },
                targetToken.center,
                {type: 'sight',mode: 'any'}
            )===true;
        } catch (_error) {
            return false;
        }
    }

    tokenIntersectsTemplate(token) {
        return this.getTokenTestPoints(token)
            .some(point=>this.templateContainsPoint(point));
    }

    getTokenTestPoints(token) {
        const center=token.center ?? {
            x: token.x+(token.w/2),
            y: token.y+(token.h/2)
        };
        const bounds=this.getTokenBounds(token);
        const points=[center];

        if (!bounds) {
            return points;
        }

        const {x,y}=bounds;
        const w=bounds.width;
        const h=bounds.height;
        const gridSize=canvas.grid.size ??
            canvas.dimensions.size ??
            Math.min(w,h);

        points.push(
            {x,y},
            {x: x+w,y},
            {x,y: y+h},
            {x: x+w,y: y+h},
            {x: x+(w/2),y},
            {x: x+(w/2),y: y+h},
            {x,y: y+(h/2)},
            {x: x+w,y: y+(h/2)}
        );

        for (let px=x+(gridSize/2); px<x+w; px+=gridSize) {
            for (let py=y+(gridSize/2); py<y+h; py+=gridSize) {
                points.push({x: px,y: py});
            }
        }

        return this.uniquePoints(points);
    }

    getTokenBounds(token) {
        if (typeof token.bounds==='function') {
            return token.bounds();
        }

        return token.bounds ?? token.getBounds?.();
    }

    uniquePoints(points) {
        const used=new Set();

        return points.filter(point=>{
            const key=`${Math.round(point.x)}:${Math.round(point.y)}`;

            if (used.has(key)) {
                return false;
            }

            used.add(key);
            return true;
        });
    }

    templateContainsPoint(point) {
        const localPoint=this.toTemplateLocal(point);
        return !!this.template.shape?.contains(localPoint.x,localPoint.y);
    }

    toTemplateLocal(point) {
        if (this.template.worldTransform?.applyInverse) {
            return this.template.worldTransform.applyInverse(
                new PIXI.Point(point.x,point.y)
            );
        }

        const direction=(-(this.document.direction || 0)*Math.PI)/180;
        const dx=point.x-this.document.x;
        const dy=point.y-this.document.y;

        return {
            x: (dx*Math.cos(direction))-(dy*Math.sin(direction)),
            y: (dx*Math.sin(direction))+(dy*Math.cos(direction))
        };
    }

    targetTokens(tokens) {
        for (const target of Array.from(game.user.targets)) {
            target.setTarget(false,{
                user: game.user,
                releaseOthers: false,
                groupSelection: true
            });
        }

        tokens.forEach(token=>{
            token.setTarget(true,{
                user: game.user,
                releaseOthers: false,
                groupSelection: true
            });
        });
    }

    async resolveGrenade(targets) {
        if (!await this.beginTransaction(['placed'])) {
            return;
        }

        let resourceConsumed=false;

        try {
            const sourceToken=this.getSourceToken();

            if (!sourceToken) {
                ui.notifications.warn(gb.trans('GrenadeSourceMissing'));
                await this.resetTransaction();
                return;
            }

            const action=this.getActivationAction();
            const damageItem=await this.resolveLinkedItem(
                this.profile.damageSourceItemUuid,
                this.item
            );
            const resourceItem=await this.resolveLinkedItem(
                this.profile.resourceSourceItemUuid,
                this.item
            );
            const resourcesUsed=Math.max(
                0,
                Number(this.profile.resourcesUsed ?? 1) || 0
            );
            const traitName=action?.override ??
                this.item.system?.actions?.trait ??
                'Athletics';
            const range=this.measureRange(sourceToken);

            if (range.tooFar) {
                ui.notifications.warn(gb.trans('TargetTooFar'));
                await this.resetTransaction();
                return;
            }

            if (targets.length && this.profile.damageEnabled!==false &&
                !ResolutionService.canRollDamage(damageItem,this.profile)) {
                ui.notifications.warn(gb.trans('NoDmgActionDefined'));
                await this.resetTransaction();
                return;
            }

            const resourceValidation=ResolutionService.canConsumeItem(
                resourceItem,
                resourcesUsed
            );

            if (!resourceValidation.ok) {
                ui.notifications.warn(
                    gb.trans(
                        resourceValidation.reason==='unsupported'
                            ? 'UnsupportedResourceItem'
                            : 'NotEnoughShots'
                    )
                );
                await this.resetTransaction();
                return;
            }

            const actionActor=ResolutionService.resolveActionActor(
                this.item.actor
            );

            if (!actionActor || actionActor.type==='vehicle') {
                ui.notifications.warn(gb.trans('VehicleOperatorMissing'));
                await this.resetTransaction();
                return;
            }

            const modifiers=[
                {
                    value: action?.modifier,
                    label: action?.name || gb.trans('AutomationModifier')
                },
                {
                    value: this.item.system?.actions?.traitMod,
                    label: gb.trans('ModItem')
                },
                {
                    value: range.modifier,
                    label: range.label
                }
            ];
            const result=await ResolutionService.rollTrait(
                actionActor,
                traitName,
                modifiers,
                `${this.item.name}: ${gb.trans('GrenadeThrow')} (${range.label})`
            );
            resourceConsumed=await ResolutionService.consumeItem(
                resourceItem,
                resourcesUsed,
                {transactionId: this.flags.transactionId}
            );

            if (!resourceConsumed) {
                await this.resetTransaction();
                return;
            }

            const success=!result.critical && result.total>=4;
            const raise=!result.critical && result.total>=8;

            if (success) {
                if (this.profile.autoTarget) {
                    this.targetTokens(targets);
                }
                this.notifyTargetCount(targets);

                if (targets.length && this.profile.damageEnabled!==false) {
                    const damageRoll=await ResolutionService
                        .rollDamageForTargets(
                            damageItem,
                            targets,
                            {...this.profile,raiseDamage: raise}
                        );

                    if (!damageRoll) {
                        throw new Error('Grenade damage roll was not created');
                    }
                }

                await this.document.update({
                    [`flags.${gb.moduleName}.grenadeResolved`]: true,
                    [`flags.${gb.moduleName}.throwSuccess`]: true,
                    [`flags.${gb.moduleName}.throwTotal`]: result.total,
                    [`flags.${gb.moduleName}.workflowState`]: 'completed'
                });
                return;
            }

            await this.document.update({
                fillColor: '#b42318',
                [`flags.${gb.moduleName}.grenadeResolved`]: true,
                [`flags.${gb.moduleName}.throwSuccess`]: false,
                [`flags.${gb.moduleName}.throwTotal`]: result.total,
                [`flags.${gb.moduleName}.pendingDeviation`]: true,
                [`flags.${gb.moduleName}.workflowState`]:
                    'awaiting-deviation'
            });
            await this.postDeviationPrompt();
        } catch (error) {
            await this.document.update({
                [`flags.${gb.moduleName}.workflowState`]:
                    resourceConsumed ? 'awaiting-damage' : 'placed'
            });
            console.error(`${gb.moduleName} | Grenade resolution failed`,error);
            ui.notifications.error(gb.trans('AutomationResolutionFailed'));
        } finally {
            this.endTransaction();
        }
    }

    getActivationAction() {
        const key=this.profile.activationAction;

        if (!key || key==='formula') {
            return null;
        }

        return this.item.system?.actions?.additional?.[key] ?? null;
    }

    async resolveLinkedItem(uuid,fallback) {
        if (!uuid) {
            return fallback;
        }

        const linked=await fromUuid(uuid);
        return linked?.actor ? linked : null;
    }

    measureRange(sourceToken) {
        const source=sourceToken.center ?? sourceToken.getCenterPoint?.();
        const target={x: Number(this.document.x),y: Number(this.document.y)};
        let distance=0;

        try {
            distance=Number(
                canvas.grid.measurePath([source,target])?.distance ?? 0
            );
        } catch (_error) {
            const gridSize=Number(canvas.grid.size ?? canvas.dimensions.size ?? 1);
            const gridDistance=Number(canvas.scene.grid.distance ?? 1);
            distance=(Math.hypot(target.x-source.x,target.y-source.y)/gridSize)*
                gridDistance;
        }

        const ranges=String(this.item.system?.range ?? '')
            .split('/')
            .map(value=>Number(value))
            .filter(Number.isFinite);
        const short=ranges[0] ?? Infinity;
        const medium=ranges[1] ?? short*2;
        const long=ranges[2] ?? short*4;
        let modifier=0;
        let label=gb.trans('RangeShort');

        if (distance>long*4) {
            return {distance,modifier: -8,label: gb.trans('Extreme'),tooFar: true};
        }

        if (distance>long) {
            modifier=-8;
            label=gb.trans('Extreme');
        } else if (distance>medium) {
            modifier=-4;
            label=gb.trans('RangeLong');
        } else if (distance>short) {
            modifier=-2;
            label=gb.trans('RangeMedium');
        }

        return {distance,modifier,label,tooFar: false};
    }

    async postDeviationPrompt() {
        const content=`
            <div class="swade-tools-resolution-summary">
                <h3>${foundry.utils.escapeHTML(this.item.name)}</h3>
                <p>${gb.trans('GrenadeDeviationHint')}</p>
                <button type="button"
                    data-swade-tools-action="confirmTemplate:${this.document.parent.id},${this.document.id}">
                    <i class="fas fa-check"></i> ${gb.trans('ConfirmTemplatePosition')}
                </button>
            </div>
        `;

        await ChatMessage.create({
            user: game.user.id,
            speaker: ChatMessage.getSpeaker({actor: this.item.actor}),
            content,
            flags: {
                [gb.moduleName]: {
                    templateUuid: this.document.uuid,
                    transactionId: this.flags.transactionId
                }
            }
        });
    }

    async confirmDeviation() {
        if (!this.document.getFlag(gb.moduleName,'pendingDeviation')) {
            ui.notifications.warn(gb.trans('NoPendingDeviation'));
            return false;
        }

        const ownerId=this.document.user?.id ?? this.document.user;

        if (!game.user.isGM && ownerId!==game.user.id) {
            ui.notifications.error(gb.trans('OnlyGM'));
            return false;
        }

        if (!await this.beginTransaction(['awaiting-deviation','placed'])) {
            return false;
        }

        try {
            const targets=this.getTokensInTemplate();
            const damageItem=await this.resolveLinkedItem(
                this.profile.damageSourceItemUuid,
                this.item
            );

            if (targets.length && this.profile.damageEnabled!==false &&
                !ResolutionService.canRollDamage(
                    damageItem,
                    this.profile
                )) {
                ui.notifications.warn(gb.trans('NoDmgActionDefined'));
                throw new Error('Deviation damage action is unavailable');
            }

            if (this.profile.autoTarget) {
                this.targetTokens(targets);
            }

            this.notifyTargetCount(targets);

            if (targets.length && this.profile.damageEnabled!==false) {
                const roll=await ResolutionService.rollDamageForTargets(
                    damageItem,
                    targets,
                    {...this.profile,raiseDamage: false}
                );

                if (!roll) {
                    throw new Error('Deviation damage roll was not created');
                }
            }

            await this.document.update({
                [`flags.${gb.moduleName}.pendingDeviation`]: false,
                [`flags.${gb.moduleName}.deviationConfirmed`]: true,
                [`flags.${gb.moduleName}.workflowState`]: 'completed'
            });
            return true;
        } catch (error) {
            await this.document.update({
                [`flags.${gb.moduleName}.pendingDeviation`]: true,
                [`flags.${gb.moduleName}.workflowState`]:
                    'awaiting-deviation'
            });
            console.error(
                `${gb.moduleName} | Deviation confirmation failed`,
                error
            );
            ui.notifications.error(gb.trans('AutomationResolutionFailed'));
            return false;
        } finally {
            this.endTransaction();
        }
    }

    notifyTargetCount(targets) {
        ui.notifications.info(
            game.i18n.format('SWADETOOLS.TemplateTargetCount',{
                count: targets.length
            })
        );
    }
}
