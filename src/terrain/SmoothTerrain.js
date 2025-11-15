// src/terrain/SmoothTerrain.js

export class SmoothTerrain {
    constructor(scene) {
        this.scene = scene;

        // Grid resolution
        this.nx = 40;
        this.ny = 20;
        this.nz = 40;
        this.cellSize = 1.0;

        // Grid origin (world coordinates of node (0,0,0))
        this.origin = new BABYLON.Vector3(
            -this.nx * this.cellSize * 0.5,
            -4,
            -this.nz * this.cellSize * 0.5
        );

        // SDF field
        this.field = new Float32Array(this.nx * this.ny * this.nz);

        // Mesh
        this.mesh = new BABYLON.Mesh("smoothTerrain", this.scene);
        this.mesh.checkCollisions = false;

        const mat = new BABYLON.StandardMaterial("terrainMat", this.scene);
        
        // Flat bright green, NOT affected by lights:
        mat.diffuseColor  = new BABYLON.Color3(0.1, 0.9, 0.3);
        mat.emissiveColor = new BABYLON.Color3(0.1, 0.8, 0.3);
        mat.ambientColor  = new BABYLON.Color3(0.1, 0.8, 0.3);
        mat.diffuseColor  = new BABYLON.Color3(0.06, 0.6, 0.20);

        mat.disableLighting = true;          // <--- key line
        mat.backFaceCulling = false;         // show both sides of the surface
        
        this.mesh.material = mat;


    }

    nodeIndex(x, y, z) {
        return x + this.nx * (y + this.ny * z);
    }

    // SDF for rolling hills
    sdf(worldPos) {
        const sx = worldPos.x * 0.08;
        const sz = worldPos.z * 0.08;

        const hills =
            Math.sin(sx * 2.0) * 2.0 +
            Math.cos(sz * 1.7) * 1.8 +
            Math.sin((sx + sz) * 0.9) * 1.3;

        const baseHeight = 0.0;
        const terrainHeight = baseHeight + hills;

        return worldPos.y - terrainHeight; // <0 solid, >0 air
    }

    buildInitialTerrain() {
        for (let z = 0; z < this.nz; z++) {
            for (let y = 0; y < this.ny; y++) {
                for (let x = 0; x < this.nx; x++) {
                    const wx = this.origin.x + x * this.cellSize;
                    const wy = this.origin.y + y * this.cellSize;
                    const wz = this.origin.z + z * this.cellSize;

                    const idx = this.nodeIndex(x, y, z);
                    this.field[idx] = this.sdf(new BABYLON.Vector3(wx, wy, wz));
                }
            }
        }

        this.rebuildMesh();
    }

    rebuildMesh() {
        const nx = this.nx;
        const ny = this.ny;
        const nz = this.nz;
        const field = this.field;

        const cx = nx - 1;
        const cy = ny - 1;
        const cz = nz - 1;

        const cellCount = cx * cy * cz;
        const vertId = new Int32Array(cellCount);
        for (let i = 0; i < cellCount; i++) vertId[i] = -1;

        const positions = [];
        const indices = [];
        const uvs = [];
        const normals = [];

        const nodeIdx = (x, y, z) => x + nx * (y + ny * z);
        const cellIdx = (x, y, z) => x + cx * (y + cy * z);
        const getField = (x, y, z) => field[nodeIdx(x, y, z)];

        let vertexCount = 0;

        // 1) place vertex per sign-changing cell
        for (let z = 0; z < cz; z++) {
            for (let y = 0; y < cy; y++) {
                for (let x = 0; x < cx; x++) {
                    const v0 = getField(x,     y,     z);
                    const v1 = getField(x + 1, y,     z);
                    const v2 = getField(x,     y + 1, z);
                    const v3 = getField(x + 1, y + 1, z);
                    const v4 = getField(x,     y,     z + 1);
                    const v5 = getField(x + 1, y,     z + 1);
                    const v6 = getField(x,     y + 1, z + 1);
                    const v7 = getField(x + 1, y + 1, z + 1);

                    let neg = false, pos = false;
                    const vs = [v0, v1, v2, v3, v4, v5, v6, v7];
                    for (let i = 0; i < 8; i++) {
                        if (vs[i] < 0) neg = true;
                        else if (vs[i] > 0) pos = true;
                    }
                    if (!neg || !pos) continue;

                    const ci = cellIdx(x, y, z);
                    vertId[ci] = vertexCount;

                    const wx = this.origin.x + (x + 0.5) * this.cellSize;
                    const wy = this.origin.y + (y + 0.5) * this.cellSize;
                    const wz = this.origin.z + (z + 0.5) * this.cellSize;

                    positions.push(wx, wy, wz);
                    uvs.push(x / cx, z / cz);

                    vertexCount++;
                }
            }
        }

        const addQuad = (a, b, c, d) => {
            indices.push(a, b, c);
            indices.push(a, c, d);
        };

        // 2) connect neighboring cell vertices
        for (let z = 0; z < cz; z++) {
            for (let y = 0; y < cy; y++) {
                for (let x = 0; x < cx; x++) {
                    const ci = cellIdx(x, y, z);
                    const v = vertId[ci];
                    if (v < 0) continue;

                    // X
                    if (x + 1 < cx) {
                        const ciX = cellIdx(x + 1, y, z);
                        const vX = vertId[ciX];
                        if (vX >= 0) {
                            if (y + 1 < cy) {
                                const ciY  = cellIdx(x,     y + 1, z);
                                const ciXY = cellIdx(x + 1, y + 1, z);
                                const vY  = vertId[ciY];
                                const vXY = vertId[ciXY];
                                if (vY >= 0 && vXY >= 0) {
                                    addQuad(v, vX, vXY, vY);
                                }
                            }
                            if (z + 1 < cz) {
                                const ciZ  = cellIdx(x,     y, z + 1);
                                const ciXZ = cellIdx(x + 1, y, z + 1);
                                const vZ  = vertId[ciZ];
                                const vXZ = vertId[ciXZ];
                                if (vZ >= 0 && vXZ >= 0) {
                                    addQuad(v, vX, vXZ, vZ);
                                }
                            }
                        }
                    }

                    // Y
                    if (y + 1 < cy) {
                        const ciY = cellIdx(x, y + 1, z);
                        const vY = vertId[ciY];
                        if (vY >= 0 && z + 1 < cz) {
                            const ciZ  = cellIdx(x, y,     z + 1);
                            const ciYZ = cellIdx(x, y + 1, z + 1);
                            const vZ  = vertId[ciZ];
                            const vYZ = vertId[ciYZ];
                            if (vZ >= 0 && vYZ >= 0) {
                                addQuad(v, vY, vYZ, vZ);
                            }
                        }
                    }

                    // Z
                    if (z + 1 < cz) {
                        const ciZ = cellIdx(x, y, z + 1);
                        const vZ = vertId[ciZ];
                        if (vZ >= 0 && x + 1 < cx) {
                            const ciX  = cellIdx(x + 1, y, z);
                            const ciXZ = cellIdx(x + 1, y, z + 1);
                            const vX  = vertId[ciX];
                            const vXZ = vertId[ciXZ];
                            if (vX >= 0 && vXZ >= 0) {
                                addQuad(v, vZ, vXZ, vX);
                            }
                        }
                    }
                }
            }
        }

        BABYLON.VertexData.ComputeNormals(positions, indices, normals);

        const vertexData = new BABYLON.VertexData();
        vertexData.positions = positions;
        vertexData.indices   = indices;
        vertexData.normals   = normals;
        vertexData.uvs       = uvs;

        vertexData.applyToMesh(this.mesh);
    }

    carveSphere(worldCenter, radius) {
        const r2 = radius * radius;

        for (let z = 0; z < this.nz; z++) {
            for (let y = 0; y < this.ny; y++) {
                for (let x = 0; x < this.nx; x++) {
                    const wx = this.origin.x + x * this.cellSize;
                    const wy = this.origin.y + y * this.cellSize;
                    const wz = this.origin.z + z * this.cellSize;

                    const dx = wx - worldCenter.x;
                    const dy = wy - worldCenter.y;
                    const dz = wz - worldCenter.z;
                    const dist2 = dx * dx + dy * dy + dz * dz;

                    if (dist2 <= r2) {
                        const idx = this.nodeIndex(x, y, z);
                        const v = this.field[idx];
                        if (v < 0) {
                            this.field[idx] = Math.abs(v) + 0.01;
                        }
                    }
                }
            }
        }

        this.rebuildMesh();
    }
}





