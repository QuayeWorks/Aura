// src/terrain/ChunkedPlanetTerrain.js
import { MarchingCubesTerrain } from "./MarchingCubesTerrain.js";

export class ChunkedPlanetTerrain {
    constructor(scene, options = {}) {
        this.scene = scene;

        // How many chunks along X and Z (odd number recommended)
        this.chunkCountX = options.chunkCountX ?? 3;
        this.chunkCountZ = options.chunkCountZ ?? 3;

        // Base resolution of a chunk in cells (will be divided by LOD factor)
        this.baseChunkResolution = options.baseChunkResolution ?? 22;
        
        this.baseDimY = options.dimY ?? 32;   // remember base vertical samples
        
        this.cellSize = options.cellSize ?? 1.0;
        this.isoLevel = options.isoLevel ?? 0.0;
        this.radius = options.radius ?? 18.0;
        
        // Make vertical resolution big enough to fully contain the sphere
        // (2 * radius / cellSize) + a small margin.
        const neededY = Math.ceil((this.radius * 2) / this.cellSize) + 4;
        this.baseDimY = options.dimY ?? neededY;



        // LOD level: 2 = high, 1 = medium, 0 = low
        this.lodLevel = 2; // start on high quality

        this.chunks = [];
        this.material = null;

        this._rebuildChunks();
    }

    // Map lodLevel -> resolution divisor
    _lodFactor() {
        switch (this.lodLevel) {
            case 0: return 3; // low (coarse mesh)
            case 1: return 2; // medium
            case 2:
            default: return 1; // high
        }
    }

    _disposeChunks() {
        for (const c of this.chunks) {
            if (c.mesh) {
                c.mesh.dispose();
            }
        }
        this.chunks = [];
        this.material = null;
    }

    _rebuildChunks() { 
        this._disposeChunks();

        const lodFactor = this._lodFactor();

        // --- Base world size of a chunk (never changes with LOD) ---
        const baseCellsX = this.baseChunkResolution - 1;
        const baseCellsZ = baseCellsX;
        const baseCellsY = this.baseDimY - 1;

        const baseChunkWidth  = baseCellsX * this.cellSize;
        const baseChunkDepth  = baseCellsZ * this.cellSize;
        const baseChunkHeight = baseCellsY * this.cellSize;

        // --- Choose how many samples we want at this LOD ---
        const dimX = Math.max(6, Math.floor(this.baseChunkResolution / lodFactor));
        const dimZ = dimX; // square chunk
        // we'll recompute dimY from height in a second

        // Cell size for this LOD: make sure world width stays the same
        const cellSizeLod = baseChunkWidth / (dimX - 1);

        // Now choose dimY so that vertical world size also matches base height
        const dimYFloat = baseChunkHeight / cellSizeLod;
        const dimY = Math.max(6, Math.round(dimYFloat) + 1);

        // World-space chunk size stays constant across LODs
        const chunkWidth  = baseChunkWidth;
        const chunkDepth  = baseChunkDepth;
        const chunkHeight = baseChunkHeight;

        // Overlap so edges match between neighboring chunks
        const overlap = 1 * this.cellSize;   // one voxel layer at base scale

        const halfCountX = this.chunkCountX / 2.0;
        const halfCountZ = this.chunkCountZ / 2.0;

        for (let ix = 0; ix < this.chunkCountX; ix++) {
            for (let iz = 0; iz < this.chunkCountZ; iz++) {
                // Grid index centered around origin
                const gx = ix - halfCountX + 0.5;
                const gz = iz - halfCountZ + 0.5;

                // Origin of this chunk's sampling volume (world space)
                const origin = new BABYLON.Vector3(
                    gx * (chunkWidth - overlap) - (chunkWidth * 0.5),
                    -chunkHeight * 0.5,
                    gz * (chunkDepth - overlap) - (chunkDepth * 0.5)
                );

                const chunk = new MarchingCubesTerrain(this.scene, {
                    dimX,
                    dimY,
                    dimZ,
                    cellSize: cellSizeLod,     // LOD-scaled voxel size
                    isoLevel: this.isoLevel,
                    radius: this.radius,
                    origin
                });

                // Share a single material across all chunks so UI can tweak one
                if (!this.material) {
                    this.material = chunk.material;
                } else {
                    chunk.mesh.material = this.material;
                }

                this.chunks.push(chunk);
            }
        }
    }


    // Public API used by main.js ------------------------

    // Adjust LOD level: 0 = low, 1 = medium, 2 = high
    setLodLevel(level) {
        const clamped = Math.max(0, Math.min(2, Math.round(level)));
        if (clamped === this.lodLevel) return;
        this.lodLevel = clamped;
        this._rebuildChunks();
    }

    // Shared material (for brightness, wireframe, etc.)
    get materialRef() {
        return this.material;
    }

    // For compatibility with old code that accessed terrain.material
    get materialAlias() {
        return this.material;
    }

    // Carve a sphere out of all chunks
    carveSphere(worldPos, radius) {
        for (const chunk of this.chunks) {
            chunk.carveSphere(worldPos, radius);
        }
    }
}
