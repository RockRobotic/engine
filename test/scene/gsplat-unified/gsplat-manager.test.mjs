import { expect } from 'chai';
import sinon from 'sinon';

import { BoundingBox } from '../../../src/core/shape/bounding-box.js';
import { NullGraphicsDevice } from '../../../src/platform/graphics/null/null-graphics-device.js';
import { GraphNode } from '../../../src/scene/graph-node.js';
import { GSplatManager } from '../../../src/scene/gsplat-unified/gsplat-manager.js';
import { GSplatParams } from '../../../src/scene/gsplat-unified/gsplat-params.js';
import { GSplatPlacement } from '../../../src/scene/gsplat-unified/gsplat-placement.js';
import { Layer } from '../../../src/scene/layer.js';
import { setDefaultMaterial } from '../../../src/scene/materials/default-material.js';
import { StandardMaterial } from '../../../src/scene/materials/standard-material.js';

describe('GSplatManager CPU order uploads', function () {
    let device, manager, world, sorter, worker, instance;

    beforeEach(function () {
        worker = globalThis.Worker;
        globalThis.Worker = class {
            on() {}

            terminate() {}
        };
        device = new NullGraphicsDevice({ width: 1, height: 1 });
        setDefaultMaterial(device, new StandardMaterial());
        const camera = new GraphNode();
        camera.camera = {};
        manager = new GSplatManager(device, { scene: {}, gsplat: new GSplatParams(device) }, new Layer(), camera);
        world = manager.world;
        sorter = manager.cpuSorter;
        instance = {
            activePlacements: new Set(),
            octree: { nodes: [{}] },
            nodeInfos: [{ allocId: 1 }],
            placement: new GSplatPlacement(null, new GraphNode()),
            destroy() {}
        };
        world._octreeInstances.set(instance.placement, instance);
        sinon.stub(world.workBuffer, 'render');
        // Use two identical slices so the intermediate frame is deterministic on the null device.
        sinon.stub(world.workBuffer._orderUploadPacer, 'rows').callsFake(size => size / 2);
    });

    afterEach(function () {
        manager?.destroy();
        device?.destroy();
        globalThis.Worker = worker;
    });

    // Stream another file for a single octree node. Layout, bounds groups and resource tracking
    // are real. Only the GPU bake and the worker's sort are replaced.
    const newState = (count, { size = 1536, replacePlacement = false, cached = false, boundsChanged = false } = {}) => {
        if (replacePlacement) {
            world._octreeInstances.delete(instance.placement);
            instance.placement = new GSplatPlacement(null, new GraphNode());
            world._octreeInstances.set(instance.placement, instance);
        }
        const resource = { numSplats: count, aabb: new BoundingBox(), hasCenters: true, incRefCount() {}, decRefCount() {} };
        const file = new GSplatPlacement(resource, instance.placement.node, 0, null, instance.placement);
        file.intervals.set(0, { x: 0, y: count - 1 });
        instance.activePlacements.clear();
        instance.activePlacements.add(file);

        // A cached file can activate in applyLodChanges, after the world's dirty-flag poll.
        world._layerPlacementsDirty = !cached;
        world._placementSetChanged = replacePlacement || boundsChanged;
        world._updateWorldState(true);
        const state = world.getState(world.lastWorldStateVersion);
        state.textureSize = size;
        return state;
    };

    const sort = (state) => {
        sorter.bufferLength = state.textureSize ** 2;
        const order = new Uint32Array(sorter.bufferLength);
        sorter.jobsInFlight++;
        sorter.onSorted({ count: state.totalActiveSplats, version: state.version, order: order.buffer });
        return sorter.pendingSorted.orderData;
    };

    const frame = () => manager._applySortResults();
    const drawnCount = () => manager.material.getParameter('numSplats').data;
    const boundOrder = () => manager.material.getParameter('splatOrder').data;

    it('keeps drawing the previous version and count until the last row of a streamed order arrives', function () {
        const first = newState(100);
        sort(first);
        frame();
        expect(drawnCount()).to.equal(100);
        const originalOrder = boundOrder();
        expect(world.workBuffer.render.callCount).to.equal(1);

        const second = newState(240);
        const data = sort(second);
        frame();
        expect(manager.hasPendingSort).to.equal(true);
        frame();
        expect(world.currentState).to.equal(first);
        expect(drawnCount()).to.equal(100);
        expect(boundOrder()).to.equal(originalOrder);
        expect(world.workBuffer.render.callCount).to.equal(1);
        expect(sorter.availableOrderData).not.to.include(data);

        frame();
        expect(world.currentState).to.equal(second);
        expect(drawnCount()).to.equal(240);
        expect(boundOrder()).not.to.equal(originalOrder);
        expect(world.workBuffer.render.lastCall.args[0]).to.include(second.splats[0]);
        expect(manager.hasPendingSort).to.equal(false);
        expect(sorter.availableOrderData).to.include(data);
    });

    it('finishes a staged version under continuous streaming, then advances to the latest result', function () {
        const first = newState(100);
        sort(first);
        frame();
        const second = newState(200);
        sort(second);
        frame();
        const third = newState(300);
        sort(third);
        frame();
        const fourth = newState(400);
        sort(fourth);
        frame();
        expect(world.currentState).to.equal(second);
        expect(drawnCount()).to.equal(200);
        frame();
        frame();
        frame();
        expect(world.currentState).to.equal(fourth);
        expect(drawnCount()).to.equal(400);
    });

    it('releases files from a skipped LOD version when its successor becomes visible', function () {
        const first = newState(100);
        sort(first);
        frame();

        const skipped = newState(140);
        const octree = { decRefCount: sinon.spy() };
        skipped.pendingReleases.push([octree, 7]);
        sort(newState(200));
        frame();
        expect(octree.decRefCount.called).to.equal(false);
        frame();
        frame();
        expect(octree.decRefCount.calledOnceWithExactly(7, manager.gsplat.cooldownTicks)).to.equal(true);
    });

    it('stages a cached LOD file even before its dirty flag is polled', function () {
        sort(newState(100));
        frame();
        sort(newState(200, { cached: true }));
        frame();
        expect(drawnCount()).to.equal(100);
        expect(manager.hasPendingSort).to.equal(true);
    });

    it('stages a streamed replacement for the last file of the same parent placement', function () {
        sort(newState(100));
        frame();
        sort(newState(200, { boundsChanged: true }));
        frame();
        expect(drawnCount()).to.equal(100);
        expect(manager.hasPendingSort).to.equal(true);
    });

    it('preempts an unfinished order on a placement change and releases its worker buffer', function () {
        const first = newState(100);
        sort(first);
        frame();
        // A camera re-sort of the displayed state is already being sliced.
        const abandoned = sort(first);
        frame();
        frame();

        const replacement = newState(200, { replacePlacement: true });
        sort(replacement);
        frame();
        expect(world.currentState).to.equal(replacement);
        expect(manager.hasPendingSort).to.equal(false);
        expect(sorter.availableOrderData).to.include(abandoned);
    });

    it('applies an edit to an existing child resource without waiting for slices', function () {
        sort(newState(100));
        frame();
        const [file] = instance.activePlacements;
        file.resource.centersVersion = 1;
        world._updateWorldState(true);
        const edited = world.getState(world.lastWorldStateVersion);
        edited.textureSize = 1536;
        sort(edited);
        frame();
        expect(world.currentState).to.equal(edited);
        expect(manager.hasPendingSort).to.equal(false);
    });

    it('applies the latest sort immediately if it skipped a parent placement change', function () {
        sort(newState(100));
        frame();
        newState(200, { replacePlacement: true });
        const latest = newState(300, { cached: true });
        sort(latest);
        frame();
        expect(world.currentState).to.equal(latest);
        expect(manager.hasPendingSort).to.equal(false);
    });

    it('discards pre-loss orders and displays the first reloaded octree state immediately', function () {
        const first = newState(100);
        sort(first);
        frame();
        const second = newState(200);
        const abandoned = sort(second);
        frame();
        frame();
        sort(second);

        manager._onDeviceRestored();
        frame();
        expect(world.currentState).to.equal(first);
        expect(manager.hasPendingSort).to.equal(false);
        expect(sorter.availableOrderData).to.include(abandoned);

        const reloaded = newState(300);
        sort(reloaded);
        frame();
        expect(world.currentState).to.equal(reloaded);
        expect(drawnCount()).to.equal(300);
        expect(manager.hasPendingSort).to.equal(false);
    });

    it('releases a staged order on sorter replacement and draws the first new result immediately', function () {
        const first = newState(100);
        sort(first);
        frame();
        const abandoned = sort(newState(200));
        frame();
        manager.destroyCpuSorting();
        expect(sorter.availableOrderData).to.include(abandoned);
        manager.initCpuSorting();
        sorter = manager.cpuSorter;

        const replacement = newState(300);
        sort(replacement);
        frame();
        expect(world.currentState).to.equal(replacement);
        expect(drawnCount()).to.equal(300);
        expect(manager.hasPendingSort).to.equal(false);
    });

    it('sorts the latest camera after movement stops during a running job', function () {
        sorter.worker.postMessage = sinon.spy();
        const first = [{ offset: 1 }];
        const last = [{ offset: 3 }];
        sorter.setSortParams(first, true);
        sorter.setSortParams([{ offset: 2 }], true);
        sorter.setSortParams(last, true);
        expect(sorter.worker.postMessage.callCount).to.equal(1);

        sorter.onSorted({ count: 0, order: new ArrayBuffer(0), version: 0 });
        expect(sorter.worker.postMessage.callCount).to.equal(2);
        expect(sorter.worker.postMessage.lastCall.args[0].sortParams).to.equal(last);
        sorter.onSorted({ count: 0, order: new ArrayBuffer(0), version: 0 });
        expect(sorter.jobsInFlight).to.equal(0);
        expect(sorter.worker.postMessage.callCount).to.equal(2);
    });

    it('does not sort a deferred old camera request against a replacement world layout', function () {
        sorter.worker.postMessage = sinon.spy();
        sorter.setSortParams([{ offset: 1 }], true);
        sorter.setSortParams([{ offset: 2 }], true);
        sorter.setSortParameters({ textureSize: 4 });
        sorter.onSorted({ count: 0, order: new ArrayBuffer(0), version: 0 });
        expect(sorter.worker.postMessage.callCount).to.equal(2);
        sorter.setSortParams([{ offset: 3 }], true);
        expect(sorter.worker.postMessage.lastCall.args[0].sortParams[0].offset).to.equal(3);
    });

    it('applies a resized order and a small order directly', function () {
        const first = newState(100);
        sort(first);
        frame();
        for (const size of [1600, 4, 4]) {
            const next = newState(10, { size });
            sort(next);
            frame();
            expect(world.currentState).to.equal(next);
            expect(manager.hasPendingSort).to.equal(false);
        }
    });
});
