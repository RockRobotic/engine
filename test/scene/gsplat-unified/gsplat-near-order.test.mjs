import { runInNewContext } from 'node:vm';

import { expect } from 'chai';

import { Vec3 } from '../../../src/core/math/vec3.js';
import { BoundingBox } from '../../../src/core/shape/bounding-box.js';
import { GraphNode } from '../../../src/scene/graph-node.js';
import { GSplatNearOrder } from '../../../src/scene/gsplat-unified/gsplat-near-order.js';
import { GSplatSortBinWeights } from '../../../src/scene/gsplat-unified/gsplat-sort-bin-weights.js';
import { UnifiedSortWorker } from '../../../src/scene/gsplat-unified/gsplat-unified-sort-worker.js';

describe('GSplat current-camera near order', function () {
    const origin = new Vec3();
    const moved = new Vec3(5, 0, 0);
    const near = 0.1;
    const fixture = () => {
        const splats = [0, 1].map((idx) => {
            // Include identical distances and explicit duplicate centers to exercise native tie order.
            const centers = Float32Array.from({ length: 1200 * 3 }, (_, i) => {
                const seed = Math.floor(i / 6);
                return ((seed * [7, 11, 13][i % 3] + idx) % 53) * 0.25 - 6;
            });
            const node = new GraphNode();
            node.setLocalPosition(idx, -idx, 0);
            node.setLocalScale(1 + idx, 1, 1);
            return {
                node,
                resource: { centers, centersVersion: idx + 2 },
                aabb: new BoundingBox(new Vec3(), new Vec3(12, 12, 12)),
                intervals: idx ? [] : [2, 490, 600, 1100],
                intervalOffsets: idx ? [1800] : [1060, 52],
                activeSplats: idx ? 1200 : 988
            };
        });
        const n = 2188;
        const width = 64;
        const texture = { width, height: Math.ceil(n / width) };
        const state = { textureSize: width, totalActiveSplats: n, splats };
        let send;
        let result;
        runInNewContext(`(${UnifiedSortWorker.toString()})();`, {
            GSplatSortBinWeights,
            performance,
            self: {
                addEventListener: (event, listener) => {
                    send = listener;
                },
                postMessage: (msg) => {
                    result = msg;
                }
            }
        });
        splats.forEach((s, id) => send({ command: 'addCenters', id, centers: s.resource.centers.buffer.slice(0) }));
        send({
            command: 'intervals',
            version: 2,
            totalActiveSplats: n,
            ids: [0, 1],
            intervals: splats.map(s => s.intervals),
            pixelOffsets: splats.map(s => s.intervalOffsets)
        });
        const sort = (camera) => {
            const sortParams = splats.map((s) => {
                const model = s.node.getWorldTransform();
                return {
                    scale: model.getX().length(),
                    transformedPosition: model.clone().invert().transformPoint(camera),
                    aabbMin: [-12, -12, -12],
                    aabbMax: [12, 12, 12]
                };
            });
            const order = new Uint32Array(width * texture.height).fill(0xffffffff);
            send({ command: 'sort', order: order.buffer, radialSorting: true, sortParams });
            return new Uint32Array(result.order);
        };
        const original = sort(origin);
        const gpu = original.slice();
        const writes = [];
        const buffer = {
            orderTexture: texture,
            uploadStream: {
                upload: (data, dst, offset, size) => {
                    expect(dst).to.equal(texture);
                    expect(offset % width).to.equal(0);
                    expect(size).to.equal(width * texture.height - offset);
                    gpu.set(data, offset);
                    writes.push(offset);
                }
            }
        };
        const correction = new GSplatNearOrder();
        return { n, sort, original, gpu, buffer, state, texture, writes, correction };
    };

    it('matches the freshly sorted worker subsequence, including equal buckets, partial rows and sparse placements', function () {
        const { n, sort, original, gpu, buffer, state, texture, writes, correction } = fixture();
        expect(correction.bind(state, texture, original)).to.equal(true);
        expect(correction.prepared).to.equal(false);
        correction.update(buffer, moved, origin, near, true);
        const start = writes[0];
        expect(start).to.be.above(0);
        expect(n - start).to.be.at.most(Math.ceil(n / 32) + texture.width - 1);
        expect(gpu.subarray(0, start)).to.deep.equal(original.subarray(0, start));
        expect(gpu.subarray(n)).to.deep.equal(original.subarray(n));
        const retained = new Set(original.subarray(start, n));
        const expected = sort(moved).subarray(0, n).filter(id => retained.has(id));
        expect(gpu.subarray(start, n)).to.deep.equal(expected);
        expect(expected).not.to.deep.equal(original.subarray(start, n));
        correction.update(buffer, moved, origin, near, true);
        expect(writes).to.have.length(1);
        correction.update(buffer, origin, origin, near, true);
        expect(gpu).to.deep.equal(original);
    });

    it('restores the untouched full-order suffix if transforms, centers, modifiers or eligibility change', function () {
        const changes = [
            state => state.splats[0].node.setLocalPosition(1, 0, 0),
            state => state.splats[0].resource.centersVersion++,
            (state) => {
                state.splats[0].resource.centers = state.splats[0].resource.centers.slice();
            },
            (state) => {
                state.splats[0].getWorkBufferModifier = () => ({});
            },
            () => {}
        ];
        changes.forEach((change, i) => {
            const { original, gpu, buffer, state, texture, writes, correction } = fixture();
            correction.bind(state, texture, original);
            correction.update(buffer, moved, origin, near, true);
            change(state);
            expect(correction.update(buffer, moved, origin, near, i !== changes.length - 1)).to.equal(false);
            expect(writes).to.have.length(2);
            expect(gpu).to.deep.equal(original);
        });
    });

    it('keeps new committed orders intact and never writes a discarded texture or stale world', function () {
        const { sort, original, gpu, buffer, state, texture, writes, correction } = fixture();
        correction.bind(state, texture, original);
        correction.update(buffer, moved, origin, near, true);
        const fresh = sort(moved);
        gpu.set(fresh);
        expect(correction.bind(state, texture, fresh)).to.equal(true);
        correction.update(buffer, moved, moved, near, true);
        expect(gpu).to.deep.equal(fresh);
        correction.update(buffer, origin, moved, near, true);
        buffer.orderTexture = { ...texture };
        correction.update(buffer, moved, moved, near, true);
        correction.restore(buffer);
        expect(writes).to.have.length(2);
        expect(correction.bind({ ...state, splats: [] }, texture, fresh)).to.equal(false);
        correction.update(buffer, origin, moved, near, true);
        expect(writes).to.have.length(2);
    });

    it('leaves empty, incomplete, overlapping, out-of-range and duplicate source orders intact', function () {
        const { original, gpu, buffer, state, texture, writes, correction } = fixture();
        expect(correction.bind(null, null, null)).to.equal(false);
        expect(correction.bind({ ...state, totalActiveSplats: 0 }, texture, original)).to.equal(false);
        expect(correction.bind({ ...state, splats: [] }, texture, original)).to.equal(false);
        expect(correction.bind(state, texture, original.subarray(1))).to.equal(false);
        for (const id of [original[state.totalActiveSplats - 2], 0, 4000]) {
            const corrupt = original.slice();
            corrupt[state.totalActiveSplats - 1] = id;
            expect(correction.bind(state, texture, corrupt)).to.equal(true);
            correction.update(buffer, moved, origin, near, true);
        }
        state.splats[1].intervalOffsets = [1100];
        expect(correction.bind({ ...state }, texture, original)).to.equal(false);
        expect(writes).to.have.length(0);
        expect(gpu).to.deep.equal(original);
    });
});
