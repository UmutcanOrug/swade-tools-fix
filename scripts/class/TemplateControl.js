import * as gb from './../gb.js';
import CharRoll from './CharRoll.js';
import ItemRoll from './ItemRoll.js';

export default class TemplateControl {
    constructor(templateDocument) {
        this.document = templateDocument;
        this.flags = templateDocument.flags?.[gb.moduleName] || {};
        this.template = templateDocument.object || canvas.templates?.get(templateDocument.id);
    }

    static async handleCreate(templateDocument, options, userId) {
        const flags = templateDocument.flags?.[gb.moduleName] || {};

        if (!flags.autoTarget || game.user.id != userId) {
            return;
        }

        const control = new TemplateControl(templateDocument);
        await control.run();
    }

    async run() {
        const item = await this.getItem();

        if (!item?.actor) {
            ui.notifications.warn('SWADE Tools: template item could not be found.');
            return;
        }

        await this.waitForTemplateObject();

        if (!this.template?.shape) {
            ui.notifications.warn('SWADE Tools: template shape could not be read.');
            return;
        }

        const targets = this.getTokensInTemplate();
        this.targetTokens(targets);

        if (!targets.length) {
            ui.notifications.warn(gb.trans('NoTarget'));
            return;
        }

        const failedTargets = [];

        for (const target of targets) {
            const success = await this.rollAthletics(target, item);

            if (!success) {
                failedTargets.push(target);
            }

            await gb.wait(100);
        }

        for (const target of failedTargets) {
            await this.rollDamage(item, target);
            await gb.wait(100);
        }
    }

    async getItem() {
        const uuid = this.flags.itemUuid || this.document.flags?.swade?.origin;

        if (!uuid) {
            return null;
        }

        return await fromUuid(uuid);
    }

    async waitForTemplateObject() {
        await gb.waitFor(() => {
            this.template = this.document.object || canvas.templates?.get(this.document.id);
            return !!this.template?.shape;
        }, 20, 50);
    }

    getTokensInTemplate() {
        return canvas.tokens.placeables.filter(token => {
            if (!token?.actor || token.document?.hidden) {
                return false;
            }

            return this.tokenIntersectsTemplate(token);
        });
    }

    tokenIntersectsTemplate(token) {
        return this.getTokenTestPoints(token).some(point => this.templateContainsPoint(point));
    }

    getTokenTestPoints(token) {
        const center = token.center || {
            x: token.x + (token.w / 2),
            y: token.y + (token.h / 2)
        };

        const bounds = this.getTokenBounds(token);
        const points = [center];

        if (!bounds) {
            return points;
        }

        const x = bounds.x;
        const y = bounds.y;
        const w = bounds.width;
        const h = bounds.height;
        const gridSize = canvas.grid.size || canvas.dimensions.size || Math.min(w, h);

        points.push(
            { x: x, y: y },
            { x: x + w, y: y },
            { x: x, y: y + h },
            { x: x + w, y: y + h },
            { x: x + (w / 2), y: y },
            { x: x + (w / 2), y: y + h },
            { x: x, y: y + (h / 2) },
            { x: x + w, y: y + (h / 2) }
        );

        for (let px = x + (gridSize / 2); px < x + w; px += gridSize) {
            for (let py = y + (gridSize / 2); py < y + h; py += gridSize) {
                points.push({ x: px, y: py });
            }
        }

        return this.uniquePoints(points);
    }

    getTokenBounds(token) {
        if (typeof token.bounds == 'function') {
            return token.bounds();
        }

        return token.bounds || token.getBounds?.();
    }

    uniquePoints(points) {
        const used = new Set();

        return points.filter(point => {
            const key = `${Math.round(point.x)}:${Math.round(point.y)}`;

            if (used.has(key)) {
                return false;
            }

            used.add(key);
            return true;
        });
    }

    templateContainsPoint(point) {
        const localPoint = this.toTemplateLocal(point);

        return !!this.template.shape?.contains(localPoint.x, localPoint.y);
    }

    toTemplateLocal(point) {
        if (this.template.worldTransform?.applyInverse) {
            return this.template.worldTransform.applyInverse(new PIXI.Point(point.x, point.y));
        }

        const direction = (-(this.document.direction || 0) * Math.PI) / 180;
        const dx = point.x - this.document.x;
        const dy = point.y - this.document.y;

        return {
            x: (dx * Math.cos(direction)) - (dy * Math.sin(direction)),
            y: (dx * Math.sin(direction)) + (dy * Math.cos(direction))
        };
    }

    targetTokens(tokens) {
        for (const target of Array.from(game.user.targets)) {
            target.setTarget(false, {user: game.user, releaseOthers: false, groupSelection: true});
        }

        tokens.forEach(token => {
            token.setTarget(true, {user: game.user, releaseOthers: false, groupSelection: true});
        });
    }

    async rollAthletics(token, item) {
        const skillName = this.getAthleticsSkillName(token.actor);
        const charRoll = new CharRoll(token.actor);

        charRoll.addFlavor(`<div>${item.name}: Athletics ${gb.trans('TN')} 4</div>`);
        await charRoll.rollSkill(skillName);

        const success = gb.raiseCount(charRoll.roll.total, 4) >= 0;

        charRoll.addFlavor(`<div>${gb.trans(success ? 'Success' : 'Failure')} (${gb.trans('TN')}: 4)</div>`, true);
        charRoll.display();

        return success;
    }

    getAthleticsSkillName(actor) {
        const candidates = this.getAthleticsSkillCandidates();
        const skill = actor.items.find(item => {
            return item.type == 'skill' && candidates.some(name => item.name.toLowerCase() == name.toLowerCase());
        });

        return skill?.name || candidates[0];
    }

    getAthleticsSkillCandidates() {
        const candidates = ['Athletics'];
        const localizationKeys = [
            'SWADE.SkillAthletics',
            'SWADE.Skills.Athletics'
        ];

        localizationKeys.forEach(key => {
            const localized = game.i18n.localize(key);

            if (localized && localized != key && !candidates.includes(localized)) {
                candidates.push(localized);
            }
        });

        return candidates;
    }

    async rollDamage(item, target) {
        if (!item.system?.damage) {
            ui.notifications.warn(`${item.name}: ${gb.trans('NoDmgActionDefined')}`);
            return;
        }

        const itemRoll = new ItemRoll(item.actor, item);

        itemRoll.useTarget(target.id);
        itemRoll.addFlavor(`<div>${target.name}</div>`, true);
        await itemRoll.rollBaseDamage();
        itemRoll.display();
    }
}
