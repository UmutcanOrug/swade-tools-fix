const SCOPE = 'swade-tools';
const BURNING_FLAG = 'aoeBurning';
export const AOE_ON_FIRE_STATUS = 'swade-tools-on-fire';

// A status makes this indefinite ActiveEffect temporary in Foundry's sense,
// exposing its icon through Actor.temporaryEffects without inventing an expiry.
export const getAoeOnFireEffectData = state => ({name: 'On Fire', img: 'icons/svg/fire.svg',
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
    Sequence: runtime.SequenceClass ?? globalThis.Sequence, logger: runtime.logger ?? console});
const visualState = canvas => {
    let state = states.get(canvas);
    if (!state) {state = {records: new Map(), generation: 0, nextRecord: 0}; states.set(canvas, state);}
    return state;
};
const tokensOf = canvas => Array.from(canvas?.tokens?.placeables ?? []);
const recordForToken = (state, uuid, tokenUuid) => [...state.records].find(([, record]) =>
    record.effectUuid === uuid && record.tokenUuid === tokenUuid);
const visibleToken = (token, canvas, game) => token?.actor && token?.document?.uuid &&
    (token.document.parent?.id ?? token.document.parent?._id) === canvas?.scene?.id &&
    token.visible !== false && token.isVisible !== false && (!token.document.hidden || game?.user?.isGM);

export const getAoeFireVisualFile = (sequencer = globalThis.Sequencer) => {
    // Never assume a guessed or paid asset exists. Missing libraries affect only
    // the optional animation; Foundry still displays the standard fire icon.
    for (const file of FLAME_FILES) {
        try {
            if (sequencer?.Database?.entryExists?.(file) === true) return file;
        } catch { /* A missing optional database must not affect combat. */ }
    }
    return null;
};

const stopRecord = async (state, name, runtime) => {
    const record = state.records.get(name);
    if (!record) return;
    state.records.delete(name);
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
    if (!file) return {ok: false, reason: 'missing-optional-assets'};
    let count = 0;
    for (const token of targets) {
        if (generation !== state.generation || !enabled(effect)) break;
        const previous = recordForToken(state, uuid, token.document.uuid);
        const existing = previous?.[1];
        if (existing?.token === token && existing.file === file) {count++; continue;}
        if (existing) {
            await stopRecord(state, previous[0], runtime);
            if (generation !== state.generation || !enabled(effect) ||
                !visibleToken(token, canvas, game) || !tokensOf(canvas).includes(token)) continue;
            // Another hook can claim the replacement while cleanup is awaited.
            const replacement = recordForToken(state, uuid, token.document.uuid)?.[1];
            if (replacement) {
                if (replacement.token === token && replacement.file === file) count++;
                continue;
            }
        }
        // A hidden/replaced token can start a new loop before the old media
        // finishes loading. Give each creation a unique cleanup identity, while
        // the effect/token lookup above still deduplicates concurrent hooks.
        const name = `${SCOPE}.on-fire:${uuid}:${token.document.uuid}:g${generation}:r${++state.nextRecord}`;
        const record = {effectUuid: uuid, tokenUuid: token.document.uuid, token, file, sceneId: canvas.scene.id};
        // Claim synchronously so simultaneous create/update/draw hooks cannot
        // create duplicate loops while Sequencer is still starting the first.
        state.records.set(name, record);
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
            count++;
        } catch (error) {
            // A media error may arrive after Sequencer started a partial loop.
            if (state.records.get(name) === record) await stopRecord(state, name, runtime);
            logger?.warn?.('SWADE Tools | Optional On Fire animation is unavailable; the fire status is unchanged.', error);
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
    if (env(runtime).canvas?.ready) run(syncAoeFireCanvas(runtime));
    return true;
};
