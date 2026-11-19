import { expect } from 'chai';
import sinon from 'sinon';

import { BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA, CULLFACE_NONE, PIXELFORMAT_RGBA8 } from '../../../../src/platform/graphics/constants.js';
import { WebglSplatCoverage } from '../../../../src/platform/graphics/webgl/webgl-splat-coverage.js';
import { getCoverageRows } from '../../../../src/scene/gsplat-unified/gsplat-world-state.js';

function makeCoverage() {
    const gl = {};
    for (const name of ['createVertexArray', 'createTexture', 'createFramebuffer', 'createProgram']) gl[name] = () => ({});
    for (const name of ['bindTexture', 'texStorage2D', 'texParameteri', 'bindFramebuffer',
        'framebufferTexture2D', 'drawBuffers', 'deleteFramebuffer', 'deleteTexture', 'deleteProgram',
        'deleteVertexArray', 'deleteRenderbuffer']) gl[name] = () => {};
    gl.checkFramebufferStatus = () => 0;
    gl.FRAMEBUFFER_COMPLETE = 0;
    const coverage = new WebglSplatCoverage({ gl, _vram: { tex: 0 } });
    coverage.program = sinon.stub().callsFake((source, program) => ({ program }));
    return coverage;
}

describe('WebGL splat coverage', function () {
    it('snapshots and merges occupied framebuffer rows of the committed allocation', function () {
        const blocks = [{ offset: 11903, size: 120 }, { offset: 121, size: 20 }, { offset: 1103, size: 30 }];
        const rows = getCoverageRows(blocks.values(), 100);
        blocks[0].offset = 0;
        expect(rows).to.deep.equal([1, 2, 11, 12, 119, 121]);
        expect(getCoverageRows([{ offset: 99, size: 2 }, { offset: 973, size: 28 }], 100)).to.deep.equal([0, 11]);
    });

    it('leaves incompatible depth, blend, scissor and render targets on the ordinary draw', function () {
        const target = { width: 1280, height: 720, samples: 1 };
        const d = {
            gl: { TRIANGLES: 4 },
            backBuffer: target,
            backBufferFormat: PIXELFORMAT_RGBA8,
            renderTarget: target,
            vx: 0,
            vy: 0,
            vw: 1280,
            vh: 720,
            sx: 0,
            sy: 0,
            sw: 1280,
            sh: 720,
            depthState: { write: false },
            raster: true,
            cullMode: CULLFACE_NONE,
            blendState: {
                blend: true,
                allWrite: 15,
                colorOp: BLENDEQUATION_ADD,
                alphaOp: BLENDEQUATION_ADD,
                colorSrcFactor: BLENDMODE_ONE,
                alphaSrcFactor: BLENDMODE_ONE,
                colorDstFactor: BLENDMODE_ONE_MINUS_SRC_ALPHA,
                alphaDstFactor: BLENDMODE_ONE_MINUS_SRC_ALPHA
            }
        };
        const coverage = new WebglSplatCoverage(d);
        const canDraw = () => coverage.eligible(4, 768, 0, 32768);
        expect(canDraw()).to.be.true;
        for (const [object, key, value] of [[d.depthState, 'write', true], [d, 'stencil', true],
            [d, 'sw', 1279], [d, 'renderTarget', { ...target }], [target, 'samples', 4],
            [d.blendState, 'colorSrcFactor', BLENDMODE_ONE_MINUS_SRC_ALPHA], [d.blendState, 'allWrite', 7]]) {
            const previous = object[key];
            object[key] = value;
            expect(canDraw()).to.be.false;
            object[key] = previous;
        }
    });

    it('restores each overwritten material sampler exactly once', function () {
        const gl = { TEXTURE0: 32, TEXTURE_2D: 1, activeTexture: sinon.spy(), bindTexture: sinon.spy(), uniform1i: sinon.spy() };
        const textureUnits = Array.from({ length: 16 }, (_, i) => [i + 100]);
        const coverage = new WebglSplatCoverage({ gl, textureUnits });
        coverage.sample(null, 3, 200);
        coverage.sample(null, 15, 201);
        coverage.sample(null, 3, 202);
        gl.activeTexture.resetHistory();
        gl.bindTexture.resetHistory();

        coverage.restoreTextures();
        coverage.restoreTextures();
        expect(gl.activeTexture.args).to.deep.equal([[47], [35]]);
        expect(gl.bindTexture.args).to.deep.equal([[1, 115], [1, 103]]);
    });

    it('retains rounded live storage when the next sorted layout shrinks', function () {
        const coverage = makeCoverage();
        const first = coverage.ensureResources(1720, 1289, 7583, false, 4390, 33283846);
        expect(first.rowCapacity).to.equal(4608);
        expect(first.rankCapacity).to.equal(33554432);
        expect(coverage.ensureResources(1720, 1289, 7583, false, 4000, 12000000)).to.equal(first);
        const next = coverage.ensureResources(1720, 1289, 7583, false, 4900, 10000000);
        expect(next.rankCapacity).to.equal(first.rankCapacity);
        expect(next.rowCapacity).to.equal(5376);
        coverage.destroy();
        expect(coverage.device._vram.tex).to.equal(0);
    });

    it('reuses linked stages when streamed order capacity and atlas dimensions change', function () {
        const coverage = makeCoverage();
        const first = coverage.ensureResources(1720, 1289, 4000, false, 2500, 10000000);
        expect(coverage.program.callCount).to.equal(5);
        const next = coverage.ensureResources(1720, 1289, 4200, false, 3000, 14000000);
        expect(next).not.to.equal(first);
        expect(coverage.program.callCount).to.equal(5);
        expect(next.gather).to.equal(first.gather);
        const larger = coverage.ensureResources(1720, 1289, 8000, false, 5500, 42000000);
        expect(coverage.program.callCount).to.equal(6);
        expect(larger.gather).not.to.equal(next.gather);
        expect(larger.mask).to.equal(first.mask);
        const original = coverage.ensureResources(1720, 1289, 4000, false, 2500, 10000000);
        expect(original.gather).to.equal(first.gather);
        sinon.stub(coverage, 'isOpaqueRgb8').returns(true);
        const opaque = coverage.ensureResources(800, 600, 4000, false, 2500, 10000000);
        expect(opaque.gather).to.equal(first.gather);
        expect(opaque.mask).not.to.equal(first.mask);
        expect(opaque.resolve).not.to.equal(first.resolve);
        coverage.destroy();
    });

    it('releases all framebuffer storage and memory accounting once', function () {
        const gl = Object.fromEntries(['deleteProgram', 'deleteVertexArray', 'deleteRenderbuffer',
            'deleteTexture', 'deleteFramebuffer'].map(name => [name, sinon.spy()]));
        const device = { gl, _vram: { tex: 164 } };
        const coverage = new WebglSplatCoverage(device);
        coverage.resources = { bytes: 100, framebuffers: [1, 2], textures: [3, 4, 5], vao: 7, depth: 8 };
        coverage.stages.set('leaf', { program: 6 });
        coverage.classifiers.set(11, { program: 9 });
        coverage.destroy();
        coverage.destroy();
        expect(device._vram.tex).to.equal(64);
        expect(gl.deleteProgram.callCount).to.equal(2);
        expect(gl.deleteTexture.callCount).to.equal(3);
        expect(gl.deleteFramebuffer.callCount).to.equal(2);
        expect(gl.deleteRenderbuffer.callCount).to.equal(1);
        expect(gl.deleteVertexArray.callCount).to.equal(1);
    });
});
