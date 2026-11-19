import { Vec3 } from '../../core/math/vec3.js';
import { GSplatSortBinWeights } from './gsplat-sort-bin-weights.js';

// Cap main-thread work and limit smaller scenes to the nearest 1/32 of their order.
const tailLimit = 512 * 1024;
const axis = new Vec3();

/**
 * Refreshes a bounded suffix of a large, committed CPU radial order at the current camera.
 * Source intervals are traversed in worker order. Counting down each radial bucket therefore
 * preserves the worker's order for ties. All pairs outside the suffix keep their original order.
 *
 * @ignore
 */
class GSplatNearOrder {
    constructor(limit = tailLimit) {
        this.limit = limit;
        this.weights = new GSplatSortBinWeights();
        this.lastPosition = new Vec3();
        this.state = null;
        this.texture = null;
        this.prepared = false;
        this.modified = false;
    }

    // A new full order has already replaced the old one. Keep scratch only while eligible.
    forget() {
        this.texture = null;
        this.prepared = false;
        this.modified = false;
    }

    buildLayout(state) {
        this.runs = [];
        this.placements = [];
        this.groups = [];
        const runs = [];
        const placements = [];
        const width = state.textureSize;
        let total = 0;
        let end = 0;
        for (const info of state.splats) {
            const resource = info.resource;
            const centers = resource?.centers;
            // The CPU worker reads the same centers for all source formats.
            if (!centers || info.getWorkBufferModifier?.()) return false;
            const model = info.node.getWorldTransform().clone();
            const m = model.data;
            const det = m[0] * (m[5] * m[10] - m[6] * m[9]) - m[4] * (m[1] * m[10] - m[2] * m[9]) +
                m[8] * (m[1] * m[6] - m[2] * m[5]);
            if (!m.every(Number.isFinite) || m[3] || m[7] || m[11] || m[15] !== 1 || !det) return false;
            const p = placements.length;
            placements.push({
                info,
                centers,
                centersVersion: resource.centersVersion,
                model,
                inverse: model.clone().invert(),
                position: new Vec3(),
                scale: model.getX(axis).length(),
                min: info.aabb.getMin().clone(),
                max: info.aabb.getMax().clone()
            });
            const { intervals, intervalOffsets } = info;
            if (!intervals || !intervalOffsets || (intervals.length ? intervals.length !== intervalOffsets.length * 2 :
                intervalOffsets.length !== 1 || info.activeSplats * 3 !== centers.length)) return false;
            for (let i = 0; i < intervalOffsets.length; i++) {
                const src = intervals.length ? intervals[i * 2] : 0;
                const count = intervals.length ? intervals[i * 2 + 1] - src : info.activeSplats;
                const dst = intervalOffsets[i];
                if (!Number.isSafeInteger(src) || !Number.isSafeInteger(dst) || !Number.isSafeInteger(count) ||
                    src < 0 || count < 0 || (src + count) * 3 > centers.length || dst < 0 || dst + count > width * width) return false;
                if (count) {
                    runs.push({ p, src, dst, end: dst + count });
                    total += count;
                    end = Math.max(end, dst + count);
                }
            }
        }
        if (!total || total !== state.totalActiveSplats) return false;
        // Overlapping allocations cannot uniquely map an order ID to its source center.
        const byOffset = runs.slice().sort((a, b) => a.dst - b.dst);
        if (byOffset.some((run, i) => i > 0 && run.dst < byOffset[i - 1].end)) return false;
        this.runs = runs;
        this.placements = placements;
        this.end = end;
        return true;
    }

    validPlacements() {
        return this.placements.every(({ info, centers, centersVersion, model }) => {
            return info.resource.centers === centers && info.resource.centersVersion === centersVersion &&
                !info.getWorkBufferModifier?.() && info.node.getWorldTransform().equals(model);
        });
    }

    bind(state, texture, data) {
        this.forget();
        if (!state || !texture || !data) return false;
        const n = state.totalActiveSplats;
        const width = state.textureSize;
        if (!Number.isSafeInteger(n) || n <= 0 || !Number.isSafeInteger(width) || width <= 0 ||
            !state.splats?.length || width !== texture.width || Math.ceil(n / width) !== texture.height ||
            data.length < width * texture.height) return false;
        if (this.state !== state) {
            this.state = state;
            this.valid = this.buildLayout(state);
        }
        if (!this.valid || !this.validPlacements()) return false;

        const budget = Math.min(this.limit, Math.ceil(n / 32));
        this.start = Math.floor((n - budget) / width) * width;
        this.length = n - this.start;
        const padded = width * texture.height - this.start;
        if (this.original?.length !== padded) {
            this.original = new Uint32Array(padded);
            this.sorted = new Uint32Array(padded);
            this.ids = new Uint32Array(padded);
            this.keys = new Uint32Array(padded);
            this.squaredDistances = new Float32Array(this.keys.buffer);
            this.xyz = new Float32Array(padded * 3);
        }
        // The worker can reclaim its full ArrayBuffer synchronously after this function.
        this.original.set(data.subarray(this.start, this.start + padded));
        this.sorted.set(this.original.subarray(this.length), this.length);
        this.texture = texture;
        return true;
    }

    prepare() {
        const words = Math.ceil(this.end / 32);
        if (!this.bits || this.bits.length < words) {
            this.bits = new Uint32Array(words);
            this.summary = new Uint32Array(Math.ceil(words / 32));
        } else {
            this.bits.fill(0);
            this.summary.fill(0);
        }
        const { bits, summary, ids, xyz } = this;
        for (let i = 0; i < this.length; i++) {
            const id = this.original[i];
            const word = id >>> 5;
            const bit = 1 << (id & 31);
            if (id >= this.end || (bits[word] & bit)) return false;
            bits[word] |= bit;
            summary[word >>> 5] |= 1 << (word & 31);
        }

        // In each source interval, scan only 32-ID words that contain selected IDs.
        // Adjacent runs can share a partially occupied first or last word.
        const groups = [];
        let at = 0;
        let previous = -1;
        for (const run of this.runs) {
            const centers = this.placements[run.p].centers;
            for (let block = run.dst >>> 10; block <= ((run.end - 1) >>> 10); block++) {
                let occupied = summary[block];
                while (occupied) {
                    const word = block * 32 + 31 - Math.clz32(occupied & -occupied);
                    occupied &= occupied - 1;
                    let marks = bits[word];
                    while (marks) {
                        const bit = marks & -marks;
                        marks &= marks - 1;
                        const id = word * 32 + 31 - Math.clz32(bit);
                        if (id < run.dst || id >= run.end) continue;
                        bits[word] &= ~bit;
                        if (previous !== run.p) {
                            groups.push({ first: at, placement: this.placements[run.p] });
                            previous = run.p;
                        }
                        const src = (id - run.dst + run.src) * 3;
                        ids[at] = id;
                        xyz[at * 3] = centers[src];
                        xyz[at * 3 + 1] = centers[src + 1];
                        xyz[at * 3 + 2] = centers[src + 2];
                        at++;
                    }
                }
            }
        }
        if (at !== this.length) return false;
        groups.push({ first: at, placement: null });
        this.groups = groups;
        const count = GSplatSortBinWeights.bucketCount(this.state.totalActiveSplats, true);
        if (count !== this.histogram?.length) this.histogram = new Uint32Array(count);
        return true;
    }

    sort(position, nearClip) {
        let far = 0;
        for (const placement of this.placements) {
            const p = placement.inverse.transformPoint(position, placement.position);
            const { min, max, scale } = placement;
            const x = Math.max(Math.abs(min.x - p.x), Math.abs(max.x - p.x));
            const y = Math.max(Math.abs(min.y - p.y), Math.abs(max.y - p.y));
            const z = Math.max(Math.abs(min.z - p.z), Math.abs(max.z - p.z));
            far = Math.max(far, Math.sqrt(x * x + y * y + z * z) * scale);
        }
        if (!(far > 0) || !Number.isFinite(far)) return false;
        const { xyz, keys, squaredDistances, histogram, groups } = this;
        histogram.fill(0);
        for (let g = 0; g < groups.length - 1; g++) {
            const { position: local, scale } = groups[g].placement;
            const scaleSq = scale * scale;
            const x = local.x;
            const y = local.y;
            const z = local.z;
            for (let i = groups[g].first; i < groups[g + 1].first; i++) {
                const k = i * 3;
                const dx = xyz[k] - x;
                const dy = xyz[k + 1] - y;
                const dz = xyz[k + 2] - z;
                squaredDistances[i] = (dx * dx + dy * dy + dz * dz) * scaleSq;
            }
        }
        const near = GSplatSortBinWeights.logNearDistance(nearClip, far);
        this.weights.logSortKeys(near * near, far * far, keys, histogram, this.length);
        for (let i = 1; i < histogram.length; i++) histogram[i] += histogram[i - 1];
        for (let i = 0; i < this.length; i++) this.sorted[--histogram[keys[i]]] = this.ids[i];
        return true;
    }

    restore(workBuffer) {
        if (this.modified && this.texture === workBuffer.orderTexture) {
            workBuffer.uploadStream.upload(this.original, this.texture, this.start, this.original.length);
        }
        this.modified = false;
    }

    update(workBuffer, position, bound, near, eligible) {
        if (!this.texture || this.texture !== workBuffer.orderTexture) return false;
        // A false result makes the manager release this layout and its source centers immediately.
        if (!eligible || !bound || !(near > 0) || !this.validPlacements()) {
            this.restore(workBuffer);
            return false;
        }
        if (position.distance(bound) <= 4 * near) {
            this.restore(workBuffer);
            return true;
        }
        if (this.modified && position.distance(this.lastPosition) < 0.7 * near) return true;
        if (!this.prepared) this.prepared = this.prepare();
        if (!this.prepared || !this.sort(position, near)) {
            this.restore(workBuffer);
            this.forget();
            return false;
        }
        workBuffer.uploadStream.upload(this.sorted, this.texture, this.start, this.sorted.length);
        this.lastPosition.copy(position);
        this.modified = true;
        return true;
    }
}

export { GSplatNearOrder };
