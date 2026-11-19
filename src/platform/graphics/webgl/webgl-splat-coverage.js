import { Debug } from '../../../core/debug.js';
import { BLENDEQUATION_ADD, BLENDMODE_ONE, BLENDMODE_ONE_MINUS_SRC_ALPHA, CULLFACE_NONE, PIXELFORMAT_RGB8, PIXELFORMAT_RGBA8 } from '../constants.js';
import { WebglShaderProcessorGLSL } from './webgl-shader-processor-glsl.js';
import { leafSize, fullscreen, makeMask, leaf, reduce, makeGather, makeResolve } from './webgl-splat-coverage-shaders.js';

const orderLayouts = new WeakMap();
const chunkSize = 2048 * 2048;
const zero = new Float32Array(4);
const one = new Float32Array([1, 1, 1, 1]);

// A native RGBA8 source-over operation is monotone in the destination. Where the
// front suffix bounds both endpoints, it bounds every possible background and
// every more distant splat. The mask and resolve use the same endpoint test.
class WebglSplatCoverage {
    static bindRows(texture, width, rows) {
        if (rows) {
            orderLayouts.set(texture, { width, rows });
        } else {
            orderLayouts.delete(texture);
        }
    }

    constructor(device) {
        this.device = device;
        this.gl = device.gl;
        this.classifiers = new Map();
        this.incompatibleShaders = new WeakSet();
        this.read = new Uint32Array(4);
        this.resources = null;
        this.failed = false;
        this.dirtyTextureUnits = 0;
    }

    eligible(mode, count, offset, instances) {
        const d = this.device;
        const target = d.renderTarget ?? d.backBuffer;
        const state = d.blendState;
        return mode === this.gl.TRIANGLES && count === 768 && offset === 0 && instances >= 32768 &&
            target === d.backBuffer && !d.activeFramebuffer && target.samples === 1 &&
            (d.backBufferFormat === PIXELFORMAT_RGBA8 || d.backBufferFormat === PIXELFORMAT_RGB8) &&
            d.vx === 0 && d.vy === 0 && d.vw === target.width && d.vh === target.height &&
            d.sx === 0 && d.sy === 0 && d.sw === target.width && d.sh === target.height &&
            !d.stencil && !d.depthState.write && !d.alphaToCoverage && d.raster &&
            !d.depthBiasEnabled && d.cullMode === CULLFACE_NONE && !d.transformFeedbackBuffers &&
            state.blend && state.allWrite === 15 && !state.hasAttachmentOverrides &&
            state.colorOp === BLENDEQUATION_ADD && state.alphaOp === BLENDEQUATION_ADD &&
            state.colorSrcFactor === BLENDMODE_ONE && state.alphaSrcFactor === BLENDMODE_ONE &&
            state.colorDstFactor === BLENDMODE_ONE_MINUS_SRC_ALPHA && state.alphaDstFactor === BLENDMODE_ONE_MINUS_SRC_ALPHA;
    }

    program(fragment, programs) {
        const gl = this.gl;
        const program = gl.createProgram();
        programs.push(program);
        for (const [type, source] of [[gl.VERTEX_SHADER, fullscreen], [gl.FRAGMENT_SHADER, fragment]]) {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            gl.attachShader(program, shader);
            gl.deleteShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
        }
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        const uniforms = {};
        for (let i = 0; i < gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); ++i) {
            const { name } = gl.getActiveUniform(program, i);
            uniforms[name] = gl.getUniformLocation(program, name);
        }
        return { program, uniforms };
    }

    classifier(shader) {
        const gl = this.gl;
        const native = shader.impl.glProgram;
        if (this.incompatibleShaders.has(native)) return null;
        let result = this.classifiers.get(native);
        if (result) return result;
        const programs = [];
        try {
            const fragment = shader.splatClassifierSource;
            const definition = shader.definition;
            const source = definition.processingOptions ?
                WebglShaderProcessorGLSL.run(this.device, { ...definition, vshader: fullscreen, fshader: fragment }, shader).fshader : fragment;
            result = this.program(source, programs);
            for (let i = 0; i < gl.getProgramParameter(result.program, gl.ACTIVE_UNIFORM_BLOCKS); i++) {
                const name = gl.getActiveUniformBlockName(result.program, i);
                const origin = gl.getUniformBlockIndex(native, name);
                if (origin === gl.INVALID_INDEX) throw new Error('Missing coverage uniform block');
                gl.uniformBlockBinding(result.program, i, gl.getActiveUniformBlockParameter(native, origin, gl.UNIFORM_BLOCK_BINDING));
            }
            // Use the same typed uniform uploaders and scopes as the material shader.
            result.uniformsToCommit = shader.impl.uniforms.filter(uniform => result.uniforms[uniform.scopeId.name]).map(uniform => ({
                ...uniform, value: [null, null, null, null], locationId: result.uniforms[uniform.scopeId.name]
            }));
            result.samplers = shader.impl.samplers.filter(sampler => result.uniforms[sampler.scopeId.name]).map(sampler => ({
                source: sampler, location: result.uniforms[sampler.scopeId.name]
            }));
            result.order = shader.impl.samplers.find(sampler => sampler.scopeId.name === 'splatOrder');
            if (!result.order) throw new Error('Missing sorted splat order');
            result.start = gl.getUniformLocation(native, 'splatCoverageStart');
            result.compact = gl.getUniformLocation(native, 'splatCompactCount');
            this.classifiers.set(native, result);
            return result;
        } catch (error) {
            programs.forEach(program => gl.deleteProgram(program));
            this.incompatibleShaders.add(native);
            Debug.warnOnce(`WebGL splat classifier unavailable: ${error.message}`);
            return null;
        }
    }

    releaseClassifier(program) {
        const result = this.classifiers.get(program);
        if (result) {
            this.gl.deleteProgram(result.program);
            this.classifiers.delete(program);
        }
    }

    releaseResources() {
        const r = this.resources;
        if (!r) return;
        const gl = this.gl;
        r.framebuffers.forEach(framebuffer => gl.deleteFramebuffer(framebuffer));
        r.textures.forEach(texture => gl.deleteTexture(texture));
        r.programs.forEach(program => gl.deleteProgram(program));
        gl.deleteVertexArray(r.vao);
        gl.deleteRenderbuffer(r.depth);
        this.device._vram.tex -= r.bytes;
        this.resources = null;
    }

    destroy() {
        this.releaseResources();
        this.classifiers.forEach(result => this.gl.deleteProgram(result.program));
        this.classifiers.clear();
    }

    isOpaqueRgb8() {
        const d = this.device;
        const gl = this.gl;
        return d.backBufferFormat === PIXELFORMAT_RGB8 && !d.defaultFramebuffer &&
            gl.getContextAttributes()?.alpha === false && gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) === null &&
            gl.getParameter(gl.RED_BITS) === 8 && gl.getParameter(gl.GREEN_BITS) === 8 &&
            gl.getParameter(gl.BLUE_BITS) === 8 && gl.getParameter(gl.ALPHA_BITS) === 0;
    }

    ensureResources(width, height, atlas, depth, liveRows, activeRanks) {
        let r = this.resources;
        const { backBufferFormat, defaultFramebuffer } = this.device;
        const sameScreen = r?.width === width && r.backBufferFormat === backBufferFormat &&
            r.defaultFramebuffer === defaultFramebuffer && r.height === height && r.atlas === atlas && !!r.depth === depth;
        if (sameScreen && r.rowCapacity >= liveRows && r.rankCapacity >= activeRanks) return r;

        // Stream layouts usually leave an empty tail in a much larger square atlas.
        // Round growth and retain the previous capacities when the next layout shrinks.
        const priorRows = sameScreen ? r.rowCapacity : 0;
        const priorRanks = sameScreen ? r.rankCapacity : 0;
        const rowGoal = liveRows > priorRows ? Math.max(liveRows, priorRows * 1.125) : priorRows;
        const rankGoal = activeRanks > priorRanks ? Math.max(activeRanks, priorRanks * 1.125) : priorRanks;
        const rowCapacity = Math.min(atlas, Math.ceil(rowGoal / 256) * 256);
        const rankCapacity = Math.min(atlas * atlas, Math.ceil(rankGoal / 1048576) * 1048576);
        this.releaseResources();
        const gl = this.gl;
        // Query the physical default framebuffer before binding a coverage target.
        const opaqueRgb8 = this.isOpaqueRgb8();
        r = { width,
            backBufferFormat,
            defaultFramebuffer,
            height,
            atlas,
            visibilityWidth: Math.ceil(atlas / 4),
            rowCapacity,
            rankCapacity,
            textures: [],
            framebuffers: [],
            programs: [],
            bytes: 0,
            vao: gl.createVertexArray(),
            depth: null };
        this.resources = r;
        const account = (bytes) => {
            r.bytes += bytes;
            this.device._vram.tex += bytes;
        };
        const texture = (format, w, h, stride) => {
            const t = gl.createTexture();
            r.textures.push(t);
            this.dirtyTextureUnits |= 1;
            gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texStorage2D(gl.TEXTURE_2D, 1, format, w, h);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
            account(w * h * stride);
            return t;
        };
        const framebuffer = (...textures) => {
            const fb = gl.createFramebuffer();
            r.framebuffers.push(fb);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
            const attachments = textures.map((t, i) => {
                const attachment = gl.COLOR_ATTACHMENT0 + i;
                gl.framebufferTexture2D(gl.DRAW_FRAMEBUFFER, attachment, gl.TEXTURE_2D, t, 0);
                return attachment;
            });
            gl.drawBuffers(attachments);
            if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete splat coverage target');
            return fb;
        };
        r.lower = texture(gl.RGBA8, width, height, 4);
        r.upper = texture(gl.RGBA8, width, height, 4);
        r.front = framebuffer(r.lower, r.upper);
        if (depth) {
            // ANGLE Metal exposes the default 24-bit depth buffer as a packed
            // depth/stencil attachment even when the context requests no stencil.
            r.depth = gl.createRenderbuffer();
            gl.bindRenderbuffer(gl.RENDERBUFFER, r.depth);
            gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, width, height);
            gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, r.depth);
            if (gl.checkFramebufferStatus(gl.DRAW_FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete splat coverage depth target');
            account(width * height * 4);
        }
        r.tiles = texture(gl.R16UI, Math.ceil(width / 4), Math.ceil(height / 4), 2);
        r.maskTarget = framebuffer(r.tiles);
        r.visibility = texture(gl.R8UI, r.visibilityWidth, rowCapacity, 1);
        r.visibilityTarget = framebuffer(r.visibility);
        r.levels = [];
        let length = Math.ceil(rankCapacity / leafSize);
        while (true) {
            const w = Math.min(1024, length);
            const h = Math.ceil(length / w);
            // A leaf is an eight-bit presence mask. Preserve upper prefix counts
            // exactly in the smallest native unsigned format that can hold them.
            const maxCount = leafSize * (4 ** r.levels.length);
            const format = r.levels.length === 0 ? gl.R8UI :
                (maxCount <= 255 ? gl.RGBA8UI : (maxCount <= 65535 ? gl.RGBA16UI : gl.RGBA32UI));
            const stride = r.levels.length === 0 ? 1 : (maxCount <= 255 ? 4 : (maxCount <= 65535 ? 8 : 16));
            const t = texture(format, w, h, stride);
            r.levels.push({ texture: t, framebuffer: framebuffer(t), width: w, height: h, length });
            if (length === 1) break;
            length = Math.ceil(length / 4);
        }
        r.packed = texture(gl.R32UI, 2048, 2048, 4);
        r.packedTarget = framebuffer(r.packed);
        r.mask = this.program(makeMask(opaqueRgb8), r.programs);
        r.leaf = this.program(leaf, r.programs);
        r.reduce = this.program(reduce, r.programs);
        r.gather = this.program(makeGather(r.levels), r.programs);
        r.resolve = this.program(makeResolve(opaqueRgb8), r.programs);
        return r;
    }

    target(fb, width, height, stage) {
        const gl = this.gl;
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fb);
        gl.viewport(0, 0, width, height);
        gl.useProgram(stage.program);
        return stage.uniforms;
    }

    sample(location, unit, texture) {
        const gl = this.gl;
        this.dirtyTextureUnits |= 1 << unit;
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.uniform1i(location, unit);
    }

    restoreTextures() {
        const gl = this.gl;
        // Most passes touch just one or two slots. Rebind precisely those
        // slots before returning to the material's texture bindings.
        let dirty = this.dirtyTextureUnits;
        while (dirty) {
            const unit = 31 - Math.clz32(dirty);
            gl.activeTexture(gl.TEXTURE0 + unit);
            gl.bindTexture(gl.TEXTURE_2D, this.device.textureUnits[unit][0]);
            dirty ^= 1 << unit;
        }
        this.dirtyTextureUnits = 0;
    }

    countSurvivors(r, originalOrder, count) {
        const gl = this.gl;
        let level = r.levels[0];
        let length = Math.ceil(count / leafSize);
        let u = this.target(level.framebuffer, level.width, Math.ceil(length / level.width), r.leaf);
        this.sample(u.originalOrder, 0, originalOrder);
        this.sample(u.visibility, 1, r.visibility);
        gl.uniform1ui(u.atlas, r.atlas);
        gl.uniform1ui(u.count, count);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        for (let i = 1; i < r.levels.length; ++i) {
            const child = level;
            level = r.levels[i];
            const childLength = length;
            length = Math.ceil(length / 4);
            u = this.target(level.framebuffer, level.width, Math.ceil(length / level.width), r.reduce);
            this.sample(u.children, 0, child.texture);
            gl.uniform1i(u.childIsLeaf, i === 1);
            gl.uniform1ui(u.childCount, childLength);
            gl.uniform1ui(u.childWidth, child.width);
            gl.uniform1ui(u.outWidth, level.width);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
        }
        // WebGL2 has no indirect draw count. Reading only the four prefix
        // endpoints allows the remaining draw to submit precisely its survivors.
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, level.framebuffer);
        gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, this.read);
        return this.read[3];
    }

    draw(shader, mode, count, format, offset, instances) {
        if (this.failed || !this.eligible(mode, count, offset, instances)) return false;
        const d = this.device;
        const gl = this.gl;
        if (this.colorTarget !== d.backBuffer) {
            this.colorTarget = d.backBuffer;
            const alpha = gl.getParameter(gl.ALPHA_BITS);
            const encoding = gl.getFramebufferAttachmentParameter(gl.DRAW_FRAMEBUFFER, gl.BACK, gl.FRAMEBUFFER_ATTACHMENT_COLOR_ENCODING);
            this.depthBits = gl.getParameter(gl.DEPTH_BITS);
            this.colorCompatible = gl.getParameter(gl.SAMPLE_BUFFERS) === 0 &&
                gl.getParameter(gl.RED_BITS) === 8 && gl.getParameter(gl.GREEN_BITS) === 8 &&
                gl.getParameter(gl.BLUE_BITS) === 8 && (alpha === 0 || alpha === 8) && encoding === gl.LINEAR;
        }
        if (!this.colorCompatible) return false;
        const view = d.scope.resolve('viewport_size').value;
        if (view && ((view[0] ?? view.x) !== d.vw || (view[1] ?? view.y) !== d.vh)) return false;
        const size = d.scope.resolve('splatTextureSize').value;
        const numSplats = d.scope.resolve('numSplats').value;
        if (!size || numSplats > size * size || Math.ceil(numSplats / 128) !== instances) return false;
        if (gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING) || gl.getParameter(gl.PACK_SKIP_PIXELS) ||
            gl.getParameter(gl.PACK_SKIP_ROWS) || gl.getParameter(gl.PACK_ROW_LENGTH)) return false;

        const readTarget = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
        const renderbuffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
        const depth = gl.isEnabled(gl.DEPTH_TEST);
        if (depth && this.depthBits !== (d.backBuffer.depth ? 24 : 0)) return false;
        const scissor = gl.isEnabled(gl.SCISSOR_TEST);
        const dither = gl.isEnabled(gl.DITHER);
        const native = shader.impl.glProgram;
        let classifier;
        try {
            classifier = this.classifier(shader);
            if (!classifier) return false;
            // Source data and order must remain available during classification;
            // the top fragment sampler is reserved solely for the proof mask.
            // Implicit LOD in a custom vertex modifier samples the base level. A
            // fragment invocation may choose another mip when derivatives are available.
            if (classifier.samplers.some(({ source }) => source.slot >= 15 || source.scopeId.value?.mipmaps) ||
                classifier.order.slot >= 16) return false;
            gl.activeTexture(gl.TEXTURE0);
            const layout = orderLayouts.get(classifier.order.scopeId.value);
            const rows = layout?.width === size && layout.rows.length ? layout.rows : null;
            const r = this.ensureResources(d.vw, d.vh, size, depth && d.backBuffer.depth, rows?.at(-1) ?? size, numSplats);
            this.restoreTextures();
            const originalOrder = d.textureUnits[classifier.order.slot][0];
            gl.useProgram(native);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, r.front);
            gl.disable(gl.SCISSOR_TEST);
            if (r.depth) {
                gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
                gl.blitFramebuffer(0, 0, r.width, r.height, 0, 0, r.width, r.height, gl.DEPTH_BUFFER_BIT, gl.NEAREST);
                if (!r.depthVerified) {
                    if (gl.getError() !== gl.NO_ERROR) throw new Error('Incompatible default framebuffer depth');
                    r.depthVerified = true;
                }
            }
            gl.clearBufferfv(gl.COLOR, 0, zero);
            gl.clearBufferfv(gl.COLOR, 1, one);
            const front = Math.ceil(instances / 16);
            gl.uniform1ui(classifier.start, (instances - front) * 128);
            gl.drawElementsInstanced(mode, count, format, offset, front);
            gl.uniform1ui(classifier.start, 0);

            gl.disable(gl.BLEND);
            gl.disable(gl.DEPTH_TEST);
            gl.bindVertexArray(r.vao);
            let u = this.target(r.maskTarget, Math.ceil(r.width / 4), Math.ceil(r.height / 4), r.mask);
            this.sample(u.lower, 14, r.lower);
            this.sample(u.upper, 15, r.upper);
            gl.drawArrays(gl.TRIANGLES, 0, 3);

            this.restoreTextures();
            u = this.target(r.visibilityTarget, r.visibilityWidth, r.rowCapacity, classifier);
            this.sample(u.coverageTiles, 15, r.tiles);
            for (const { source, location } of classifier.samplers) gl.uniform1i(location, source.slot);
            for (const uniform of classifier.uniformsToCommit) {
                const value = uniform.scopeId.value;
                if (value !== undefined && value !== null) d.commitFunction[uniform.dataType](uniform, value);
            }
            if (rows) {
                for (let i = 0; i < rows.length; i += 2) {
                    const first = rows[i];
                    gl.viewport(0, first, r.visibilityWidth, rows[i + 1] - first);
                    gl.drawArrays(gl.TRIANGLES, 0, 3);
                }
            } else {
                gl.drawArrays(gl.TRIANGLES, 0, 3);
            }
            const survivors = this.countSurvivors(r, originalOrder, numSplats);
            if (survivors > numSplats) throw new Error('Splat coverage count exceeds the source count');
            for (let first = 0; first < survivors; first += chunkSize) {
                const length = Math.min(chunkSize, survivors - first);
                gl.disable(gl.BLEND);
                gl.disable(gl.DEPTH_TEST);
                gl.bindVertexArray(r.vao);
                u = this.target(r.packedTarget, 2048, Math.ceil(length / 2048), r.gather);
                for (let i = 0; i < r.levels.length; ++i) this.sample(u[`level${i}`], i, r.levels[i].texture);
                this.sample(u.originalOrder, r.levels.length, originalOrder);
                gl.uniform1ui(u.atlas, size);
                gl.uniform1ui(u.count, length);
                gl.uniform1ui(u.first, first);
                gl.drawArrays(gl.TRIANGLES, 0, 3);

                gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
                gl.viewport(0, 0, r.width, r.height);
                gl.bindVertexArray(d.boundVao);
                gl.useProgram(native);
                this.restoreTextures();
                gl.activeTexture(gl.TEXTURE0 + classifier.order.slot);
                this.dirtyTextureUnits |= 1 << classifier.order.slot;
                gl.bindTexture(gl.TEXTURE_2D, r.packed);
                if (depth) gl.enable(gl.DEPTH_TEST);
                gl.enable(gl.BLEND);
                gl.uniform1ui(classifier.compact, length);
                gl.drawElementsInstanced(mode, count, format, offset, Math.ceil(length / 128));
                gl.uniform1ui(classifier.compact, 0);
            }

            gl.disable(gl.DEPTH_TEST);
            gl.disable(gl.BLEND);
            gl.disable(gl.DITHER);
            gl.bindVertexArray(r.vao);
            u = this.target(null, r.width, r.height, r.resolve);
            this.sample(u.lower, 14, r.lower);
            this.sample(u.upper, 15, r.upper);
            gl.drawArrays(gl.TRIANGLES, 0, 3);
            return true;
        } catch (error) {
            Debug.warnOnce(`WebGL splat coverage unavailable: ${error.message}`);
            this.failed = true;
            this.releaseResources();
            return false;
        } finally {
            gl.bindFramebuffer(gl.READ_FRAMEBUFFER, readTarget);
            gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
            gl.bindRenderbuffer(gl.RENDERBUFFER, renderbuffer);
            gl.viewport(d.vx, d.vy, d.vw, d.vh);
            gl.bindVertexArray(d.boundVao);
            gl.useProgram(native);
            if (classifier) {
                gl.uniform1ui(classifier.start, 0);
                gl.uniform1ui(classifier.compact, 0);
            }
            gl.enable(gl.BLEND);
            if (scissor) gl.enable(gl.SCISSOR_TEST);
            if (depth) gl.enable(gl.DEPTH_TEST);
            if (dither) gl.enable(gl.DITHER);
            this.restoreTextures();
            gl.activeTexture(gl.TEXTURE0 + d.textureUnit);
        }
    }
}

export { WebglSplatCoverage };
