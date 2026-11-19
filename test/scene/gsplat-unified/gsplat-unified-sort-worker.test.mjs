import { runInNewContext } from 'node:vm';

import { expect } from 'chai';

import { GSplatSortBinWeights } from '../../../src/scene/gsplat-unified/gsplat-sort-bin-weights.js';
import { UnifiedSortWorker } from '../../../src/scene/gsplat-unified/gsplat-unified-sort-worker.js';

describe('GSplat unified sort worker', function () {
    const makeWorker = () => {
        let send;
        let response;
        const allocations = [];
        class RecordingUint32Array extends Uint32Array {
            constructor(value) {
                super(value);
                if (typeof value === 'number') allocations.push(value);
            }
        }
        runInNewContext(`(${UnifiedSortWorker.toString()})();`, {
            GSplatSortBinWeights,
            performance,
            Uint32Array: RecordingUint32Array,
            self: {
                addEventListener: (event, listener) => {
                    send = listener;
                },
                postMessage: (message) => {
                    response = message;
                }
            }
        });
        const centers = n => new Float32Array(n * 3).buffer;
        send({ command: 'addCenters', id: 1, centers: centers(7) });
        send({ command: 'addCenters', id: 2, centers: centers(3) });
        const layout = {
            command: 'intervals',
            ids: [1, 2],
            pixelOffsets: [[300, 12, 50], [200]],
            intervals: [[2, 4, 4, 4, 6, 7], []],
            totalActiveSplats: 6,
            version: 1
        };
        return { allocations, send, layout, result: () => response };
    };

    it('stores layout by interval without allocating an index per active splat', function () {
        const worker = makeWorker();
        worker.send(worker.layout);
        expect(worker.allocations).not.to.include(worker.layout.totalActiveSplats);
    });

    for (const radialSorting of [false, true]) {
        it(`keeps work-buffer offsets, equal-depth order and padding across layout changes (radial=${radialSorting})`, function () {
            const worker = makeWorker();
            const params = {
                transformedDirection: { x: 0, y: 0, z: 1 },
                transformedPosition: { x: 0, y: 0, z: 1 },
                offset: 0,
                scale: 1,
                aabbMin: [-1, -1, -1],
                aabbMax: [1, 1, 1]
            };
            const sort = () => {
                const order = new Uint32Array(9).fill(777).buffer;
                worker.send({ command: 'sort', radialSorting, sortParams: [params, params], order });
                return Array.from(new Uint32Array(worker.result().order));
            };
            worker.send(worker.layout);
            expect(sort()).to.deep.equal([202, 201, 200, 50, 301, 300, 777, 777, 777]);
            worker.send({ ...worker.layout, version: 2, pixelOffsets: [[7, 11, 12], [31]] });
            expect(sort()).to.deep.equal([33, 32, 31, 12, 8, 7, 777, 777, 777]);
            expect(worker.result().version).to.equal(2);
        });
    }
});
