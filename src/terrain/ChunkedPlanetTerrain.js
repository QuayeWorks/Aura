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
        // dist < lodNear  -> high (2)
        // < lodMid        -> medium (1)
        // else            -> low (0)
        // We now use fixed meters by default: 15m and 30m
        this.lodNear = options.lodNear ?? 15.0;
        this.lodMid  = options.lodMid  ?? 30.0;

        this.chunks = [];         // { terrain, gridX, gridZ, lodLevel }
        
        // Shared terrain material across all chunks
        this.material = new BABYLON.StandardMaterial("terrainSharedMat", this.scene);
        this.material.diffuseColor = new BABYLON.Color3(0.2, 0.9, 0.35);
        this.material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        this.material.backFaceCulling = false;
        
        this.meshPool = [];       // pool of reusable Babylon meshes

        // Queue of pending chunk rebuilds (for smooth streaming / LOD changes)
        this.buildQueue = [];

        // Persistent edit history so carves survive streaming / LOD rebuilds
        this.carveHistory = [];

        // Streaming / grid tracking (kept for compatibility, but we no longer move the grid)
        this.gridOffsetX = 0;
        this.gridOffsetZ = 0;

        // Cached world-space chunk metrics (set via _computeBaseChunkMetrics)
        this.chunkWorldSizeX = 0;
        this.chunkWorldSizeZ = 0;
        this.chunkOverlap = 0;

        // Position used for LOD ring & hemisphere decisions (player or camera)
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

    // Dist (from focus to chunk center) -> desired LOD level, clamped by global limit
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

    /**
     * Compute the base world-space size of a chunk and base grid dimensions,
     * from the planet radius and the requested chunkCount / baseChunkResolution.
     *
     * We ensure that the total voxel volume fully encloses the sphere:
     *   worldSpan ≈ 2 * radius * marginFactor   (margin ≈ 10%)
     * and that the same cellSize is used in X/Y/Z so the SDF is sampled isotropically.
     */
    _computeBaseChunkMetrics() {
        // Full diameter of the planet in world units
        const diameter = this.radius * 2.0;

        // Slightly larger cube so we don't accidentally clip the sphere at the edges
        const marginFactor = 1.1;
        const worldSpan = diameter * marginFactor;     // size of the cube edge

        // Split that span into chunkCountX/Z tiles
        const chunkWorldSizeX = worldSpan / this.chunkCountX;
        const chunkWorldSizeZ = worldSpan / this.chunkCountZ;

        // How many samples (cells+1) per chunk in X/Z at base LOD
        const baseDimX = this.baseChunkResolution;
        const baseDimZ = this.baseChunkResolution;

        // Choose a cellSize that exactly makes baseDimX samples fit chunkWorldSizeX
        // (minus 1 because cells = samples-1)
        const cellSize = chunkWorldSizeX / (baseDimX - 1);

        // Compute vertical dimension so Y also spans the same worldSpan
        const baseDimY = Math.round(worldSpan / cellSize) + 1;
        const chunkWorldSizeY = (baseDimY - 1) * cellSize;

        // Save for other code that relies on these
        this.cellSize = cellSize;
        this.baseDimY = baseDimY;
        this.chunkWorldSizeX = chunkWorldSizeX;
        this.chunkWorldSizeZ = chunkWorldSizeZ;
        this.chunkWorldSizeY = chunkWorldSizeY;

        return {
            baseChunkWidth:  chunkWorldSizeX,
            baseChunkDepth:  chunkWorldSizeZ,
            baseChunkHeight: chunkWorldSizeY,
            baseDimX,
            baseDimY,
            baseDimZ,
            cellSize
        };
    }

    // Given an LOD level, compute grid resolution + cellSize that keep world size fixed
    _computeLodDimensions(lodLevel) {
        const {
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

        const chunkWidth  = baseMetrics.baseChunkWidth;
        const chunkDepth  = baseMetrics.baseChunkDepth;
        const chunkHeight = baseMetrics.baseChunkHeight;

        const worldSpan = this.radius * 2.0 * 1.1; // must match marginFactor in _computeBaseChunkMetrics()
		
        this.chunkWorldSizeX = baseMetrics.baseChunkWidth;
        this.chunkWorldSizeZ = baseMetrics.baseChunkDepth;

        // Overlap so edges match between neighboring chunks
        const overlap = this.cellSize; // one voxel layer at base scale
        this.chunkOverlap = overlap;

        const halfCountX = this.chunkCountX / 2.0;
        const halfCountZ = this.chunkCountZ / 2.0;

        const camPos =
            this.lastCameraPosition ||
            new BABYLON.Vector3(0, 0, this.radius * 2);

        // We’ll build everything lazily via the build queue
        this.buildQueue = [];

        for (let ix = 0; ix < this.chunkCountX; ix++) {
            for (let iz = 0; iz < this.chunkCountZ; iz++) {
                // Grid index centered around origin
                const gx = (ix - halfCountX + 0.5) + this.gridOffsetX;
                const gz = (iz - halfCountZ + 0.5) + this.gridOffsetZ;

                // Center the whole chunk grid around world origin so the planet
                // (also centered at origin) is fully enclosed.
                const halfSpan = worldSpan * 0.5;  // same worldSpan as in _computeBaseChunkMetrics

                const origin = new BABYLON.Vector3(
                    -halfSpan + ix * chunkWidth,
                    -halfSpan,
                    -halfSpan + iz * chunkDepth
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

                // IMPORTANT: deferBuild = true so no heavy work in constructor
                const terrain = new MarchingCubesTerrain(this.scene, {
                    dimX: lodDims.dimX,
                    dimY: lodDims.dimY,
                    dimZ: lodDims.dimZ,
                    cellSize: lodDims.cellSize,
                    isoLevel: this.isoLevel,
                    radius: this.radius,
                    origin,
                    mesh: pooledMesh,
                    material: this.material,
                    deferBuild: true
                });

                this.chunks.push({
                    terrain,
                    gridX: gx,
                    gridZ: gz,
                    lodLevel: lodForChunk
                });

                // Schedule initial build for this chunk
                this.buildQueue.push({
                    chunk: terrain,
                    origin,
                    lodLevel: lodForChunk
                });
            }
        }
    }

    /**
     * After gridOffsetX/Z change, schedule all chunks to be rebuilt
     * at their new world-space origins (and appropriate LOD).
     * Kept for compatibility, but no longer used now that we don't shift the grid.
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
     * Is this chunk on the same hemisphere as the focus position (player)?
     * We treat the planet center as (0,0,0) and compare normalized directions.
     */
    _isChunkOnNearHemisphere(chunkCenter, focusPos) {
        if (!focusPos) return true;

        const planetCenter = BABYLON.Vector3.Zero();
        const toChunk = chunkCenter.subtract(planetCenter);
        const toFocus = focusPos.subtract(planetCenter);

        const lenSqChunk = toChunk.lengthSquared();
        const lenSqFocus = toFocus.lengthSquared();
        if (lenSqChunk < 1e-6 || lenSqFocus < 1e-6) {
            return true;
        }

        const invLenChunk = 1 / Math.sqrt(lenSqChunk);
        const invLenFocus = 1 / Math.sqrt(lenSqFocus);

        const nChunk = toChunk.scale(invLenChunk);
        const nFocus = toFocus.scale(invLenFocus);

        const dot = BABYLON.Vector3.Dot(nChunk, nFocus);

        // dot >= 0 means same hemisphere or exactly on the great circle boundary
        return dot >= 0;
    }

    /**
     * Check all chunks against current focus distance and hemisphere, and, if their
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

            // Hemisphere culling: only keep the half-planet facing the player
            const onNearSide = this._isChunkOnNearHemisphere(chunkCenter, camPos);

            if (!onNearSide) {
                if (c.terrain && c.terrain.mesh) {
                    c.terrain.mesh.setEnabled(false);
                }
                continue;
            } else if (c.terrain && c.terrain.mesh) {
                // Re-enable if it was previously culled
                c.terrain.mesh.setEnabled(true);
            }

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
     * to avoid big hitches when LOD changes.
     */
    _processBuildQueue(maxPerFrame = 1) {
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

            // Reapply only the carve edits that actually touch this chunk
            this._applyRelevantCarvesToChunk(job.chunk);

            count++;
        }
    }

    /**
     * Test if a sphere (center, radius) intersects a chunk's AABB.
     * origin = chunk's origin (min corner), sizes from base metrics.
     */
    _sphereIntersectsChunkAabb(center, radius, origin, baseMetrics) {
        const chunkWidth  = baseMetrics.baseChunkWidth;
        const chunkDepth  = baseMetrics.baseChunkDepth;
        const chunkHeight = baseMetrics.baseChunkHeight;

        const minX = origin.x;
        const maxX = origin.x + chunkWidth;
        const minY = origin.y;
        const maxY = origin.y + chunkHeight;
        const minZ = origin.z;
        const maxZ = origin.z + chunkDepth;

        const cx = center.x;
        const cy = center.y;
        const cz = center.z;

        const closestX = Math.max(minX, Math.min(cx, maxX));
        const closestY = Math.max(minY, Math.min(cy, maxY));
        const closestZ = Math.max(minZ, Math.min(cz, maxZ));

        const dx = cx - closestX;
        const dy = cy - closestY;
        const dz = cz - closestZ;

        return (dx * dx + dy * dy + dz * dz) <= radius * radius;
    }

    /**
     * Reapply only the carve operations that actually intersect
     * the given chunk's world-space AABB.
     */
    _applyRelevantCarvesToChunk(terrain) {
        if (!this.carveHistory.length || !terrain || !terrain.origin) return;

        const baseMetrics = this._computeBaseChunkMetrics();
        const origin = terrain.origin;

        let touched = false;

        for (const op of this.carveHistory) {
            if (!this._sphereIntersectsChunkAabb(op.position, op.radius, origin, baseMetrics)) {
                continue;
            }
            // Update field only; defer mesh rebuild
            terrain.carveSphere(op.position, op.radius, { deferRebuild: true });
            touched = true;
        }

        if (touched) {
            terrain.rebuildMeshOnly();
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
     * LOD rings + hemisphere culling around the "focus" position
     * (player capsule, ideally). We keep the chunk grid fixed and
     * only adjust LOD + visibility; no more chunk streaming.
     */
    updateStreaming(focusPosition) {
        if (focusPosition) {
            this.lastCameraPosition = focusPosition.clone
                ? focusPosition.clone()
                : new BABYLON.Vector3(
                      focusPosition.x,
                      focusPosition.y,
                      focusPosition.z
                  );
        }

        if (!this.lastCameraPosition) {
            // Still process any pending chunk rebuilds (initial planet build)
            this._processBuildQueue();
            return;
        }

        // Update per-chunk LOD and hemisphere visibility
        this._scheduleLodAdjustments();

        // Rebuild at most one chunk per frame to avoid hitches
        this._processBuildQueue();
    }

    // Carve a sphere out of all chunks
    carveSphere(worldPos, radius) {
        // Store this carve so it can be replayed after streaming/LOD rebuilds
        this.carveHistory.push({
            position: worldPos.clone ? worldPos.clone() : worldPos,
            radius
        });

        const baseMetrics = this._computeBaseChunkMetrics();

        // Apply immediately only to chunks whose AABB intersects the carve
        for (const c of this.chunks) {
            if (!c.terrain || !c.terrain.origin) continue;

            const origin = c.terrain.origin;
            if (!this._sphereIntersectsChunkAabb(worldPos, radius, origin, baseMetrics)) {
                continue;
            }

            c.terrain.carveSphere(worldPos, radius);
        }
    }
}
