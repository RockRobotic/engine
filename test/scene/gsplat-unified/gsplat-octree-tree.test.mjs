import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GSplatOctree } from '../../../src/scene/gsplat-unified/gsplat-octree.js';
import { GSplatOctreeResource } from '../../../src/scene/gsplat-unified/gsplat-octree.resource.js';

test('GSplatOctree tree mode: retains splat nodes and their parent/child relationships', () => {
    const data = {
        hierarchyMode: 'tree',
        lodLevels: 1,
        totalLevels: 2,
        filenames: ['a.sog', 'b.sog', 'c.sog'],
        tree: {
            bound: { min: [0, 0, 0], max: [10, 10, 10] },
            lod: null,
            depth: 0,
            children: [
                {
                    bound: { min: [0, 0, 0], max: [5, 10, 10] },
                    lod: { file: 0, offset: 0, count: 100 },
                    depth: 1,
                    children: [
                        {
                            bound: { min: [0, 0, 0], max: [5, 5, 10] },
                            lod: { file: 1, offset: 0, count: 200 },
                            depth: 2,
                            children: []
                        }
                    ]
                },
                {
                    bound: { min: [5, 0, 0], max: [10, 10, 10] },
                    lod: { file: 2, offset: 0, count: 150 },
                    depth: 1,
                    children: []
                }
            ]
        }
    };
    const oct = new GSplatOctree('file:///scene.lcc2', data);

    assert.equal(oct.hierarchyMode, 'tree');
    assert.equal(oct.totalLevels, 2);
    assert.equal(oct.nodes.length, 3, 'only renderable nodes enter the cut');
    assert.equal(oct.lodLevels, 2);
    assert.deepEqual(Array.from(oct.parentIndex), [-1, -1, 0]);
    assert.deepEqual(Array.from(oct.childCount), [1, 0, 0]);
    assert.deepEqual(Array.from(oct.nodeLevel), [1, 1, 0]);
    assert.equal(oct.nodes[0].lods[1].fileIndex, 0);
    assert.equal(oct.nodes[0].lods[1].count, 100);
    const resource = new GSplatOctreeResource('/scene/office.lcc2', data, null);
    assert.equal(resource.numSplats, 350, 'includes the shallow leaf at level 1');
});

test('GSplatOctree converts leaf-only LoD manifests into a chain of levels', () => {
    const data = {
        lodLevels: 2,
        filenames: ['a.sog', 'b.sog'],
        tree: {
            bound: { min: [0, 0, 0], max: [10, 10, 10] },
            children: [
                {
                    bound: { min: [0, 0, 0], max: [5, 10, 10] },
                    lods: {
                        '0': { file: 0, offset: 0, count: 100 },
                        '1': { file: 1, offset: 0, count: 50 }
                    }
                }
            ]
        }
    };
    const oct = new GSplatOctree('file:///scene.json', data);
    assert.deepEqual(Array.from(oct.nodeLevel), [1, 0]);
    assert.deepEqual(Array.from(oct.nodeSplats), [50, 100]);
});

test('GSplatOctreeResource: exposes hierarchyMode and metadata from tree data', () => {
    const data = {
        hierarchyMode: 'tree',
        lodLevels: 1,
        totalLevels: 2,
        metadata: { virtualLoD: null, lodSplats: [100, 50] },
        filenames: ['a.sog'],
        tree: {
            bound: { min: [0, 0, 0], max: [1, 1, 1] },
            lod: { file: 0, offset: 0, count: 100 },
            depth: 0,
            children: []
        }
    };
    const fakeAssetLoader = { load() {},
        unload() {},
        getResource() {
            return null;
        },
        destroy() {} };
    const res = new GSplatOctreeResource('file:///scene.lcc2', data, fakeAssetLoader);
    assert.equal(res.hierarchyMode, 'tree');
    assert.equal(res.numSplats, 100, 'preserves a populated root');
    assert.deepEqual(res.metadata, { virtualLoD: null, lodSplats: [100, 50] });
});
