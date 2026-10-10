const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');

// Reuse the full macro fixture without registering the separate mechanics tests.
// This executes the production chat renderer after real pool review/assignment,
// rather than testing a copy of the card's HTML.
const fixtureSource = fs.readFileSync(path.join(__dirname, 'rof-inline-setup.test.cjs'), 'utf8')
    .split('// Exercise the actual native geometry functions')[0];
const runPool = Function('require', '__dirname', `${fixtureSource}\nreturn runPool;`)(require, __dirname);
const collapsedContent = content => content.replace(/<details\b[^>]*>[\s\S]*?<\/details>/gi, '');
const detailsContent = content => content.match(/<details\b[^>]*>([\s\S]*?)<\/details>/i)?.[1] ?? '';
module.exports = {runPool};

if (require.main === module) {
    test('RoF chat uses a small native-style weapon header, one dice strip and one totals block', async () => {
        const result = await runPool({weaponRof: 3, setup: {rof: 3}, dice: [9, 7, 4, 2]});
        const content = result.cards[0].content;
        const visible = collapsedContent(content);
        assert.match(visible, /class="swadetools-rof-card"[^>]*max-width:320px/);
        assert.match(visible, /width="32" height="32"/);
        assert.match(visible, /font-size:15px;line-height:18px[^>]*>Rifle/);
        assert.match(visible, /Shooting &middot; RoF 3/);
        assert.doesNotMatch(content, /<h[123]\b/i);
        assert.equal((visible.match(/class="swadetools-rof-pool-die"/g) ?? []).length, 3);
        assert.equal((visible.match(/class="dice-total"/g) ?? []).length, 1);
        assert.match(visible, /title="Usable attack totals">9 · 7 · 4/);
        assert.doesNotMatch(visible, /<table\b|<th\b|Discarded|Usable<\/td>/i);
        assert.match(visible, /flex-wrap:wrap/);
    });

    test('bookkeeping, discarded results and full arithmetic are preserved only in closed Details', async () => {
        const result = await runPool({setup: {otherModifierFormula: '2', damageModifier: '+3', theDrop: true}});
        const content = result.cards[0].content;
        const visible = collapsedContent(content), details = detailsContent(content);
        assert.equal((content.match(/<details\b/g) ?? []).length, 1);
        assert.doesNotMatch(content, /<details\b[^>]*\bopen\b/i);
        for (const label of ['Ammo spent', 'Base common modifier', 'Benny rerolls', 'Minimum Strength',
            'Damage modifier', 'Wounds', 'Fatigue', 'Called Shot']) {
            assert.ok(details.includes(label), `${label} must remain inspectable`);
            assert.ok(!visible.includes(label), `${label} must not fill the collapsed chat card`);
        }
        assert.match(details, /<th>Die<\/th><th>Raw<\/th><th>Mod<\/th><th>Total<\/th><th>Pool<\/th>/);
        assert.match(details, /Discarded/);
        assert.match(details, /The Drop \+4/);
        assert.match(details, /\+3/);
        assert.match(visible, /Mod \+6/);
        assert.deepEqual(result.events.filter(event => event.startsWith('ammo:')), ['ammo:5']);
    });

    test('Benny history stays available without adding visible history tables or consuming extra ammunition', async () => {
        const result = await runPool({reviewActions: ['actor-benny', 'continue'], dice: [9, 7, 4, 10, 8, 3]});
        const content = result.cards[0].content;
        const visible = collapsedContent(content), details = detailsContent(content);
        assert.match(details, /Benny Reroll History/);
        assert.match(details, /Initial roll/);
        assert.match(details, /Benny reroll/);
        assert.match(details, /Final pool/);
        assert.doesNotMatch(visible, /Benny Reroll History|Initial roll|Final pool|<table\b/);
        assert.equal(result.cards[0].rolls.length, 6);
        assert.equal(result.events.filter(event => event === 'benny').length, 1);
        assert.deepEqual(result.events.filter(event => event.startsWith('ammo:')), ['ammo:5']);
    });

    test('assigned target rows are compact, color-coded and preserve detailed target math in Details', async () => {
        for (const [outcome, label, color] of [['miss', 'Miss', '#777777'], ['hit', 'Hit', '#008000'],
            ['raise', 'Raise', '#800080']]) {
            const result = await runPool({assignedOutcome: outcome, targetCover: -2});
            const visible = collapsedContent(result.cards[0].content);
            const rows = visible.match(/<div class="swadetools-rof-target"[\s\S]*?<\/div>/g) ?? [];
            assert.equal(rows.length, 2);
            assert.ok(rows.every(row => row.includes(`Target: ${label}`)));
            assert.ok(rows.every(row => row.includes(`color:${color}`)));
            assert.ok(rows.every(row => !row.includes('<br>')));
            assert.match(detailsContent(result.cards[0].content), /Target Resolution/);
            assert.match(detailsContent(result.cards[0].content), /Detected:/);
            assert.doesNotMatch(visible, /Detected:|Not stacked:|Target Resolution/);
        }
    });

    test('compact target display does not change native damage calls, per-target flags or assignments', async () => {
        const result = await runPool({assignedOutcome: 'raise', targetCount: 2});
        assert.equal(result.assignments.length, 2);
        assert.equal(result.nativeCalls.length, 2);
        assert.equal(result.nativeMessages.length, 2);
        assert.ok(result.nativeMessages.every(message => message.raise === undefined || message.raise === true));
        assert.deepEqual(result.nativeMessages.map(message => message.target), ['target', 'target-1']);
        assert.ok(result.nativeCalls.every(call => call.owner === result.actor && call.id === result.weapon.id));
        assert.ok(result.nativeCalls.every(call => call.options.damageOnly === true));
    });

    test('AoE pool summary is compact while projectile count and one-time resource accounting remain unchanged', async () => {
        const result = await runPool({aoe: true, noTargets: true});
        const visible = collapsedContent(result.cards[0].content);
        assert.match(visible, /RoF 2 &middot; AoE/);
        assert.match(visible, /AoE projectiles resolve below\./);
        assert.doesNotMatch(visible, /<table\b|Ammo spent|Base common modifier/);
        assert.equal(result.aoeCalls.length, 2);
        assert.deepEqual(result.events.filter(event => event.startsWith('ammo:')), ['ammo:5']);
    });

    test('maximum-size pools remain bounded and item names plus image attributes are escaped', async () => {
        const result = await runPool({weaponRof: 6, setup: {rof: 6}, dice: [12, 11, 10, 9, 8, 7, 3],
            mutate({weapon}) { weapon.name = 'Long Cannon <script>alert("test")</script>';
                weapon.img = 'icons/test.svg" onerror="bad'; }});
        const visible = collapsedContent(result.cards[0].content);
        assert.equal((visible.match(/class="swadetools-rof-pool-die"/g) ?? []).length, 6);
        assert.equal((visible.match(/class="dice-total"/g) ?? []).length, 1);
        assert.match(visible, /max-width:320px/);
        assert.match(visible, /overflow-wrap:anywhere/);
        assert.match(visible, /Long Cannon &lt;script&gt;alert\(&quot;test&quot;\)&lt;\/script&gt;/);
        assert.match(visible, /src="icons\/test.svg&quot; onerror=&quot;bad"/);
        assert.doesNotMatch(visible, /<script\b| onerror="bad/);
    });
}
