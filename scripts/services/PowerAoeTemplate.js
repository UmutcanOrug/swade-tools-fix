/** Place a native SWADE Power area without changing the user's target selection. */
import { getPowerAoeSettings, getAoeCustomShape, normalizeAoeCustomShape } from './AoeItemFlags.js';
import { collectAoeTemplateTargets } from './AoeGeometry.js';

const SHAPES = Object.freeze({
    small: {t: 'circle', distance: 1},
    medium: {t: 'circle', distance: 2},
    large: {t: 'circle', distance: 3},
    scone: {t: 'cone', distance: 4, width: 2, angle: 0},
    cone: {t: 'cone', distance: 9, width: 3, angle: 0},
    stream: {t: 'ray', distance: 12, width: 1},
});
const LABELS = Object.freeze({small: 'Small Blast', medium: 'Medium Blast', large: 'Large Blast',
    scone: 'Small Cone', cone: 'Cone', stream: 'Stream'});
const CUSTOM_LABELS = Object.freeze({circle: 'Custom Circle', cone: 'Custom Cone',
    ray: 'Custom Line', rect: 'Custom Rectangle'});
const CUSTOM_CONE_PATCH = Symbol.for('swade-tools.custom-cone-geometry');
let previewSequence = 0;
const pointOf = value => {
    const point = value?.document ?? value;
    return Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y))
        ? {x: Number(point.x), y: Number(point.y)} : null;
};
const centerOf = token => pointOf(token?.center) ?? (Number.isFinite(Number(token?.w)) && Number.isFinite(Number(token?.h))
    ? {x: Number(token.x ?? token.document?.x) + Number(token.w) / 2,
        y: Number(token.y ?? token.document?.y) + Number(token.h) / 2} : null);
const tokenId = token => token?.id ?? token?.document?.id;
const asToken = token => token?.object ?? token;
const matchesActor = (token, actor) => {
    if (!token?.actor || !actor) return false;
    // Synthetic actors must retain their own token, not a different copy of the same NPC.
    if (actor.isToken && actor.token?.id) return tokenId(token) === actor.token.id;
    if (actor.uuid && token.actor.uuid === actor.uuid) return true;
    return !!actor.id && token.actor.id === actor.id;
};

/** Power range is a single distance, not the weapon's short/medium/long range bands. */
export const getNumericPowerRange = item => {
    const value = String(item?.system?.range ?? '').trim();
    return /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : null;
};

/** Dimensions are grid squares here; conversion to scene units happens once in the builder. */
export const resolveAoeTemplateShape = (shape, customShape) => {
    if (shape !== 'custom') {
        const preset = SHAPES[shape];
        if (!preset) throw new Error('Choose a supported Power AoE template.');
        return {...preset, label: LABELS[shape], directional: preset.t !== 'circle'};
    }
    const custom = normalizeAoeCustomShape(customShape, {strict: true});
    // A native Foundry rectangle is an axis-aligned diagonal bounding box. A ray is a
    // rotatable rectangle and therefore preserves both requested dimensions while aiming.
    const data = {t: custom.type === 'rect' ? 'ray' : custom.type, distance: custom.distance,
        label: CUSTOM_LABELS[custom.type], directional: custom.type !== 'circle', customType: custom.type,
        customShape: {...custom}};
    if (['ray', 'rect'].includes(custom.type)) data.width = custom.width;
    if (custom.type === 'cone') data.angle = custom.angle;
    return data;
};

/**
 * SWADE 5.x's positive-angle cone override uses the old core argument order. Only
 * our flagged custom cones use the installed core implementation; rounded SWADE
 * presets and every other module's templates retain their original implementation.
 */
export const registerCustomAoeTemplateGeometry = (runtime = {}) => {
    const configRef = runtime.configRef ?? globalThis.CONFIG;
    const baseTemplateClass = runtime.baseTemplateClass ?? globalThis.foundry?.canvas?.placeables?.MeasuredTemplate;
    const prototype = configRef?.MeasuredTemplate?.objectClass?.prototype;
    if (!prototype || typeof prototype._computeShape !== 'function' ||
        typeof baseTemplateClass?.getConeShape !== 'function') return false;
    if (Object.hasOwn(prototype, CUSTOM_CONE_PATCH)) return true;
    const original = prototype._computeShape;
    Object.defineProperty(prototype, '_computeShape', {configurable: true, writable: true, value: function(...args) {
        const document = this.document;
        const flags = document?.flags?.['swade-tools'];
        if (document?.t === 'cone' && flags?.templateType === 'custom' && flags?.customShapeType === 'cone' &&
            (flags.powerAoeTemplate === true || flags.weaponAoeTemplate === true) &&
            Number.isFinite(Number(document.distance)) && Number(document.distance) > 0 &&
            Number.isFinite(Number(document.direction)) && Number(document.angle) >= 1 && Number(document.angle) <= 360) {
            return baseTemplateClass.getConeShape(Number(document.distance), Number(document.direction), Number(document.angle));
        }
        return original.apply(this, args);
    }});
    Object.defineProperty(prototype, CUSTOM_CONE_PATCH, {value: true});
    return true;
};

export const buildPowerAoeTemplateData = ({actor, item, shape, customShape, source, target, scene, user,
    originMode = 'caster', direction: freeDirection = 0}) => {
    const preset = resolveAoeTemplateShape(shape, shape === 'custom' ? customShape ?? getAoeCustomShape(item) : undefined);
    const sceneDistance = Number(scene?.grid?.distance);
    if (!(sceneDistance > 0)) throw new Error('The scene grid distance must be greater than zero.');
    if (!pointOf(source) || !pointOf(target)) throw new Error('The Power AoE position could not be read.');
    if (!['caster', 'free'].includes(originMode)) throw new Error('Choose a valid power template origin.');
    const directional = preset.t !== 'circle';
    const freeOrigin = directional && originMode === 'free';
    if (freeOrigin && !Number.isFinite(Number(freeDirection))) throw new Error('The Power AoE direction could not be read.');
    const origin = directional && !freeOrigin ? source : target;
    const direction = freeOrigin ? (Number(freeDirection) % 360 + 360) % 360 : directional
        ? (Math.atan2(target.y - source.y, target.x - source.x) * 180 / Math.PI + 360) % 360 : 0;
    const data = {
        t: preset.t, x: origin.x, y: origin.y, direction,
        distance: preset.distance * sceneDistance,
        user: user?.id, fillColor: user?.color ?? '#ff6b35', borderColor: '#ff6b35',
        flags: {'swade-tools': {powerAoeTemplate: true, autoTarget: false,
            itemUuid: item?.uuid, actorUuid: actor?.uuid, templateType: shape,
            originMode: directional ? originMode : 'free', user: user?.id}},
    };
    // SWADE's rounded cone width is a count of grid squares; a ray width is a scene distance.
    if (preset.width !== undefined) data.width = preset.t === 'cone' && shape !== 'custom'
        ? preset.width : preset.width * sceneDistance;
    if (preset.angle !== undefined) data.angle = preset.angle;
    if (shape === 'custom') Object.assign(data.flags['swade-tools'], {
        customShapeType: preset.customType, customShape: {...preset.customShape}
    });
    return data;
};

/** Native template shapes already include direction; translating again must not rotate them twice. */
export const getPowerAoeTargetIds = (template, tokens, {sourceToken = null, excludeSource = false} = {}) => {
    if (!template?.shape?.contains) throw new Error('The Power AoE template shape could not be read.');
    const origin = template.document ?? template;
    const result = new Set();
    for (const token of tokens ?? []) {
        if (!token?.actor || token.document?.hidden || token.visible === false || token.isVisible === false) continue;
        if (excludeSource && tokenId(token) === tokenId(sourceToken)) continue;
        const center = centerOf(token);
        if (center && template.shape.contains(center.x - origin.x, center.y - origin.y)) {
            const id = tokenId(token);
            if (id) result.add(id);
        }
    }
    return Array.from(result);
};

const resolveSourceToken = (actor, explicitToken, canvasRef) => {
    const sceneId = canvasRef.scene.id;
    const valid = token => matchesActor(token, actor) &&
        (!token.document?.parent?.id || token.document.parent.id === sceneId) && !!centerOf(token);
    if (explicitToken) {
        const token = asToken(explicitToken);
        if (!valid(token)) throw new Error('Select the token casting this Power on the active scene.');
        return token;
    }
    const ownToken = asToken(actor.token);
    if (actor.isToken && valid(ownToken)) return ownToken;
    const selected = (canvasRef.tokens?.controlled ?? []).filter(valid);
    if (selected.length === 1) return selected[0];
    if (selected.length > 1) throw new Error('Select only the token casting this Power.');
    const active = (canvasRef.tokens?.placeables ?? []).filter(valid);
    if (active.length === 1) return active[0];
    throw new Error('Select the token casting this Power on the active scene.');
};

const refreshPreview = (preview, data) => {
    preview.document.updateSource(data);
    // refresh() queues a render. These native shape methods ensure targeting can use the confirmed geometry immediately.
    preview._refreshShape?.();
    preview._refreshPosition?.();
    preview.refresh?.();
};

const destroyPreview = (preview, baseTemplateClass, configRef) => {
    if (!preview) return;
    preview.parent?.removeChild?.(preview);
    // SWADE destroy() normally removes its drawPreview mouse listeners. We never installed those listeners;
    // use the core destroy implementation to leave other active previews and canvas handlers untouched.
    const baseDestroy = baseTemplateClass?.prototype?.destroy;
    if (typeof baseDestroy === 'function') {
        baseDestroy.call(preview, {children: true});
        return;
    }
    const removeListeners = preview._removeListenersFromCanvas;
    const previousActive = configRef?.SWADE?.activeMeasuredTemplatePreview;
    try {
        if (typeof removeListeners === 'function') preview._removeListenersFromCanvas = () => {};
        preview.destroy?.({children: true});
    } finally {
        if (typeof removeListeners === 'function') preview._removeListenersFromCanvas = removeListeners;
        if (previousActive && previousActive !== preview && configRef?.SWADE) {
            configRef.SWADE.activeMeasuredTemplatePreview = previousActive;
        }
    }
};

/**
 * Return null when placement is cancelled. Invalid context and document failures throw English errors.
 * The caller owns casting/PP and chat cards; this service never rolls, spends resources, or targets tokens.
 */
const placeNativeAoeTemplate = async ({actor, item, token, shape, customShape, origin: explicitOrigin,
    weapon = false, createDocument = true}, runtime = {}) => {
    const canvasRef = runtime.canvasRef ?? globalThis.canvas;
    const gameRef = runtime.gameRef ?? globalThis.game;
    const sequencerRef = runtime.sequencerRef ?? globalThis.Sequencer;
    const configRef = runtime.configRef ?? globalThis.CONFIG;
    const constRef = runtime.constRef ?? globalThis.CONST;
    const baseTemplateClass = runtime.baseTemplateClass ?? globalThis.foundry?.canvas?.placeables?.MeasuredTemplate;
    const notifications = runtime.notifications ?? globalThis.ui?.notifications;
    if (!actor || !(weapon ? ['weapon', 'consumable', 'gear'].includes(item?.type) : item?.type === 'power')) {
        throw new Error(weapon ? 'Choose an AoE item owned by the firing actor.' : 'Choose a Power owned by the casting actor.');
    }
    if (!gameRef?.user?.isGM && (!actor.isOwner || item.isOwner === false)) throw new Error('You do not own this Power.');
    if (item.actor && item.actor !== actor &&
        !(item.actor.uuid && item.actor.uuid === actor.uuid) &&
        !(item.actor.id && item.actor.id === actor.id && !item.actor.isToken && !actor.isToken)) {
        throw new Error('Choose a Power owned by the casting actor.');
    }
    if (!canvasRef?.scene || canvasRef.ready === false) throw new Error('Open a scene before placing a Power AoE template.');
    if (!sequencerRef?.Crosshair?.show || gameRef?.modules?.get?.('sequencer')?.active === false) {
        throw new Error('Power AoE placement requires the Sequencer module to be active.');
    }
    if (!configRef?.MeasuredTemplate?.documentClass || !configRef?.MeasuredTemplate?.objectClass) {
        throw new Error('The native SWADE template classes are unavailable.');
    }
    const preset = resolveAoeTemplateShape(shape, shape === 'custom' ? customShape ?? getAoeCustomShape(item) : undefined);
    const customSnapshot = preset.customShape;
    if (shape === 'custom' && preset.t === 'cone' &&
        !registerCustomAoeTemplateGeometry({configRef, baseTemplateClass})) {
        throw new Error('The native custom cone geometry is unavailable.');
    }
    const scene = canvasRef.scene;
    const sourceToken = resolveSourceToken(actor, token, canvasRef);
    const source = centerOf(sourceToken);
    const directional = preset.directional;
    const originMode = explicitOrigin ?? getPowerAoeSettings(item).origin;
    const freeOrigin = directional && originMode === 'free';
    const user = gameRef.user;
    const initialTarget = {x: source.x + Number(canvasRef.grid?.size ?? scene.grid.size ?? 100), y: source.y};
    let direction = 0;
    const buildData = target => {
        const value = buildPowerAoeTemplateData({actor, item, shape, customShape: customSnapshot, source, target, scene, user,
            originMode, direction});
        if (weapon) {
            delete value.flags['swade-tools'].powerAoeTemplate;
            value.flags['swade-tools'].weaponAoeTemplate = true;
        }
        return value;
    };
    let data = buildData(initialTarget);
    let preview = null;
    let cancelled = false;
    let removeRotationListener = null;
    const createPreview = async (show) => {
        const document = new configRef.MeasuredTemplate.documentClass(data, {parent: scene});
        preview = new configRef.MeasuredTemplate.objectClass(document);
        // Draft documents share a null ID. Keep this draft's grid highlight isolated from other previews.
        Object.defineProperty(preview, 'highlightId', {value: `swade-tools-power-aoe-preview-${++previewSequence}`});
        preview.eventMode = 'none';
        await preview.draw();
        preview.eventMode = 'none';
        if (preview.controlIcon) preview.controlIcon.renderable = false;
        if (show) {
            if (!canvasRef.templates?.preview?.addChild) throw new Error('The native template preview layer is unavailable.');
            canvasRef.templates.preview.addChild(preview);
        }
        refreshPreview(preview, data);
    };
    try {
        if (directional) await createPreview(true);
        if (freeOrigin) {
            const wheelTarget = runtime.wheelTarget ?? canvasRef.app?.canvas ?? canvasRef.app?.view;
            if (!wheelTarget?.addEventListener || !wheelTarget?.removeEventListener) {
                throw new Error('The Power AoE rotation controls are unavailable.');
            }
            // Match native SWADE preview rotation, without replacing another module's onwheel handler.
            const rotate = event => {
                if (!Number.isFinite(Number(event.deltaY)) || Number(event.deltaY) === 0) return;
                event.preventDefault();
                event.stopImmediatePropagation();
                const square = constRef?.GRID_TYPES?.SQUARE ?? 1;
                const gridType = Number(canvasRef.grid?.type ?? scene.grid.type ?? square);
                const step = event.shiftKey ? (gridType > square ? 30 : 15) : 5;
                direction = (direction + step * Math.sign(event.deltaY) + 360) % 360;
                data.direction = direction;
                refreshPreview(preview, data);
            };
            wheelTarget.addEventListener('wheel', rotate, {capture: true, passive: false});
            removeRotationListener = () => wheelTarget.removeEventListener('wheel', rotate, {capture: true});
        }
        const callbacks = sequencerRef.Crosshair.CALLBACKS ?? {};
        const updateAim = crosshair => {
            const target = pointOf(crosshair);
            if (!target) return;
            data = buildData(target);
            if (preview) refreshPreview(preview, data);
        };
        const range = weapon || directional && !freeOrigin ? null : getNumericPowerRange(item);
        const radius = directional ? Number(scene.grid.distance) * 0.05 : data.distance;
        const crosshairConfig = {
            t: 'circle', distance: radius, distanceMin: radius, distanceMax: radius,
            lockDrag: true, lockManualRotation: true, gridHighlight: !directional,
            borderColor: '#ff6b35', fillColor: '#ff6b35', fillAlpha: 0.2,
            label: {text: `${item.name} - ${directional && !freeOrigin ? 'Aim ' : ''}${preset.label}${freeOrigin ? ' (Mouse Wheel: Rotate)' : ''}`},
            snap: {position: directional && !freeOrigin ? 0 : ((constRef?.GRID_SNAPPING_MODES?.CENTER ?? 1) |
                (constRef?.GRID_SNAPPING_MODES?.VERTEX ?? 2)), resolution: 1},
            location: {obj: sourceToken, showRange: !directional || freeOrigin,
                wallBehavior: sequencerRef.Crosshair.PLACEMENT_RESTRICTIONS?.ANYWHERE},
        };
        if (range !== null && range > 0) crosshairConfig.location.limitMaxRange = range;
        const target = await sequencerRef.Crosshair.show(crosshairConfig, {
            [callbacks.SHOW ?? 'show']: updateAim,
            [callbacks.MOUSE_MOVE ?? 'mouseMove']: updateAim,
            [callbacks.CANCEL ?? 'cancel']: () => { cancelled = true; },
        });
        if (cancelled || !target) return null;
        const targetPoint = pointOf(target);
        if (!targetPoint) throw new Error('The confirmed Power AoE position could not be read.');
        if (canvasRef.scene?.id !== scene.id) throw new Error('The active scene changed. Place the Power AoE again.');
        const confirmedSource = centerOf(sourceToken);
        if (!confirmedSource || Math.hypot(confirmedSource.x - source.x, confirmedSource.y - source.y) > 0.000001) {
            throw new Error(`The ${weapon ? 'firing' : 'casting'} token moved. Place the AoE again.`);
        }
        if (range !== null) {
            const straightDistance = Math.hypot(targetPoint.x - source.x, targetPoint.y - source.y) /
                Number(canvasRef.grid?.size ?? scene.grid.size ?? 100) * Number(scene.grid.distance);
            let measuredDistance = straightDistance;
            try {
                const measured = Number(canvasRef.grid?.measurePath?.([source, targetPoint])?.distance);
                if (Number.isFinite(measured)) measuredDistance = measured;
            } catch { /* Gridless/third-party grids can use the Euclidean fallback. */ }
            if (measuredDistance > range + 0.000001) {
                notifications?.warn?.(`The selected area is outside this Power's range (${range}).`);
                return null;
            }
        }
        data = buildData(targetPoint);
        if (!preview) await createPreview(false);
        else refreshPreview(preview, data);
        const targetIds = weapon ? collectAoeTemplateTargets(preview, canvasRef.tokens?.placeables,
            {gridSize: Number(canvasRef.grid?.size ?? scene.grid.size ?? 100), sceneDistance: Number(scene.grid.distance),
                sourceTokenUuid: sourceToken.document?.uuid, sourceTokenId: tokenId(sourceToken),
                excludeSource: directional && !freeOrigin})
            .map(tokenId) : getPowerAoeTargetIds(preview, canvasRef.tokens?.placeables,
                {sourceToken, excludeSource: directional && !freeOrigin});
        const geometry = Object.fromEntries(['t', 'x', 'y', 'direction', 'distance', 'width', 'angle']
            .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
        if (!createDocument) return {sceneId: scene.id, targetIds, sourceToken, shape, geometry, point: targetPoint};
        let documents;
        try { documents = await scene.createEmbeddedDocuments('MeasuredTemplate', [data]); }
        catch (error) { throw new Error(`The Power AoE template could not be created: ${error.message}`, {cause: error}); }
        const templateDocument = documents?.[0];
        if (!templateDocument) throw new Error('The Power AoE template could not be created.');
        return {templateDocument, sceneId: scene.id, targetIds, sourceToken, shape, geometry, point: targetPoint};
    } finally {
        removeRotationListener?.();
        destroyPreview(preview, baseTemplateClass, configRef);
    }
};

export const placePowerAoeTemplate = (input, runtime = {}) => placeNativeAoeTemplate(input, runtime);

/** Preview a weapon cone/stream without spending ammunition or creating a persistent document. */
export const placeWeaponAoeTemplatePoint = async ({actor, item, token, shape, customShape, origin = 'token'}, runtime = {}) => {
    if (!['scone', 'cone', 'stream', 'custom'].includes(shape)) throw new Error('Choose a directional weapon template.');
    if (!['token', 'free'].includes(origin)) throw new Error('Choose a valid weapon template origin.');
    const result = await placeNativeAoeTemplate({actor, item, token, shape, customShape, origin: origin === 'token' ? 'caster' : 'free',
        weapon: true, createDocument: false}, runtime);
    return result ? {...result.point, direction: result.geometry.direction, geometry: result.geometry,
        targetIds: result.targetIds} : null;
};

/** Build the same native weapon geometry for a trusted RoF pool projectile. */
export const buildWeaponAoeTemplateData = ({actor, item, shape, customShape, source, target, scene, user, origin = 'token', direction = 0}) => {
    if (!['token', 'free'].includes(origin)) throw new Error('Choose a valid weapon template origin.');
    const data = buildPowerAoeTemplateData({actor, item, shape, customShape, source, target, scene, user,
        originMode: origin === 'token' ? 'caster' : 'free', direction});
    delete data.flags['swade-tools'].powerAoeTemplate;
    data.flags['swade-tools'].weaponAoeTemplate = true;
    return data;
};
