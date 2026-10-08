const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const walk = directory => fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => entry.isDirectory()
        ? walk(path.join(directory, entry.name))
        : [path.join(directory, entry.name)]);
const scripts = walk(path.join(root, 'scripts')).filter(file => file.endsWith('.js'));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

test('Foundry manifest points to existing files and the versioned release', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'module.json'), 'utf8'));
    assert.equal(manifest.id, 'swade-tools');
    assert.equal(manifest.compatibility.minimum, '13');
    assert.equal(manifest.compatibility.verified, '13');
    assert.match(manifest.download, new RegExp(`/v${manifest.version}/swade-tools-${manifest.version}\\.zip$`));
    assert.match(manifest.manifest, /\/releases\/latest\/download\/module\.json$/);
    const files = [...manifest.esmodules, ...manifest.styles,
        ...manifest.languages.map(language => language.path),
        ...manifest.packs.map(pack => pack.path)];
    for (const file of files) assert.ok(fs.existsSync(path.join(root, file)), file);
    for (const language of manifest.languages) {
        assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(root, language.path), 'utf8')), language.path);
    }
});

test('every bundled script parses and every relative import resolves', () => {
    const macros = new Set(['grenade-attack.js', 'rof-attack-pool.js']);
    for (const file of scripts) {
        const source = fs.readFileSync(file, 'utf8');
        if (macros.has(path.basename(file))) {
            assert.doesNotThrow(() => new AsyncFunction('scope', source), file);
        } else {
            const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
            assert.equal(result.status, 0, `${file}\n${result.stderr}`);
        }
        for (const [, reference] of source.matchAll(/(?:from\s*|import\s*)['"](\.\.?\/[^'"]+)['"]/g)) {
            assert.ok(fs.existsSync(path.resolve(path.dirname(file), reference)), `${file}: ${reference}`);
        }
    }
});

test('release workflow runs tests and uses the current manifest version', () => {
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    assert.match(workflow, /node --test tests\/\*\.test\.cjs/);
    assert.match(workflow, /test "\$version" = "\$manifest_version"/);
    assert.match(workflow, /git archive HEAD/);
    assert.match(workflow, /gh release create/);
    assert.ok(fs.existsSync(path.join(root, 'RELEASE-NOTES.md')));
});
