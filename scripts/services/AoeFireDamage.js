const SCOPE = 'swade-tools';
const TOKEN_UUID = /^Scene\.([^.]+)\.Token\.([^.]+)$/;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g,
    char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));

const bindingOf = message => {
    const binding = message?.flags?.[SCOPE]?.aoeFireDamage;
    const match = TOKEN_UUID.exec(String(binding?.targetUuid ?? ''));
    if (binding?.version !== 1 || !match || !binding.actorUuid ||
        binding.sceneId !== match[1] || binding.targetId !== match[2]) return null;
    return binding;
};

// Unlike ordinary weapon cards, environmental fire must never inherit the
// current user's targets or resolve a same-ID token from a different scene.
export const getAoeFireDamageTarget = (message, runtime = {}) => {
    const binding = bindingOf(message);
    const game = runtime.gameRef ?? globalThis.game;
    const canvas = runtime.canvasRef ?? globalThis.canvas;
    if (!binding || canvas?.scene?.id !== binding.sceneId) return null;
    const document = game?.scenes?.get(binding.sceneId)?.tokens?.get(binding.targetId);
    const token = canvas?.tokens?.get(binding.targetId);
    if (!document?.actor || document.uuid !== binding.targetUuid ||
        document.actor.uuid !== binding.actorUuid || token?.document?.uuid !== binding.targetUuid ||
        token.actor?.uuid !== binding.actorUuid) return null;
    return token;
};

export const createAoeFireDamageCard = async ({actor, targetUuid, damage, flavor = '', content = '',
    privacy = {}, fireFlags = {}}, runtime = {}) => {
    const match = TOKEN_UUID.exec(String(targetUuid ?? ''));
    const game = runtime.gameRef ?? globalThis.game;
    const ChatMessage = runtime.ChatMessageClass ?? globalThis.ChatMessage;
    const SwadeRoll = runtime.SwadeRollClass ?? globalThis.CONFIG?.Dice?.SwadeRoll;
    if (!match || !actor?.uuid || !damage || damage._evaluated === false ||
        !Number.isFinite(damage.total) || !ChatMessage?.create)
        throw new Error('The already-rolled fire damage or its original target is unavailable.');

    // SWADE's official fromRoll retains the evaluated terms and total. Do not
    // call evaluate, rollDamage, an ItemRoll, or an item/resource API here.
    const swadeRenderer = typeof SwadeRoll?.fromRoll === 'function';
    const messageRoll = swadeRenderer ? SwadeRoll.fromRoll(damage) : damage;
    messageRoll.options = {...(messageRoll.options ?? {}), rollType: 'damage', rerollable: false};
    let body = String(content);
    if (!swadeRenderer) {
        // Core Foundry skips automatic dice rendering when content contains
        // HTML. SWADE, conversely, always renders SwadeRoll dice itself.
        let dice = '';
        try { dice = typeof messageRoll.render === 'function' ? await messageRoll.render() : ''; }
        catch { /* The evaluated roll and apply controls remain usable. */ }
        if (!dice) dice = `<div class="dice-roll"><div class="dice-formula">${escapeHTML(messageRoll.formula)}</div><div class="dice-total">${messageRoll.total}</div></div>`;
        body = dice + body;
    }
    const whisper = Array.from(privacy?.whisper ?? [], user => typeof user === 'string' ? user : user?.id)
        .filter(id => typeof id === 'string');
    return ChatMessage.create({user: game?.user?.id,
        speaker: ChatMessage.getSpeaker?.({actor}) ?? {actor: actor.id, alias: actor.name},
        flavor: String(flavor), content: body, rolls: [messageRoll], whisper, blind: privacy?.blind === true,
        flags: {[SCOPE]: {rolltype: 'damage', userof: 1, useactor: actor.id,
            aoeFire: {...fireFlags}, aoeFireDamage: {version: 1, actorUuid: actor.uuid,
                targetUuid: String(targetUuid), sceneId: match[1], targetId: match[2]}}}});
};
