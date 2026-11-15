const assert = require('node:assert/strict');
const {test} = require('node:test');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {runAttack} = require('./aoe-attack.test.cjs');
const chatApi = import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeChatControl.js')).href);

const picture = ({dx = 0, dy = 0, wildcard = false} = {}) => {
    const token = (id, x, y) => {
        const actor = {name:id, isWildcard:wildcard, system:{wildcard}};
        const value = {id, name:id, actor, isVisible:true, x:x+dx, y:y+dy, w:100, h:100,
            center:{x:x+dx+50, y:y+dy+50},
            document:{id, uuid:`Scene.scene.Token.${id}`, actor, x:x+dx, y:y+dy, width:1, height:1}};
        value.document.object = value;
        return value;
    };
    // User screenshot: circle center (200,300), radius 2 squares. The upper
    // row only touches its top point; the lower row has genuine area overlap.
    return [token('outside-left',100,0), token('outside-right',200,0),
        token('partial-left',100,100), token('partial-right',200,100)];
};
const expectedIds = ['partial-left','partial-right'];
const flags = custom => ({aoeAutoEvade:true, aoeFireEnabled:true,
    ...(custom ? {aoeTemplateShape:'custom', aoeCustomShape:{type:'circle',distance:2,width:1,angle:90}} : {})});

const attack = async ({custom = false, sceneDistance = 1, wildcard = false,
    dx = 0, dy = 0, dice = [6,4], onRuntime} = {}) => {
    const defense = [], fire = [];
    let native;
    const s = await runAttack({name:'Boundary Test Grenade', range:'100/200/400',
        flags:flags(custom), dice, targetTokens:picture({dx,dy,wildcard}),
        serviceOverrides:{
            async resolveAoeEvade(_message, uuid) {defense.push(uuid);return {allowed:true,evaded:false};},
            async recordAoeFireHit(_message, uuid) {fire.push(uuid);return {ignited:false};}
        },
        configureRuntime(runtime) {
            native = runtime;
            runtime.canvas.scene.id = 'scene';runtime.canvas.scene.grid.distance = sceneDistance;
            runtime.game.users = new Map([['gm',runtime.game.user]]);
            runtime.Sequencer.Crosshair.show = async () => ({x:200+dx,y:300+dy});
            onRuntime?.(runtime);
        }});
    return {...s, native, defense, fire};
};
const ids = s => s.cards.at(-1).flags.world.aoeAttack.targets.map(target=>target.id);
const uuidIds = entries => entries.map(uuid=>uuid.split('.').at(-1));

test('the four-token screenshot includes only actual overlap for grenade and custom circles, Extras and Wild Cards',async()=>{
    for (const custom of [false,true]) for (const sceneDistance of [1,5]) for (const wildcard of [false,true]) {
        const s = await attack({custom,sceneDistance,wildcard,dx:700,dy:400});
        assert.deepEqual(ids(s),expectedIds);
        assert.deepEqual(s.nativeCards.map(card=>card.targets),expectedIds);
        assert.deepEqual(uuidIds(s.defense),expectedIds);assert.deepEqual(uuidIds(s.fire),expectedIds);
        assert.doesNotMatch(s.cards[0].content,/outside-left|outside-right/);
        assert.equal(s.scene.templates.get('template').distance,2*sceneDistance);
        assert.equal(s.weapon.system.currentShots,3);
    }
});

test('a missed circular attack does not list edge-only outsiders or roll damage, Evade or ignition',async()=>{
    for (const custom of [false,true]) {
        const s = await attack({custom,dice:[2,3]});
        assert.deepEqual(ids(s),expectedIds);
        assert.equal(s.cards[0].flags.world.aoeAttack.success,false);
        assert.equal(s.nativeCards.length,0);assert.deepEqual(s.defense,[]);assert.deepEqual(s.fire,[]);
        assert.doesNotMatch(s.cards[0].content,/outside-left|outside-right/);
    }
});

test('GM correction recomputes the exact circle boundary and refuses outside damage rows',async()=>{
    const api = await chatApi;
    for (const custom of [false,true]) {
        const s = await attack({custom,sceneDistance:5,dice:[2,3]});
        const message = s.cards[0], runtime = {gameRef:s.native.game,canvasRef:s.native.canvas,
            notifications:s.native.ui.notifications};
        assert.equal(await api.applyAoeGmModifier(message,4,runtime),true);
        assert.deepEqual(ids(s),expectedIds);
        assert.equal(message.flags.world.aoeAttack.success,true);
        assert.equal(s.nativeCards.length,0,'GM correction alone must not roll damage');
        for (const id of ['outside-left','outside-right']) {
            assert.equal(await api.rollAoeChatTargetDamage(message,`Scene.scene.Token.${id}`,runtime),false);
        }
        assert.deepEqual(s.defense,[]);assert.deepEqual(s.fire,[]);
        assert.equal(s.weapon.system.currentShots,3);
    }
});

test('Benny success retains the circle boundary without new placement, ammunition or outside defense/fire calls',async()=>{
    for (const custom of [false,true]) {
        const s = await attack({custom,dice:[2,3,6,4]});
        const before = s.cards[0];
        await s.platform.__swadeGrenadeBennyRuntime.handlers.get(before.flags.world.grenadeBennySession)('actor',before.id);
        assert.deepEqual(ids(s),expectedIds);
        assert.deepEqual(s.nativeCards.map(card=>card.targets),expectedIds);
        assert.deepEqual(uuidIds(s.defense),expectedIds);assert.deepEqual(uuidIds(s.fire),expectedIds);
        assert.doesNotMatch(s.cards.at(-1).content,/outside-left|outside-right/);
        assert.equal(s.events.filter(event=>event==='ammo').length,1);
        assert.equal(s.events.filter(event=>event==='template').length,1);
    }
});

test('GM deviation at a translated point excludes edge-only outsiders and damages each actual overlap once',async()=>{
    for (const custom of [false,true]) {
        const s = await attack({custom,dice:[2,3],dx:600,dy:400,
            onRuntime(runtime){runtime.Sequencer.Crosshair.show=async()=>({x:100,y:100});}});
        assert.equal(s.nativeCards.length,0);
        const area=s.scene.templates.get('template');area.x=800;area.y=700;
        await s.emitHook('updateMeasuredTemplate',area,{x:800,y:700},{},'gm');
        await s.emitHook('updateMeasuredTemplate',area,{x:800,y:700},{},'gm');
        assert.deepEqual(ids(s),expectedIds);
        assert.deepEqual(s.nativeCards.map(card=>card.targets),expectedIds);
        assert.deepEqual(uuidIds(s.defense),expectedIds);assert.deepEqual(uuidIds(s.fire),expectedIds);
        assert.equal(s.events.filter(event=>event==='ammo').length,1);
    }
});
