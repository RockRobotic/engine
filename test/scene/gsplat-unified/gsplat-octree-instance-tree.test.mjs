import { strict as assert } from 'node:assert';
import { test } from 'node:test';

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

test('tree selector: far camera picks depth-1 nodes only', async () => {
    const { selectTreeActiveNodes } = await import(
        '../../../src/scene/gsplat-unified/gsplat-octree-instance.js'
    );
    const oct = new GSplatOctree('file:///scene.lcc2', makeTree());

    const active = selectTreeActiveNodes(oct, {
        cameraPos: { x: 0, y: 0, z: 1000 },
        lodBaseDistance: 10,
        lodMultiplier: 2,
        fovScale: 1
    });

    const depths = active.map(i => oct.nodes[i].depth).sort();
    assert.deepEqual(depths, [1, 1]);
});

test('tree selector: close camera picks deepest leaves', async () => {
    const { selectTreeActiveNodes } = await import(
        '../../../src/scene/gsplat-unified/gsplat-octree-instance.js'
    );
    const oct = new GSplatOctree('file:///scene.lcc2', makeTree());

    const active = selectTreeActiveNodes(oct, {
        cameraPos: { x: -50, y: -50, z: -50 },
        lodBaseDistance: 10,
        lodMultiplier: 2,
        fovScale: 1
    });

    const depths = active.map(i => oct.nodes[i].depth).sort();
    assert.deepEqual(depths, [1, 3]);
});

test('tree selector: root with null lod never enters active set', async () => {
    const { selectTreeActiveNodes } = await import(
        '../../../src/scene/gsplat-unified/gsplat-octree-instance.js'
    );
    const oct = new GSplatOctree('file:///scene.lcc2', makeTree());

    const active = selectTreeActiveNodes(oct, {
        cameraPos: { x: 0, y: 0, z: 1e9 },
        lodBaseDistance: 10,
        lodMultiplier: 2,
        fovScale: 1
    });

    assert.ok(!active.includes(0), 'root (index 0) must not be active');
});

test('tree selector: hysteresis keeps the previously chosen depth within deadband', async () => {
    const { selectTreeActiveNodes } = await import(
        '../../../src/scene/gsplat-unified/gsplat-octree-instance.js'
    );
    const oct = new GSplatOctree('file:///scene.lcc2', makeTree());

    const firstFrame = selectTreeActiveNodes(oct, {
        cameraPos: { x: -50, y: -50, z: -50 },
        lodBaseDistance: 10,
        lodMultiplier: 2,
        fovScale: 1
    });
    const prev = new Set(firstFrame);

    const justBeyond = selectTreeActiveNodes(oct, {
        cameraPos: { x: -55, y: -55, z: -55 },
        lodBaseDistance: 10,
        lodMultiplier: 2,
        fovScale: 1,
        previousActive: prev,
        hysteresis: 0.15
    });
    assert.deepEqual(
        justBeyond.map(i => oct.nodes[i].depth).sort(),
        firstFrame.map(i => oct.nodes[i].depth).sort(),
        'within 15% deadband, depth selection unchanged'
    );

    const past = selectTreeActiveNodes(oct, {
        cameraPos: { x: 0, y: 0, z: 1000 },
        lodBaseDistance: 10,
        lodMultiplier: 2,
        fovScale: 1,
        previousActive: prev,
        hysteresis: 0.15
    });
    const pastDepths = past.map(i => oct.nodes[i].depth);
    assert.ok(pastDepths.every(d => d <= 1), 'past deadband, coarsened to depth <=1');
});
