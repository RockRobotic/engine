export default /* glsl */`
uniform highp usampler2D coverageTiles;
layout(location = 0) out highp uint visible;

// Each bit in a tile covers a pixel where both endpoint colors agreed.
bool rectangleCovered(ivec2 low, ivec2 high) {
    ivec2 first = low >> 2;
    ivec2 last = high >> 2;
    if (any(greaterThan(last - first, ivec2(3)))) return false;

    for (int y = first.y; y <= last.y; ++y) {
        int bottom = max(0, low.y - 4 * y);
        int top = min(3, high.y - 4 * y);
        uint rows = (0xffffu << uint(4 * bottom)) & (0xffffu >> uint(4 * (3 - top)));
        for (int x = first.x; x <= last.x; ++x) {
            uint left = uint(max(0, low.x - 4 * x));
            uint right = uint(min(3, high.x - 4 * x));
            uint columns = ((2u << right) - 1u) & ~((1u << left) - 1u);
            uint pixels = (columns * 0x1111u) & rows;
            uint tile = texelFetch(coverageTiles, ivec2(x, y), 0).r;
            if ((tile & pixels) != pixels) return false;
        }
    }
    return true;
}

void main() {
    visible = 0u;
    splat.uv = ivec2(gl_FragCoord.xy);
    splat.index = uint(splat.uv.y) * splatTextureSize + uint(splat.uv.x);
    vec3 modelCenter = getCenter();
    SplatCenter center;
    center.modelCenterOriginal = modelCenter;
    modifySplatCenter(modelCenter);
    center.modelCenterModified = modelCenter;
    if (!initCenter(modelCenter, center)) return;

    SplatSource source;
    source.order = 0u;
    source.cornerUV = vec2(1.0);
    SplatCorner corner;
    if (!initCorner(source, center, corner)) return;

    float opacity = getOpacity();
    vec4 color = vec4(getColor(), opacity);
    #if GSPLAT_AA
        color.a *= corner.aaFactor;
    #endif
    modifySplatColor(modelCenter, color);
    if (color.a <= alphaClipForward) return;
    clipCorner(corner, color.a);

    // Native rasterization snaps vertices to subpixel positions. Grow the bound
    // before converting it into inclusive pixel-center coordinates.
    vec2 extent = corner.coverageExtent * abs(corner.uv) + vec2(0.08);
    vec2 pixel = (center.proj.xy / center.proj.w * 0.5 + 0.5) * viewport_size.xy;
    vec2 low = max(ceil(pixel - extent - 0.5), vec2(0.0));
    vec2 high = min(floor(pixel + extent - 0.5), viewport_size.xy - 1.0);
    if (any(greaterThan(low, high))) return;
    visible = rectangleCovered(ivec2(low), ivec2(high)) ? 0u : 1u;
}
`;
