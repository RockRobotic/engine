import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GSplatOctree } from '../../../src/scene/gsplat-unified/gsplat-octree.js';

test('GSplatOctree tree mode: retains every node and links parent/children', () => {
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
    assert.equal(oct.nodes.length, 4, 'root + 3 descendants = 4 nodes');
    assert.equal(oct.rootIndex, 0);
    assert.equal(oct.totalLevels, 2);

    const root = oct.nodes[0];
    assert.equal(root.depth, 0);
    assert.equal(root.parent, -1);
    assert.equal(root.children.length, 2);
    assert.equal(root.lods[0].fileIndex, -1, 'root lod is null sentinel');

    const firstChild = oct.nodes[root.children[0]];
    assert.equal(firstChild.depth, 1);
    assert.equal(firstChild.parent, 0);
    assert.equal(firstChild.lods[0].fileIndex, 0);
    assert.equal(firstChild.lods[0].count, 100);
});

test('GSplatOctree flat mode: unchanged behaviour when hierarchyMode absent', () => {
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
    assert.equal(oct.hierarchyMode ?? 'flat', 'flat');
    assert.equal(oct.nodes.length, 1, 'only 1 leaf in flat mode');
    assert.equal(oct.nodes[0].lods.length, 2);
});
