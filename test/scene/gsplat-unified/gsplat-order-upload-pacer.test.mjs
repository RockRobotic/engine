import { expect } from 'chai';

import { GSplatOrderUploadPacer } from '../../../src/scene/gsplat-unified/gsplat-order-upload-pacer.js';

const MB = 1024 * 1024;

describe('GSplatOrderUploadPacer', function () {

    it('converts its byte size to whole rows, never fewer than one', function () {
        const pacer = new GSplatOrderUploadPacer();
        pacer.bytes = 3 * MB;
        // 2816 texels of 4 bytes is 11264 bytes a row
        expect(pacer.rows(2816, 4)).to.equal(Math.floor(3 * MB / 11264));
        pacer.bytes = 100;
        expect(pacer.rows(2816, 4)).to.equal(1);
    });

    it('grows while uploads return quickly', function () {
        const pacer = new GSplatOrderUploadPacer();
        const before = pacer.bytes;
        pacer.record(0.3);
        expect(pacer.bytes).to.be.above(before);
    });

    it('backs off when an upload blocks', function () {
        const pacer = new GSplatOrderUploadPacer();
        const before = pacer.bytes;
        pacer.record(5);
        expect(pacer.bytes).to.be.below(before);
    });

    it('holds its size for an upload that neither returned at once nor blocked', function () {
        const pacer = new GSplatOrderUploadPacer();
        const before = pacer.bytes;
        pacer.record(1.2);
        expect(pacer.bytes).to.equal(before);
    });

    it('stays within its bounds', function () {
        const pacer = new GSplatOrderUploadPacer();
        for (let i = 0; i < 100; i++) pacer.record(0);
        expect(pacer.bytes).to.be.at.most(GSplatOrderUploadPacer.MAX_BYTES);
        expect(pacer.bytes).to.be.above(12 * MB);
        for (let i = 0; i < 100; i++) pacer.record(50);
        expect(pacer.bytes).to.equal(GSplatOrderUploadPacer.MIN_BYTES);
    });

    it('settles near the largest size that does not block', function () {
        // a browser that queues up to 4 MB and blocks beyond it
        const pacer = new GSplatOrderUploadPacer();
        const sizes = [];
        let blockedInTail = 0;
        for (let i = 0; i < 200; i++) {
            const blocked = pacer.bytes > 4 * MB;
            if (blocked && i >= 100) blockedInTail++;
            pacer.record(blocked ? 6 : 0.3);
            sizes.push(pacer.bytes);
        }
        const tail = sizes.slice(-100);
        expect(Math.max(...tail)).to.be.below(5 * MB);
        expect(Math.min(...tail)).to.be.above(2 * MB);
        // it probes the limit now and then, it does not run into it every few frames
        expect(blockedInTail).to.be.below(8);
    });
});
