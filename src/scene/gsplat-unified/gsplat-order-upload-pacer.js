const MB = 1024 * 1024;

/**
 * Chooses how much of the sorted order texture to upload per frame on WebGL.
 *
 * A browser forwards texture data to its GPU process through a buffer of limited size. An upload
 * that fits is queued and returns at once; a larger one blocks the main thread while the buffer
 * drains, and the time it blocks grows faster than the size. How much fits depends on the browser
 * and on the frame rate, so the slice size follows what the uploads are measured to cost: it
 * grows while they return quickly and shrinks as soon as one blocks.
 *
 * @ignore
 */
class GSplatOrderUploadPacer {
    /** Smallest and largest slice, in bytes. */
    static MIN_BYTES = 1 * MB;

    static MAX_BYTES = 16 * MB;

    /** A slice that returns within this many ms did not block: try a larger one. */
    static FAST_MS = 0.75;

    /** A slice that takes longer than this many ms blocked: back off. */
    static SLOW_MS = 2;

    /**
     * Current slice size in bytes.
     *
     * @type {number}
     */
    bytes = 3 * MB;

    /**
     * Size that last blocked. Growth stops short of it, so the pacer does not walk back into the
     * same stall every few frames.
     *
     * @type {number}
     * @private
     */
    _ceiling = GSplatOrderUploadPacer.MAX_BYTES;

    /**
     * Number of texture rows to upload in the next slice.
     *
     * @param {number} width - Texture width in texels.
     * @param {number} bytesPerTexel - Bytes per texel.
     * @returns {number} Row count, at least 1.
     */
    rows(width, bytesPerTexel) {
        return Math.max(1, Math.floor(this.bytes / (width * bytesPerTexel)));
    }

    /**
     * Records how long the last slice took and adjusts the size of the next.
     *
     * @param {number} ms - Time the upload call took.
     */
    record(ms) {
        if (ms > GSplatOrderUploadPacer.SLOW_MS) {
            // remember the size that blocked, and stay under it
            this._ceiling = this.bytes;
            this.bytes = Math.max(GSplatOrderUploadPacer.MIN_BYTES, this.bytes * 0.6);
        } else if (ms < GSplatOrderUploadPacer.FAST_MS) {
            // let the ceiling drift up, so a limit that has since risen is found again
            this._ceiling = Math.min(GSplatOrderUploadPacer.MAX_BYTES, this._ceiling * 1.002);
            this.bytes = Math.min(this.bytes * 1.25, this._ceiling * 0.9);
        }
    }
}

export { GSplatOrderUploadPacer };
