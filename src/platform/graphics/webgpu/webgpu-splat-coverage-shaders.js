// The proof and final draw use the original mesh's index count and instance size. Workgroups
// in the compactor cover 128 sorted entries independently of that mesh layout.
const parameters = /* wgsl */`
struct Parameters {
    dimensions: vec2u,
    instanceSize: u32,
    indexCount: u32,
}
`;

const prepare = /* wgsl */`
${parameters}
@group(0) @binding(0) var<storage, read> count: array<u32>;
@group(0) @binding(1) var<storage, read_write> args: array<u32>;
@group(0) @binding(2) var<uniform> params: Parameters;

@compute @workgroup_size(1)
fn main() {
    let groups = (count[0] + params.instanceSize - 1u) / params.instanceSize;
    let foreground = groups / 8u;
    args[0] = params.indexCount;
    args[1] = foreground;
    args[2] = 0u;
    args[3] = 0u;
    args[4] = groups - foreground;
    let blocks = (count[0] + 127u) / 128u;
    args[8] = min(blocks, 1024u);
    args[9] = (blocks + 1023u) / 1024u;
    args[10] = 1u;
}`;

const comparePixels = /* wgsl */`
@group(0) @binding(0) var lower: texture_2d<f32>;
@group(0) @binding(1) var upper: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> masks: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) thread: vec3u) {
    let dimensions = textureDimensions(lower);
    let tiles = (dimensions + 3u) / 4u;
    if (any(thread.xy >= tiles)) { return; }

    var mask = 0u;
    for (var y = 0u; y < 4u; y++) {
        for (var x = 0u; x < 4u; x++) {
            let p = vec2i(thread.xy * 4u + vec2u(x, y));
            if (all(textureLoad(lower, p, 0) == textureLoad(upper, p, 0))) {
                mask |= 1u << (y * 4u + x);
            }
        }
    }
    masks[thread.y * tiles.x + thread.x] = mask;
}`;

const markVisible = /* wgsl */`
${parameters}
@group(0) @binding(0) var<storage, read> order: array<u32>;
@group(0) @binding(1) var<storage, read> cache: array<u32>;
@group(0) @binding(2) var<storage, read> count: array<u32>;
@group(0) @binding(3) var<storage, read> masks: array<u32>;
@group(0) @binding(4) var<uniform> params: Parameters;
@group(0) @binding(5) var<storage, read_write> flags: array<vec4u>;
@group(0) @binding(6) var<storage, read_write> offsets: array<u32>;
var<workgroup> words: array<atomic<u32>, 4>;

fn drawSplat(i: u32) -> bool {
    if (i >= count[0]) { return false; }
    // Mono hybrid cache layout, matching gsplatHybridVS. Bound the entire pre-clipping quad
    // with extra subpixel slack; the comparison never relies on an opacity approximation.
    let base = order[i] * 8u;
    let w = bitcast<f32>(cache[base + 3u]);
    if (!(w > 0.0)) { return true; }
    let xy = vec2f(bitcast<f32>(cache[base]), bitcast<f32>(cache[base + 1u]));
    let dimensions = vec2f(params.dimensions);
    let center = (xy / w * vec2f(1.0, -1.0) + 1.0) * 0.5 * dimensions;
    let axes = abs(unpack2x16float(cache[base + 4u])) + abs(unpack2x16float(cache[base + 5u]));
    let extent = axes * 0.5 + 0.02;
    let last = vec2i(params.dimensions) - 1;
    let lo = clamp(vec2i(ceil(center - extent - 0.5)), vec2i(0), last);
    let hi = clamp(vec2i(floor(center + extent - 0.5)), vec2i(0), last);
    // Bound cost for giant foreground quads. The final draw handles them normally.
    if (any(hi - lo > vec2i(98))) { return true; }

    let columns = (params.dimensions.x + 3u) / 4u;
    for (var ty = lo.y >> 2; ty <= (hi.y >> 2); ty++) {
        let y0 = u32(max(0, lo.y - ty * 4));
        let y1 = u32(min(3, hi.y - ty * 4));
        let rows = ((16u << (4u * y1)) - 1u) & ~((1u << (4u * y0)) - 1u);
        for (var tx = lo.x >> 2; tx <= (hi.x >> 2); tx++) {
            let x0 = u32(max(0, lo.x - tx * 4));
            let x1 = u32(min(3, hi.x - tx * 4));
            let columnsMask = ((2u << x1) - 1u) & ~((1u << x0) - 1u);
            let required = (columnsMask * 0x1111u) & rows;
            if ((masks[u32(ty) * columns + u32(tx)] & required) != required) { return true; }
        }
    }
    return false;
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) grid: vec3u,
        @builtin(local_invocation_index) lane: u32) {
    let i = gid.x + gid.y * grid.x * 128u;
    if (lane < 4u) { atomicStore(&words[lane], 0u); }
    workgroupBarrier();
    if (drawSplat(i)) { atomicOr(&words[lane / 32u], 1u << (lane % 32u)); }
    workgroupBarrier();
    if (lane == 0u) {
        let bits = vec4u(atomicLoad(&words[0]), atomicLoad(&words[1]), atomicLoad(&words[2]), atomicLoad(&words[3]));
        let n = countOneBits(bits);
        flags[i / 128u] = bits;
        offsets[i / 128u] = n.x + n.y + n.z + n.w;
    }
}`;

const scan = /* wgsl */`
@group(0) @binding(0) var<storage, read_write> offsets: array<u32>;
@group(0) @binding(1) var<storage, read_write> chunks: array<u32>;
@group(0) @binding(2) var<storage, read> count: array<u32>;
var<workgroup> sums: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) group: vec3u, @builtin(local_invocation_index) lane: u32) {
    let block = group.x * 256u + lane;
    let n = (count[0] + 127u) / 128u;
    var inputCount = 0u;
    if (block < n) { inputCount = offsets[block]; }
    sums[lane] = inputCount;
    workgroupBarrier();
    for (var distance = 1u; distance < 256u; distance *= 2u) {
        var previous = 0u;
        if (lane >= distance) { previous = sums[lane - distance]; }
        workgroupBarrier();
        sums[lane] += previous;
        workgroupBarrier();
    }
    if (block < n) { offsets[block] = sums[lane] - inputCount; }
    if (lane == 255u) { chunks[group.x] = sums[lane]; }
}`;

const finishScan = /* wgsl */`
${parameters}
@group(0) @binding(0) var<storage, read_write> chunks: array<u32>;
@group(0) @binding(1) var<storage, read> count: array<u32>;
@group(0) @binding(2) var<storage, read_write> visible: array<u32>;
@group(0) @binding(3) var<storage, read_write> drawArgs: array<u32>;
@group(0) @binding(4) var<uniform> params: Parameters;

@compute @workgroup_size(1)
fn main() {
    let numChunks = (count[0] + 32767u) / 32768u;
    var total = 0u;
    for (var i = 0u; i < numChunks; i++) {
        let value = chunks[i];
        chunks[i] = total;
        total += value;
    }
    visible[0] = total;
    drawArgs[0] = params.indexCount;
    drawArgs[1] = (total + params.instanceSize - 1u) / params.instanceSize;
    drawArgs[2] = 0u;
    drawArgs[3] = 0u;
    drawArgs[4] = 0u;
}`;

const scatter = /* wgsl */`
@group(0) @binding(0) var<storage, read> flags: array<vec4u>;
@group(0) @binding(1) var<storage, read> offsets: array<u32>;
@group(0) @binding(2) var<storage, read> chunks: array<u32>;
@group(0) @binding(3) var<storage, read> order: array<u32>;
@group(0) @binding(4) var<storage, read_write> survivors: array<u32>;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) gid: vec3u, @builtin(num_workgroups) grid: vec3u,
        @builtin(local_invocation_index) lane: u32) {
    let i = gid.x + gid.y * grid.x * 128u;
    let block = i / 128u;
    let words = flags[block];
    let word = lane / 32u;
    let bit = 1u << (lane % 32u);
    if ((words[word] & bit) == 0u) { return; }
    let sizes = countOneBits(words);
    let prefix = countOneBits(words[word] & (bit - 1u)) + select(0u, sizes.x, word > 0u) +
        select(0u, sizes.y, word > 1u) + select(0u, sizes.z, word > 2u);
    survivors[chunks[block / 256u] + offsets[block] + prefix] = order[i];
}`;

const resolve = /* wgsl */`
@group(0) @binding(0) var lower: texture_2d<f32>;
@group(0) @binding(1) var upper: texture_2d<f32>;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
    return vec4f(vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
    let lo = textureLoad(lower, vec2i(p.xy), 0);
    let hi = textureLoad(upper, vec2i(p.xy), 0);
    if (any(lo != hi)) { discard; }
    return lo;
}`;

export { prepare, comparePixels, markVisible, scan, finishScan, scatter, resolve };
