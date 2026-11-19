import * as shaders from './webgpu-splat-coverage-shaders.js';

/**
 * @import { WebgpuGraphicsDevice } from './webgpu-graphics-device.js'
 * @import { StorageBuffer } from '../storage-buffer.js'
 */

const sourceOver = state => state && state.srcFactor === 'one' &&
    state.dstFactor === 'one-minus-src-alpha' && (state.operation ?? 'add') === 'add';

const entries = buffers => buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));

/**
 * Reduces native raster work in dense Gaussian scenes. At a pixel, premultiplied source-over
 * blending is monotonic in the destination color. If the same sequence of foreground fragments
 * maps both values 0 and 1 to identical attachment bits, its output is independent of everything
 * behind it. Testing with the actual color format, fragment shader, and scene depth includes the
 * hardware's intermediate rounding. The masks are rebuilt for the current draw and camera.
 *
 * Owned by a single hybrid forward draw's WebgpuDrawCommands. Other draws and picks retain
 * their original resources, and unsupported attachments continue through the regular draw path.
 *
 * @ignore
 */
class WebgpuSplatCoverage {
    /** @type {WebgpuGraphicsDevice} */
    device;

    enabled = false;

    /** @type {StorageBuffer} */
    sorted;

    /** @type {StorageBuffer} */
    cache;

    /** @type {StorageBuffer} */
    count;

    /** @type {StorageBuffer} */
    scratch;

    instanceSize = 0;

    /** @type {WeakMap<GPURenderPipeline, {front: GPURenderPipeline, resolve: GPURenderPipeline}>} */
    renderPipelines = new WeakMap();

    /** @type {GPUComputePipeline[]} */
    computes = [];

    /** @type {Array<GPUTexture|GPUBuffer>} */
    owned = [];

    resources = null;

    constructor(device) {
        this.device = device;
    }

    setInputs(sorted, cache, count, scratch, instanceSize) {
        this.enabled = true;
        this.sorted = sorted;
        this.cache = cache;
        this.count = count;
        this.scratch = scratch;
        this.instanceSize = instanceSize;
    }

    releaseResources() {
        for (const resource of this.owned) this.device.deferDestroy(resource);
        this.owned.length = 0;
        this.resources = null;
    }

    destroy() {
        this.releaseResources();
        this.renderPipelines = new WeakMap();
        this.computes.length = 0;
    }

    ensureResources(width, height, format, indexCount) {
        const gpu = this.device.wgpu;
        const capacity = this.scratch.byteSize / 4;
        const old = this.resources;
        if (old && old.width === width && old.height === height && old.format === format &&
            old.capacity >= capacity && old.indexCount === indexCount) return old;

        this.releaseResources();
        const makeBuffer = (size, usage) => {
            const buffer = gpu.createBuffer({ size, usage });
            this.owned.push(buffer);
            return buffer;
        };
        const makeTarget = () => {
            const texture = gpu.createTexture({
                size: [width, height, 1],
                format,
                usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
            });
            this.owned.push(texture);
            return texture.createView();
        };
        // The indirect 2D grid has at most one partial row of 1024 workgroups.
        const blockCount = Math.ceil(capacity / 128) + 1024;
        const storage = GPUBufferUsage.STORAGE;
        const indirect = storage | GPUBufferUsage.INDIRECT;
        const params = makeBuffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
        gpu.queue.writeBuffer(params, 0, new Uint32Array([width, height, this.instanceSize, indexCount]));
        this.resources = {
            width,
            height,
            format,
            capacity,
            indexCount,
            params,
            lower: makeTarget(),
            upper: makeTarget(),
            masks: makeBuffer(Math.ceil(width / 4) * Math.ceil(height / 4) * 4, storage),
            flags: makeBuffer(blockCount * 16, storage),
            offsets: makeBuffer(blockCount * 4, storage),
            chunks: makeBuffer(Math.ceil(blockCount / 256) * 4, storage),
            args: makeBuffer(48, indirect),
            drawArgs: makeBuffer(20, indirect),
            visible: makeBuffer(4, storage),
            groups: [],
            inputs: []
        };
        return this.resources;
    }

    getPipelines(original, desc) {
        let pair = this.renderPipelines.get(original);
        if (!pair) {
            const gpu = this.device.wgpu;
            const target = desc.fragment.targets[0];
            const front = gpu.createRenderPipeline({
                ...desc,
                fragment: { ...desc.fragment, entryPoint: 'splatCoverageMain', targets: [target, target] }
            });
            const module = gpu.createShaderModule({ code: shaders.resolve });
            const resolve = gpu.createRenderPipeline({
                layout: 'auto',
                primitive: { topology: 'triangle-list' },
                vertex: { module, entryPoint: 'vs' },
                fragment: { module, entryPoint: 'fs', targets: [{ format: target.format }] },
                depthStencil: desc.depthStencil && {
                    format: desc.depthStencil.format, depthCompare: 'always', depthWriteEnabled: false
                }
            });
            pair = { front, resolve };
            this.renderPipelines.set(original, pair);
        }
        if (!this.computes.length) {
            for (const code of [shaders.prepare, shaders.comparePixels, shaders.markVisible,
                shaders.scan, shaders.finishScan, shaders.scatter]) {
                this.computes.push(this.device.wgpu.createComputePipeline({
                    layout: 'auto', compute: { module: this.device.wgpu.createShaderModule({ code }), entryPoint: 'main' }
                }));
            }
        }
        return pair;
    }

    updateBindings(r, original, resolve) {
        const sorted = this.sorted.impl.buffer;
        const cache = this.cache.impl.buffer;
        const count = this.count.impl.buffer;
        const scratch = this.scratch.impl.buffer;
        const inputs = r.inputs;
        if (inputs[0] === sorted && inputs[1] === cache && inputs[2] === count &&
            inputs[3] === scratch && inputs[4] === original) return;
        inputs[0] = sorted;
        inputs[1] = cache;
        inputs[2] = count;
        inputs[3] = scratch;
        inputs[4] = original;
        const views = [{ binding: 0, resource: r.lower }, { binding: 1, resource: r.upper }];
        const bind = (pipe, list, group = 0) => this.device.wgpu.createBindGroup({
            layout: pipe.getBindGroupLayout(group), entries: list
        });
        const c = this.computes;
        r.groups[0] = bind(c[0], entries([count, r.args, r.params]));
        r.groups[1] = bind(c[1], [...views, { binding: 2, resource: { buffer: r.masks } }]);
        r.groups[2] = bind(c[2], entries([sorted, cache, count, r.masks, r.params, r.flags, r.offsets]));
        r.groups[3] = bind(c[3], entries([r.offsets, r.chunks, count]));
        r.groups[4] = bind(c[4], entries([r.chunks, count, r.visible, r.drawArgs, r.params]));
        r.groups[5] = bind(c[5], entries([r.flags, r.offsets, r.chunks, sorted, scratch]));
        r.groups[6] = bind(original, entries([scratch, cache, r.visible]), 2);
        r.groups[7] = bind(resolve, views);
    }

    restoreBindings(pass, pipeline) {
        const d = this.device;
        pass.setPipeline(pipeline);
        for (let i = 0; i < d._coverageBindings.length; i++) {
            const entry = d._coverageBindings[i];
            if (entry) pass.setBindGroup(i, entry.group, entry.offsets);
        }
        for (let i = 0; i < d._boundVertexBuffers.length; i++) {
            const buffer = d._boundVertexBuffers[i];
            if (buffer) pass.setVertexBuffer(i, buffer, d._boundVertexOffsets[i]);
        }
        pass.setIndexBuffer(d._boundIndexBuffer, d._boundIndexFormat);
        pass.setStencilReference(d.stencilRef);
        pass.setBlendConstant(d.blendColor);
        pass.setViewport(d.vx, d.vy, d.vw, d.vh, 0, 1);
        pass.setScissorRect(d.sx, d.sy, d.sw, d.sh);
    }

    dispatch(encoder, name, index, x, y = 1) {
        const pass = encoder.beginComputePass(this.device.setupTimeStampWrites(undefined, name));
        pass.setPipeline(this.computes[index]);
        pass.setBindGroup(0, this.resources.groups[index]);
        if (x === 0) {
            pass.dispatchWorkgroupsIndirect(this.resources.args, 32);
        } else {
            pass.dispatchWorkgroups(x, y, 1);
        }
        pass.end();
    }

    draw(original, indexCount) {
        const d = this.device;
        if (!d.splatCoveragePass || d.stencilEnabled || d.depthState.write || indexCount !== this.instanceSize * 6) return false;
        // A user-defined bind group can carry additional resources or a different binding order.
        const mesh = d._coverageBindings[2]?.owner;
        if (!mesh || mesh.storageBuffers.length !== 3 || mesh.storageBuffers[0] !== this.sorted ||
            mesh.storageBuffers[1] !== this.cache || mesh.storageBuffers[2] !== this.count ||
            mesh.format.uniformBufferFormats.length || mesh.format.textureFormats.length ||
            mesh.format.storageTextureFormats.length ||
            mesh.format.storageBufferFormats.some((format, i) => format.slot !== i)) return false;
        const target = d.renderTarget;
        const { width, height } = target;
        if (d.vx !== 0 || d.vy !== 0 || d.vw !== width || d.vh !== height ||
            d.sx !== 0 || d.sy !== 0 || d.sw !== width || d.sh !== height) return false;
        const desc = d.renderPipeline.coverageDescriptors.get(original);
        const color = desc?.fragment.targets[0];
        if (!color || color.writeMask !== GPUColorWrite.ALL ||
            !sourceOver(color.blend?.color) || !sourceOver(color.blend?.alpha)) return false;

        const rt = target.impl.renderPassDescriptor;
        if (rt.colorAttachments[0].storeOp !== 'store') return false;
        const r = this.ensureResources(width, height, color.format, indexCount);
        const pair = this.getPipelines(original, desc);
        this.updateBindings(r, original, pair.resolve);

        // The new passes use the opaque depth already produced by earlier draws. All subsequent
        // draws resume in the same attachment with their original viewport and bindings.
        // #if _DEBUG
        for (let i = d._activePassMarkers.length - 1; i >= 0; i--) d.passEncoder.popDebugGroup();
        // #endif
        d.passEncoder.end();
        const encoder = d.getCommandEncoder();
        this.dispatch(encoder, 'GSplatCoverageArgs', 0, 1);
        let depth;
        if (rt.depthStencilAttachment) {
            depth = { ...rt.depthStencilAttachment };
            if (depth.depthLoadOp) depth.depthLoadOp = 'load';
            if (depth.stencilLoadOp) depth.stencilLoadOp = 'load';
        }
        const savedDepth = depth && { ...depth };
        if (savedDepth?.depthStoreOp) savedDepth.depthStoreOp = 'store';
        if (savedDepth?.stencilStoreOp) savedDepth.stencilStoreOp = 'store';
        const front = encoder.beginRenderPass(d.setupTimeStampWrites({
            colorAttachments: [
                { view: r.lower, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] },
                { view: r.upper, loadOp: 'clear', storeOp: 'store', clearValue: [1, 1, 1, 1] }
            ],
            depthStencilAttachment: savedDepth
        }, 'GSplatCoverageFront'));
        this.restoreBindings(front, pair.front);
        front.drawIndexedIndirect(r.args, 0);
        front.end();

        this.dispatch(encoder, 'GSplatCoveragePixels', 1, Math.ceil(width / 32), Math.ceil(height / 32));
        this.dispatch(encoder, 'GSplatCoverageCull', 2, 0);
        this.dispatch(encoder, 'GSplatCoverageScan', 3, Math.ceil(this.scratch.byteSize / (4 * 32768)));
        this.dispatch(encoder, 'GSplatCoveragePrefix', 4, 1);
        this.dispatch(encoder, 'GSplatCoverageSurvivors', 5, 0);

        const pass = encoder.beginRenderPass(d.setupTimeStampWrites({
            colorAttachments: [{ ...rt.colorAttachments[0], loadOp: 'load' }],
            depthStencilAttachment: depth
        }, 'GSplatCoverageDraw'));
        d.passEncoder = pass;
        // #if _DEBUG
        for (const marker of d._activePassMarkers) pass.pushDebugGroup(marker);
        // #endif
        this.restoreBindings(pass, original);
        pass.setBindGroup(2, r.groups[6]);
        pass.drawIndexedIndirect(r.drawArgs, 0);
        pass.setPipeline(pair.resolve);
        pass.setBindGroup(0, r.groups[7]);
        pass.draw(3);

        this.restoreBindings(pass, original);
        // The resumed pass uses the caller's original depth store operation, which can be
        // discard. Further draws in it must finish normally before another pass reads that depth.
        d.splatCoveragePass = false;
        return true;
    }
}

export { WebgpuSplatCoverage };
