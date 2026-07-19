import * as gb from '../gb.js';
import CharRoll from '../class/CharRoll.js';

export default class AutomationSocketService {
    static installed=false;
    static pending=new Map();
    static channel=`module.${gb.moduleName}`;
    static templateConfirmHandler=null;

    static install() {
        if (this.installed || !game.socket) {
            return;
        }

        this.installed=true;
        game.socket.on(this.channel,message=>this.onMessage(message));
    }

    static getAuthority() {
        return Array.from(game.users ?? [])
            .filter(user=>user.active && user.isGM)
            .sort((left,right)=>left.id.localeCompare(right.id))[0] ?? null;
    }

    static getSceneAuthority(sceneId) {
        return Array.from(game.users ?? [])
            .filter(user=>
                user.active &&
                user.isGM &&
                (!sceneId || user.viewedScene===sceneId)
            )
            .sort((left,right)=>left.id.localeCompare(right.id))[0] ?? null;
    }

    static registerTemplateConfirmHandler(handler) {
        this.templateConfirmHandler=
            typeof handler==='function' ? handler : null;
    }

    static async confirmTemplate(sceneId,templateId) {
        const authority=this.getSceneAuthority(sceneId);

        if (!authority || !this.templateConfirmHandler) {
            ui.notifications.warn(gb.trans('TemplateAuthorityUnavailable'));
            return false;
        }

        if (authority.id===game.user.id && game.user.isGM) {
            return Boolean(
                await this.templateConfirmHandler(sceneId,templateId)
            );
        }

        const requestId=foundry.utils.randomID();
        const result=new Promise(resolve=>{
            const timeout=setTimeout(()=>{
                this.pending.delete(requestId);
                ui.notifications.warn(
                    gb.trans('TemplateAuthorityTimeout')
                );
                resolve(false);
            },20000);

            this.pending.set(requestId,{
                type: 'template-confirm',
                resolve,
                timeout
            });
        });

        game.socket.emit(this.channel,{
            type: 'template-confirm-request',
            requestId,
            requesterId: game.user.id,
            authorityId: authority.id,
            sceneId,
            templateId
        });

        return result;
    }

    static async rollTrait(actor,traitName,modifier=0,flavor='') {
        if (game.user.isGM || actor?.isOwner || !game.socket) {
            return this.rollLocal(actor,traitName,modifier,flavor);
        }

        const authority=this.getAuthority();

        if (!authority) {
            ui.notifications.warn(gb.trans('NoAutomationGM'));
            return {roll: null,total: 0,critical: false};
        }

        const requestId=foundry.utils.randomID();
        const result=new Promise(resolve=>{
            const timeout=setTimeout(()=>{
                this.pending.delete(requestId);
                ui.notifications.warn(gb.trans('AutomationGMTimeout'));
                resolve({roll: null,total: 0,critical: false});
            },20000);

            this.pending.set(requestId,{
                type: 'trait',
                resolve,
                timeout
            });
        });

        game.socket.emit(this.channel,{
            type: 'trait-request',
            requestId,
            requesterId: game.user.id,
            authorityId: authority.id,
            actorUuid: actor.uuid,
            traitName,
            modifier,
            flavor
        });

        return result;
    }

    static async onMessage(message) {
        if (!message || typeof message!=='object') {
            return;
        }

        if (message.type==='template-confirm-response' &&
            message.requesterId===game.user.id) {
            const pending=this.pending.get(message.requestId);

            if (!pending || pending.type!=='template-confirm') {
                return;
            }

            clearTimeout(pending.timeout);
            this.pending.delete(message.requestId);
            pending.resolve(message.ok===true);
            return;
        }

        if (message.type==='template-confirm-request' &&
            message.authorityId===game.user.id &&
            game.user.isGM) {
            let ok=false;

            try {
                ok=Boolean(
                    await this.templateConfirmHandler?.(
                        message.sceneId,
                        message.templateId
                    )
                );
            } catch (error) {
                console.error(
                    `${gb.moduleName} | Template confirmation failed`,
                    error
                );
            }

            game.socket.emit(this.channel,{
                type: 'template-confirm-response',
                requestId: message.requestId,
                requesterId: message.requesterId,
                authorityId: game.user.id,
                ok
            });
            return;
        }

        if (message.type==='trait-response' &&
            message.requesterId===game.user.id) {
            const pending=this.pending.get(message.requestId);

            if (!pending || pending.type!=='trait') {
                return;
            }

            clearTimeout(pending.timeout);
            this.pending.delete(message.requestId);
            pending.resolve({
                roll: message.ok ? {remote: true} : null,
                total: Number(message.total ?? 0),
                critical: message.critical===true,
                messageId: message.messageId ?? null
            });
            return;
        }

        if (message.type!=='trait-request' ||
            message.authorityId!==game.user.id ||
            !game.user.isGM) {
            return;
        }

        let result={roll: null,total: 0,critical: false};

        try {
            const actor=await fromUuid(message.actorUuid);

            if (actor) {
                result=await this.rollLocal(
                    actor,
                    message.traitName,
                    message.modifier,
                    message.flavor
                );
            }
        } catch (error) {
            console.error(`${gb.moduleName} | Remote trait roll failed`,error);
        }

        game.socket.emit(this.channel,{
            type: 'trait-response',
            requestId: message.requestId,
            requesterId: message.requesterId,
            authorityId: game.user.id,
            ok: Boolean(result.roll),
            total: result.total,
            critical: result.critical,
            messageId: result.messageId ?? null
        });
    }

    static async rollLocal(actor,traitName,modifier=0,flavor='') {
        const charRoll=new CharRoll(actor);
        const attribute=this.resolveAttribute(traitName);
        const modifiers=Array.isArray(modifier)
            ? modifier
            : [{value: modifier,label: gb.trans('AutomationModifier')}];

        for (const entry of modifiers) {
            const value=typeof entry==='object' ? entry.value : entry;
            const label=typeof entry==='object'
                ? (entry.label || gb.trans('AutomationModifier'))
                : gb.trans('AutomationModifier');

            if (value!==undefined && value!==null && value!=='') {
                charRoll.addModifier(value,label);
            }
        }

        if (flavor) {
            charRoll.addFlavor(
                `<div>${foundry.utils.escapeHTML(flavor)}</div>`
            );
        }

        if (attribute) {
            await charRoll.rollAtt(attribute);
        } else {
            await charRoll.rollSkill(String(traitName || 'Athletics'));
        }

        if (!charRoll.roll) {
            return {roll: null,total: 0,critical: false};
        }

        charRoll.addFlag('autoResolution',true);
        const message=await charRoll.display();

        return {
            roll: charRoll.roll,
            total: Number(charRoll.roll.total ?? 0),
            critical: charRoll.roll.isCritfail===true,
            messageId: message?.id ?? null
        };
    }

    static resolveAttribute(traitName) {
        const normalized=String(traitName ?? '').trim().toLowerCase();

        if (gb.attributes.includes(normalized)) {
            return normalized;
        }

        return gb.findAttr(String(traitName ?? '')) ?? null;
    }
}
