import { EventHandler } from '../../core/event-handler.js';
import { platform } from '../../core/platform.js';
import { UnifiedSortWorker } from './gsplat-unified-sort-worker.js';
import { GSplatSortBinWeights } from './gsplat-sort-bin-weights.js';

/**
 * @import { Vec3 } from '../../core/math/vec3.js'
 * @import { GSplatInfo } from './gsplat-info.js'
 * @import { Scene } from '../scene.js'
 */

/** @type {Set<number>} */
const _neededIds = new Set();

class GSplatUnifiedSorter extends EventHandler {
    worker;

    bufferLength = 0;

    availableOrderData = [];

    // track how many jobs are in flight
    jobsInFlight = 0;

    // true if we have new version to process
    hasNewVersion = false;

    /**
     * Latest camera request for the current layout while a worker sort is running.
     *
     * @type {{ params: object[], radialSorting: boolean, nearClip: number, logDepthKeys: boolean, radialPosition: Vec3|null } | null}
     * @private
     */
    _deferredCamera = null;

    // Worker results arrive in dispatch order, including jobs queued by layout changes.
    /** @type {(Vec3|null)[]} */
    _sentPositions = [];

    /**
     * Pending sorted result to be applied next frame. If multiple sorted results are received from
     * the worker, the latest result is stored here.
     *
     * @type {{ count: number, version: number, orderData: Uint32Array, radialPosition: Vec3|null }|null}
     */
    pendingSorted = null;

    /**
     * The most recently applied sorted result. Its order data is kept out of the reuse pool, so it
     * can be applied again after a device restore, which loses the GPU copy of the order.
     *
     * @type {{ count: number, version: number, orderData: Uint32Array, radialPosition: Vec3|null }|null}
     */
    lastSorted = null;

    /** @type {Set<number>} */
    centersSet = new Set();

    /** @type {boolean} */
    _destroyed = false;

    /** @type {boolean} */
    _orderDataRetained = false;

    /** @type {Scene|null} */
    scene = null;

    /**
     * @param {Scene} [scene] - The scene to fire sort timing events on.
     */
    constructor(scene) {
        super();
        this.scene = scene ?? null;

        // Build worker source with GSplatSortBinWeights class injected via stringification.
        const workerPort = platform.environment === 'node' ? 'require("node:worker_threads").parentPort' : 'self';
        const workerSource = `
            const GSplatSortBinWeights = ${GSplatSortBinWeights.toString()};
            (${UnifiedSortWorker.toString()})(${workerPort})
        `;

        if (platform.environment === 'node') {
            this.worker = new Worker(workerSource, {
                eval: true
            });
            this.worker.on('message', this.onSorted.bind(this));
        } else {
            this.worker = new Worker(URL.createObjectURL(new Blob([workerSource], {
                type: 'application/javascript'
            })));
            this.worker.addEventListener('message', this.onSorted.bind(this));
        }
    }

    onSorted(message) {

        if (this._destroyed) {
            return;
        }

        const msgData = message.data ?? message;

        // Fire sortTime event directly on scene (before result might be dropped)
        if (this.scene && msgData.sortTime !== undefined) {
            this.scene.fire('gsplat:sorted', msgData.sortTime);
        }

        const orderData = new Uint32Array(msgData.order);

        // decrement jobs in flight counter
        this.jobsInFlight--;

        // if there's already a pending result, return its orderData to the pool, unless it is the
        // re-queued last result, which still owns it
        if (this.pendingSorted && this.pendingSorted !== this.lastSorted) {
            this.releaseOrderData(this.pendingSorted.orderData);
        }

        // store the result to be available
        this.pendingSorted = {
            count: msgData.count,
            version: msgData.version,
            orderData: orderData,
            radialPosition: this._sentPositions.shift() ?? null
        };

        // The camera may have come to rest while the worker was busy. Dispatch its latest
        // exact pose here; render-on-demand might never report another camera movement.
        if (this.jobsInFlight === 0 && this._deferredCamera) {
            const { params, radialSorting, nearClip, logDepthKeys, radialPosition } = this._deferredCamera;
            this.setSortParams(params, radialSorting, nearClip, logDepthKeys, radialPosition);
        }
    }

    /**
     * @param {boolean} [cacheForRestore] - Keep the order for a device restore. Streaming worlds
     * reload their source resources on restore and can return the order to the pool sooner.
     */
    applyPendingSorted(cacheForRestore = true) {
        const pending = this.pendingSorted;
        if (pending) {
            this.pendingSorted = null;
            this._orderDataRetained = false;
            this.fire('sorted', pending.count, pending.version, pending.orderData, pending.radialPosition);

            const previous = this.lastSorted;
            this.lastSorted = cacheForRestore ? pending : null;
            if (previous && previous !== pending) {
                this.releaseOrderData(previous.orderData);
            }
            if (!cacheForRestore && !this._orderDataRetained) {
                this.releaseOrderData(pending.orderData);
            }
        }
    }

    /**
     * Queues the most recently applied sorted result to be applied again on the next
     * {@link applyPendingSorted}. Used after a device restore, which loses the GPU copy of the
     * order, so the splats render without waiting for the worker to sort again. No-op when a newer
     * result is already pending.
     */
    reapplyLastSorted() {
        if (!this.pendingSorted && this.lastSorted) {
            this.pendingSorted = this.lastSorted;
        }
    }

    /**
     * Called from a 'sorted' handler to keep the order data it was given past the event, for an
     * upload that takes several frames. The handler returns it with {@link releaseOrderData} when
     * done, or simply drops it.
     */
    retainOrderData() {
        this._orderDataRetained = true;
    }

    releaseOrderData(orderData) {
        if (orderData !== this.lastSorted?.orderData && orderData.length === this.bufferLength) {
            this.availableOrderData.push(orderData);
        }
    }

    destroy() {
        this._destroyed = true;
        this._sentPositions.length = 0;
        this._deferredCamera = null;
        this.pendingSorted = null;
        this.lastSorted = null;
        this.worker.terminate();
        this.worker = null;
    }

    /**
     * Adds or removes centers from the sorter.
     *
     * @param {number} id - The id of the centers.
     * @param {Float32Array|null} centers - The centers buffer.
     */
    setCenters(id, centers) {

        if (centers) { // add

            if (!this.centersSet.has(id)) {
                this.centersSet.add(id);

                // clone centers buffer - required when multiple workers sort the same splat resource
                const centersBuffer = centers.buffer.slice();

                // post centers to worker
                this.worker.postMessage({
                    command: 'addCenters',
                    id: id,
                    centers: centersBuffer
                }, [centersBuffer]);
            }

        } else { // remove

            if (this.centersSet.has(id)) {
                this.centersSet.delete(id);

                // post centers to worker
                this.worker.postMessage({
                    command: 'removeCenters',
                    id: id
                });
            }
        }
    }

    /**
     * Updates centers in the worker based on current splats.
     * Adds new centers and removes centers no longer needed.
     *
     * @param {GSplatInfo[]} splats - Array of active splat infos.
     */
    updateCentersForSplats(splats) {

        // collect resource IDs from current splats
        for (const splat of splats) {
            const id = splat.resource.id;
            _neededIds.add(id);

            // add centers if not already present
            if (!this.centersSet.has(id)) {
                this.setCenters(id, splat.resource.centers);
            }
        }

        // remove centers no longer needed
        for (const id of this.centersSet) {
            if (!_neededIds.has(id)) {
                this.setCenters(id, null);
            }
        }

        _neededIds.clear();
    }

    /**
     * Sets sort parameters data for sorting of splats.
     *
     * @param {object} payload - The sort parameters payload to send.
     */
    setSortParameters(payload) {

        // we have a new version to process
        this.hasNewVersion = true;
        this._deferredCamera = null; // sortParams are ordered by the previous layout's placements

        // The sorted sequence is dense even when the source atlas contains free blocks.
        // Pad only its last row so WebGL can upload the complete rectangle directly.
        const { textureSize, totalActiveSplats = textureSize * textureSize } = payload;
        const newLength = Math.ceil(totalActiveSplats / textureSize) * textureSize;
        if (newLength !== this.bufferLength) {
            this.bufferLength = newLength;
            this.availableOrderData.length = 0;
        }

        this.worker.postMessage(payload);
    }

    /**
     * Sends sorting parameters to the sorter. Called every frame sorting is needed.
     *
     * @param {object[]} params - The sorting parameters - per-splat directions, offsets, scales, AABBs.
     * @param {boolean} radialSorting - Whether to use radial distance sorting.
     * @param {number} nearClip - The camera's near clip distance, which log spaced sort keys start
     * inside of.
     * @param {boolean} logDepthKeys - Whether a directional sort's keys are log spaced, which needs
     * a perspective, non-fisheye camera (radial sort keys always are).
     * @param {Vec3|null} [radialPosition] - World-space camera snapshot for a radial sort.
     * @returns {boolean} True when the camera request has been sent or queued for the worker.
     */
    setSortParams(params, radialSorting, nearClip, logDepthKeys, radialPosition = null) {

        if (this.hasNewVersion || this.jobsInFlight === 0) {
            this._deferredCamera = null;

            // reuse or allocate new order data
            let orderData = this.availableOrderData.pop();
            if (!orderData) {
                orderData = new Uint32Array(this.bufferLength);
            }

            // worker management
            this.jobsInFlight++;
            this._sentPositions.push(radialPosition);
            this.hasNewVersion = false;

            // send job to worker
            this.worker.postMessage({
                command: 'sort',
                sortParams: params,
                radialSorting: radialSorting,
                nearClip: nearClip,
                logDepthKeys: logDepthKeys,
                order: orderData.buffer
            }, [
                orderData.buffer
            ]);
        } else {
            this._deferredCamera = { params, radialSorting, nearClip, logDepthKeys, radialPosition };
        }
        return true;
    }
}

export { GSplatUnifiedSorter };
