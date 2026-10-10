/** Place a native SWADE Power area without changing the user's target selection. */
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

export const buildPowerAoeTemplateData = ({actor, item, shape, source, target, scene, user}) => {
    const preset = SHAPES[shape];
    if (!preset) throw new Error('Choose a supported Power AoE template.');
    const sceneDistance = Number(scene?.grid?.distance);
    if (!(sceneDistance > 0)) throw new Error('The scene grid distance must be greater than zero.');
    if (!pointOf(source) || !pointOf(target)) throw new Error('The Power AoE position could not be read.');
    const directional = preset.t !== 'circle';
    const origin = directional ? source : target;
    const direction = directional
        ? (Math.atan2(target.y - source.y, target.x - source.x) * 180 / Math.PI + 360) % 360 : 0;
    const data = {
        t: preset.t, x: origin.x, y: origin.y, direction,
        distance: preset.distance * sceneDistance,
        user: user?.id, fillColor: user?.color ?? '#ff6b35', borderColor: '#ff6b35',
        flags: {'swade-tools': {powerAoeTemplate: true, autoTarget: false,
            itemUuid: item?.uuid, actorUuid: actor?.uuid, templateType: shape, user: user?.id}},
    };
    // SWADE's rounded cone width is a count of grid squares; a ray width is a scene distance.
    if (preset.width !== undefined) data.width = preset.t === 'cone' ? preset.width : preset.width * sceneDistance;
    if (preset.angle !== undefined) data.angle = preset.angle;
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
export const placePowerAoeTemplate = async ({actor, item, token, shape}, runtime = {}) => {
    const canvasRef = runtime.canvasRef ?? globalThis.canvas;
    const gameRef = runtime.gameRef ?? globalThis.game;
    const sequencerRef = runtime.sequencerRef ?? globalThis.Sequencer;
    const configRef = runtime.configRef ?? globalThis.CONFIG;
    const constRef = runtime.constRef ?? globalThis.CONST;
    const baseTemplateClass = runtime.baseTemplateClass ?? globalThis.foundry?.canvas?.placeables?.MeasuredTemplate;
    const notifications = runtime.notifications ?? globalThis.ui?.notifications;
    if (!actor || item?.type !== 'power') throw new Error('Choose a Power owned by the casting actor.');
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
    if (!SHAPES[shape]) throw new Error('Choose a supported Power AoE template.');
    const scene = canvasRef.scene;
    const sourceToken = resolveSourceToken(actor, token, canvasRef);
    const source = centerOf(sourceToken);
    const directional = SHAPES[shape].t !== 'circle';
    const user = gameRef.user;
    const initialTarget = {x: source.x + Number(canvasRef.grid?.size ?? scene.grid.size ?? 100), y: source.y};
    let data = buildPowerAoeTemplateData({actor, item, shape, source, target: initialTarget, scene, user});
    let preview = null;
    let cancelled = false;
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
        const callbacks = sequencerRef.Crosshair.CALLBACKS ?? {};
        const updateAim = crosshair => {
            const target = pointOf(crosshair);
            if (!target) return;
            data = buildPowerAoeTemplateData({actor, item, shape, source, target, scene, user});
            if (preview) refreshPreview(preview, data);
        };
        const range = directional ? null : getNumericPowerRange(item);
        const radius = directional ? Number(scene.grid.distance) * 0.05 : data.distance;
        const crosshairConfig = {
            t: 'circle', distance: radius, distanceMin: radius, distanceMax: radius,
            lockDrag: true, lockManualRotation: true, gridHighlight: !directional,
            borderColor: '#ff6b35', fillColor: '#ff6b35', fillAlpha: 0.2,
            label: {text: `${item.name} - ${directional ? 'Aim ' : ''}${LABELS[shape]}`},
            snap: {position: directional ? 0 : ((constRef?.GRID_SNAPPING_MODES?.CENTER ?? 1) |
                (constRef?.GRID_SNAPPING_MODES?.VERTEX ?? 2)), resolution: 1},
            location: {obj: sourceToken, showRange: !directional,
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
        data = buildPowerAoeTemplateData({actor, item, shape, source, target: targetPoint, scene, user});
        if (!preview) await createPreview(false);
        else refreshPreview(preview, data);
        const targetIds = getPowerAoeTargetIds(preview, canvasRef.tokens?.placeables,
            {sourceToken, excludeSource: directional});
        let documents;
        try { documents = await scene.createEmbeddedDocuments('MeasuredTemplate', [data]); }
        catch (error) { throw new Error(`The Power AoE template could not be created: ${error.message}`, {cause: error}); }
        const templateDocument = documents?.[0];
        if (!templateDocument) throw new Error('The Power AoE template could not be created.');
        const geometry = Object.fromEntries(['t', 'x', 'y', 'direction', 'distance', 'width', 'angle']
            .filter(key => data[key] !== undefined).map(key => [key, data[key]]));
        return {templateDocument, sceneId: scene.id, targetIds, sourceToken, shape, geometry};
    } finally {
        destroyPreview(preview, baseTemplateClass, configRef);
    }
};
