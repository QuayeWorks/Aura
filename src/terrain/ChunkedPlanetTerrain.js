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

        // Vertical resolution: big enough to fully contain the sphere
        this.cellSize = options.cellSize ?? 1.0;
        this.isoLevel = options.isoLevel ?? 0.0;
        this.radius = options.radius ?? 18.0;

        const neededY = Math.ceil((this.radius * 2) / this.cellSize) + 4;
        this.baseDimY = options.dimY ?? neededY;

        // Global LOD limit controlled by UI slider:
        // 0 = only coarse, 1 = up to medium, 2 = allow high near camera
        this.lodLevel = 2;

        // Distance thresholds for LOD rings (in world units)
        // dist < near  -> high (2)
        // < mid        -> medium (1)
        // else         -> low (0)
        this.lodNear = options.lodNear ?? this.radius * 1.5;
        this.lodMid  = options.lodMid  ?? this.radius * 3.0;

        this.chunks = [];         // { terrain, gridX, gridZ, lodLevel }
        this.material = null;
        this.meshPool = [];       // pool of reusable Babylon meshes

        // Queue of pending chunk rebuilds (for smooth streaming / LOD changes)
        this.buildQueue = [];

        // Persistent edit history so carves survive streaming / LOD rebuilds
        this.carveHistory = [];

        // Streaming / grid tracking
        this.gridOffsetX = 0;
        this.gridOffsetZ = 0;

        // Cached world-space chunk metrics (set via _computeBaseChunkMetrics)
        this.chunkWorldSizeX = 0;
        this.chunkWorldSizeZ = 0;
        this.chunkOverlap = 0;

        // Camera position used for LOD ring decisions
        this.lastCameraPosition = null;

        this._rebuildChunks();
    }

    // Map lod level -> resolution divisor (higher level = more detail)
    _lodFactorFor(level) {
        switch (level) {
            case 0: return 3; // low (coarse)
            case 1: return 2; // medium
            case 2:
            default: return 1; // high
        }
    }

    // Dist (from camera to chunk center) -> desired LOD level, clamped by global limit
    _lodForDistance(dist) {
        let desired;
        if (dist < this.lodNear) {
            desired = 2; // high
        } else if (dist < this.lodMid) {
            desired = 1; // medium
        } else {
            desired = 0; // low
        }
        return Math.min(desired, this.lodLevel);
    }

    // Base chunk metrics that do NOT depend on LOD
    _computeBaseChunkMetrics() {
        const baseCellsX = this.baseChunkResolution - 1;
        const baseCellsZ = baseCellsX;
        const baseCellsY = this.baseDimY - 1;

        const baseChunkWidth  = baseCellsX * this.cellSize;
        const baseChunkDepth  = baseCellsZ * this.cellSize;
        const baseChunkHeight = baseCellsY * this.cellSize;

        return {
            baseCellsX,
            baseCellsZ,
            baseCellsY,
            baseChunkWidth,
            baseChunkDepth,
            baseChunkHeight
        };
    }

    // Given an LOD level, compute grid resolution + cellSize that keep world size fixed
    _computeLodDimensions(lodLevel) {
        const {
            baseCellsX,
            baseCellsZ,
            baseCellsY,
            baseChunkWidth,
            baseChunkDepth,
            baseChunkHeight
        } = this._computeBaseChunkMetrics();

        const factor = this._lodFactorFor(lodLevel);

        const dimX = Math.max(6, Math.floor(this.baseChunkResolution / factor));
        const dimZ = dimX; // square in X/Z

        const cellSizeLod = baseChunkWidth / (dimX - 1);

        const dimYFloat = baseChunkHeight / cellSizeLod;
        const dimY = Math.max(6, Math.round(dimYFloat) + 1);

        return {
            dimX,
            dimY,
            dimZ,
            cellSize: cellSizeLod,
            chunkWidth: baseChunkWidth,
            chunkDepth: baseChunkDepth,
            chunkHeight: baseChunkHeight
        };
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
        // Keep this.material so future chunks can share it
    }

    _rebuildChunks() {
        this._disposeChunks();

        const baseMetrics = this._computeBaseChunkMetrics();
        this.chunkWorldSizeX = baseMetrics.baseChunkWidth;
        this.chunkWorldSizeZ = baseMetrics.baseChunkDepth;

        const chunkWidth  = baseMetrics.baseChunkWidth;
        const chunkDepth  = baseMetrics.baseChunkDepth;
        const chunkHeight = baseMetrics.baseChunkHeight;

        // Overlap so edges match between neighboring chunks
        const overlap = 1 * this.cellSize; // one voxel layer at base scale
        this.chunkOverlap = overlap;

        const halfCountX = this.chunkCountX / 2.0;
        const halfCountZ = this.chunkCountZ / 2.0;

        const camPos =
            this.lastCameraPosition ||
            new BABYLON.Vector3(0, 0, this.radius * 2);

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

                // Chunk center (approx) for distance based LOD
                const chunkCenter = new BABYLON.Vector3(
                    origin.x + chunkWidth * 0.5,
                    0,
                    origin.z + chunkDepth * 0.5
                );
                const dist = BABYLON.Vector3.Distance(camPos, chunkCenter);
                const lodForChunk = this._lodForDistance(dist);
                const lodDims = this._computeLodDimensions(lodForChunk);

                // Try to reuse a mesh from the pool
                const pooledMesh =
                    this.meshPool.length > 0 ? this.meshPool.pop() : null;

                const terrain = new MarchingCubesTerrain(this.scene, {
                    dimX: lodDims.dimX,
                    dimY: lodDims.dimY,
                    dimZ: lodDims.dimZ,
                    cellSize: lodDims.cellSize,
                    isoLevel: this.isoLevel,
                    radius: this.radius,
                    origin,
                    mesh: pooledMesh,
                    material: this.material
                });

                // Share a single material across all chunks so UI can tweak one
                if (!this.material) {
                    this.material = terrain.material;
                } else if (terrain.mesh && terrain.mesh.material !== this.material) {
                    terrain.mesh.material = this.material;
                }

                // Reapply all previous carve operations to this new chunk
                for (const op of this.carveHistory) {
                    terrain.carveSphere(op.position, op.radius);
                }

                this.chunks.push({
                    terrain,
                    gridX: gx,
                    gridZ: gz,
                    lodLevel: lodForChunk
                });
            }
        }
    }

    /**
     * After gridOffsetX/Z change, schedule all chunks to be rebuilt
     * at their new world-space origins (and appropriate LOD).
     * Heavy work is spread over frames via _processBuildQueue.
     */
    _scheduleRebuildForNewGrid() {
        this.buildQueue = [];

        const baseMetrics = this._computeBaseChunkMetrics();
        const chunkWidth  = baseMetrics.baseChunkWidth;
        const chunkDepth  = baseMetrics.baseChunkDepth;

        const overlap = this.chunkOverlap || (1 * this.cellSize);
        const halfCountX = this.chunkCountX / 2.0;
        const halfCountZ = this.chunkCountZ / 2.0;

        const camPos = this.lastCameraPosition;

        for (let ix = 0; ix < this.chunkCountX; ix++) {
            for (let iz = 0; iz < this.chunkCountZ; iz++) {
                const idx = ix + iz * this.chunkCountX;
                const c = this.chunks[idx];
                if (!c) continue;

                const gx = (ix - halfCountX + 0.5) + this.gridOffsetX;
                const gz = (iz - halfCountZ + 0.5) + this.gridOffsetZ;

                const origin = new BABYLON.Vector3(
                    gx * (chunkWidth - overlap) - (chunkWidth * 0.5),
                    -baseMetrics.baseChunkHeight * 0.5,
                    gz * (chunkDepth - overlap) - (chunkDepth * 0.5)
                );

                // New LOD based on current camera distance
                let lodLevel = c.lodLevel;
                if (camPos) {
                    const chunkCenter = new BABYLON.Vector3(
                        origin.x + chunkWidth * 0.5,
                        0,
                        origin.z + chunkDepth * 0.5
                    );
                    const dist = BABYLON.Vector3.Distance(camPos, chunkCenter);
                    lodLevel = this._lodForDistance(dist);
                }

                c.gridX = gx;
                c.gridZ = gz;
                c.lodLevel = lodLevel;

                this.buildQueue.push({
                    chunk: c.terrain,
                    origin,
                    lodLevel
                });
            }
        }
    }
    /**
     * Check all chunks against current camera distance and, if their
     * desired LOD has changed, schedule a rebuild for that chunk only.
     */
    _scheduleLodAdjustments() {
        if (!this.lastCameraPosition) return;

        const camPos = this.lastCameraPosition;
        const baseMetrics = this._computeBaseChunkMetrics();
        const chunkWidth  = baseMetrics.baseChunkWidth;
        const chunkDepth  = baseMetrics.baseChunkDepth;
        const chunkHeight = baseMetrics.baseChunkHeight; // y not used here, but kept for completeness

        for (const c of this.chunks) {
            if (!c || !c.terrain || !c.terrain.origin) continue;

            const origin = c.terrain.origin;

            const chunkCenter = new BABYLON.Vector3(
                origin.x + chunkWidth * 0.5,
                0,
                origin.z + chunkDepth * 0.5
            );

            const dist = BABYLON.Vector3.Distance(camPos, chunkCenter);
            const desiredLod = this._lodForDistance(dist);

            if (desiredLod === c.lodLevel) {
                continue; // no change for this chunk
            }

            c.lodLevel = desiredLod;

            // Schedule a rebuild of just this chunk at its current origin
            this.buildQueue.push({
                chunk: c.terrain,
                origin: origin.clone ? origin.clone() : origin,
                lodLevel: desiredLod
            });
        }
    }

    /**
     * Process a few pending chunk rebuilds per frame
     * to avoid big hitches when streaming / LOD changes.
     */
    _processBuildQueue(maxPerFrame = 2) {
        let count = 0;
        while (count < maxPerFrame && this.buildQueue.length > 0) {
            const job = this.buildQueue.shift();
            if (!job || !job.chunk) continue;

            const lodDims = this._computeLodDimensions(job.lodLevel);

            job.chunk.rebuildWithSettings({
                origin: job.origin,
                dimX: lodDims.dimX,
                dimY: lodDims.dimY,
                dimZ: lodDims.dimZ,
                cellSize: lodDims.cellSize
            });

            // Reapply all carved edits so terrain remains persistent
            for (const op of this.carveHistory) {
                job.chunk.carveSphere(op.position, op.radius);
            }

            count++;
        }
    }

    // -------------------------------------------------
    // Public API used by main.js
    // -------------------------------------------------

    // LOD slider: sets the *maximum* allowed LOD (0..2) and rebuilds the grid
    setLodLevel(level) {
        const clamped = Math.max(0, Math.min(2, Math.round(level)));
        if (clamped === this.lodLevel) return;
        this.lodLevel = clamped;

        // LOD changes change resolution, so we rebuild all chunks
        this.buildQueue = [];
        this._rebuildChunks();
    }

    /*
     * Basic camera-centered streaming + dynamic LOD rings.
     * Keeps a fixed grid of chunks, but moves their sampling window
     * in world-space as the camera crosses chunk boundaries.
     * Also adjusts LOD per chunk based on distance from the camera.
     * Heavy rebuild work is spread over multiple frames.
     */
    updateStreaming(cameraPosition) {
        if (cameraPosition) {
            // Store camera position for LOD ring decisions
            this.lastCameraPosition = cameraPosition.clone
                ? cameraPosition.clone()
                : new BABYLON.Vector3(
                      cameraPosition.x,
                      cameraPosition.y,
                      cameraPosition.z
                  );
        }

        if (!cameraPosition) {
            // Still process any pending chunk rebuilds
            this._processBuildQueue();
            return;
        }

        const baseMetrics = this._computeBaseChunkMetrics();
        const baseChunkWidth  = baseMetrics.baseChunkWidth;
        const baseChunkDepth  = baseMetrics.baseChunkDepth;

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

        // Even if the grid didn't move, some chunks may need LOD changes
        this._scheduleLodAdjustments();

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

    get materialObj() {
        return this.material;
    }

    // Convenience used by main.js in your current version
    get material() {
        return this.materialRef;
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
