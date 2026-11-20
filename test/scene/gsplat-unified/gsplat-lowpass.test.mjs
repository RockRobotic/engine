import { expect } from 'chai';

import { Preprocessor } from '../../../src/core/preprocessor.js';
import { computeGsplatCommonSource as projector } from '../../../src/scene/shader-lib/wgsl/chunks/gsplat/compute-gsplat-common.js';
import corner from '../../../src/scene/shader-lib/wgsl/chunks/gsplat/vert/gsplatCorner.js';

describe('WebGPU splat screen-space filter', function () {
    for (const [path, chunk] of Object.entries({ projector, corner })) {
        it(`opts in to a custom draw variance in the ${path}, retaining the trained AA filter`, function () {
            const includes = new Map([['halfTypesCS', '']]);
            const custom = 'getSplatLowpassVariance(';
            const defaults = Preprocessor.run(chunk, includes);
            expect(defaults).not.to.include(custom);

            const shader = Preprocessor.run(`#define GSPLAT_CUSTOM_LOWPASS\n#define GSPLAT_AA\n${chunk}`, includes);
            const trained = path === 'projector' ? 'lowpass = 4.0 * antiAliasFilterSize;' : 'lowpass = 4.0 * uniform.antiAliasFilterSize;';
            expect(shader).to.include(custom);
            expect(shader).to.include(trained);
            expect(shader.indexOf(custom)).to.be.lessThan(shader.indexOf(trained));
        });
    }
});
