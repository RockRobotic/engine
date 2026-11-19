// Every set bit in a leaf represents an original sorted rank. Internal nodes
// contain four cumulative counts. Descending the tree recovers the source
// rank of a survivor without changing native source-over order.
const leafSize = 8;
const levelWidth = 1024;

const fullscreen = `#version 300 es
void main() {
    vec2 v = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}`;

const header = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
ivec2 address(uint i, uint width) { return ivec2(i % width, i / width); }
// Match splatTexel's reciprocal row estimate and integer correction. Atlas
// width is uniform, so each eight-rank leaf computes its order origin once.
ivec2 atlasAddress(uint index, uint width) {
    uint row = uint(float(index) * (1.0 / float(width)) + 0.5);
    int column = int(index - row * width);
    bool previousRow = column < 0;
    return ivec2(previousRow ? column + int(width) : column, int(row) - int(previousRow));
}
uint pixelRank(uint width) { return uint(gl_FragCoord.y) * width + uint(gl_FragCoord.x); }
uint population(uint u) {
    u -= (u >> 1u) & 0x55555555u;
    u = (u & 0x33333333u) + ((u >> 2u) & 0x33333333u);
    u = (u + (u >> 4u)) & 0x0f0f0f0fu;
    return (u * 0x01010101u) >> 24u;
}
`;

function closureTest(opaqueRgb8) {
    // With no destination alpha channel, agreeing RGB endpoints prove the
    // native displayed color even when the intermediate alpha endpoints differ.
    const test = opaqueRgb8 ? 'all(equal(lo.rgb, hi.rgb))' : 'all(equal(lo, hi))';
    return `bool covered(vec4 lo, vec4 hi) { return ${test}; }`;
}

function makeMask(opaqueRgb8) {
    return `${header}
${closureTest(opaqueRgb8)}
uniform highp sampler2D lower;
uniform highp sampler2D upper;
layout(location = 0) out uint bits;
void main() {
    ivec2 base = ivec2(gl_FragCoord.xy) * 4;
    ivec2 size = textureSize(lower, 0);
    bits = 0u;
    for (int y = 0; y < 4; ++y) {
        for (int x = 0; x < 4; ++x) {
            ivec2 p = base + ivec2(x, y);
            if (all(lessThan(p, size)) && covered(texelFetch(lower, p, 0), texelFetch(upper, p, 0))) {
                bits |= 1u << uint(y * 4 + x);
            }
        }
    }
}`;
}

const leaf = `${header}
uniform usampler2D originalOrder;
uniform usampler2D visibility;
uniform uint atlas;
uniform uint count;
layout(location = 0) out uint mask;
void main() {
    uint first = pixelRank(${levelWidth}u) * ${leafSize}u;
    uint bits = 0u;
    ivec2 origin = atlasAddress(first, atlas);
    for (uint i = 0u; i < ${leafSize}u && first + i < count; ++i) {
        ivec2 p = origin + ivec2(i, 0);
        if (p.x >= int(atlas)) p += ivec2(-int(atlas), 1);
        uint id = texelFetch(originalOrder, p, 0).r;
        ivec2 source = atlasAddress(id, atlas);
        uint word = texelFetch(visibility, ivec2(source.x >> 2, source.y), 0).r;
        if ((word & (1u << uint(source.x & 3))) != 0u) bits |= 1u << i;
    }
    mask = bits;
}`;

const reduce = `${header}
uniform usampler2D children;
uniform uint childWidth;
uniform uint childCount;
uniform uint outWidth;
uniform bool childIsLeaf;
layout(location = 0) out uvec4 node;
void main() {
    uint first = pixelRank(outWidth) * 4u;
    uint sum = 0u;
    uvec4 prefix;
    for (int i = 0; i < 4; ++i) {
        uint child = first + uint(i);
        if (child < childCount) {
            uvec4 data = texelFetch(children, address(child, childWidth), 0);
            sum += childIsLeaf ? population(data.r) : data.a;
        }
        prefix[i] = sum;
    }
    node = prefix;
}`;

function makeGather(levelCount) {
    let declarations = '';
    let descent = '';
    for (let i = levelCount - 1; i >= 0; i--) {
        declarations += `uniform usampler2D level${i};\n`;
        // Short levels fit in one row, where every valid child is below the level width.
        // The same stride therefore addresses all levels even when the atlas changes.
        const read = `texelFetch(level${i}, address(child, ${levelWidth}u), 0)`;
        if (i > 0) {
            descent += `{ uvec4 ends = ${read};
                uint branch = uint(rank >= ends.x) + uint(rank >= ends.y) + uint(rank >= ends.z);
                if (branch > 0u) rank -= ends[int(branch) - 1];
                child = child * 4u + branch; }\n`;
        } else {
            descent += `uint bits = ${read}.r;\n`;
        }
    }
    return `${header}${declarations}
        uniform usampler2D originalOrder;
        uniform uint atlas;
        uniform uint first;
        uniform uint count;
        layout(location = 0) out uint compactId;
        void main() {
            uint index = pixelRank(2048u);
            if (index >= count) { compactId = 0u; return; }
            uint rank = index + first;
            uint child = 0u;
            ${descent}
            uint bit = 0u;
            for (uint span = ${leafSize / 2}u; span > 0u; span >>= 1u) {
                uint left = bits & ((1u << span) - 1u);
                uint countLeft = population(left);
                if (rank >= countLeft) { rank -= countLeft; bits >>= span; bit += span; }
                else { bits = left; }
            }
            compactId = texelFetch(originalOrder, atlasAddress(child * ${leafSize}u + bit, atlas), 0).r;
        }`;
}

function makeResolve(opaqueRgb8) {
    return `${header}
${closureTest(opaqueRgb8)}
uniform highp sampler2D lower;
uniform highp sampler2D upper;
layout(location = 0) out vec4 color;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    vec4 lo = texelFetch(lower, p, 0);
    vec4 hi = texelFetch(upper, p, 0);
    if (!covered(lo, hi)) discard;
    color = ${opaqueRgb8 ? 'vec4(lo.rgb, 1.0)' : 'lo'};
}`;
}

export { leafSize, levelWidth, fullscreen, makeMask, leaf, reduce, makeGather, makeResolve };
