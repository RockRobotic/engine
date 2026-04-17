import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GSplatOctreeNode } from '../../../src/scene/gsplat-unified/gsplat-octree-node.js';

test('GSplatOctreeNode exposes optional tree fields (default -1 / empty)', () => {
    const node = new GSplatOctreeNode([{ file: 'a', fileIndex: 0, offset: 0, count: 100 }], {
        min: [0, 0, 0],
        max: [1, 1, 1]
    });
    assert.equal(node.depth, -1, 'default depth is -1 (flat mode sentinel)');
    assert.equal(node.parent, -1, 'default parent is -1 (no parent)');
    assert.deepEqual(node.children, [], 'default children is empty array');
});

test('GSplatOctreeNode tree fields round-trip when set', () => {
    const node = new GSplatOctreeNode([{ file: 'a', fileIndex: 0, offset: 0, count: 100 }], {
        min: [0, 0, 0],
        max: [1, 1, 1]
    });
    node.depth = 3;
    node.parent = 7;
    node.children = [9, 10, 11];
    assert.equal(node.depth, 3);
    assert.equal(node.parent, 7);
    assert.deepEqual(node.children, [9, 10, 11]);
});
