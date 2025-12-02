import { MarchingCubesTerrain } from "./MarchingCubesTerrain.js";

export class ChunkedPlanetTerrain {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.maxBuildDistance = 40000;

        // How many chunks along X and Z (odd number recommended)
        this.chunkCountX = options.chunkCountX ?? 3;
        this.chunkCountZ = options.chunkCountZ ?? 3;

        // Base resolution of a chunk in cells (will be divided by LOD factor)
        // This is the HIGHEST detail (e.g. 128) – lower LODs derive from this.
        this.baseChunkResolution = options.baseChunkResolution ?? 128;

        // Vertical resolution parameters
        this.cellSize = options.cellSize ?? 1.0;
        this.isoLevel = options.isoLevel ?? 0.0;
        this.radius = options.radius ?? 18.0;

        const neededY = Math.ceil((this.radius * 2) / this.cellSize) + 4;
        this.baseDimY = options.dimY ?? neededY;

        // Global LOD limit controlled by UI slider:
        // 0 = only coarse, 5 = allow ultra-high near camera
        this.lodLevel = options.lodLevel ?? 5;

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
        this.chunkWorldSizeY = 0;
        this.chunkOverlap = 0;

        // --- Initial build tracking ---
        this.initialBuildTotal = 0;        // how many jobs in the first pass
        this.initialBuildCompleted = 0;    // how many finished
        this.initialBuildDone = false;     // set true once, when first pass ends
        this.onInitialBuildDone = null;    // callback, set from main.js (optional)

        // Last focus position used for LOD ring calculation
        this.lastCameraPosition = null;

        // Cached LOD stats for HUD
        this.lastLodStats = {
            totalVisible: 0,
            perLod: [0, 0, 0, 0, 0, 0],
            maxLodInUse: 0
        };

        this._rebuildChunks();
    }

    // Map LOD level -> resolution divisor (higher level = more detail)
    // For baseChunkResolution = 128:
    //   level 5 -> 128, 4 -> 64, 3 -> 32, 2 -> 16, 1 -> 8, 0 -> 4
    _lodFactorFor(level) {
        switch (level) {
            case 5: return 1;   // 128
            case 4: return 2;   // 64
            case 3: return 4;   // 32
            case 2: return 8;   // 16
            case 1: return 16;  // 8
            case 0: return 32;  // 4
            default: return 32;
        }
    }

    // Dist (from focus to chunk center) -> desired LOD level,
    // clamped by global limit, according to your %-of-radius spec.
    //
    // R = this.radius
    // 0 – 0.25% R     => LOD 5 (dim ~128)
    // 0.25 – 1% R     => LOD 4 (dim ~64)
    // 1 – 2% R        => LOD 3 (dim ~32)
    // 2 – 4% R        => LOD 2 (dim ~16)
    // 4 – 6% R        => LOD 1 (dim ~8)
    // 6 – 10% R       => LOD 0 (dim ~4)
    // > 10% R         => culled separately by distance
    _lodForDistance(dist) {
        const R = this.radius || 1.0;
        const dNorm = dist / R;

        let desiredLevel;
        if (dNorm < 0.06) {         // 6% (~2000m)
            desiredLevel = 5;
        } else if (dNorm < 0.08) {  // 8%
            desiredLevel = 4;
        } else if (dNorm < 0.10) {  // 10%
            desiredLevel = 3;
        } else if (dNorm < 0.12) {  // 12%
            desiredLevel = 2;
        } else if (dNorm < 0.14) {
            desiredLevel = 1;
        } else {
            desiredLevel = 0;
        }


        // Respect global LOD cap from the slider
        return Math.min(desiredLevel, this.lodLevel);
    }

    // View-distance check: only 10% of radius around the player should be visible
    _isWithinViewDistance(dist) {
        const R = this.radius || 1.0;
        return dist <= R * 0.10; // 10% of planet radius
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
        this.chunkWorldSizeY = baseMetrics.baseChunkHeight;

        // Overlap so edges match between neighboring chunks
        const overlap = this.cellSize; // one voxel layer at base scale
        this.chunkOverlap = overlap;

        const halfCountX = this.chunkCountX / 2.0;
        const halfCountZ = this.chunkCountZ / 2.0;

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

                // Initial planet build: whole grid at lowest LOD (4 cells),
                // as per your requirement that the full planet loads at LOD 4.
                const lodForChunk = 0;
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
                    deferBuild: true,
                    useWorker: true     // let worker build the SDF field
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

        // Capture the total number of jobs ONCE for the initial loading screen
        if (!this.initialBuildDone && this.initialBuildTotal === 0) {
            this.initialBuildTotal = this.buildQueue.length;
            this.initialBuildCompleted = 0;
            console.log("[ChunkedPlanetTerrain] Initial jobs:", this.initialBuildTotal);
        }
    }

    _onChunkBuilt() {
        if (this.initialBuildDone || this.initialBuildTotal === 0) {
            return;
        }

        this.initialBuildCompleted++;

        if (this.initialBuildCompleted >= this.initialBuildTotal) {
            this.initialBuildDone = true;
            console.log("[ChunkedPlanetTerrain] Initial build complete");

            if (typeof this.onInitialBuildDone === "function") {
                this.onInitialBuildDone();
            }
        }
    }

    // Optional: convenience getter for UI
    getInitialBuildProgress() {
        if (this.initialBuildTotal === 0) return 0;
        return this.initialBuildCompleted / this.initialBuildTotal;
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
     *
     * - Chunks on the far hemisphere are hidden.
     * - Chunks farther than 10% of the radius are hidden.
     * - Within 10% of radius, we apply your LOD rings.
     */
    _updateChunksForFocus() {
        if (!this.lastCameraPosition) return;

        const camPos = this.lastCameraPosition;
        const baseMetrics = this._computeBaseChunkMetrics();
        const chunkWidth  = baseMetrics.baseChunkWidth;
        const chunkDepth  = baseMetrics.baseChunkDepth;

        // Reset stats
        const stats = {
            totalVisible: 0,
            perLod: [0, 0, 0, 0, 0, 0],
            maxLodInUse: 0
        };

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
                if (c.terrain.mesh) {
                    c.terrain.mesh.setEnabled(false);
                }
                continue;
            }

            const dist = BABYLON.Vector3.Distance(camPos, chunkCenter);

            // View-distance culling: only 10% of the radius around the player
            if (!this._isWithinViewDistance(dist)) {
                if (c.terrain.mesh) {
                    c.terrain.mesh.setEnabled(false);
                }
                continue;
            }

            // Ensure it's visible; from here on, LOD rings apply
            if (c.terrain.mesh) {
                c.terrain.mesh.setEnabled(true);
            }

            const desiredLod = this._lodForDistance(dist);

            // Stats
            stats.totalVisible++;
            if (desiredLod >= 0 && desiredLod < stats.perLod.length) {
                stats.perLod[desiredLod]++;
                if (desiredLod > stats.maxLodInUse) {
                    stats.maxLodInUse = desiredLod;
                }
            }

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

        this.lastLodStats = stats;
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

            // Mesh-only jobs are used for carving: the scalar field has
            // already been updated, we just need to rebuild the mesh.
            if (job.meshOnly) {
                job.chunk.rebuildMeshOnly();
                this._onChunkBuilt();
                count++;
                continue;
            }

            const lodDims = this._computeLodDimensions(job.lodLevel);

            const maybePromise = job.chunk.rebuildWithSettings({
                origin: job.origin,
                dimX: lodDims.dimX,
                dimY: lodDims.dimY,
                dimZ: lodDims.dimZ,
                cellSize: lodDims.cellSize
            });

            // If worker is used, rebuildWithSettings returns a Promise.
            // We reapply carves only after the new mesh is ready.
            if (maybePromise && typeof maybePromise.then === "function") {
                maybePromise
                    .then(() => {
                        this._applyRelevantCarvesToChunk(job.chunk);
                        this._onChunkBuilt();
                    })
                    .catch((err) => {
                        console.error("Chunk rebuild failed:", err);
                    });
            } else {
                // Synchronous path
                this._applyRelevantCarvesToChunk(job.chunk);
                this._onChunkBuilt();
            }

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

    // LOD slider: sets the *maximum* allowed LOD (0..5) and rebuilds the grid
    setLodLevel(level) {
        const clamped = Math.max(0, Math.min(5, Math.round(level)));
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

        // Update per-chunk LOD, hemisphere visibility and distance culling
        if (this.lastCameraPosition) {
            this._updateChunksForFocus();
        }

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

        // Apply immediately only to chunks whose AABB intersects the carve.
        // We only update the scalar field here, and queue a mesh rebuild so
        // it can be processed gradually via the existing buildQueue.
        for (const c of this.chunks) {
            if (!c.terrain || !c.terrain.origin) continue;

            const origin = c.terrain.origin;
            if (!this._sphereIntersectsChunkAabb(worldPos, radius, origin, baseMetrics)) {
                continue;
            }

            // Mark voxels only; do NOT rebuild the mesh immediately.
            c.terrain.carveSphere(worldPos, radius, { deferRebuild: true });

            // Queue a mesh-only rebuild job for this chunk so the mesh is
            // updated later without blocking the pointer event.
            this.buildQueue.push({
                chunk: c.terrain,
                origin: origin.clone ? origin.clone() : origin,
                lodLevel: c.lodLevel,
                meshOnly: true
            });
        }
    }


    /**
     * Return the most recently computed LOD stats for HUD display.
     * If updateStreaming has not yet run with a valid focus position,
     * this will just return zeros.
     */
    getLodStats() {
        return this.lastLodStats;
    }

    /**
     * Rich debug info for UI:
     *  - chunk counts
     *  - base resolution
     *  - LOD cap
     *  - LOD stats
     *  - nearest visible chunk LOD + resolution around a focus position
     */
    getDebugInfo(focusPosition) {
        const info = {
            chunkCountX: this.chunkCountX,
            chunkCountZ: this.chunkCountZ,
            baseChunkResolution: this.baseChunkResolution,
            lodCap: this.lodLevel,
            lodStats: this.lastLodStats,
            nearestChunk: null
        };

        if (!focusPosition) {
            return info;
        }

        const baseMetrics = this._computeBaseChunkMetrics();
        const chunkWidth  = baseMetrics.baseChunkWidth;
        const chunkDepth  = baseMetrics.baseChunkDepth;

        let bestDist = Infinity;
        for (const c of this.chunks) {
            if (!c || !c.terrain || !c.terrain.origin) continue;
            if (!c.terrain.mesh || !c.terrain.mesh.isEnabled()) continue;

            const origin = c.terrain.origin;
            const center = new BABYLON.Vector3(
                origin.x + chunkWidth * 0.5,
                0,
                origin.z + chunkDepth * 0.5
            );

            const dist = BABYLON.Vector3.Distance(focusPosition, center);
            if (dist < bestDist) {
                bestDist = dist;
                const lodDims = this._computeLodDimensions(c.lodLevel);
                info.nearestChunk = {
                    lodLevel: c.lodLevel,
                    dimX: lodDims.dimX,
                    dimZ: lodDims.dimZ,
                    distance: dist
                };
            }
        }

        return info;
    }
}
