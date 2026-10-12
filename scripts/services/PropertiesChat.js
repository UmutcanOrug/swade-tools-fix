import {applyRegisteredPropertyCandidate, isPrimaryPropertiesGm, undoPropertyCandidate} from './PropertiesEffects.js';

const registrations = new WeakSet();
export const registerPropertiesChatControls = (runtime = {}) => {
    const document = runtime.documentRef ?? globalThis.document;
    const hooks = runtime.hooks ?? globalThis.Hooks;
    // Modules can register before game exists; resolve the current viewer
    // when a card is rendered or a control is clicked.
    const gameOf = () => runtime.gameRef ?? runtime.game ?? globalThis.game;
    if (!document?.addEventListener || !hooks?.on || registrations.has(document)) return;
    registrations.add(document);
    hooks.on('renderChatMessageHTML', (message, html) => {
        const root = html?.[0] ?? html;
        root?.querySelectorAll?.('[data-properties-gm]').forEach(control => {
            // Persisted Foundry HTML sanitization can strip hidden. Reapply
            // authorization per viewer; click handlers enforce it again.
            control.hidden = message.isContentVisible === false || !isPrimaryPropertiesGm(gameOf());
        });
    });
    document.addEventListener('click', async event => {
        const game = gameOf();
        const control = event.target?.closest?.('[data-properties-apply],[data-properties-undo]');
        if (!control || !isPrimaryPropertiesGm(game)) return;
        event.preventDefault();
        const messageId = control.closest('[data-message-id]')?.dataset.messageId;
        const message = game.messages?.get?.(messageId);
        if (!message || message.isContentVisible === false) return;
        control.disabled = true;
        try {
            const result = control.dataset.propertiesApply ? await applyRegisteredPropertyCandidate(message,
                control.dataset.propertiesApply, runtime) : await undoPropertyCandidate(message, control.dataset.propertiesUndo, runtime);
            if (!result || result.status === 'stale') (runtime.notifications ?? globalThis.ui?.notifications)?.warn(
                'Effects require the original scene and a current eligible attack result.');
        } catch (error) {(runtime.notifications ?? globalThis.ui?.notifications)?.error(String(error?.message ?? error));}
        finally {control.disabled = false;}
    });
};
