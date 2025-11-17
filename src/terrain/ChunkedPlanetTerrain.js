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

        // Persistent edit history so carves survive streaming / LOD rebuilds
        this.carveHistory = [];
        // Streaming / grid tracking
        this.gridOffsetX = 0;
        this.gridOffsetZ = 0;

        // Global LOD quality bias (controlled by UI slider)
        this.globalLodLevel = 2;

        // Last camera position for LOD updates
        this._lastCameraPos = null;

        // Queue of chunks waiting for LOD rebuild
        this.lodRebuildQueue = [];

        // Cached world-space chunk metrics (set in _rebuildChunks)
        this.chunkWorldSizeX = 0;
        this.chunkWorldSizeZ = 0;
        this.chunkOverlap = 0;

        this._rebuildChunks();
    }

    /**
     * Compute all geometric parameters for a given LOD level.
     */
    _computeLodParams(lodLevel) {
        const clamped = Math.max(0, Math.min(2, Math.round(lodLevel)));
        const lodFactor = clamped === 2 ? 1 : (clamped === 1 ? 2 : 4);

        const baseCellsX = this.baseChunkResolution - 1;
        const baseCellsZ = baseCellsX;
        const baseCellsY = this.baseDimY - 1;

        const dimX = Math.max(6, Math.floor(this.baseChunkResolution / lodFactor));
        const dimZ = dimX;
        const dimY = this.baseDimY;

        const cellSizeLod = this.cellSize * lodFactor;

        const chunkWidth  = (dimX - 1) * cellSizeLod;
        const chunkDepth  = (dimZ - 1) * cellSizeLod;
        const chunkHeight = (dimY - 1) * cellSizeLod;

        const overlap = 1 * this.cellSize; // one base voxel as overlap

        return {
            lodLevel: clamped,
            lodFactor,
            baseCellsX,
            baseCellsZ,
            baseCellsY,
            dimX,
            dimY,
            dimZ,
            cellSizeLod,
            chunkWidth,
            chunkDepth,
            chunkHeight,
            overlap
        };
    }

    /**
     * Create a single chunk entry at grid coords (ix, iz) for the given LOD.
     * Reuses a pooled mesh if provided.
     */
    _createChunkEntry(ix, iz, lodLevel, pooledMesh) {
        const params = this._computeLodParams(lodLevel);
        const {
            dimX,
            dimY,
            dimZ,
            cellSizeLod,
            chunkWidth,
            chunkDepth,
            chunkHeight,
            overlap
        } = params;

        const halfCountX = this.chunkCountX / 2.0;
        const halfCountZ = this.chunkCountZ / 2.0;

        // Grid index centered around origin + current streaming offset
        const gx = (ix - halfCountX + 0.5) + this.gridOffsetX;
        const gz = (iz - halfCountZ + 0.5) + this.gridOffsetZ;

        const origin = new BABYLON.Vector3(
            gx * (chunkWidth - overlap) - (chunkWidth * 0.5),
            -chunkHeight * 0.5,
            gz * (chunkDepth - overlap) - (chunkDepth * 0.5)
        );

        const terrain = new MarchingCubesTerrain(this.scene, {
            dimX,
            dimY,
            dimZ,
            cellSize: cellSizeLod,
            isoLevel: this.isoLevel,
            radius: this.radius,
            origin,
            mesh: pooledMesh,
            material: this.material
        });

        // Share a single material across all chunks
        if (!this.material) {
            this.material = terrain.material;
        } else if (terrain.mesh && terrain.mesh.material !== this.material) {
            terrain.mesh.material = this.material;
        }

        // Re-apply persisted carves to this new chunk
        for (const op of this.carveHistory) {
            terrain.carveSphere(op.position, op.radius);
        }

        // Approximate center of the chunk volume (for later LOD distance checks)
        const center = origin.add(new BABYLON.Vector3(
            chunkWidth * 0.5,
            chunkHeight * 0.5,
            chunkDepth * 0.5
        ));

        return {
            ix,
            iz,
            lodLevel,
            targetLod: null, // pending LOD rebuild target (if any)
            terrain,
            center
        };
    }

    /**
     * Decide desired LOD for a given distance and current LOD,
     * using the global LOD bias and hysteresis so chunks don't flap.
     */
    _getLodForDistance(distance, currentLod) {
        const base = this.globalLodLevel;

        // Base thresholds for high/medium rings
        let highRadius;
        let midRadius;

        if (base >= 2) {
            highRadius = 120;
            midRadius = 260;
        } else if (base >= 1) {
            highRadius = 70;
            midRadius = 180;
        } else {
            highRadius = 40;
            midRadius = 120;
        }

        // Hysteresis margin: how big the "buffer zone" is
        const margin = 20;

        // If we don't know the current LOD, fall back to simple thresholds
        if (currentLod !== 0 && currentLod !== 1 && currentLod !== 2) {
            if (distance < highRadius) return 2;
            if (distance < midRadius) return 1;
            return 0;
        }

        // Hysteresis logic:
        // - To downgrade quality, distance must go past radius + margin.
        // - To upgrade quality, distance must go below radius - margin.

        if (currentLod === 2) {
            // Highest detail; only drop to 1 if we move clearly beyond highRadius
            if (distance > highRadius + margin) {
                return 1;
            }
            return 2;
        }

        if (currentLod === 1) {
            // Mid detail: can go up or down
            if (distance < highRadius - margin) {
                return 2; // move closer -> upgrade to high
            }
            if (distance > midRadius + margin) {
                return 0; // move far -> downgrade to low
            }
            return 1; // stay mid
        }

        // currentLod === 0 (lowest detail)
        if (distance < midRadius - margin) {
            return 1; // move closer -> upgrade to mid
        }
        return 0;
    }

    /**
     * Update each chunk's desired LOD based on distance to the camera.
     * Only enqueues chunks for rebuild; actual rebuilds are processed
     * separately to spread work across frames.
     */
    _updateLodForCamera(cameraPosition) {
        if (!cameraPosition || this.chunks.length === 0) {
            return;
        }

        this._lastCameraPos = cameraPosition.clone
            ? cameraPosition.clone()
            : cameraPosition;

        for (const entry of this.chunks) {
            if (!entry.center) {
                continue;
            }

            const d = BABYLON.Vector3.Distance(cameraPosition, entry.center);
            const desiredLod = this._getLodForDistance(d, entry.lodLevel);

            if (desiredLod !== entry.lodLevel && desiredLod !== entry.targetLod) {
                // Mark target LOD and enqueue for rebuild
                entry.targetLod = desiredLod;
                this.lodRebuildQueue.push(entry);
            }
        }
    }

    /**
     * Process a limited number of pending LOD rebuilds per frame
     * to avoid big hitches.
     */
    _processLodQueue(maxPerFrame = 2) {
        let count = 0;

        while (count < maxPerFrame && this.lodRebuildQueue.length > 0) {
            const entry = this.lodRebuildQueue.shift();
            if (!entry) {
                break;
            }

            // If targetLod was cleared or already applied, skip
            if (entry.targetLod == null || entry.targetLod === entry.lodLevel) {
                continue;
            }

            const target = entry.targetLod;
            this._rebuildChunk(entry, target);

            entry.lodLevel = target;
            entry.targetLod = null;
            count++;
        }
    }

    /**
     * Rebuild an existing chunk entry in-place for a new LOD.
     */
    _rebuildChunk(entry, lodLevel) {
        const pooledMesh = entry.terrain && entry.terrain.mesh
            ? entry.terrain.mesh
            : (this.meshPool.length > 0 ? this.meshPool.pop() : null);

        if (pooledMesh) {
            pooledMesh.setEnabled(false);
            this.meshPool.push(pooledMesh);
        }

        const reuseMesh = this.meshPool.length > 0 ? this.meshPool.pop() : null;
        const newEntry = this._createChunkEntry(entry.ix, entry.iz, lodLevel, reuseMesh);

        entry.lodLevel = lodLevel;
        entry.terrain = newEntry.terrain;
        entry.center = newEntry.center;
    }

    _rebuildChunks() {
        // Move all current meshes into the pool and clear entries
        this._disposeChunks();
        this.chunks = [];

        const params = this._computeLodParams(this.lodLevel);
        const {
            dimX,
            dimY,
            dimZ,
            cellSizeLod,
            chunkWidth,
            chunkDepth,
            chunkHeight,
            overlap
        } = params;

        // Cache world-space chunk metrics for streaming
        this.chunkWorldSizeX = chunkWidth;
        this.chunkWorldSizeZ = chunkDepth;
        this.chunkOverlap = overlap;

        for (let ix = 0; ix < this.chunkCountX; ix++) {
            for (let iz = 0; iz < this.chunkCountZ; iz++) {
                const pooledMesh =
                    this.meshPool.length > 0 ? this.meshPool.pop() : null;

                const entry = this._createChunkEntry(
                    ix,
                    iz,
                    this.globalLodLevel,
                    pooledMesh
                );

                this.chunks.push(entry);
            }
        }
    }


    _disposeChunks() {
        for (const entry of this.chunks) {
            const terrain = entry.terrain;
            if (terrain && terrain.mesh) {
                terrain.mesh.setEnabled(false);
                this.meshPool.push(terrain.mesh);
            }
        }
        // Do not clear this.material; we keep and reuse the shared material.
    }


    // Public API used by main.js ------------------------

    // UI-controlled global LOD quality bias: 0 = low, 1 = medium, 2 = high.
    setLodLevel(level) {
        const clamped = Math.max(0, Math.min(2, Math.round(level)));
        if (clamped === this.globalLodLevel) {
            return;
        }
        this.globalLodLevel = clamped;

        // If we don't have a camera yet, just remember the setting.
        if (!this._lastCameraPos) {
            return;
        }

        // Re-evaluate desired LOD per chunk using the last known camera position.
        this._updateLodForCamera(this._lastCameraPos);
    }

    /**
     * Basic camera-centered streaming + per-chunk LOD with hysteresis
     * and a limited rebuild budget per frame.
     */
    updateStreaming(cameraPosition) {
        if (!cameraPosition) {
            return;
        }

        // Effective world-space distance between neighboring chunk centers
        const baseCellsX = this.baseChunkResolution - 1;
        const baseCellsZ = baseCellsX;
        const baseChunkWidth  = baseCellsX * this.cellSize;
        const baseChunkDepth  = baseCellsZ * this.cellSize;

        const overlap = this.chunkOverlap || (1 * this.cellSize);
        const stepX = (this.chunkWorldSizeX || baseChunkWidth) - overlap;
        const stepZ = (this.chunkWorldSizeZ || baseChunkDepth) - overlap;

        if (stepX > 0 && stepZ > 0) {
            // Which "chunk index" is the camera currently over?
            const camChunkX = Math.round(cameraPosition.x / stepX);
            const camChunkZ = Math.round(cameraPosition.z / stepZ);

            // If we've crossed into a new chunk index, shift the grid + rebuild
            if (camChunkX !== this.gridOffsetX || camChunkZ !== this.gridOffsetZ) {
                this.gridOffsetX = camChunkX;
                this.gridOffsetZ = camChunkZ;

                // Rebuild the grid at a baseline LOD, then let LOD logic refine it
                this._rebuildChunks();
            }
        }

        // Update desired LOD per chunk given this camera position
        this._updateLodForCamera(cameraPosition);

        // Actually rebuild a limited number of chunks this frame
        this._processLodQueue(2);
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
        for (const entry of this.chunks) {
            entry.terrain.carveSphere(worldPos, radius);
        }
    }
}
