// Every set bit in a leaf represents an original sorted rank. Internal nodes
// contain four cumulative counts. Descending the tree recovers the source
// rank of a survivor without changing native source-over order.
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
uint pixelRank(uint width) { return uint(gl_FragCoord.y) * width + uint(gl_FragCoord.x); }
uint population(uint u) {
    u -= (u >> 1u) & 0x55555555u;
    u = (u & 0x33333333u) + ((u >> 2u) & 0x33333333u);
    u = (u + (u >> 4u)) & 0x0f0f0f0fu;
    return (u * 0x01010101u) >> 24u;
}
`;

const mask = `${header}
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
            if (all(lessThan(p, size)) && all(equal(texelFetch(lower, p, 0), texelFetch(upper, p, 0)))) {
                bits |= 1u << uint(y * 4 + x);
            }
        }
    }
}`;

const leaf = `${header}
uniform usampler2D originalOrder;
uniform usampler2D visibility;
uniform uint atlas;
uniform uint count;
layout(location = 0) out uvec4 node;
void main() {
    uint first = pixelRank(1024u) * 32u;
    uint bits = 0u;
    for (uint i = 0u; i < 32u && first + i < count; ++i) {
        uint id = texelFetch(originalOrder, address(first + i, atlas), 0).r;
        if (texelFetch(visibility, address(id, atlas), 0).r != 0u) bits |= 1u << i;
    }
    node = uvec4(bits, 0u, 0u, population(bits));
}`;

const reduce = `${header}
uniform usampler2D children;
uniform uint childWidth;
uniform uint childCount;
uniform uint outWidth;
layout(location = 0) out uvec4 node;
void main() {
    uint first = pixelRank(outWidth) * 4u;
    uint sum = 0u;
    uvec4 prefix;
    for (int i = 0; i < 4; ++i) {
        uint child = first + uint(i);
        if (child < childCount) sum += texelFetch(children, address(child, childWidth), 0).a;
        prefix[i] = sum;
    }
    node = prefix;
}`;

function makeGather(levels) {
    let declarations = '';
    let descent = '';
    for (let i = levels.length - 1; i >= 0; i--) {
        declarations += `uniform usampler2D level${i};\n`;
        const read = `texelFetch(level${i}, address(child, ${levels[i].width}u), 0)`;
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
            for (uint span = 16u; span > 0u; span >>= 1u) {
                uint left = bits & ((1u << span) - 1u);
                uint countLeft = population(left);
                if (rank >= countLeft) { rank -= countLeft; bits >>= span; bit += span; }
                else { bits = left; }
            }
            compactId = texelFetch(originalOrder, address(child * 32u + bit, atlas), 0).r;
        }`;
}

const resolve = `${header}
uniform highp sampler2D lower;
uniform highp sampler2D upper;
layout(location = 0) out vec4 color;
void main() {
    ivec2 p = ivec2(gl_FragCoord.xy);
    color = texelFetch(lower, p, 0);
    if (any(notEqual(color, texelFetch(upper, p, 0)))) discard;
}`;

export { fullscreen, mask, leaf, reduce, makeGather, resolve };
