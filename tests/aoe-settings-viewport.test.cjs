const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../scripts/services/AoeItemConfig.js')).href);

const fixture = () => {
    const viewport = new EventTarget(), root = new EventTarget(), positions = [];
    Object.assign(root, {nodeType:1, isConnected:true, ownerDocument:{defaultView:viewport}});
    const dialog = new EventTarget();
    Object.assign(dialog, {element:root, setPosition:position => positions.push(position)});
    return {viewport, root, dialog, positions};
};

test('AoE settings refit once on opening, then on viewport resize and conditional field changes',async()=>{
    const {bindAoeSettingsViewport} = await load(), f = fixture();
    bindAoeSettingsViewport(f.dialog);bindAoeSettingsViewport(f.dialog);
    assert.deepEqual(f.positions,[{height:'auto'}],'repeat render must not duplicate bindings');
    f.viewport.dispatchEvent(new Event('resize'));f.root.dispatchEvent(new Event('change'));
    assert.deepEqual(f.positions,[{height:'auto'},{height:'auto'},{height:'auto'}]);
    f.root.isConnected=false;
    f.viewport.dispatchEvent(new Event('resize'));
    assert.equal(f.positions.length,3,'a disconnected dialog must not be repositioned');
    f.dialog.dispatchEvent(new Event('close'));
});

test('closing AoE settings removes resize and field listeners; other settings remain independent',async()=>{
    const {bindAoeSettingsViewport} = await load(), f = fixture();
    bindAoeSettingsViewport(f.dialog);
    f.dialog.dispatchEvent(new Event('close'));
    f.viewport.dispatchEvent(new Event('resize'));f.root.dispatchEvent(new Event('change'));
    assert.equal(f.positions.length,1);
    const another = fixture();
    bindAoeSettingsViewport(another.dialog);another.viewport.dispatchEvent(new Event('resize'));
    assert.equal(another.positions.length,2);assert.equal(f.positions.length,1);
    another.dialog.dispatchEvent(new Event('close'));
});

test('AoE viewport layout is opt-in, with a shrinking scrollable body and a non-scrolling footer',()=>{
    const css = fs.readFileSync(path.resolve(__dirname,'../css/swadetools.css'),'utf8');
    assert.match(css,/\.application\.swadetools-aoe-settings-dialog\s*\{[^}]*max-height:\s*min\(800px, calc\(100dvh - 32px\)\)/);
    assert.match(css,/\.swadetools-aoe-settings-dialog \.dialog-content\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;/);
    assert.match(css,/\.swadetools-aoe-settings-dialog \.dialog-form\s*\{[^}]*min-height:\s*0;/);
    assert.match(css,/\.swadetools-aoe-settings-dialog \.dialog-form > \.form-footer\s*\{[^}]*flex:\s*0 0 auto;/);
    const source = fs.readFileSync(path.resolve(__dirname,'../scripts/services/AoeItemConfig.js'),'utf8');
    assert.equal((source.match(/classes: \['dialog', 'swadetools-aoe-settings-dialog'\]/g)??[]).length,2,
        'both power and weapon settings need their own layout class');
});

test('replacing the rendered dialog root removes old bindings and fits the new form exactly once',async()=>{
    const {bindAoeSettingsViewport} = await load(), f = fixture(), next = fixture();
    bindAoeSettingsViewport(f.dialog);
    next.root.ownerDocument = f.root.ownerDocument;
    f.dialog.element = next.root;
    bindAoeSettingsViewport(f.dialog);
    assert.equal(f.positions.length,2);
    f.root.dispatchEvent(new Event('change'));assert.equal(f.positions.length,2);
    next.root.dispatchEvent(new Event('change'));f.viewport.dispatchEvent(new Event('resize'));
    assert.equal(f.positions.length,4);
    f.dialog.dispatchEvent(new Event('close'));
    next.root.dispatchEvent(new Event('change'));f.viewport.dispatchEvent(new Event('resize'));
    assert.equal(f.positions.length,4);
});
