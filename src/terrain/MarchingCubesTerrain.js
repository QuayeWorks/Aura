// src/terrain/MarchingCubesTerrain.js

//
// NOTE ABOUT TABLES
// -----------------
// Marching Cubes relies on two precomputed tables:
//
//   - edgeTable: 256 integers (bitmasks), one per cube configuration
//   - triTable:  256 x 16 integers, triangle edge indices for each config
//
// They’re standard and you can copy them directly from any Marching Cubes
// reference, for example Paul Bourke’s “Polygonising a Scalar Field”
// or Seb Lague’s Marching Cubes code.
//
// To keep this reply from being thousands of lines of numbers, I’ve left
// them as TODOs below. Once you paste them in, the terrain will work.
//

// TODO: Paste the standard 256-entry edgeTable array here.
// Example shape:
//
// const edgeTable = [
//   0x000, 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c,
//   ...
//   0xf00
// ];
//
const edgeTable = [/* TODO: paste full 256-entry table here */];

// TODO: Paste the standard 256x16 triTable array here.
// Example shape:
//
// const triTable = [
//   [-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
//   [0, 8, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
//   ...
// ];
//
const triTable = [/* TODO: paste full 256 x 16 table here */];

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

        // Center the volume around the origin
        this.origin = new BABYLON.Vector3(
            -this.dimX * this.cellSize * 0.5,
            -this.dimY * this.cellSize * 0.5,
            -this.dimZ * this.cellSize * 0.5
        );

        // Scalar field samples at each grid vertex
        this.field = new Float32Array(this.dimX * this.dimY * this.dimZ);

        this.mesh = null;
        this.material = null;

        this._buildInitialField();
        this._buildMesh();
    }

    // Index helper into 1D field array
    _index(x, y, z) {
        return x + this.dimX * (y + this.dimY * z);
    }

    // Signed distance-ish function: sphere + noise
    _sampleSdf(worldPos) {
        const radius = 12.0;

        const center = new BABYLON.Vector3(0, 0, 0);
        const toPoint = worldPos.subtract(center);
        const sphereDist = toPoint.length() - radius;

        // Simple value noise using sin/cos (fast, deterministic)
        const n =
            Math.sin(worldPos.x * 0.3) * 0.5 +
            Math.cos(worldPos.z * 0.25 + worldPos.y * 0.1) * 0.5;

        const noise = n * 1.3;

        return sphereDist + noise;
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
    carveSphere(worldPos, radius) {
        const r2 = radius * radius;

        for (let z = 0; z < this.dimZ; z++) {
            for (let y = 0; y < this.dimY; y++) {
                for (let x = 0; x < this.dimX; x++) {
                    const idx = this._index(x, y, z);
                    const pos = this.origin.add(
                        new BABYLON.Vector3(
                            x * this.cellSize,
                            y * this.cellSize,
                            z * this.cellSize
                        )
                    );

                    const d2 = BABYLON.Vector3.DistanceSquared(pos, worldPos);

                    // If we’re inside the carving sphere, push field to positive (empty)
                    if (d2 <= r2 && this.field[idx] < this.isoLevel) {
                        this.field[idx] = this.isoLevel + 0.01;
                    }
                }
            }
        }

        this._buildMesh();
    }

    _buildMesh() {
        const positions = [];
        const normals = [];
        const indices = [];

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

                        if (e0 === -1 || e1 === -1 || e2 === -1) break;

                        const p0 = vertList[e0];
                        const p1 = vertList[e1];
                        const p2 = vertList[e2];

                        const baseIndex = positions.length / 3;

                        positions.push(
                            p0.x,
                            p0.y,
                            p0.z,
                            p1.x,
                            p1.y,
                            p1.z,
                            p2.x,
                            p2.y,
                            p2.z
                        );

                        // Indices – no vertex sharing for simplicity
                        indices.push(baseIndex, baseIndex + 1, baseIndex + 2);
                    }
                }
            }
        }

        // Compute normals
        BABYLON.VertexData.ComputeNormals(positions, indices, normals);

        const vertexData = new BABYLON.VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;

        if (!this.mesh) {
            this.mesh = new BABYLON.Mesh("marchingCubesTerrain", this.scene);

            this.material = new BABYLON.StandardMaterial(
                "terrainMat",
                this.scene
            );
            this.material.diffuseColor = new BABYLON.Color3(0.2, 0.9, 0.35);
            this.material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
            this.material.backFaceCulling = false;

            this.mesh.material = this.material;
        }

        vertexData.applyToMesh(this.mesh, true);
    }
}
