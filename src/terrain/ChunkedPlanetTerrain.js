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
        this.meshPool = []; // pool of reusable Babylon meshes

         // Queue of pending chunk rebuilds (for smooth streaming)
        this.buildQueue = [];
        // Persistent edit history so carves survive streaming / LOD rebuilds
        this.carveHistory = [];
        // Streaming / grid tracking
        this.gridOffsetX = 0;
        this.gridOffsetZ = 0;

        // Cached world-space chunk metrics (set in _rebuildChunks)
        this.chunkWorldSizeX = 0;
        this.chunkWorldSizeZ = 0;
        this.chunkOverlap = 0;

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
            const terrain = c.terrain;
            if (terrain && terrain.mesh) {
                // Disable and keep for reuse instead of destroying
                terrain.mesh.setEnabled(false);
                this.meshPool.push(terrain.mesh);
            }
        }
        this.chunks = [];
        this.buildQueue = [];
        // Keep this.material so all future chunks can share it
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

        // Cache base world-space chunk sizes so streaming code can reuse them
        this.chunkWorldSizeX = baseChunkWidth;
        this.chunkWorldSizeZ = baseChunkDepth;

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
        this.chunkOverlap = overlap;
        const halfCountX = this.chunkCountX / 2.0;
        const halfCountZ = this.chunkCountZ / 2.0;

        for (let ix = 0; ix < this.chunkCountX; ix++) {
            for (let iz = 0; iz < this.chunkCountZ; iz++) {
                // Grid index centered around origin
                const gx = (ix - halfCountX + 0.5) + this.gridOffsetX;
                const gz = (iz - halfCountZ + 0.5) + this.gridOffsetZ;

                // Origin of this chunk's sampling volume (world space)
                const origin = new BABYLON.Vector3(
                    gx * (chunkWidth - overlap) - (chunkWidth * 0.5),
                    -chunkHeight * 0.5,
                    gz * (chunkDepth - overlap) - (chunkDepth * 0.5)
                );

                // Try to reuse a mesh from the pool
                const pooledMesh =
                    this.meshPool.length > 0 ? this.meshPool.pop() : null;

                const chunk = new MarchingCubesTerrain(this.scene, {
                    dimX,
                    dimY,
                    dimZ,
                    cellSize: cellSizeLod, // LOD-scaled voxel size
                    isoLevel: this.isoLevel,
                    radius: this.radius,
                    origin,
                    mesh: pooledMesh,
                    material: this.material
                });

                // Share a single material across all chunks so UI can tweak one
                if (!this.material) {
                    this.material = chunk.material;
                } else if (chunk.mesh && chunk.mesh.material !== this.material) {
                    chunk.mesh.material = this.material;
                }

                // Reapply all previous carve operations to this new chunk
                for (const op of this.carveHistory) {
                    chunk.carveSphere(op.position, op.radius);
                }

                this.chunks.push({
                    terrain: chunk,
                    gridX: gx,
                    gridZ: gz
                });
            }
        }
    }
    /**
     * After gridOffsetX/Z change, schedule all chunks to be rebuilt
     * at their new world-space origins. The actual heavy rebuild
     * work is spread over multiple frames via _processBuildQueue.
     */
    _scheduleRebuildForNewGrid() {
        this.buildQueue = [];

        const baseCellsX = this.baseChunkResolution - 1;
        const baseCellsZ = baseCellsX;
        const baseChunkWidth  = baseCellsX * this.cellSize;
        const baseChunkDepth  = baseCellsZ * this.cellSize;
        const overlap = this.chunkOverlap || (1 * this.cellSize);

        const chunkWidth  = baseChunkWidth;
        const chunkDepth  = baseChunkDepth;

        const halfCountX = this.chunkCountX / 2.0;
        const halfCountZ = this.chunkCountZ / 2.0;

        for (let ix = 0; ix < this.chunkCountX; ix++) {
            for (let iz = 0; iz < this.chunkCountZ; iz++) {
                const idx = ix + iz * this.chunkCountX;
                const c = this.chunks[idx];
                if (!c) continue;

                const gx = (ix - halfCountX + 0.5) + this.gridOffsetX;
                const gz = (iz - halfCountZ + 0.5) + this.gridOffsetZ;

                const origin = new BABYLON.Vector3(
                    gx * (chunkWidth - overlap) - (chunkWidth * 0.5),
                    -this.baseDimY * this.cellSize * 0.5,
                    gz * (chunkDepth - overlap) - (chunkDepth * 0.5)
                );

                c.gridX = gx;
                c.gridZ = gz;

                this.buildQueue.push({
                    chunk: c.terrain,
                    origin
                });
            }
        }
    }

    /**
     * Process a few pending chunk rebuilds per frame
     * to avoid big hitches when streaming.
     */
    _processBuildQueue(maxPerFrame = 2) {
        let count = 0;
        while (count < maxPerFrame && this.buildQueue.length > 0) {
            const job = this.buildQueue.shift();
            if (!job || !job.chunk) continue;

            job.chunk.rebuildAtOrigin(job.origin);

            // Reapply all carved edits so terrain remains persistent
            for (const op of this.carveHistory) {
                job.chunk.carveSphere(op.position, op.radius);
            }

            count++;
        }
    }


    // Public API used by main.js ------------------------

    // Adjust LOD level: 0 = low, 1 = medium, 2 = high
    setLodLevel(level) {
        const clamped = Math.max(0, Math.min(2, Math.round(level)));
        if (clamped === this.lodLevel) return;
        this.lodLevel = clamped;

        // LOD changes alter resolution, so we do a full rebuild
        this.buildQueue = [];
        this._rebuildChunks();
    }

    
    /*
     * Basic camera-centered streaming.
     * Keeps a fixed grid of chunks, but moves their sampling window
     * in world-space as the camera crosses chunk boundaries.
     * Heavy rebuild work is spread over multiple frames.
     */
    updateStreaming(cameraPosition) {
        if (!cameraPosition) {
            // Still process any pending chunk rebuilds
            this._processBuildQueue();
            return;
        }

        const baseCellsX = this.baseChunkResolution - 1;
        const baseCellsZ = baseCellsX;
        const baseChunkWidth  = baseCellsX * this.cellSize;
        const baseChunkDepth  = baseCellsZ * this.cellSize;

        const overlap = this.chunkOverlap || (1 * this.cellSize);
        const stepX = (this.chunkWorldSizeX || baseChunkWidth) - overlap;
        const stepZ = (this.chunkWorldSizeZ || baseChunkDepth) - overlap;

        if (stepX <= 0 || stepZ <= 0) {
            this._processBuildQueue();
            return;
        }

        // Which "chunk index" is the camera currently over?
        const camChunkX = Math.round(cameraPosition.x / stepX);
        const camChunkZ = Math.round(cameraPosition.z / stepZ);

        // If we've crossed into a new chunk index, shift the grid logically
        if (camChunkX !== this.gridOffsetX || camChunkZ !== this.gridOffsetZ) {
            this.gridOffsetX = camChunkX;
            this.gridOffsetZ = camChunkZ;
            this._scheduleRebuildForNewGrid();
        }

        // Each frame, rebuild a few chunks from the queue
        this._processBuildQueue();
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
        // Store this carve so it can be replayed after streaming/LOD rebuilds
        this.carveHistory.push({
            position: worldPos.clone ? worldPos.clone() : worldPos,
            radius
        });

        // Apply immediately to all current chunks
        for (const c of this.chunks) {
            if (c.terrain) {
                c.terrain.carveSphere(worldPos, radius);
            }
        }
    }
}
