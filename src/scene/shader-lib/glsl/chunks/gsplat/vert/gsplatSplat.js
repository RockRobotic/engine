// Splat identification struct and helper - shared between rendering and processing contexts
export default /* glsl */`

// Splat identification for texture sampling
struct Splat {
    uint index;     // linear index into splat data
    ivec2 uv;       // texture coordinate for sampling
};

// Global splat instance used by format read functions and load functions
Splat splat;

// Estimate the nearest row with a uniform reciprocal. An atlas row number is small enough to
// be exact in a float, even when its linear index is too large. The estimate therefore lies on
// this row or the next. Correct with the original integer index to keep boundary texels exact.
ivec2 splatTexel(uint index) {
    uint row = uint(float(index) * (1.0 / float(splatTextureSize)) + 0.5);
    int column = int(index - row * splatTextureSize);
    bool previousRow = column < 0;
    return ivec2(previousRow ? column + int(splatTextureSize) : column, int(row) - int(previousRow));
}

// Initialize splat from linear index
void setSplat(uint idx) {
    splat.index = idx;
    splat.uv = splatTexel(idx);
}

`;
