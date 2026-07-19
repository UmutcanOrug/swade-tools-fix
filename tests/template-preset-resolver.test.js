import assert from 'node:assert/strict';
import test from 'node:test';

import {
    toSwadeTemplatePreset
} from '../scripts/services/TemplatePresetResolver.js';

test('maps module template names to SWADE 5.1 preset identifiers',()=>{
    assert.equal(toSwadeTemplatePreset('small'),'sbt');
    assert.equal(toSwadeTemplatePreset('medium'),'mbt');
    assert.equal(toSwadeTemplatePreset('large'),'lbt');
    assert.equal(toSwadeTemplatePreset('cone'),'swcone');
    assert.equal(toSwadeTemplatePreset('stream'),'stream');
});
