import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GSplatOctree } from '../../../src/scene/gsplat-unified/gsplat-octree.js';

test('legacy node ranges, bounds and child links survive hierarchy conversion', () => {
    const bound = { min: [0, 1, 2], max: [3, 4, 5] };
    const octree = new GSplatOctree('/scene/office.lcc2', {
        hierarchyMode: 'tree',
        totalLevels: 2,
        filenames: ['scene.sog'],
        tree: {
            bound,
            lod: null,
            children: [{
                bound,
                lod: { file: 0, offset: 30, count: 10 },
                children: [{ bound, lod: { file: 0, offset: 40, count: 20 } }]
            }]
        }
    });

    assert.deepEqual(Array.from(octree.parentIndex), [-1, 0]);
    assert.deepEqual(Array.from(octree.childCount), [1, 0]);
    assert.equal(octree.childStart[0], 1);
    assert.equal(octree.nodes[0].lods[1].offset, 30);
    assert.equal(octree.nodes[1].lods[0].offset, 40);
    assert.deepEqual(Array.from(octree.nodeBoundsMinMax), [...bound.min, ...bound.max, ...bound.min, ...bound.max]);
});
