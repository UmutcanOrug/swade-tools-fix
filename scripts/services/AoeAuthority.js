const CHANNEL = 'module.swade-tools';
const PROTOCOL = 'swade-tools.aoe-authority.v1';
const ACTIONS = new Set(['evade', 'fireHit']);
const handlers = new Map();
const registrations = new WeakMap();
const inFlight = new Map();
const attackQueues = new Map();
let nextRequest = 0;

const usersOf = gameRef => Array.from(gameRef?.users?.contents ?? gameRef?.users?.values?.() ?? []);
export const getPrimaryAoeGm = (gameRef = globalThis.game) => usersOf(gameRef)
    .filter(user => user.active && user.isGM).sort((a, b) => String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)[0] ?? null;
export const isPrimaryAoeGm = (gameRef = globalThis.game) => Boolean(gameRef?.user?.isGM &&
    getPrimaryAoeGm(gameRef)?.id === gameRef.user.id);
const userOf = (gameRef, id) => gameRef?.users?.get?.(id) ??
    (String(gameRef?.user?.id) === String(id) ? gameRef.user : null);
const pending = reason => ({allowed: false, pending: true, reason});
const denied = reason => ({allowed: false, pending: false, reason});
const authorIdOf = message => message.author?.id ?? message.user?.id ?? message.user ?? null;
const owns = (actor, user) => user.isGM || actor?.testUserPermission?.(user, 'OWNER') === true ||
    Number(actor?.ownership?.[user.id] ?? actor?.ownership?.default ?? 0) >= 3;

export const registerAoeAuthorityHandler = (action, handler) => {
    if (!ACTIONS.has(action) || typeof handler !== 'function') throw new Error('Unsupported AoE authority action.');
    handlers.set(action, handler);
};

// Foundry V13 supplies the authenticated socket sender as the listener's second
// argument. Never trust a user ID in the client-controlled envelope. Every
// operation also resolves its actor, item, configuration and target from a
// current owned card; no client-provided actor data, rolls or code are accepted.
export const validateAoeAuthorityContext = async (payload, requesterId, runtime = {}) => {
    const gameRef = runtime.gameRef ?? globalThis.game;
    const canvasRef = runtime.canvasRef ?? globalThis.canvas;
    const fromUuid = runtime.fromUuid ?? globalThis.fromUuid;
    if (!payload || typeof payload.messageId !== 'string' || typeof payload.targetUuid !== 'string' ||
        Object.keys(payload).some(key => key !== 'messageId' && key !== 'targetUuid')) return null;
    const requester = userOf(gameRef, requesterId);
    const message = gameRef?.messages?.get?.(payload.messageId);
    const author = userOf(gameRef, message ? authorIdOf(message) : null);
    const state = message?.flags?.world?.aoeAttack;
    const sceneAvailable = gameRef?.scenes?.get ? Boolean(gameRef.scenes.get(state?.sceneId))
        : String(canvasRef?.scene?.id ?? '') === String(state?.sceneId);
    if (!requester || !author || requester.active === false || !state || state.version !== 1 ||
        message.flags.world.aoeSuperseded ||
        (!requester.isGM && String(authorIdOf(message)) !== String(requester.id)) ||
        !sceneAvailable ||
        !state.targets?.some(target => target.uuid === payload.targetUuid) ||
        !payload.targetUuid.startsWith(`Scene.${state.sceneId}.Token.`) ||
        !/^Scene\.[^.]+\.Token\.[^.]+$/.test(payload.targetUuid) || typeof fromUuid !== 'function') return null;
    const benny = message.flags.world.aoeBennyInProgress;
    if (benny && (!Number.isFinite(Number(benny.expiresAt)) || Date.now() < Number(benny.expiresAt))) return null;
    const total = Number(state.baseTotal) + Number(state.gmModifier ?? 0);
    const success = Number.isFinite(total) && total >= 4 && !state.criticalFailure && !state.naturalOneFailure;
    const directional = ['cone', 'scone', 'stream'].includes(state.shape);
    if (!success && (!state.deviationResolved || directional)) return null;
    const [owner, operator, item, target] = await Promise.all([
        fromUuid(state.weaponActorUuid), fromUuid(state.operatorActorUuid),
        fromUuid(state.itemUuid), fromUuid(payload.targetUuid),
    ]);
    if (!owner || !operator || !item || !target?.actor ||
        !['weapon', 'consumable', 'gear', 'power'].includes(item.type) ||
        (item.actor?.uuid ?? item.parent?.uuid) !== owner.uuid ||
        !owns(owner, requester) || !owns(operator, requester) ||
        // A claimed GM sender may trigger a legitimate existing attack, but
        // cannot turn a player-authored card into an unowned NPC/weapon attack.
        !owns(owner, author) || !owns(operator, author) ||
        String(target.parent?.id ?? (gameRef.scenes?.get ? '' : state.sceneId)) !== String(state.sceneId)) return null;
    return {message, state, requester, author, target, actor: target.actor, owner, operator, item};
};

const execute = async (action, payload, requesterId, runtime) => {
    const gameRef = runtime.gameRef ?? globalThis.game;
    if (!isPrimaryAoeGm(gameRef)) return pending('No elected GM is available.');
    if (!ACTIONS.has(action) || !handlers.has(action)) return denied('Unsupported AoE action.');
    const context = await validateAoeAuthorityContext(payload, requesterId, runtime);
    if (!context) return denied('This AoE target or attack is no longer eligible.');
    const key = `${action}:${payload.messageId}:${payload.targetUuid}`;
    if (inFlight.has(key)) return inFlight.get(key);
    // Different targets may be clicked by separate clients at the same time.
    // Serializing a card also prevents whole-map flag updates from losing a
    // previously resolved target, while identical requests share one promise.
    const previous = attackQueues.get(payload.messageId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(async () => {
        const latest = await validateAoeAuthorityContext(payload, requesterId, runtime);
        return latest ? handlers.get(action)(latest, runtime)
            : denied('This AoE target or attack is no longer eligible.');
    })
        .catch(error => { console.error('SWADE Tools AoE authority:', error); return pending('The GM could not resolve this AoE action.'); })
        .finally(() => {
            inFlight.delete(key);
            if (attackQueues.get(payload.messageId) === task) attackQueues.delete(payload.messageId);
        });
    inFlight.set(key, task);
    attackQueues.set(payload.messageId, task);
    return task;
};

export const registerAoeAuthority = (runtime = {}) => {
    const gameRef = runtime.gameRef ?? globalThis.game;
    if (!gameRef?.socket?.on || registrations.has(gameRef)) return;
    const pendingRequests = new Map();
    const listener = async (envelope, senderId) => {
        if (envelope?.protocol !== PROTOCOL || typeof envelope.id !== 'string' || envelope.id.length > 160) return;
        if (typeof senderId !== 'string' || !userOf(gameRef, senderId)) return;
        if (envelope.kind === 'response') {
            const entry = pendingRequests.get(envelope.id);
            if (!entry || envelope.to !== gameRef.user?.id || envelope.gmId !== entry.gmId ||
                senderId !== entry.gmId ||
                getPrimaryAoeGm(gameRef)?.id !== entry.gmId) return;
            pendingRequests.delete(envelope.id);
            clearTimeout(entry.timer);
            entry.resolve(envelope.result && typeof envelope.result.allowed === 'boolean'
                ? envelope.result : pending('Invalid GM response.'));
            return;
        }
        if (envelope.kind !== 'request' || envelope.gmId !== gameRef.user?.id || !isPrimaryAoeGm(gameRef)) return;
        const result = await execute(envelope.action, envelope.payload, senderId, runtime);
        gameRef.socket.emit(CHANNEL, {protocol: PROTOCOL, kind: 'response', id: envelope.id,
            gmId: gameRef.user.id, to: senderId, result}, {recipients: [senderId]});
    };
    gameRef.socket.on(CHANNEL, listener);
    registrations.set(gameRef, {pendingRequests, listener});
};

export const requestAoeAuthority = async (action, payload, runtime = {}) => {
    const gameRef = runtime.gameRef ?? globalThis.game;
    const gm = getPrimaryAoeGm(gameRef);
    if (!gm) return pending('An active GM is required to resolve Evade and fire.');
    if (!ACTIONS.has(action) || !handlers.has(action)) return denied('Unsupported AoE action.');
    if (gm.id === gameRef.user?.id) return execute(action, payload, gameRef.user.id, runtime);
    registerAoeAuthority(runtime);
    const registration = registrations.get(gameRef);
    if (!registration || !gameRef.socket?.emit) return pending('The GM connection is not available.');
    const id = `${gameRef.user.id}:${Date.now()}:${++nextRequest}`;
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            registration.pendingRequests.delete(id);
            resolve(pending('Waiting for the GM to resolve this AoE action.'));
        }, Math.max(10, Math.min(60000, Number(runtime.timeoutMs) || 30000)));
        registration.pendingRequests.set(id, {resolve, timer, gmId: gm.id});
        gameRef.socket.emit(CHANNEL, {protocol: PROTOCOL, kind: 'request', id, gmId: gm.id,
            requesterId: gameRef.user.id, action, payload}, {recipients: [gm.id]});
    });
};
