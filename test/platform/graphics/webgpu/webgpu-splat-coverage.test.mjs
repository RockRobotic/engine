import { expect } from 'chai';
import sinon from 'sinon';

import { WebgpuShaderProcessorWGSL } from '../../../../src/platform/graphics/webgpu/webgpu-shader-processor-wgsl.js';
import { WebgpuSplatCoverage } from '../../../../src/platform/graphics/webgpu/webgpu-splat-coverage.js';

describe('WebGPU splat coverage', function () {
    it('initializes interpolated inputs for both native color entry points', function () {
        const code = [
            '@fragment fn fragmentMain(color: FragmentInput) -> FragmentOutput { return shade(); }',
            '@fragment fn splatCoverageMain(bounds: FragmentInput) -> CoverageOutput { return shadeBounds(); }'
        ].join('\n');
        const result = WebgpuShaderProcessorWGSL.copyInputs(code, {});
        expect(result).to.include('_pcCopyInputs(color);');
        expect(result).to.include('_pcCopyInputs(bounds);');
    });

    it('leaves other render passes and custom mesh layouts on the regular draw path', function () {
        const device = { splatCoveragePass: false, depthState: { write: false }, _coverageBindings: [] };
        const coverage = new WebgpuSplatCoverage(device);
        coverage.instanceSize = 128;
        expect(coverage.draw(null, 768)).to.equal(false);
        device.splatCoveragePass = true;
        expect(coverage.draw(null, 768)).to.equal(false);
        device._coverageBindings[2] = { owner: { storageBuffers: [] } };
        expect(coverage.draw(null, 768)).to.equal(false);
    });

    it('releases all owned resources without releasing world, projector or sorter inputs', function () {
        const device = { deferDestroy: sinon.spy() };
        const coverage = new WebgpuSplatCoverage(device);
        const inputs = Array.from({ length: 4 }, () => ({}));
        coverage.setInputs(...inputs, 128);
        const owned = [{}, {}, {}];
        coverage.owned.push(...owned);
        coverage.resources = { capacity: 4 };
        coverage.destroy();
        coverage.destroy();
        expect(device.deferDestroy.getCalls().map(call => call.args[0])).to.deep.equal(owned);
        expect(coverage.resources).to.equal(null);
    });
});
