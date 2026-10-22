const assert = require('node:assert/strict');
const {test} = require('node:test');
const {runAttack} = require('./aoe-attack.test.cjs');
const target = (id, x, y) => ({id, name:id, isVisible:true, x, y, w:50, h:50,
    center:{x:x+25,y:y+25}, actor:{name:id}, document:{id,uuid:`Scene.scene.Token.${id}`}});
const customFlags = customShape => ({aoeTemplateShape:'custom', aoeCustomShape:customShape});
const custom = (type, extra={}) => ({type,distance:6,width:2,angle:60,...extra});
const preview = async () => ({x:1000,y:50,direction:0});
const reroll = async s => {
    const card=s.cards.at(-1);
    await s.platform.__swadeGrenadeBennyRuntime.handlers.get(card.flags.world.grenadeBennySession)('actor',card.id);
};

test('custom circle uses its own scaled radius for cursor, persistent area, targets, state and animation',async()=>{
    let cursor,animation;
    const shape=custom('circle',{distance:3.5});
    const s=await runAttack({flags:customFlags(shape),targetTokens:[target('inside',400,100),target('outside',800,100)],
        serviceOverrides:{async playAoeAnimation(context){animation=context;return {}; }},
        configureRuntime(runtime){runtime.canvas.scene.grid.distance=5;
            runtime.Sequencer.Crosshair.show=async config=>{cursor=config;return {x:100,y:100};};}});
    const area=s.scene.templates.get('template'),state=s.cards[0].flags.world.aoeAttack;
    assert.equal(cursor.distance,17.5);assert.equal(area.distance,17.5);assert.equal(area.t,'circle');
    assert.equal(area.x,100);assert.equal(area.y,100);
    assert.deepEqual(state.customShape,shape);assert.equal(state.geometry.distance,17.5);
    assert.deepEqual(state.targets.map(row=>row.id),['inside']);
    assert.deepEqual(s.nativeCards.map(card=>card.targets),['inside']);
    assert.equal(animation.blastDiameter,7);assert.equal(s.weapon.system.currentShots,3);
    assert.match(s.cards[0].content,/Custom Circle/);
});

test('custom cone, line and rectangle preserve dimensions and reject blast deviation on failure',async()=>{
    for(const type of ['cone','ray','rect']){
        const shape=custom(type),s=await runAttack({flags:customFlags(shape),dice:[2,3,6,4],range:'Template',
            targetTokens:[target('inside',400,20),target('outside',400,400)],
            serviceOverrides:{placeWeaponAoeTemplatePoint:preview}});
        const area=s.scene.templates.get('template');
        assert.equal(area.t,type==='cone'?'cone':'ray');assert.equal(area.distance,6);
        assert.equal(area.angle,type==='cone'?60:undefined);assert.equal(area.width,type==='cone'?undefined:2);
        assert.equal(area.flags['swade-tools'].customShapeType,type);
        assert.equal(area.flags.world.pendingDeviation,false);assert.equal(s.nativeCards.length,0);
        assert.match(s.cards[0].content,/No Effect/);
        assert.doesNotMatch(s.cards[0].content,/data-aoe-resolve-deviation/);
        s.weapon.flags['swade-tools'].aoeCustomShape=custom('circle',{distance:50});
        await reroll(s);
        const state=s.cards.at(-1).flags.world.aoeAttack;
        assert.deepEqual(state.customShape,shape,'Benny must keep the original attack configuration');
        assert.equal(state.geometry.distance,6);assert.equal(state.geometry.t,type==='cone'?'cone':'ray');
        assert.deepEqual(s.nativeCards.map(card=>card.targets),['inside']);
        assert.equal(s.events.filter(event=>event==='ammo').length,1);
        assert.equal(s.events.filter(event=>event==='template').length,1);
    }
});

test('free custom rectangle keeps the selected origin and rotation, and cancellation spends nothing',async()=>{
    const shape=custom('rect',{distance:4,width:1.5});
    const s=await runAttack({flags:{...customFlags(shape),aoeTemplateOrigin:'free'},
        targetTokens:[target('inside',180,500),target('outside',600,200)],
        serviceOverrides:{async placeWeaponAoeTemplatePoint(input){
            assert.deepEqual(input.customShape,shape);assert.equal(input.origin,'free');
            return {x:200,y:200,direction:90};}}});
    const area=s.scene.templates.get('template');
    assert.equal(area.x,200);assert.equal(area.y,200);assert.equal(area.direction,90);
    assert.equal(area.distance,4);assert.equal(area.width,1.5);
    assert.deepEqual(s.nativeCards.map(card=>card.targets),['inside']);
    const canceled=await runAttack({flags:customFlags(shape),
        serviceOverrides:{placeWeaponAoeTemplatePoint:async()=>null}});
    assert.equal(canceled.cards.length,0);assert.equal(canceled.scene.templates.size,0);
    assert.equal(canceled.weapon.system.currentShots,4);
});

test('changing custom dimensions during placement aborts before ammunition, dice or chat',async()=>{
    const s=await runAttack({flags:customFlags(custom('circle')),
        configureRuntime(runtime){runtime.Sequencer.Crosshair.show=async()=>{
            runtime.scope.item.flags['swade-tools'].aoeCustomShape.distance=12;return {x:100,y:100};};}});
    assert.equal(s.cards.length,0);assert.equal(s.scene.templates.size,0);assert.equal(s.weapon.system.currentShots,4);
    assert.equal(s.events.includes('ammo'),false);assert.equal(s.queue.length,2);
    assert.ok(s.notices.some(notice=>/settings changed during placement/.test(notice.text)));
});

test('custom circle failure can be moved by GM once, retaining radius and rolling only the new blast targets',async()=>{
    const s=await runAttack({flags:customFlags(custom('circle',{distance:1})),dice:[2,3],
        targetTokens:[target('original',80,80),target('deviated',580,80)],
        configureRuntime(runtime){runtime.game.users=new Map([['gm',runtime.game.user]]);}});
    const area=s.scene.templates.get('template');
    assert.equal(area.flags.world.pendingDeviation,true);assert.equal(s.nativeCards.length,0);
    area.x=600;area.y=100;
    await s.emitHook('updateMeasuredTemplate',area,{x:600,y:100},{},'gm');
    await s.emitHook('updateMeasuredTemplate',area,{x:600,y:100},{},'gm');
    assert.equal(area.distance,1);assert.deepEqual(s.nativeCards.map(card=>card.targets),['deviated']);
    assert.equal(s.events.filter(event=>event==='ammo').length,1);
});
