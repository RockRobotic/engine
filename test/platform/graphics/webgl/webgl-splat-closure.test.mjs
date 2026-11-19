import { expect } from 'chai';

import { PIXELFORMAT_RGB8, PIXELFORMAT_RGBA8 } from '../../../../src/platform/graphics/constants.js';
import { makeMask, makeResolve } from '../../../../src/platform/graphics/webgl/webgl-splat-coverage-shaders.js';
import { WebglSplatCoverage } from '../../../../src/platform/graphics/webgl/webgl-splat-coverage.js';

describe('WebGL splat color closure', function () {
    it('requires an opaque physical RGB8 default framebuffer', function () {
        const gl = {
            DRAW_FRAMEBUFFER_BINDING: 'fb',
            RED_BITS: 'r',
            GREEN_BITS: 'g',
            BLUE_BITS: 'b',
            ALPHA_BITS: 'a',
            attributes: { alpha: false },
            physical: { fb: null, r: 8, g: 8, b: 8, a: 0 },
            getContextAttributes() {
                return this.attributes;
            },
            getParameter(key) {
                return this.physical[key];
            }
        };
        const device = { gl, backBufferFormat: PIXELFORMAT_RGB8, defaultFramebuffer: null };
        const coverage = new WebglSplatCoverage(device);
        expect(coverage.isOpaqueRgb8()).to.equal(true);
        for (const [object, key, changed] of [
            [gl.attributes, 'alpha', true], [gl.physical, 'fb', {}], [gl.physical, 'r', 10],
            [gl.physical, 'g', 6], [gl.physical, 'b', 5], [gl.physical, 'a', 8],
            [device, 'backBufferFormat', PIXELFORMAT_RGBA8], [device, 'defaultFramebuffer', {}]
        ]) {
            const saved = object[key];
            object[key] = changed;
            expect(coverage.isOpaqueRgb8()).to.equal(false);
            object[key] = saved;
        }
    });

    it('uses the same endpoint predicate in masking and compositing', function () {
        const common = shader => shader.match(/bool covered\(vec4 lo, vec4 hi\) \{[^}]+\}/)[0];
        for (const opaque of [true, false]) {
            expect(common(makeMask(opaque))).to.equal(common(makeResolve(opaque)));
        }
        expect(common(makeMask(false))).to.include('all(equal(lo, hi))');
        expect(makeResolve(false)).to.include('color = lo;');
        expect(common(makeMask(true))).to.include('all(equal(lo.rgb, hi.rgb))');
        expect(makeResolve(true)).to.include('color = vec4(lo.rgb, 1.0);');
    });

    it('keeps native source-over monotone for every possible 8-bit destination', function () {
        // Exhaustive 8-bit source colors, opacities, and adjacent destination codes.
        for (let alpha = 0; alpha < 256; alpha++) {
            const remaining = 255 - alpha;
            for (let source = 0; source < 256; source++) {
                let current = Math.round(source * alpha / 255);
                for (let destination = 1; destination < 256; destination++) {
                    const next = Math.round((source * alpha + remaining * destination) / 255);
                    if (next < current) throw new Error('Source-over reversed the destination order');
                    current = next;
                }
            }
        }
    });
});
