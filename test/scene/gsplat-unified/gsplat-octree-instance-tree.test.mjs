import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { GSplatBudgetBalancer } from '../../../src/scene/gsplat-unified/gsplat-budget-balancer.js';
import { GSplatOctreeInstance } from '../../../src/scene/gsplat-unified/gsplat-octree-instance.js';
import { GSplatOctree } from '../../../src/scene/gsplat-unified/gsplat-octree.js';

function makeTree() {
    return {
        hierarchyMode: 'tree',
        lodLevels: 1,
        totalLevels: 3,
        filenames: ['r.sog', 'a.sog', 'b.sog', 'aa.sog', 'ab.sog'],
        tree: {
            bound: { min: [-100, -100, -100], max: [100, 100, 100] },
            lod: null,
            depth: 0,
            children: [
                {
                    bound: { min: [-100, -100, -100], max: [0, 100, 100] },
                    lod: { file: 1, offset: 0, count: 1000 },
                    depth: 1,
                    children: [
                        {
                            bound: { min: [-100, -100, -100], max: [0, 0, 100] },
                            lod: { file: 3, offset: 0, count: 500 },
                            depth: 2,
                            children: [
                                {
                                    bound: { min: [-100, -100, -100], max: [0, 0, 0] },
                                    lod: { file: 4, offset: 0, count: 200 },
                                    depth: 3,
                                    children: []
                                }
                            ]
                        }
                    ]
                },
                {
                    bound: { min: [0, -100, -100], max: [100, 100, 100] },
                    lod: { file: 2, offset: 0, count: 1200 },
                    depth: 1,
                    children: []
                }
            ]
        }
    };
}

test('distance selection on an uneven legacy tree switches between coarse and finest nodes', () => {
    const octree = new GSplatOctree('/scene/office.lcc2', makeTree());
    octree.assetLoader = { getResource: () => ({}) };
    for (let i = 0; i < octree.files.length; i++) octree.pollFileResource(i);
    const instance = new GSplatOctreeInstance({ on() {} }, octree, { lodBaseDistance: 10, lodMultiplier: 2 });
    instance.resolveLodRange();
    const balancer = new GSplatBudgetBalancer();
    const instances = new Map([[instance.placement, instance]]);
    const draw = (x, y, z) => {
        instance._cameraPos.set(x, y, z);
        balancer.balance(instances, Infinity, true);
        instance.applyLodChanges({});
        return instance.nodeInfos.flatMap((info, i) => (info.currentLod < 0 ? [] : [octree.nodes[i].lods[info.currentLod].fileIndex])).sort();
    };

    assert.deepEqual(draw(0, 0, 1000), [1, 2]);
    assert.deepEqual(draw(-50, -50, -50), [2, 4]);
    assert.deepEqual(draw(-55, -55, -55), [2, 4]);
    assert.deepEqual(draw(0, 0, 1000), [1, 2]);
});
