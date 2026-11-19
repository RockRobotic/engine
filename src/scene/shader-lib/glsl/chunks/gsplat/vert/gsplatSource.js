export default /* glsl */`
attribute vec3 vertex_position;         // xy: cornerUV, z: render order offset within instance

uniform uint numSplats;                 // total number of splats
uniform highp usampler2D splatOrder;    // per-splat index to source gaussian

#if defined(GSPLAT_GL_COVERAGE) && defined(FORWARD_PASS) && defined(DITHER_NONE) && !defined(PICK_PASS) && !defined(SHADOW_PASS) && !defined(PREPASS_PASS) && !defined(SCENE_TEXTURE_DEPTH)
    uniform uint splatCoverageStart;
    uniform uint splatCompactCount;
#endif

// initialize the splat source structure and global splat
bool initSource(out SplatSource source) {
    // calculate splat order from instance index and vertex position offset
    source.order = uint(gl_InstanceID) * {GSPLAT_INSTANCE_SIZE}u + uint(vertex_position.z);

    #if defined(GSPLAT_GL_COVERAGE) && defined(FORWARD_PASS) && defined(DITHER_NONE) && !defined(PICK_PASS) && !defined(SHADOW_PASS) && !defined(PREPASS_PASS) && !defined(SCENE_TEXTURE_DEPTH)
        // Packed ranks retain their order in the original source-over draw.
        if (splatCompactCount != 0u) {
            if (source.order >= splatCompactCount) return false;
            ivec2 packedCoord = ivec2(source.order & 2047u, source.order >> 11u);
            setSplat(texelFetch(splatOrder, packedCoord, 0).r);
            source.cornerUV = vertex_position.xy;
            return true;
        }
        source.order += splatCoverageStart;
    #endif

    // return if out of range (since the last block of splats may be partially full)
    if (source.order >= numSplats) {
        return false;
    }

    ivec2 orderUV = splatTexel(source.order);

    // read splat id and initialize global splat for format read functions
    uint splatId = texelFetch(splatOrder, orderUV, 0).r;
    setSplat(splatId);

    // get the corner
    source.cornerUV = vertex_position.xy;

    return true;
}
`;
