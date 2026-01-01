// src/workers/terrainFieldWorker.js
// Web Worker: builds SDF scalar field for one marching-cubes chunk.
// No Babylon.js here, only math and noise.

self.onmessage = (e) => {
    const msg = e.data;
    if (!msg || msg.type !== "buildField") return;

    const {
        id,
        dimX,
        dimY,
        dimZ,
        cellSize,
        radius,
        origin // { x, y, z }
    } = msg;

    try {
        const field = buildField(dimX, dimY, dimZ, cellSize, radius, origin);
        // Send back as transferable
        self.postMessage(
            {
                type: "fieldDone",
                id,
                field
            },
            [field.buffer]
        );
    } catch (err) {
        self.postMessage({
            type: "fieldError",
            id,
            message: err && err.message ? err.message : String(err)
        });
    }
};

// -------- Noise helpers (match MarchingCubesTerrain) --------

function hash3(ix, iy, iz) {
    let h = ix * 374761393 + iy * 668265263 + iz * 2147483647;
    h = (h ^ (h >> 13)) >>> 0;
    return (h & 0xfffffff) / 0xfffffff; // 0..1
}

function fade(t) {
    return t * t * t * (t * (t * 6 - 15) + 10);
}

function valueNoise3(x, y, z) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);

    const fx = x - ix;
    const fy = y - iy;
    const fz = z - iz;

    const ux = fade(fx);
    const uy = fade(fy);
    const uz = fade(fz);

    const v000 = hash3(ix,     iy,     iz);
    const v100 = hash3(ix + 1, iy,     iz);
    const v010 = hash3(ix,     iy + 1, iz);
    const v110 = hash3(ix + 1, iy + 1, iz);
    const v001 = hash3(ix,     iy,     iz + 1);
    const v101 = hash3(ix + 1, iy,     iz + 1);
    const v011 = hash3(ix,     iy + 1, iz + 1);
    const v111 = hash3(ix + 1, iy + 1, iz + 1);

    const lerp = (a, b, t) => a + (b - a) * t;

    const x00 = lerp(v000, v100, ux);
    const x10 = lerp(v010, v110, ux);
    const x01 = lerp(v001, v101, ux);
    const x11 = lerp(v011, v111, ux);

    const y0 = lerp(x00, x10, uy);
    const y1 = lerp(x01, x11, uy);

    return lerp(y0, y1, uz); // 0..1
}

function fbmNoise3(x, y, z, baseFreq, octaves, lacunarity, gain) {
    let amp = 1.0;
    let freq = baseFreq;
    let sum = 0.0;
    let norm = 0.0;

    for (let i = 0; i < octaves; i++) {
        const n = valueNoise3(x * freq, y * freq, z * freq); // 0..1
        const v = n * 2.0 - 1.0; // -> [-1,1]
        sum += v * amp;
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
    }
    if (norm > 0) sum /= norm;
    return sum; // approx [-1,1]
}

function ridgedFbm3(x, y, z, baseFreq, octaves, lacunarity, gain) {
    let amp = 1.0;
    let freq = baseFreq;
    let sum = 0.0;
    let norm = 0.0;

    for (let i = 0; i < octaves; i++) {
        const n = valueNoise3(x * freq, y * freq, z * freq); // 0..1
        const v = 1.0 - Math.abs(2.0 * n - 1.0); // 0..1
        sum += v * amp;
        norm += amp;
        amp *= gain;
        freq *= lacunarity;
    }
    if (norm > 0) sum /= norm;
    return sum; // [0,1]
}

// SDF matching your 32.4 km planet settings (same as in MarchingCubesTerrain.js)
function sampleSdf(px, py, pz, R) {
    const distSq = px * px + py * py + pz * pz;
    const dist = Math.sqrt(distSq);
    if (dist < 1e-6) {
        return dist - R;
    }

    // 1) Domain warp
    const warp1 = fbmNoise3(
        px, py, pz,
        0.00035 / 3.0,
        3,
        2.0,
        0.5
    ); // [-1,1]

    const warp2 = fbmNoise3(
        px + 10000.0,
        py - 7000.0,
        pz + 3000.0,
        0.0008 / 3.0,
        2,
        2.0,
        0.5
    ); // [-1,1]

    const warpStrength1 = 800.0 * 3.0;  // 2400
    const warpStrength2 = 300.0 * 3.0;  // 900

    const wx = px + warp1 * warpStrength1 + warp2 * warpStrength2;
    const wy = py + warp1 * warpStrength1 * 0.6 + warp2 * warpStrength2 * 0.4;
    const wz = pz + warp1 * warpStrength1 + warp2 * warpStrength2 * 0.2;

    // 2) Continents
    const continents = fbmNoise3(
        wx, wy, wz,
        0.00045 / 3.0,
        4,
        2.0,
        0.5
    ); // [-1,1]
    const continentHeight = continents * (600.0 * 3.0);  // +/- 1800m

    // 3) Ridged mountains
    let ridges = ridgedFbm3(
        wx + 5000.0,
        wy - 2000.0,
        wz + 1000.0,
        0.0018 / 3.0,
        4,
        2.1,
        0.5
    ); // [0,1]

    const contMask = Math.max(0, (continents - 0.2) / 0.8);
    ridges *= contMask;

    ridges = Math.max(0, ridges - 0.3) / 0.7;
    ridges = ridges * ridges;

    const mountainHeight = ridges * (1200.0 * 3.0); // up to ~3.6 km

    // 4) Valleys / basins
    const valleysNoise = fbmNoise3(
        wx - 7000.0,
        wy + 3000.0,
        wz - 2000.0,
        0.00025 / 3.0,
        3,
        2.0,
        0.5
    ); // [-1,1]
    const valleyDepth = valleysNoise * (400.0 * 3.0); // +/- 1.2 km

    const effectiveRadius = R + continentHeight + mountainHeight + valleyDepth;

    let d = dist - effectiveRadius;

    // 6) Caves
    const innerSurface = R - 180.0;
    if (dist < innerSurface) {
        const caves = fbmNoise3(
            px * 1.5,
            py * 1.5,
            pz * 1.5,
            0.009 / 3.0,
            3,
            2.0,
            0.5
        ); // [-1,1]

        if (caves > 0.25) {
            d += (caves - 0.25) * (90.0 * 3.0);
        }
    }

    return d;
}

// Build the entire scalar field for one chunk
function buildField(dimX, dimY, dimZ, cellSize, radius, origin) {
    const total = dimX * dimY * dimZ;
    const field = new Float32Array(total);

    let index = 0;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;

    for (let z = 0; z < dimZ; z++) {
        const wz = oz + z * cellSize;
        for (let y = 0; y < dimY; y++) {
            const wy = oy + y * cellSize;
            for (let x = 0; x < dimX; x++) {
                const wx = ox + x * cellSize;
                field[index++] = sampleSdf(wx, wy, wz, radius);
            }
        }
    }

    return field;
}
