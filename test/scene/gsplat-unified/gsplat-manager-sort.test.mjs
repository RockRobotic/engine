import { expect } from 'chai';

import { Vec3 } from '../../../src/core/math/vec3.js';
import { PROJECTION_ORTHOGRAPHIC, PROJECTION_PERSPECTIVE } from '../../../src/scene/constants.js';
import { GraphNode } from '../../../src/scene/graph-node.js';
import { GSplatManager } from '../../../src/scene/gsplat-unified/gsplat-manager.js';
import { GSplatUnifiedSorter } from '../../../src/scene/gsplat-unified/gsplat-unified-sorter.js';

describe('GSplatManager#testCameraMovedForSort', function () {

    // A manager whose last CPU sort was taken from the camera's current pose and sort mode, with
    // only the properties the test reads.
    const makeManager = ({ radialSorting = false, projection = PROJECTION_PERSPECTIVE, fisheye = 0 } = {}) => {
        const cameraNode = new GraphNode();
        cameraNode.camera = { projection };
        cameraNode.setPosition(1, 2, 3);
        cameraNode.setEulerAngles(10, 20, 0);

        const manager = Object.create(GSplatManager.prototype);
        manager.gsplat = { radialSorting, fisheye };
        manager.cameraNode = cameraNode;
        manager.lastSortCameraPos = cameraNode.getPosition().clone();
        manager.lastSortCameraFwd = cameraNode.forward.clone();
        manager.lastSortKeyMode = manager._sortKeyMode();
        return manager;
    };

    const move = (manager) => {
        manager.cameraNode.setPosition(new Vec3(1, 2, 3).add(new Vec3(0.5, 0, 0)));
    };

    const turn = (manager) => {
        manager.cameraNode.setEulerAngles(10, 25, 0);
    };

    it('does not re-sort a camera that has not changed', function () {
        expect(makeManager().testCameraMovedForSort()).to.equal(false);
        expect(makeManager({ radialSorting: true }).testCameraMovedForSort()).to.equal(false);
    });

    it('re-sorts a radial sort on a move but not on a turn', function () {
        const moved = makeManager({ radialSorting: true });
        move(moved);
        expect(moved.testCameraMovedForSort()).to.equal(true);

        const turned = makeManager({ radialSorting: true });
        turn(turned);
        expect(turned.testCameraMovedForSort()).to.equal(false);
    });

    it('re-sorts a perspective depth sort on a move and on a turn', function () {
        const moved = makeManager();
        move(moved);
        expect(moved.testCameraMovedForSort()).to.equal(true);

        const turned = makeManager();
        turn(turned);
        expect(turned.testCameraMovedForSort()).to.equal(true);
    });

    it('re-sorts an orthographic or fisheye depth sort on a turn only', function () {
        for (const options of [{ projection: PROJECTION_ORTHOGRAPHIC }, { fisheye: 1 }]) {
            const moved = makeManager(options);
            move(moved);
            expect(moved.testCameraMovedForSort()).to.equal(false);

            const turned = makeManager(options);
            turn(turned);
            expect(turned.testCameraMovedForSort()).to.equal(true);
        }
    });

    it('re-sorts a still camera when its projection or sort mode changes', function () {
        const orthographic = makeManager();
        orthographic.cameraNode.camera.projection = PROJECTION_ORTHOGRAPHIC;
        expect(orthographic.testCameraMovedForSort()).to.equal(true);

        const fisheye = makeManager();
        fisheye.gsplat.fisheye = 1;
        expect(fisheye.testCameraMovedForSort()).to.equal(true);

        const radial = makeManager();
        radial.gsplat.radialSorting = true;
        expect(radial.testCameraMovedForSort()).to.equal(true);
    });
});

describe('GSplatUnifiedSorter#setSortParams', function () {

    // A sorter whose worker records the jobs posted to it.
    const makeSorter = () => {
        const sorter = Object.create(GSplatUnifiedSorter.prototype);
        sorter.posted = [];
        sorter._sentPositions = [];
        sorter.worker = {
            postMessage: message => sorter.posted.push(message)
        };
        sorter.bufferLength = 4;
        sorter.availableOrderData = [];
        sorter.jobsInFlight = 0;
        sorter.hasNewVersion = false;
        return sorter;
    };

    it('accepts a camera request while busy and posts its latest projection and near clip when the worker finishes', function () {
        const sorter = makeSorter();
        const latest = [{ offset: 3 }];
        expect(sorter.setSortParams([], false, 0.1, true)).to.equal(true);
        expect(sorter.setSortParams([{ offset: 2 }], false, 0.2, true)).to.equal(true);
        expect(sorter.setSortParams(latest, false, 0.3, false)).to.equal(true);
        expect(sorter.posted).to.have.length(1);

        sorter.onSorted({ order: sorter.posted[0].order, count: 0, version: 1 });
        expect(sorter.posted).to.have.length(2);
        expect(sorter.posted[1]).to.include({ sortParams: latest, nearClip: 0.3, logDepthKeys: false });
    });

    it('keeps a staged order available for restore and releases it once a newer order replaces it', function () {
        const sorter = makeSorter();
        const initial = { count: 2, version: 1, orderData: new Uint32Array(4), radialPosition: new Vec3(1, 2, 3) };
        sorter.fire = () => sorter.retainOrderData();
        sorter.pendingSorted = initial;
        sorter.applyPendingSorted(true);
        sorter.releaseOrderData(initial.orderData);
        expect(sorter.availableOrderData).to.be.empty;

        sorter.reapplyLastSorted();
        expect(sorter.pendingSorted).to.equal(initial);
        sorter.applyPendingSorted(true);
        expect(sorter.availableOrderData).to.be.empty;

        const latest = { ...initial, orderData: new Uint32Array(4) };
        sorter.pendingSorted = latest;
        sorter.applyPendingSorted(true);
        expect(sorter.lastSorted).to.equal(latest);
        expect(sorter.availableOrderData).to.deep.equal([initial.orderData]);
    });
});
