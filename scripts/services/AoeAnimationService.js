const AA_MODULE_ID = 'autoanimations';
const nativeAoeGuards = new WeakMap();

const isAutomatedAnimationsActive = gameRef =>
    Boolean(gameRef?.modules?.get(AA_MODULE_ID)?.active);
const itemKey = item => item?.uuid ?? item;

// SWADE can start a linked consumable's consume() without awaiting it. Its
// pre-consume event is synchronous, so keep the already-selected resource
// scope alive until that exact usage object reaches the post-consume event.
const trackNativeConsumption = (keys, hooksRef, runtime) => {
    const pending = new Set();
    const setTimer = runtime.setTimeout ?? globalThis.setTimeout;
    const clearTimer = runtime.clearTimeout ?? globalThis.clearTimeout;
    const configuredTimeout = Number(runtime.consumptionTimeoutMs ?? 8000);
    const timeoutMs = Number.isFinite(configuredTimeout)
        ? Math.max(0, configuredTimeout) : 8000;
    const preHookId = hooksRef.on('swadePreConsumeItem', (item, _charges, usage) => {
        const key = itemKey(item);
        if (!keys.has(key) || !usage || typeof usage !== 'object') return;
        if ([...pending].some(entry => entry.key === key && entry.usage === usage)) return;
        let resolve;
        const promise = new Promise(done => { resolve = done; });
        pending.add({key, usage, promise, resolve});
    });
    const postHookId = hooksRef.on('swadeConsumeItem', (item, _charges, usage) => {
        const key = itemKey(item);
        for (const entry of pending) {
            if (entry.key !== key || entry.usage !== usage) continue;
            pending.delete(entry);
            entry.resolve();
        }
    });
    return {
        async wait() {
            if (!pending.size) return true;
            let timer;
            try {
                return await Promise.race([
                    (async () => {
                        while (pending.size) {
                            await Promise.all([...pending].map(entry => entry.promise));
                        }
                        return true;
                    })(),
                    new Promise(resolve => { timer = setTimer(() => resolve(false), timeoutMs); }),
                ]);
            } finally {
                if (timer !== undefined) clearTimer(timer);
            }
        },
        cleanup() {
            hooksRef.off('swadePreConsumeItem', preHookId);
            hooksRef.off('swadeConsumeItem', postHookId);
            // Also release a timed-out internal waiter; no native update is
            // cancelled, retried or consumed by this cosmetic-only tracker.
            for (const entry of pending) entry.resolve();
            pending.clear();
        },
    };
};

// AA 6.8.5 prepares SWADE data synchronously before its asynchronous handler.
// Stamp only this workflow's native consume/damage events. The manual API call
// below does not pass through aa.getRequiredData and is not suppressed.
export const withSuppressedAoeAutomation = async (items, callback, runtime = {}) => {
    const gameRef = runtime.gameRef ?? globalThis.game;
    const hooksRef = runtime.hooksRef ?? globalThis.Hooks;
    if (!isAutomatedAnimationsActive(gameRef) || !hooksRef?.on || !hooksRef?.off) {
        return callback();
    }
    const keys = [...new Set(items.filter(Boolean).map(itemKey))];
    if (!keys.length) return callback();
    let state = nativeAoeGuards.get(hooksRef);
    if (!state) {
        state = {counts: new Map(), hookId: undefined};
        state.hookId = hooksRef.on('aa.getRequiredData', data => {
            const key = data?.item?.uuid ?? data?.itemUuid ?? data?.item;
            if (state.counts.has(key)) data.stopWorkflow = true;
        });
        nativeAoeGuards.set(hooksRef, state);
    }
    for (const key of keys) state.counts.set(key, (state.counts.get(key) ?? 0) + 1);
    let consumptionTracker;
    try {
        if (runtime.trackConsumption) {
            consumptionTracker = trackNativeConsumption(new Set(keys), hooksRef, runtime);
        }
        const result = await callback();
        if (consumptionTracker && !await consumptionTracker.wait()) {
            (runtime.logger ?? console).warn('SWADE Tools | Timed out waiting for AoE resource consumption; temporary animation suppression was released.');
        }
        return result;
    } finally {
        consumptionTracker?.cleanup();
        for (const key of keys) {
            const count = state.counts.get(key) - 1;
            if (count > 0) state.counts.set(key, count);
            else state.counts.delete(key);
        }
        if (!state.counts.size) {
            hooksRef.off('aa.getRequiredData', state.hookId);
            nativeAoeGuards.delete(hooksRef);
        }
    }
};

const databasePathExists = (sequencerRef, path) => {
    try {
        if (typeof sequencerRef?.Database?.entryExists === 'function') {
            return sequencerRef.Database.entryExists(path);
        }
        if (typeof sequencerRef?.Database?.getEntry === 'function') {
            return Boolean(sequencerRef.Database.getEntry(path));
        }
    } catch {
        return false;
    }
    return true;
};

// Animation is cosmetic: neither a missing asset nor a failed optional API
// may prevent the attack or its native damage cards from resolving.
export const playAoeAnimation = async (context, runtime = {}) => {
    const gameRef = runtime.gameRef ?? globalThis.game;
    const api = runtime.automatedAnimations ?? globalThis.AutomatedAnimations;
    const sequencerRef = runtime.sequencerRef ?? globalThis.Sequencer;
    const SequenceClass = runtime.SequenceClass ?? globalThis.Sequence;
    const logger = runtime.logger ?? console;
    const {sourceToken, item, templateDocument, success, throwProjectile,
        blastDiameter, projectileEffect, impactEffect} = context;
    const targets = Array.from(context.targets ?? []);
    if (!sourceToken || !item || !templateDocument) {
        return {engine: 'none', ok: false, reason: 'missing-context'};
    }
    if (isAutomatedAnimationsActive(gameRef)) {
        // Do not fall back when AA rejects/disabled an item. Its configured
        // killAnim, isEnabled and AutoRec choices are authoritative.
        if (typeof api?.playAnimation !== 'function') {
            logger.warn('SWADE Tools | Automated Animations API is unavailable; AoE still resolved.');
            return {engine: 'automated-animations', ok: false, reason: 'missing-api'};
        }
        try {
            const handler = await api.playAnimation(sourceToken, item, {
                templateData: templateDocument,
                isTemplate: true,
                targets,
                hitTargets: success ? [...targets] : [],
                playOnMiss: false,
            });
            return {engine: 'automated-animations', ok: Boolean(handler)};
        } catch (error) {
            logger.warn('SWADE Tools | Automated Animations could not dispatch this AoE; attack and damage are unchanged.', error);
            return {engine: 'automated-animations', ok: false, reason: 'api-error'};
        }
    }
    if (typeof SequenceClass !== 'function' ||
        !databasePathExists(sequencerRef, impactEffect) ||
        (throwProjectile && !databasePathExists(sequencerRef, projectileEffect))) {
        return {engine: 'sequencer', ok: false, reason: 'missing-assets'};
    }
    try {
        const templateTarget = templateDocument.object ?? {
            x: templateDocument.x, y: templateDocument.y,
        };
        const animation = new SequenceClass();
        if (throwProjectile) animation.effect()
            .file(projectileEffect).atLocation(sourceToken)
            .stretchTo(templateTarget).waitUntilFinished();
        await animation.effect().file(impactEffect).atLocation(templateTarget)
            .size(blastDiameter, {gridUnits: true}).waitUntilFinished(250).play();
        return {engine: 'sequencer', ok: true};
    } catch (error) {
        logger.warn('SWADE Tools | AoE fallback animation failed; attack and damage are unchanged.', error);
        return {engine: 'sequencer', ok: false, reason: 'play-error'};
    }
};
