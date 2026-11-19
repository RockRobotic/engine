import { expect } from 'chai';

import { Mat4 } from '../../../src/core/math/mat4.js';
import { NullGraphicsDevice } from '../../../src/platform/graphics/null/null-graphics-device.js';
import { GSPLATDATA_LARGE } from '../../../src/scene/constants.js';
import { GraphNode } from '../../../src/scene/graph-node.js';
import { GSplatParams } from '../../../src/scene/gsplat-unified/gsplat-params.js';
import { GSplatQuadRenderer } from '../../../src/scene/gsplat-unified/gsplat-quad-renderer.js';
import { Layer } from '../../../src/scene/layer.js';
import { setDefaultMaterial } from '../../../src/scene/materials/default-material.js';
import { StandardMaterial } from '../../../src/scene/materials/standard-material.js';
import { gsplatChunksGLSL } from '../../../src/scene/shader-lib/glsl/collections/gsplat-chunks-glsl.js';
import { shaderChunksGLSL } from '../../../src/scene/shader-lib/glsl/collections/shader-chunks-glsl.js';
import { ProgramLibrary } from '../../../src/scene/shader-lib/program-library.js';
import { ShaderChunks } from '../../../src/scene/shader-lib/shader-chunks.js';

describe('GSplatQuadRenderer WebGL coverage eligibility', function () {
    let device, params, renderer, deviceChunks, materialChunks;

    beforeEach(function () {
        device = new NullGraphicsDevice();
        device.isWebGL2 = true;
        device.supportsSplatCoverage = true;
        deviceChunks = ShaderChunks.get(device).add(shaderChunksGLSL).add(gsplatChunksGLSL);
        setDefaultMaterial(device, new StandardMaterial());
        params = new GSplatParams(device);
        params.splatBudget = 50000000;
        materialChunks = params.material.getShaderChunks('glsl');
        const camera = new GraphNode();
        camera.camera = { fov: 60, projectionMatrix: new Mat4() };
        const workBuffer = { format: params.format, orderTexture: {}, getTexture: () => null, syncWithFormat() {} };
        renderer = new GSplatQuadRenderer(device, new GraphNode(), camera, new Layer(), workBuffer);
    });

    afterEach(function () {
        renderer.destroy();
        params.material.destroy();
        device.destroy();
    });

    const usesCoverage = () => {
        params.material.update();
        renderer.frameUpdate(params);
        return renderer.material.getDefine('GSPLAT_GL_COVERAGE');
    };

    it('accepts the built-in compact and packed readers, including mixed antialiasing', function () {
        expect(usesCoverage()).to.equal(true);
        params.dataFormat = GSPLATDATA_LARGE;
        renderer.workBuffer.format = params.format;
        renderer.onWorkBufferFormatChanged();
        // The manager resolves these flags from the resources and sets them before frameUpdate.
        renderer.setAntiAlias(true, true);
        expect(usesCoverage()).to.equal(true);
        expect(renderer.material.getDefine('GSPLAT_AA')).to.equal(true);
        expect(renderer.material.getDefine('GSPLAT_AA_MIXED')).to.equal(true);
    });

    it('requires the exact registered source after each material shader change', function () {
        const approved = gsplatChunksGLSL.gsplatModifyVS.replace('    // Example: center.y', '    center.y += 1.0; // center.y');
        const custom = `float count = 0.;\n${gsplatChunksGLSL.gsplatModifyVS.replace('inout vec3 center) {',
            'inout vec3 center) { count++; center.x += count;')}`;
        materialChunks.set('gsplatModifyVS', approved);
        expect(usesCoverage()).to.equal(false);
        params.coverageModifierGLSL = approved;
        expect(usesCoverage()).to.equal(true);
        materialChunks.set('gsplatModifyVS', `#define GSPLAT_COVERAGE_ALPHA_CAP\n${custom}`);
        expect(usesCoverage()).to.equal(false);
        materialChunks.set('gsplatModifyVS', approved);
        expect(usesCoverage()).to.equal(true);
        materialChunks.set('gsplatModifyPS', `${gsplatChunksGLSL.gsplatModifyPS}\n`);
        expect(usesCoverage()).to.equal(false);
    });

    it('falls back for a replaced reader or shader helper on the device', function () {
        deviceChunks.set('gsplatQuatToMat3VS', `${gsplatChunksGLSL.gsplatQuatToMat3VS}\n`);
        expect(usesCoverage()).to.equal(false);
        deviceChunks.set('gsplatQuatToMat3VS', gsplatChunksGLSL.gsplatQuatToMat3VS);
        expect(usesCoverage()).to.equal(true);
        deviceChunks.set('tonemappingAgxPS', `${shaderChunksGLSL.tonemappingAgxPS}\n`);
        expect(usesCoverage()).to.equal(false);
        deviceChunks.set('tonemappingAgxPS', shaderChunksGLSL.tonemappingAgxPS);
        expect(usesCoverage()).to.equal(true);
        renderer.material.getShaderChunks('glsl').set('gsplatReadVS', 'vec3 getCenter() { return vec3(0); }');
        expect(usesCoverage()).to.equal(false);
    });

    it('keeps a shader edited by a one-shot generation listener on the ordinary draw path', function () {
        const library = new ProgramLibrary(device);
        const options = { defines: new Map([['GSPLAT_GL_COVERAGE', true]]), shaderDesc: { uniqueName: 'UnifiedSplatMaterial' } };
        const vertex = '#version 300 es\nuniform uint splatCoverageStart;\nvoid main() { gl_Position=vec4(1.0); }';
        library.register('coverage', {
            generateKey: o => o.shaderDesc.uniqueName,
            createShaderDefinition: () => ({ vshader: vertex, fshader: 'void main() {}', attributes: {} })
        });
        const program = suffix => library.getProgram('coverage', options, { generateKey: () => suffix });
        expect(program('initial').splatClassifierSource).to.be.a('string');
        device.once('shader:generate', ({ definition }) => {
            definition.vshader = vertex.replace('vec4(1.0)', 'vec4(0.75)');
        });
        expect(program('edited').splatClassifierSource).to.equal(null);
        expect(program('reprocessed').splatClassifierSource).to.equal(null);
        options.shaderDesc.uniqueName = 'CustomMaterial';
        expect(program('custom').splatClassifierSource).to.equal(null);
        library.destroy();
    });

    it('falls back for a global modifier or material defines that can change rasterization', function () {
        deviceChunks.set('gsplatModifyVS', `${gsplatChunksGLSL.gsplatModifyVS}\n`);
        expect(usesCoverage()).to.equal(false);
        deviceChunks.set('gsplatModifyVS', gsplatChunksGLSL.gsplatModifyVS);
        params.material.setDefine('GSPLAT_CENTER_NOPROJ', true);
        expect(usesCoverage()).to.equal(false);
        params.material.setDefine('GSPLAT_CENTER_NOPROJ', false);
        expect(usesCoverage()).to.equal(true);
    });
});
