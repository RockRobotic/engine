import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { translateLcc2ToOctreeData } from '../../../src/framework/parsers/lcc2.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
    readFileSync(resolve(here, '../../fixtures/lcc2/tiny.lcc2.json'), 'utf8')
);

test('translateLcc2ToOctreeData: hierarchyMode is always "tree"', () => {
    const out = translateLcc2ToOctreeData(fixture);
    assert.equal(out.hierarchyMode, 'tree');
});

test('translateLcc2ToOctreeData: filenames come from root.splatFiles verbatim', () => {
    const out = translateLcc2ToOctreeData(fixture);
    assert.deepEqual(out.filenames, [
        'data/3dgs/depth1a.sog',
        'data/3dgs/depth1b.sog',
        'data/3dgs/leaf.sog'
    ]);
});

test('translateLcc2ToOctreeData: root has null lod and two children', () => {
    const out = translateLcc2ToOctreeData(fixture);
    assert.equal(out.tree.lod, null);
    assert.equal(out.tree.depth, 0);
    assert.equal(out.tree.children.length, 2);
    assert.deepEqual(out.tree.bound.min, [0, 0, 0]);
    assert.deepEqual(out.tree.bound.max, [10, 10, 10]);
});

test('translateLcc2ToOctreeData: every non-root node has lod derived from data.3dgs', () => {
    const out = translateLcc2ToOctreeData(fixture);
    const first = out.tree.children[0];        // "0_0"
    assert.equal(first.depth, 1);
    assert.deepEqual(first.lod, { file: 0, offset: 0, count: 50 });
    const leafOfFirst = first.children[0];     // "0_0_0"
    assert.equal(leafOfFirst.depth, 2);
    assert.deepEqual(leafOfFirst.lod, { file: 2, offset: 0, count: 200 });
    const second = out.tree.children[1];       // "0_1"
    assert.equal(second.depth, 1);
    assert.equal(second.children.length, 0);
    assert.deepEqual(second.lod, { file: 1, offset: 0, count: 50 });
});

test('translateLcc2ToOctreeData: totalLevels + metadata propagated', () => {
    const out = translateLcc2ToOctreeData(fixture);
    assert.equal(out.totalLevels, 2);
    assert.deepEqual(out.metadata.lodSplats, [300, 100]);
    assert.equal(out.metadata.virtualLoD, null);
});

test('translateLcc2ToOctreeData: environment resolved when env.name present', () => {
    const withEnv = structuredClone(fixture);
    withEnv.root.splatFiles.push('data/3dgs/env.sog');
    withEnv.root.data.env = { name: 3 };
    const out = translateLcc2ToOctreeData(withEnv);
    assert.equal(out.environment, 'data/3dgs/env.sog');
});

test('translateLcc2ToOctreeData: environment undefined when env.name absent', () => {
    const out = translateLcc2ToOctreeData(fixture);
    assert.equal(out.environment, undefined);
});

test('translateLcc2ToOctreeData: rejects unsupported major version', () => {
    const wrongMajor = structuredClone(fixture);
    wrongMajor.version = '1.0.0';
    assert.throws(
        () => translateLcc2ToOctreeData(wrongMajor),
        /unsupported LCC2 version/i
    );
});
