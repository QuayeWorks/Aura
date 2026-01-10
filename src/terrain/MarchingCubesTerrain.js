/* global BABYLON */
// src/terrain/MarchingCubesTerrain.js

import { resolveBiomeSettings, DEFAULT_BIOME_SETTINGS } from "./biomeSettings.js";

// --- Optional Web Worker for SDF field generation (CPU offload) ---
let FIELD_WORKER = null;
let FIELD_JOB_ID = 0;
const FIELD_JOB_PROMISES = new Map();

function ensureFieldWorker() {
    if (typeof Worker === "undefined") return null;
    if (FIELD_WORKER) return FIELD_WORKER;

    // Worker lives in the shared workers directory
    FIELD_WORKER = new Worker(
        new URL("../workers/terrainFieldWorker.js", import.meta.url),
        { type: "module" }
    );

    FIELD_WORKER.onmessage = (e) => {
        const msg = e.data;
        if (!msg || typeof msg.id === "undefined") return;

        const entry = FIELD_JOB_PROMISES.get(msg.id);
        if (!entry) return;
        FIELD_JOB_PROMISES.delete(msg.id);

        if (msg.type === "fieldDone" && msg.field) {
            entry.resolve(msg.field);
        } else if (msg.type === "fieldError") {
            console.error("terrainFieldWorker error:", msg.message);
            entry.reject(new Error(msg.message || "Worker field error"));
        }
    };

    FIELD_WORKER.onerror = (err) => {
        console.error("terrainFieldWorker fatal error:", err);
        // Fail all pending jobs
        for (const [, entry] of FIELD_JOB_PROMISES) {
            entry.reject(err);
        }
        FIELD_JOB_PROMISES.clear();
    };

    return FIELD_WORKER;
}

function buildFieldAsync(dimX, dimY, dimZ, cellSize, radius, origin) {
    const worker = ensureFieldWorker();
    if (!worker) {
        return Promise.reject(new Error("Web Worker not available"));
    }

    const id = ++FIELD_JOB_ID;

    return new Promise((resolve, reject) => {
        FIELD_JOB_PROMISES.set(id, { resolve, reject });

        worker.postMessage({
            type: "buildField",
            id,
            dimX,
            dimY,
            dimZ,
            cellSize,
            radius,
            origin: { x: origin.x, y: origin.y, z: origin.z }
        });
    });
}

// --- Web Worker for FULL mesh extraction (field + marching cubes) ---
let MESH_WORKER = null;
let MESH_JOB_ID = 0;
const MESH_JOB_PROMISES = new Map();

function ensureMeshWorker() {
    if (typeof Worker === "undefined") return null;
    if (MESH_WORKER) return MESH_WORKER;

    MESH_WORKER = new Worker(
        new URL("../workers/terrainMeshWorker.js", import.meta.url),
        { type: "module" }
    );

    MESH_WORKER.onmessage = (e) => {
        const msg = e.data;
        if (!msg || typeof msg.id === "undefined") return;

        const entry = MESH_JOB_PROMISES.get(msg.id);
        if (!entry) return;
        MESH_JOB_PROMISES.delete(msg.id);

        if (msg.type === "meshDone") entry.resolve(msg);
        else if (msg.type === "meshError") entry.reject(new Error(msg.message || "Worker mesh error"));
    };

    MESH_WORKER.onerror = (err) => {
        for (const [, entry] of MESH_JOB_PROMISES) entry.reject(err);
        MESH_JOB_PROMISES.clear();
    };

    return MESH_WORKER;
}

function buildMeshAsync(payload) {
    const worker = ensureMeshWorker();
    if (!worker) return Promise.reject(new Error("Web Worker not available"));

    const id = ++MESH_JOB_ID;

    return new Promise((resolve, reject) => {
        MESH_JOB_PROMISES.set(id, { resolve, reject });
        worker.postMessage({ type: "buildMesh", id, ...payload });
    });
}

// Corner index -> (dx, dy, dz) within a cube
const CORNER_OFFSETS = [
    [0, 0, 0], // 0
    [1, 0, 0], // 1
    [1, 1, 0], // 2
    [0, 1, 0], // 3
    [0, 0, 1], // 4
    [1, 0, 1], // 5
    [1, 1, 1], // 6
    [0, 1, 1], // 7
];

// Edge index -> [cornerA, cornerB]
const EDGE_CORNER_PAIRS = [
    [0, 1], // 0
    [1, 2], // 1
    [2, 3], // 2
    [3, 0], // 3
    [4, 5], // 4
    [5, 6], // 5
    [6, 7], // 6
    [7, 4], // 7
    [0, 4], // 8
    [1, 5], // 9
    [2, 6], // 10
    [3, 7], // 11
];

export class MarchingCubesTerrain {
    constructor(scene, options = {}) {
        this.scene = scene;

        // Grid resolution – tweak these if perf is bad / mesh too coarse
        this.dimX = options.dimX ?? 32;
        this.dimY = options.dimY ?? 32;
        this.dimZ = options.dimZ ?? 32;

        this.cellSize = options.cellSize ?? 1.0;
        this.isoLevel = options.isoLevel ?? 0.0;

        // Approximate radius of the planet (in world units)
        this.radius = options.radius ?? 18.0;
        this.biomeSettings = resolveBiomeSettings(options.biomeSettings || DEFAULT_BIOME_SETTINGS);
        // Center the volume around the origin
        // but allow an explicit world-space origin via options.origin.
        this.origin = options.origin || new BABYLON.Vector3(
            -((this.dimX - 1) * this.cellSize) * 0.5,
            -((this.dimY - 1) * this.cellSize) * 0.5,
            -((this.dimZ - 1) * this.cellSize) * 0.5
        );

        // Optional mesh/material reuse (for chunk pooling)
        this.mesh = options.mesh ?? null;
		this.colliderMesh = null; // NEW: second mesh for physics
		
        this.material = options.material ?? null;

        // Scalar field samples at each grid vertex
        this.field = new Float32Array(this.dimX * this.dimY * this.dimZ);

        // If true, caller will build field/mesh later via rebuildWithSettings()
        this.deferBuild = !!options.deferBuild;

        // Optional: offload SDF generation to Web Worker
        // (used by ChunkedPlanetTerrain for smoother streaming)
        this.useWorker = !!options.useWorker;

        if (!this.deferBuild) {
            if (this.useWorker && typeof Worker !== "undefined") {
                // Fire-and-forget async build for standalone usage
                buildFieldAsync(
                    this.dimX,
                    this.dimY,
                    this.dimZ,
                    this.cellSize,
                    this.radius,
                    this.origin
                )
                    .then((field) => {
                        this.field = field;
                        this._buildMesh();
                    })
                    .catch((err) => {
                        console.error("Worker build failed, falling back:", err);
                        this._buildInitialField();
                        this._buildMesh();
                    });
            } else {
                this._buildInitialField();
                this._buildMesh();
            }
        }
    }

    // Index helper into 1D field array
    _index(x, y, z) {
        return x + this.dimX * (y + this.dimY * z);
    }

	// ====== NEW TERRAIN SDF GENERATION ======
    // ====== NEW TERRAIN SDF USING BUILT-IN HASH NOISE ======
    // ====== SMOOTH PLANET TERRAIN SDF (no blocky hash steps) ======
    // ====== STRONGER, SMOOTH PLANET TERRAIN SDF ======

	    // ---- 3D value noise + FBM helpers (no external libs needed) ----
    // Very small deterministic fake-noise (fast, stable, no import required)
    _hashNoise(x, y, z) {
        // large prime constants
        const a = 1103515245, b = 12345, c = 3141592653;
        let n = x * a ^ y * b ^ z * c;
        n = (n << 13) ^ n;
        return (1.0 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0);
    }

    // Hash integer lattice coord -> [0,1]
    _hash3(ix, iy, iz) {
        // Use unsigned 32-bit arithmetic for stability
        let h = ix * 374761393 + iy * 668265263 + iz * 2147483647;
        h = (h ^ (h >> 13)) >>> 0;
        return (h & 0xfffffff) / 0xfffffff; // 0..1
    }

    // Smoothstep used by Perlin-style fade
    _fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    // Trilinear interpolated value-noise in [0,1]
    _valueNoise3(x, y, z) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const iz = Math.floor(z);

        const fx = x - ix;
        const fy = y - iy;
        const fz = z - iz;

        const ux = this._fade(fx);
        const uy = this._fade(fy);
        const uz = this._fade(fz);

        const v000 = this._hash3(ix,     iy,     iz);
        const v100 = this._hash3(ix + 1, iy,     iz);
        const v010 = this._hash3(ix,     iy + 1, iz);
        const v110 = this._hash3(ix + 1, iy + 1, iz);
        const v001 = this._hash3(ix,     iy,     iz + 1);
        const v101 = this._hash3(ix + 1, iy,     iz + 1);
        const v011 = this._hash3(ix,     iy + 1, iz + 1);
        const v111 = this._hash3(ix + 1, iy + 1, iz + 1);

        const lerp = (a, b, t) => a + (b - a) * t;

        const x00 = lerp(v000, v100, ux);
        const x10 = lerp(v010, v110, ux);
        const x01 = lerp(v001, v101, ux);
        const x11 = lerp(v011, v111, ux);

        const y0 = lerp(x00, x10, uy);
        const y1 = lerp(x01, x11, uy);

        return lerp(y0, y1, uz); // 0..1
    }

    // Fractal Brownian Motion: sum of octaves, result ~[-1,1]
    _fbmNoise3(x, y, z, baseFreq, octaves, lacunarity, gain) {
        let amp = 1.0;
        let freq = baseFreq;
        let sum = 0.0;
        let norm = 0.0;

        for (let i = 0; i < octaves; i++) {
            const n = this._valueNoise3(x * freq, y * freq, z * freq); // 0..1
            const v = n * 2.0 - 1.0; // -> [-1,1]
            sum += v * amp;
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        if (norm > 0) sum /= norm;
        return sum; // approx [-1,1]
    }

    // Ridged multifractal FBM: sharp peaks, in [0,1]
    _ridgedFbm3(x, y, z, baseFreq, octaves, lacunarity, gain) {
        let amp = 1.0;
        let freq = baseFreq;
        let sum = 0.0;
        let norm = 0.0;

        for (let i = 0; i < octaves; i++) {
            const n = this._valueNoise3(x * freq, y * freq, z * freq); // 0..1
            // Convert to ridges: 1 - |2n-1|
            const v = 1.0 - Math.abs(2.0 * n - 1.0); // 0..1
            sum += v * amp;
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        if (norm > 0) sum /= norm;
        return sum; // [0,1]
    }

    // ====== DOMAIN-WARPED FRACTAL PLANET TERRAIN FOR RADIUS ≈ 3600 ======
    // ====== DOMAIN-WARPED FRACTAL PLANET TERRAIN FOR RADIUS ≈ 10800 ======
    _sampleSdf(pos) {
        const p = pos;
        const R = this.radius;  // e.g. 10800
        // Distance from planet center
        const distSq = p.x * p.x + p.y * p.y + p.z * p.z;
        const dist = Math.sqrt(distSq);
        if (dist < 1e-6) {
            return dist - R;
        }

        // -------- 1) DOMAIN WARP --------
        // Scales chosen for planet radius ~10800 (3x bigger than before).
        const warp1 = this._fbmNoise3(
            p.x, p.y, p.z,
            0.00035 / 3.0,   // was 0.00035
            3,
            2.0,
            0.5
        ); // [-1,1]

        const warp2 = this._fbmNoise3(
            p.x + 10000.0,
            p.y - 7000.0,
            p.z + 3000.0,
            0.0008 / 3.0,    // was 0.0008
            2,
            2.0,
            0.5
        ); // [-1,1]

        const warpStrength1 = 800.0 * 3.0;  // 2400
        const warpStrength2 = 300.0 * 3.0;  // 900

        const wx = p.x + warp1 * warpStrength1 + warp2 * warpStrength2;
        const wy = p.y + warp1 * warpStrength1 * 0.6 + warp2 * warpStrength2 * 0.4;
        const wz = p.z + warp1 * warpStrength1 + warp2 * warpStrength2 * 0.2;

        // -------- 2) CONTINENTS --------
        const continents = this._fbmNoise3(
            wx, wy, wz,
            0.00045 / 3.0,   // was 0.00045
            4,
            2.0,
            0.5
        ); // [-1,1]

		// broader macro elevation
		const continentHeight = continents * (900.0 * 3.0); // ~ +/- 2700m at R≈10800


        // -------- 3) RIDGED MOUNTAIN CHAINS --------
        let ridges = this._ridgedFbm3(
            wx + 5000.0,
            wy - 2000.0,
            wz + 1000.0,
            0.0018 / 3.0,    // was 0.0018
            4,
            2.1,
            0.5
        ); // [0,1]

        const contMask = Math.max(0, (continents - 0.2) / 0.8); // 0..1
        ridges *= contMask;

        ridges = Math.max(0, ridges - 0.3) / 0.7;
        ridges = ridges * ridges;

        // Scale heights based on planet size.
		// These values are "meters" when 1 unit == 1 meter.
		
		// Guarantee high peaks: target mountain max ~7000m (scaled with planet radius)
		const mountainMax = 7000.0;
		
		// Keep ridges sharp and meaningful
		const mountainHeight = ridges * mountainMax;


        // -------- 4) MACRO VALLEYS / BASINS --------
        const valleysNoise = this._fbmNoise3(
            wx - 7000.0,
            wy + 3000.0,
            wz - 2000.0,
            0.00025 / 3.0,   // was 0.00025
            3,
            2.0,
            0.5
        ); // [-1,1]
        const valleyDepth = valleysNoise * (400.0 * 3.0);     // +/- 1.2 km

        // -------- 5) EFFECTIVE TERRAIN RADIUS --------
        const effectiveRadius = R + continentHeight + mountainHeight + valleyDepth;

        let d = dist - effectiveRadius;

        // -------- 6) CAVES (INSIDE THE PLANET) --------
        const innerSurface = R - 180.0; // scaled from 60 for bigger planet
        if (dist < innerSurface) {
            const caves = this._fbmNoise3(
                p.x * 1.5,
                p.y * 1.5,
                p.z * 1.5,
                0.009 / 3.0,   // was 0.009
                3,
                2.0,
                0.5
            ); // [-1,1]

            if (caves > 0.25) {
                d += (caves - 0.25) * (90.0 * 3.0); // carve bigger voids
            }
        }

        return d;
    }



    _buildInitialField() {
        for (let z = 0; z < this.dimZ; z++) {
            for (let y = 0; y < this.dimY; y++) {
                for (let x = 0; x < this.dimX; x++) {
                    const worldPos = this.origin.add(
                        new BABYLON.Vector3(
                            x * this.cellSize,
                            y * this.cellSize,
                            z * this.cellSize
                        )
                    );
                    const v = this._sampleSdf(worldPos);
                    this.field[this._index(x, y, z)] = v;
                }
            }
        }
    }

    // Public: carve out a ball of emptiness at worldPos
    // options.deferRebuild === true  => only change field, caller will rebuild mesh

    carveSphere(worldPos, radius, options = {}) {
        // Carves are applied in the mesh worker via settings.carves (passed in rebuildWithSettings).
        // Intentionally a no-op.
    }


    rebuildMeshOnly() {
        // Intentionally a no-op. Rebuilds happen through rebuildWithSettings() worker pipeline.
    }


    /**
     * Compute terrain color at a given world-space position.
     * Handles:
     * - surface grass/sand
     * - underground brown → dark brown → glowing core
     * - mountains: rock → snow
     */
    _getColorForWorldPos(worldPos) {
        const biome = resolveBiomeSettings(this.biomeSettings || DEFAULT_BIOME_SETTINGS);
        const dist = worldPos.length();
        const heightAboveSea = (dist - this.radius) - biome.seaLevelUnits;

        let up = new BABYLON.Vector3(0, 1, 0);
        if (dist > 1e-6) {
            up = worldPos.scale(1 / dist);
        }

        // LOD-independent slope via SDF gradient (central difference)
        const eps = biome.slopeEpsUnits;
        const gradX = this._sampleSdf(worldPos.add(new BABYLON.Vector3(eps, 0, 0))) -
            this._sampleSdf(worldPos.add(new BABYLON.Vector3(-eps, 0, 0)));
        const gradY = this._sampleSdf(worldPos.add(new BABYLON.Vector3(0, eps, 0))) -
            this._sampleSdf(worldPos.add(new BABYLON.Vector3(0, -eps, 0)));
        const gradZ = this._sampleSdf(worldPos.add(new BABYLON.Vector3(0, 0, eps))) -
            this._sampleSdf(worldPos.add(new BABYLON.Vector3(0, 0, -eps)));
        const invDen = 1 / (2 * eps);
        const grad = new BABYLON.Vector3(gradX * invDen, gradY * invDen, gradZ * invDen);
        const gradLen = grad.length();
        const gradDir = gradLen > 1e-6 ? grad.scale(1 / gradLen) : new BABYLON.Vector3(0, 1, 0);
        const slope = 1 - Math.abs(BABYLON.Vector3.Dot(gradDir, up));

        const deepWater = new BABYLON.Color3(0.02, 0.12, 0.25);
        const shallowWater = new BABYLON.Color3(0.15, 0.45, 0.75);
        const wetSand = new BABYLON.Color3(0.86, 0.78, 0.52);
        const drySand = new BABYLON.Color3(0.96, 0.88, 0.60);
        const grassLow = new BABYLON.Color3(0.20, 0.75, 0.32);
        const grassHigh = new BABYLON.Color3(0.14, 0.58, 0.26);
        const rockBrown = new BABYLON.Color3(0.45, 0.40, 0.35);
        const rockGrey = new BABYLON.Color3(0.65, 0.65, 0.68);
        const snowBase = new BABYLON.Color3(0.80, 0.82, 0.87);
        const snowPure = new BABYLON.Color3(1.0, 1.0, 1.0);

        if (heightAboveSea < -biome.shallowWaterDepthUnits) {
            return deepWater;
        }

        if (heightAboveSea < 0) {
            const t = (heightAboveSea + biome.shallowWaterDepthUnits) / biome.shallowWaterDepthUnits;
            return BABYLON.Color3.Lerp(deepWater, shallowWater, Math.max(0, Math.min(1, t)));
        }

        if (heightAboveSea < biome.beachWidthUnits) {
            const t = heightAboveSea / biome.beachWidthUnits;
            return BABYLON.Color3.Lerp(wetSand, drySand, Math.max(0, Math.min(1, t)));
        }

        const aboveBeach = heightAboveSea - biome.beachWidthUnits;

        const jitter = this._hashNoise(
            Math.floor(worldPos.x * 0.02),
            Math.floor(worldPos.y * 0.02),
            Math.floor(worldPos.z * 0.02)
        ) * 0.03;

        const grassT = Math.max(0, Math.min(1, aboveBeach / Math.max(1, biome.grassMaxUnits)));
        const grassColor = BABYLON.Color3.Lerp(
            new BABYLON.Color3(grassLow.r, grassLow.g + jitter, grassLow.b),
            grassHigh,
            grassT
        );

        const rockT = Math.max(0, Math.min(1, (aboveBeach - biome.rockStartUnits) / Math.max(1, biome.rockFullUnits - biome.rockStartUnits)));
        const rockColor = BABYLON.Color3.Lerp(rockBrown, rockGrey, rockT);

        const slopeRock = BABYLON.Scalar.Clamp(
            (slope - biome.slopeRockStart) / Math.max(0.0001, (biome.slopeRockFull - biome.slopeRockStart)),
            0,
            1
        );

        let base = BABYLON.Color3.Lerp(grassColor, rockColor, Math.max(grassT, rockT));
        base = BABYLON.Color3.Lerp(base, rockColor, slopeRock);

        const snowHeightT = Math.max(0, Math.min(1, (aboveBeach - biome.snowStartUnits) / Math.max(1, biome.snowFullUnits - biome.snowStartUnits)));
        const latFactor = Math.min(1, Math.abs(up.y));
        const snowInfluence = Math.max(snowHeightT, latFactor * 0.5);
        const snowColor = BABYLON.Color3.Lerp(snowBase, snowPure, snowHeightT || 0);

        return BABYLON.Color3.Lerp(base, snowColor, snowInfluence);
    }

_applyMeshBuffers(positions, normals, indices, colors) {
    if (!positions || positions.length === 0 || !indices || indices.length === 0) {
        if (this.mesh) this.mesh.setEnabled(false);
        return;
    }

    const vertexData = new BABYLON.VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;

    if (colors && colors.length > 0) {
        vertexData.colors = colors;
    }

    if (!this.mesh) {
        this.mesh = new BABYLON.Mesh("marchingCubesTerrain", this.scene);

        if (!this.material) {
            this.material = new BABYLON.StandardMaterial("terrainMat", this.scene);
            this.material.diffuseColor = new BABYLON.Color3(1, 1, 1);
            this.material.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
            this.material.backFaceCulling = false;
            this.material.twoSidedLighting = true;
        }

        this.mesh.material = this.material;
    } else {
        this.mesh.setEnabled(true);
    }

    if (this.mesh.material) this.mesh.material.useVertexColors = true;

    this.mesh.isPickable = true;
    this.mesh.checkCollisions = true;
    this.mesh.metadata = this.mesh.metadata || {};
    this.mesh.metadata.isVoxelTerrain = true;
    this.mesh.metadata.isTerrain = true;
    this.mesh.metadata.isTerrainChunk = true;
	this.mesh.layerMask = 0x1 | 0x2;

    vertexData.applyToMesh(this.mesh, true);
}



    _buildMesh() {
        const positions = [];
        const normals = [];
        const indices = [];
        const colors = []; // <--- NEW

        const worldPos = (gx, gy, gz) =>
            this.origin.add(
                new BABYLON.Vector3(
                    gx * this.cellSize,
                    gy * this.cellSize,
                    gz * this.cellSize
                )
            );

        const vertList = new Array(12);

        // March over all cubes in the grid
        for (let z = 0; z < this.dimZ - 1; z++) {
            for (let y = 0; y < this.dimY - 1; y++) {
                for (let x = 0; x < this.dimX - 1; x++) {
                    const cornerValues = new Array(8);
                    const cornerPositions = new Array(8);

                    // Sample the 8 corners of this cube
                    for (let i = 0; i < 8; i++) {
                        const [dx, dy, dz] = CORNER_OFFSETS[i];
                        const gx = x + dx;
                        const gy = y + dy;
                        const gz = z + dz;

                        const idx = this._index(gx, gy, gz);
                        const v = this.field[idx];

                        cornerValues[i] = v;
                        cornerPositions[i] = worldPos(gx, gy, gz);
                    }

                    // Determine cube index
                    let cubeIndex = 0;
                    if (cornerValues[0] < this.isoLevel) cubeIndex |= 1;
                    if (cornerValues[1] < this.isoLevel) cubeIndex |= 2;
                    if (cornerValues[2] < this.isoLevel) cubeIndex |= 4;
                    if (cornerValues[3] < this.isoLevel) cubeIndex |= 8;
                    if (cornerValues[4] < this.isoLevel) cubeIndex |= 16;
                    if (cornerValues[5] < this.isoLevel) cubeIndex |= 32;
                    if (cornerValues[6] < this.isoLevel) cubeIndex |= 64;
                    if (cornerValues[7] < this.isoLevel) cubeIndex |= 128;

                    const edgeMask = edgeTable[cubeIndex];
                    if (!edgeMask) continue;

                    // Interpolate along edges where the surface cuts
                    for (let e = 0; e < 12; e++) {
                        if (!(edgeMask & (1 << e))) continue;

                        const [aIdx, bIdx] = EDGE_CORNER_PAIRS[e];
                        const va = cornerValues[aIdx];
                        const vb = cornerValues[bIdx];
                        const pa = cornerPositions[aIdx];
                        const pb = cornerPositions[bIdx];

                        const t =
                            Math.abs(vb - va) < 1e-6
                                ? 0.5
                                : (this.isoLevel - va) / (vb - va);

                        vertList[e] = BABYLON.Vector3.Lerp(pa, pb, t);
                    }

                    // Build triangles from triTable
                    const triRow = triTable[cubeIndex];
                    for (let i = 0; i < 16; i += 3) {
                        const e0 = triRow[i];
                        const e1 = triRow[i + 1];
                        const e2 = triRow[i + 2];

                        // end of this configuration
                        if (e0 === -1 || e1 === -1 || e2 === -1) break;

                        const p0 = vertList[e0];
                        const p1 = vertList[e1];
                        const p2 = vertList[e2];

                        if (!p0 || !p1 || !p2) continue;

                        const baseIndex = positions.length / 3;

                        // Positions
                        positions.push(
                            p0.x, p0.y, p0.z,
                            p1.x, p1.y, p1.z,
                            p2.x, p2.y, p2.z
                        );

                        // Indices
                        indices.push(baseIndex, baseIndex + 1, baseIndex + 2);

                        // Colors per vertex
                        const c0 = this._getColorForWorldPos(p0);
                        const c1 = this._getColorForWorldPos(p1);
                        const c2 = this._getColorForWorldPos(p2);

                        colors.push(c0.r, c0.g, c0.b, 1.0);
                        colors.push(c1.r, c1.g, c1.b, 1.0);
                        colors.push(c2.r, c2.g, c2.b, 1.0);
                    }
                }
            }
        }

        // If this chunk is empty, disable its mesh and bail
        if (positions.length === 0 || indices.length === 0) {
            if (this.mesh) {
                this.mesh.setEnabled(false);
            }
            return;
        }

        // Compute normals
        BABYLON.VertexData.ComputeNormals(positions, indices, normals);

        const vertexData = new BABYLON.VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;

        if (colors.length > 0) {
            vertexData.colors = colors; // <--- NEW
        }

        if (!this.mesh) {
            this.mesh = new BABYLON.Mesh("marchingCubesTerrain", this.scene);

            if (!this.material) {
                this.material = new BABYLON.StandardMaterial(
                    "terrainMat",
                    this.scene
                );
                this.material.diffuseColor = new BABYLON.Color3(1, 1, 1);
                this.material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
                this.material.backFaceCulling = false;
            }

            this.mesh.material = this.material;
        } else {
            this.mesh.setEnabled(true);
        }

        // IMPORTANT: enable vertex color usage
        if (this.mesh.material) {
            this.mesh.material.useVertexColors = true;
            this.mesh.material.twoSidedLighting = true;
            this.mesh.material.backFaceCulling = false;
            this.mesh.material.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
        }

		// Mark terrain chunks as pickable ground for player raycasts
		this.mesh.isPickable = true;
		this.mesh.checkCollisions = true; // optional but nice
		this.mesh.metadata = this.mesh.metadata || {};
		this.mesh.metadata.isVoxelTerrain = true; // <-- voxel chunk tag

		this.mesh.metadata.isTerrain = true;
		this.mesh.metadata.isTerrainChunk = true;


        vertexData.applyToMesh(this.mesh, true);
    }


    // Rebuild with possibly new resolution / cellSize / origin (used for LOD + streaming)
    // If this.useWorker is true, this may return a Promise that resolves
    // when the worker has finished building the field + mesh.
    rebuildWithSettings(settings) {
        // Update core parameters
        if (settings.dimX && settings.dimY && settings.dimZ) {
            this.dimX = settings.dimX;
            this.dimY = settings.dimY;
            this.dimZ = settings.dimZ;
        }
        if (typeof settings.cellSize === "number") this.cellSize = settings.cellSize;
        if (typeof settings.isoLevel === "number") this.isoLevel = settings.isoLevel;
        if (typeof settings.radius === "number") this.radius = settings.radius;
        if (settings.biomeSettings) this.biomeSettings = resolveBiomeSettings(settings.biomeSettings);

        if (settings.origin) {
            this.origin = settings.origin.clone
                ? settings.origin.clone()
                : new BABYLON.Vector3(settings.origin.x, settings.origin.y, settings.origin.z);
        }

        // Carves passed from ChunkedPlanetTerrain as plain objects: [{position:{x,y,z}, radius}]
        this.carves = settings.carves || [];

        const buildKey = settings.buildKey ?? null;
        const shouldApplyResult = settings.shouldApplyResult;

        // Version gate: if multiple rebuilds are requested quickly, only apply the latest
        this._buildVersion = (this._buildVersion || 0) + 1;
        const myVersion = this._buildVersion;

        if (this.useWorker && typeof Worker !== "undefined") {
            return buildMeshAsync({
                version: myVersion,
                buildKey,
                dimX: this.dimX,
                dimY: this.dimY,
                dimZ: this.dimZ,
                cellSize: this.cellSize,
                radius: this.radius,
                isoLevel: this.isoLevel,
                origin: { x: this.origin.x, y: this.origin.y, z: this.origin.z },
                carves: this.carves,
                wantColors: true,
                biomeSettings: this.biomeSettings
            }).then((msg) => {
                if (msg.version !== this._buildVersion) return { applied: false, skipped: "version" };
                if (typeof shouldApplyResult === "function" && !shouldApplyResult(msg)) {
                    return { applied: false, skipped: "stale" };
                }
                this._applyMeshBuffers(msg.positions, msg.normals, msg.indices, msg.colors);
                return { applied: true };
            }).catch((err) => {
                console.error("Mesh worker rebuild failed, falling back:", err);
                this._buildInitialField();
                this._buildMesh();
                return { applied: true };
            });
        }

        // Fallback (no worker)
        this._buildInitialField();
        this._buildMesh();
        return { applied: true };
    }



    // Rebuild this chunk at a new world-space origin (used by streaming).
    // Keeps the same resolution, cellSize, radius, mesh and material.
    // Convenience: only move origin, keep current resolution
    rebuildAtOrigin(newOrigin) {
        this.rebuildWithSettings({ origin: newOrigin });
    }

	
    /**
     * TEMPORARY COLLIDER MESH BUILDER
     * -------------------------------
     * Right now we simply reuse the visual mesh as the collider mesh.
     * This keeps behavior stable while we build out the real collider
     * generation pipeline in later steps.
     *
     * Later:
     *  - we will generate a lower-poly collider mesh
     *  - physics LOD will be independent of render LOD
     *  - player will walk on this collider instead of the render mesh
     */
    rebuildColliderFromField() {
        // No render mesh? No collider.
        if (!this.mesh) {
            this.colliderMesh = null;
            return;
        }

        // For now, collider = render mesh.
        this.colliderMesh = this.mesh;

        // Make sure collider metadata is set correctly.
        this.colliderMesh.metadata = this.colliderMesh.metadata || {};
        this.colliderMesh.metadata.isTerrainCollider = true;

        // Collision picking only matters for visual mesh,
        // colliderMesh will not be visible anyway.
        this.colliderMesh.checkCollisions = true;
        // We leave isPickable inherited from mesh; collider itself is invisible.
    }



	    /**
     * Build a simplified collider mesh from the existing scalar field.
     * For now, this reuses Marching Cubes at a lower resolution.
     * Later we can swap this for a lower-poly approximation.
     */
    _buildColliderMesh(dimX, dimY, dimZ, cellSize) {
        // TEMP: use the same marching cubes routine but WITHOUT colors
        // and with fewer vertices.
        const positions = [];
        const indices = [];
        const normals = [];

        const iso = this.isoLevel;

        const mcTables = window.mcTables;
        if (!mcTables) {
            console.error("MarchingCubes tables not found for collider mesh.");
            return;
        }

        const edges = mcTables.edges;
        const triTable = mcTables.triTableRaw;

        const interpolate = (p1, p2, val1, val2) => {
            const alpha = (iso - val1) / (val2 - val1);
            return p1 + (p2 - p1) * alpha;
        };

        const offsetField = (x, y, z) => this._index(x, y, z);

        // basic marching cubes loop but WITHOUT colors
        for (let x = 0; x < dimX - 1; x++) {
            for (let y = 0; y < dimY - 1; y++) {
                for (let z = 0; z < dimZ - 1; z++) {
                    const f0 = this.field[offsetField(x, y, z)];
                    const f1 = this.field[offsetField(x + 1, y, z)];
                    const f2 = this.field[offsetField(x, y + 1, z)];
                    const f3 = this.field[offsetField(x + 1, y + 1, z)];
                    const f4 = this.field[offsetField(x, y, z + 1)];
                    const f5 = this.field[offsetField(x + 1, y, z + 1)];
                    const f6 = this.field[offsetField(x, y + 1, z + 1)];
                    const f7 = this.field[offsetField(x + 1, y + 1, z + 1)];

                    let cubeIndex = 0;
                    if (f0 < iso) cubeIndex |= 1;
                    if (f1 < iso) cubeIndex |= 2;
                    if (f3 < iso) cubeIndex |= 8;
                    if (f2 < iso) cubeIndex |= 4;
                    if (f4 < iso) cubeIndex |= 16;
                    if (f5 < iso) cubeIndex |= 32;
                    if (f7 < iso) cubeIndex |= 128;
                    if (f6 < iso) cubeIndex |= 64;

                    if (cubeIndex === 0 || cubeIndex === 255) continue;

                    const baseX = x * cellSize;
                    const baseY = y * cellSize;
                    const baseZ = z * cellSize;

                    const corners = [
                        new BABYLON.Vector3(baseX, baseY, baseZ),
                        new BABYLON.Vector3(baseX + cellSize, baseY, baseZ),
                        new BABYLON.Vector3(baseX, baseY + cellSize, baseZ),
                        new BABYLON.Vector3(baseX + cellSize, baseY + cellSize, baseZ),
                        new BABYLON.Vector3(baseX, baseY, baseZ + cellSize),
                        new BABYLON.Vector3(baseX + cellSize, baseY, baseZ + cellSize),
                        new BABYLON.Vector3(baseX, baseY + cellSize, baseZ + cellSize),
                        new BABYLON.Vector3(baseX + cellSize, baseY + cellSize, baseZ + cellSize),
                    ];

                    const vertList = new Array(12);

                    for (let e = 0; e < 12; e++) {
                        const edgePair = edges[e];
                        if (edgePair === undefined) continue;
                        const i0 = edgePair[0];
                        const i1 = edgePair[1];
                        const p0 = corners[i0];
                        const p1 = corners[i1];

                        const val0 = [f0, f1, f2, f3, f4, f5, f6, f7][i0];
                        const val1 = [f0, f1, f2, f3, f4, f5, f6, f7][i1];

                        const ix = interpolate(p0.x, p1.x, val0, val1);
                        const iy = interpolate(p0.y, p1.y, val0, val1);
                        const iz = interpolate(p0.z, p1.z, val0, val1);

                        vertList[e] = new BABYLON.Vector3(ix, iy, iz);
                    }

                    const triRow = triTable[cubeIndex];
                    for (let t = 0; t < triRow.length; t += 3) {
                        if (triRow[t] < 0) break;
                        const a = vertList[triRow[t]];
                        const b = vertList[triRow[t + 1]];
                        const c = vertList[triRow[t + 2]];
                        if (!a || !b || !c) continue;

                        const idx = positions.length / 3;

                        positions.push(a.x, a.y, a.z);
                        positions.push(b.x, b.y, b.z);
                        positions.push(c.x, c.y, c.z);

                        indices.push(idx, idx + 1, idx + 2);
                    }
                }
            }
        }

        // build or update collider mesh
        if (!this.colliderMesh) {
            this.colliderMesh = new BABYLON.Mesh("terrainCollider", this.scene);
            this.colliderMesh.checkCollisions = true;
            this.colliderMesh.isPickable = false;
            this.colliderMesh.isVisible = false; // invisible
        }

        const colliderData = new BABYLON.VertexData();
        colliderData.positions = positions;
        colliderData.indices = indices;
        BABYLON.VertexData.ComputeNormals(positions, indices, normals);
        colliderData.normals = normals;

        colliderData.applyToMesh(this.colliderMesh);

        this.colliderMesh.position = this.origin;
        this.colliderMesh.metadata = this.colliderMesh.metadata || {};
        this.colliderMesh.metadata.isTerrainCollider = true;
    }

}
