const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const api = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeResultSummary.js')).href);
const target = {name: 'Victim <one>', uuid: 'Scene.scene.Token.one'};
const key = 'Scene%2Escene%2EToken%2Eone';

test('one target summary shows defense, automatic ignition and independent fire damage compactly', async () => {
    const {renderAoeTargetSummary} = await api;
    const html = renderAoeTargetSummary(target, {evadeResults: {[key]: {total: 2, evaded: false}},
        fireResults: {[key]: {check: 6, threshold: 6, status: 'burning', damageTotal: 12, initialIntensity: 3}}});
    assert.match(html, /Evade: 2 — Hit/);
    assert.match(html, /Fire: 6\/6 — On Fire · Damage 12 \(3d6\)/);
    assert.doesNotMatch(html, /<button|<h[1-6]|<table/);
});

test('Evaded, no ignition and not flammable are distinct and absent outcomes add no empty text', async () => {
    const {renderAoeTargetSummary} = await api;
    assert.equal(renderAoeTargetSummary(target, {}), '');
    assert.match(renderAoeTargetSummary(target, {evadeResults: {[key]: {evaded: true, total: 4}}}), /Evade: 4 — Evaded/);
    assert.match(renderAoeTargetSummary(target, {fireResults: {[key]: {status: 'not-ignited', check: 2, threshold: 6}}}), /Fire: 2\/6 — No ignition/);
    assert.match(renderAoeTargetSummary(target, {fireResults: {[key]: {status: 'nonflammable'}}}), /Fire: Not flammable/);
});

test('all AoE controls and audit dice stay inside one closed Details disclosure', async () => {
    const {renderAoeResolutionDetails} = await api;
    const html = renderAoeResolutionDetails([target], {evadeResults: {[key]: {evaded: false, rollHtml: '<div>Evade dice</div>'}},
        fireResults: {[key]: {status: 'burning', effectUuid: 'Actor.victim.ActiveEffect.fire', actorUuid: 'Actor.victim',
            rollHtml: '<div>Fire dice</div>', damageTotal: 11}}});
    assert.equal((html.match(/<details/g) ?? []).length, 1);
    assert.doesNotMatch(html, /<details[^>]*\sopen/);
    assert.match(html, /Victim &lt;one&gt;/);
    assert.match(html, /data-aoe-evade-target="Scene.scene.Token.one"/);
    assert.match(html, /data-aoe-fire-effect="Actor.victim.ActiveEffect.fire"/);
    assert.match(html, /data-aoe-fire-actor="Actor.victim"/);
    assert.match(html, /data-aoe-evade-gm hidden/);
    assert.match(html, /Fire damage: armor applies/);
    assert.doesNotMatch(html, /Fire Check<\/button>|Flammability<\/button>/);
});

test('summary reads already-expanded legacy results and escapes names and attributes', async () => {
    const {renderAoeResolutionDetails, renderAoeTargetSummary} = await api;
    const state = {evadeResults: {Scene: {scene: {Token: {one: {pending: true}}}}}};
    assert.match(renderAoeTargetSummary(target, state), /GM decision needed/);
    const bad = {name: '<img onerror=alert(1)>', uuid: 'Scene.scene.Token.one'};
    assert.doesNotMatch(renderAoeResolutionDetails([bad], state), /<img onerror/);
    assert.match(renderAoeResolutionDetails([bad], state), /&lt;img/);
});

test('extinguished results do not retain actionable On Fire controls', async () => {
    const {renderAoeResolutionDetails, renderAoeTargetSummary} = await api;
    const state = {fireResults: {[key]: {status: 'extinguished', effectUuid: 'Actor.victim.ActiveEffect.fire'}}};
    assert.match(renderAoeTargetSummary(target, state), /Extinguished/);
    assert.doesNotMatch(renderAoeResolutionDetails([target], state), /data-aoe-fire-extinguish/);
});
