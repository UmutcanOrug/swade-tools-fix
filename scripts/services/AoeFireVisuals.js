const SCOPE = 'swade-tools';
const BURNING_FLAG = 'aoeBurning';
export const AOE_ON_FIRE_STATUS = 'swade-tools-on-fire';
export const AOE_ON_FIRE_ICON = 'modules/swade-tools/assets/on-fire.svg';

// A status makes this indefinite ActiveEffect temporary in Foundry's sense,
// exposing its icon through Actor.temporaryEffects without inventing an expiry.
export const getAoeOnFireEffectData = state => ({name: 'On Fire', img: AOE_ON_FIRE_ICON,
    statuses: [AOE_ON_FIRE_STATUS], disabled: false, transfer: false, changes: [],
    flags: {[SCOPE]: {[BURNING_FLAG]: state}}});

const FLAME_FILES = Object.freeze(['jb2a.flames.04.loop.orange', 'jb2a.flames.01.orange',
    'jb2a.flames.02.orange', 'jb2a.flames.orange.01']);
const states = new WeakMap();
const registrations = new WeakSet();
const burning = effect => effect?.getFlag?.(SCOPE, BURNING_FLAG) ?? effect?.flags?.[SCOPE]?.[BURNING_FLAG];
const actorOf = effect => effect?.parent ?? effect?.actor;
const actorMatches = (left, right) => left === right || Boolean(left?.uuid && left.uuid === right?.uuid);
const effectUuid = effect => effect?.uuid ?? (actorOf(effect)?.uuid && effect?.id
    ? `${actorOf(effect).uuid}.ActiveEffect.${effect.id}` : null);
const enabled = effect => burning(effect)?.version === 1 && effect?.active !== false &&
    !effect?.disabled && !effect?.isSuppressed;
const effectsOf = actor => Array.from(actor?.effects?.values?.() ?? actor?.effects ?? []);
const env = runtime => ({canvas: runtime.canvasRef ?? globalThis.canvas,
    game: runtime.gameRef ?? globalThis.game, sequencer: runtime.sequencerRef ?? globalThis.Sequencer,
    Sequence: runtime.SequenceClass ?? globalThis.Sequence, PIXI: runtime.PIXIRef ?? globalThis.PIXI,
    logger: runtime.logger ?? console});
const visualState = canvas => {
    let state = states.get(canvas);
    if (!state) {state = {records: new Map(), generation: 0, nextRecord: 0}; states.set(canvas, state);}
    return state;
};
const tokensOf = canvas => Array.from(canvas?.tokens?.placeables ?? []);
const recordForToken = (state, uuid, tokenUuid) => [...state.records].find(([, record]) =>
    record.effectUuid === uuid && record.tokenUuid === tokenUuid);
const reusableRecord = (record, token, file, retryAssets) => record?.token === token && record.file === file &&
    !(retryAssets && record.backend === 'native' && file) && (record.backend !== 'native' ||
        (record.native?.graphics && !record.native.graphics.destroyed && record.native.graphics.parent === token));
const visibleToken = (token, canvas, game) => token?.actor && token?.document?.uuid &&
    (token.document.parent?.id ?? token.document.parent?._id) === canvas?.scene?.id &&
    token.visible !== false && token.isVisible !== false && (!token.document.hidden || game?.user?.isGM);

export const getAoeFireVisualFile = (sequencer = globalThis.Sequencer) => {
    // These keys exist in JB2A's official free database. Validate them at runtime
    // because the database can still be registering, disabled or relocated.
    for (const file of FLAME_FILES) {
        try {
            if (sequencer?.Database?.entryExists?.(file) === true) return file;
        } catch { /* A missing optional database must not affect combat. */ }
    }
    return null;
};

const stopNative = record => {
    const native = record.native;
    if (!native) return;
    record.native = null;
    native.ticker.remove(native.tick);
    if (!native.graphics.destroyed) {
        native.graphics.parent?.removeChild?.(native.graphics);
        native.graphics.destroy({children: true});
    }
};

// A small local PIXI drawing is a dependency-free fallback, not an actor/token
// mutation. Parenting to the token follows movement, visibility and alpha.
const startNative = (record, effect, state, name, runtime) => {
    const {canvas, game, PIXI} = env(runtime);
    const {token} = record, ticker = canvas?.app?.ticker;
    if (typeof PIXI?.Graphics !== 'function' || typeof token?.addChild !== 'function' ||
        !ticker?.add || !ticker?.remove) return false;
    const graphics = new PIXI.Graphics();
    graphics.name = name;
    graphics.eventMode = 'none';
    graphics.interactive = false;
    const native = {graphics, ticker, elapsed: 0, phase: 0, tick: null};
    const draw = () => {
        const width = Number(token.w) || Number(canvas.grid?.size) || 100;
        const height = Number(token.h) || Number(canvas.grid?.size) || 100;
        graphics.clear();
        // Five tapered flame tongues; no particles, textures, filters or lights.
        for (let index = 0; index < 5; index++) {
            const phase = native.phase + index * 1.7;
            const baseX = width * (0.13 + index * 0.185);
            const baseY = height * (0.91 - 0.05 * Math.sin(phase * 0.7));
            const flameHeight = height * (0.40 + 0.22 * (0.5 + 0.5 * Math.sin(phase)));
            const sway = width * 0.07 * Math.sin(phase * 1.3);
            for (const [scale, color, alpha] of [[1, 0xe84b12, 0.72], [0.68, 0xff981f, 0.86],
                [0.36, 0xffe16a, 0.95]]) {
                const radius = width * 0.13 * scale, top = baseY - flameHeight * scale;
                graphics.beginFill(color, alpha).moveTo(baseX - radius, baseY)
                    .bezierCurveTo(baseX - radius * 1.5, baseY - flameHeight * scale * 0.5,
                        baseX + sway - radius * 0.35, top + flameHeight * scale * 0.28,
                        baseX + sway, top)
                    .bezierCurveTo(baseX + sway + radius * 0.15, top + flameHeight * scale * 0.45,
                        baseX + radius * 1.6, baseY - flameHeight * scale * 0.3,
                        baseX + radius, baseY)
                    .quadraticCurveTo(baseX, baseY + height * 0.06 * scale,
                        baseX - radius, baseY).endFill();
            }
        }
    };
    native.tick = () => {
        const active = state.records.get(name) === record && !graphics.destroyed && !token.destroyed &&
            canvas.ready !== false && enabled(effect) && visibleToken(token, canvas, game);
        graphics.visible = active;
        if (!active) return;
        native.elapsed += Math.min(Number(ticker.deltaMS) || 16.667, 100);
        if (native.elapsed < 50) return;
        native.phase += native.elapsed / 190;
        native.elapsed %= 50;
        draw();
    };
    try {
        record.native = native;
        token.addChild(graphics);
        draw();
        ticker.add(native.tick);
        return true;
    } catch (error) {
        stopNative(record);
        env(runtime).logger?.warn?.('SWADE Tools | On Fire fallback drawing is unavailable.', error);
        return false;
    }
};

const stopRecord = async (state, name, runtime) => {
    const record = state.records.get(name);
    if (!record) return;
    state.records.delete(name);
    stopNative(record);
    if (record.backend !== 'sequencer') return;
    try {
        // These are local temporary loops: never send deletion to other clients
        // or touch unrelated Sequencer effects or actor/token document flags.
        await env(runtime).sequencer?.EffectManager?.endEffects?.({name, sceneId: record.sceneId}, false);
    } catch (error) {
        env(runtime).logger?.warn?.('SWADE Tools | Optional On Fire animation cleanup failed.', error);
    }
};

export const clearAoeFireVisuals = async (runtime = {}) => {
    const {canvas} = env(runtime);
    if (!canvas || !states.has(canvas)) return;
    const state = visualState(canvas);
    state.generation++;
    await Promise.all([...state.records.keys()].map(name => stopRecord(state, name, runtime)));
};

export const syncAoeFireVisual = async (effect, runtime = {}) => {
    const {canvas, game, sequencer, Sequence, logger} = env(runtime);
    const uuid = effectUuid(effect);
    if (!canvas || !uuid) return {ok: false, reason: 'missing-context'};
    const state = visualState(canvas);
    const generation = state.generation;
    const active = runtime.deleted !== true && enabled(effect);
    const targets = active && canvas.ready !== false ? tokensOf(canvas).filter(token =>
        actorMatches(token.actor, actorOf(effect)) && visibleToken(token, canvas, game)) : [];
    const targetIds = new Set(targets.map(token => token.document.uuid));
    for (const [name, record] of [...state.records]) {
        if (record.effectUuid === uuid && !targetIds.has(record.tokenUuid)) await stopRecord(state, name, runtime);
    }
    if (!targets.length) return {ok: true, count: 0};
    const file = game?.modules?.get?.('sequencer')?.active && typeof Sequence === 'function'
        ? getAoeFireVisualFile(sequencer) : null;
    let count = 0;
    for (const token of targets) {
        if (generation !== state.generation || !enabled(effect)) break;
        const previous = recordForToken(state, uuid, token.document.uuid);
        const existing = previous?.[1];
        if (reusableRecord(existing, token, file, runtime.retryAssets)) {count++; continue;}
        if (existing) {
            await stopRecord(state, previous[0], runtime);
            if (generation !== state.generation || !enabled(effect) ||
                !visibleToken(token, canvas, game) || !tokensOf(canvas).includes(token)) continue;
            // Another hook can claim the replacement while cleanup is awaited.
            const replacement = recordForToken(state, uuid, token.document.uuid)?.[1];
            if (replacement) {
                if (reusableRecord(replacement, token, file, runtime.retryAssets)) count++;
                continue;
            }
        }
        // A hidden/replaced token can start a new loop before the old media
        // finishes loading. Give each creation a unique cleanup identity, while
        // the effect/token lookup above still deduplicates concurrent hooks.
        const name = `${SCOPE}.on-fire:${uuid}:${token.document.uuid}:g${generation}:r${++state.nextRecord}`;
        const record = {effectUuid: uuid, tokenUuid: token.document.uuid, token, file, sceneId: canvas.scene.id,
            backend: file ? 'sequencer' : 'native'};
        // Claim synchronously so simultaneous create/update/draw hooks cannot
        // create duplicate loops while Sequencer is still starting the first.
        state.records.set(name, record);
        if (!file) {
            if (startNative(record, effect, state, name, runtime)) count++;
            else state.records.delete(name);
            continue;
        }
        try {
            const animation = new Sequence();
            animation.effect().file(file).attachTo(token, {bindVisibility: true, bindAlpha: true,
                bindRotation: false}).scaleToObject(1.15).persist().temporary().locally().name(name);
            await animation.play();
            if (state.records.get(name) !== record || generation !== state.generation ||
                !enabled(effect) || !visibleToken(token, canvas, game)) {
                // An effect can be removed while its optional asset is loading.
                if (!state.records.has(name)) state.records.set(name, record);
                await stopRecord(state, name, runtime);
                continue;
            }
            // Sequence.play uses allSettled internally, so asset failures and
            // permission gates can resolve without creating any visual.
            const getEffects = sequencer?.EffectManager?.getEffects;
            if (typeof getEffects === 'function' &&
                !getEffects.call(sequencer.EffectManager, {name, sceneId: record.sceneId})?.length) {
                throw new Error('Sequencer did not create the On Fire animation.');
            }
            count++;
        } catch (error) {
            // A media error may arrive after Sequencer started a partial loop.
            const wasCurrent = state.records.get(name) === record;
            if (wasCurrent) await stopRecord(state, name, runtime);
            if (!wasCurrent || generation !== state.generation || !enabled(effect) || !visibleToken(token, canvas, game) ||
                !tokensOf(canvas).includes(token) || recordForToken(state, uuid, token.document.uuid)) continue;
            record.backend = 'native';
            state.records.set(name, record);
            if (startNative(record, effect, state, name, runtime)) count++;
            else state.records.delete(name);
            logger?.warn?.('SWADE Tools | Sequencer On Fire animation is unavailable; using local flames.', error);
        }
    }
    return {ok: true, count};
};

export const syncAoeFireCanvas = async (runtime = {}) => {
    const {canvas} = env(runtime);
    if (!canvas) return;
    const effects = new Map();
    for (const token of tokensOf(canvas)) {
        for (const effect of effectsOf(token.actor)) {
            if (burning(effect)?.version === 1) effects.set(effectUuid(effect), effect);
        }
    }
    const state = visualState(canvas);
    for (const [name, record] of [...state.records]) {
        if (!effects.has(record.effectUuid)) await stopRecord(state, name, runtime);
    }
    await Promise.all([...effects.values()].map(effect => syncAoeFireVisual(effect, runtime)));
};

export const registerAoeFireVisuals = (runtime = {}) => {
    const hooks = runtime.hooksRef ?? globalThis.Hooks;
    if (!hooks?.on || registrations.has(hooks)) return false;
    registrations.add(hooks);
    const run = task => Promise.resolve(task).catch(error => env(runtime).logger?.warn?.(
        'SWADE Tools | Optional On Fire visual refresh failed.', error));
    const setTimer = runtime.setTimeout ?? globalThis.setTimeout;
    const clearTimer = runtime.clearTimeout ?? globalThis.clearTimeout;
    let pending = null;
    const scheduleCanvasSync = () => {
        if (pending) return pending.promise;
        let resolve;
        const promise = new Promise(done => {resolve = done;});
        const scheduled = {promise, resolve, timer: null};
        pending = scheduled;
        // Token movement can refresh many placeables in a single frame. One
        // bounded local refresh covers the burst rather than scanning repeatedly.
        scheduled.timer = setTimer(() => {
            if (pending !== scheduled) return;
            pending = null;
            return run(syncAoeFireCanvas(runtime)).finally(scheduled.resolve);
        }, 50);
        return promise;
    };
    const cancelScheduledSync = () => {
        if (!pending) return;
        clearTimer(pending.timer);
        pending.resolve();
        pending = null;
    };
    hooks.on('createActiveEffect', effect => run(syncAoeFireVisual(effect, runtime)));
    hooks.on('updateActiveEffect', effect => run(syncAoeFireVisual(effect, runtime)));
    hooks.on('deleteActiveEffect', effect => run(syncAoeFireVisual(effect, {...runtime, deleted: true})));
    hooks.on('canvasReady', () => run(syncAoeFireCanvas(runtime)));
    hooks.on('canvasTearDown', () => {cancelScheduledSync(); return run(clearAoeFireVisuals(runtime));});
    // Actor replacement, synthetic token actors, visibility and newly drawn
    // placeables all need reconciling, without any token/effect writes here.
    for (const hook of ['createToken', 'updateToken', 'deleteToken', 'drawToken', 'refreshToken', 'updateActor']) {
        hooks.on(hook, scheduleCanvasSync);
    }
    hooks.on('sequencerReady', () => run(syncAoeFireCanvas(runtime)));
    hooks.on('registerSequencerDatabaseEntries', namespace => namespace === 'jb2a' &&
        run(syncAoeFireCanvas({...runtime, retryAssets: true})));
    if (env(runtime).canvas?.ready) run(syncAoeFireCanvas(runtime));
    return true;
};
