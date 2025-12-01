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

        // Collider LOD threshold: chunks with lodLevel >= this
        // value will be used as physics colliders for the player.
        // Farther, low-detail chunks are visual-only.
        this.colliderLodThreshold = options.colliderLodThreshold ?? 3;

        this.chunks = [];         // { terrain, gridX, gridZ, lodLevel }

        // Shared terrain material across all chunks
        this.terrainMaterial = null;

        // Queue of pending chunk rebuilds (for smooth streaming / LOD changes)
        this.buildQueue = [];

        // Keep track of how many builds are pending, for UI
        this.totalBuildJobs = 0;
        this.completedBuildJobs = 0;

        // Last focus (camera/player) position used for streaming decisions
        this.lastCameraPosition = null;

        // Stats for debugging HUD
        this.lastLodStats = {
            counts: [0, 0, 0, 0, 0, 0],
            nearLod: 0,
            nearestVisibleChunkDistance: 0,
            nearestDimX: 0,
            nearestDimZ: 0,
            maxUsedLod: 0
        };

        // Carve history so carves survive streaming / LOD rebuilds
        this.carveHistory = [];

        // Streaming / grid tracking (kept for compatibility, but we no longer move the grid)
        this.gridOffsetX = 0;
        this.gridOffsetZ = 0;

        // Whether to use the terrainFieldWorker for SDF field generation
        this.useWorker = !!options.useWorker;

        // Initialize chunk grid around origin
        this._createInitialChunks();
    }

    // -------------------------------------------------
    // Internal helpers
    // -------------------------------------------------

    // Create the initial chunk grid around (0, 0, 0)
    _createInitialChunks() {
        const baseMetrics = this._computeBaseChunkMetrics();

        // Shared material for all chunks (simple green)
        if (!this.terrainMaterial) {
            this.terrainMaterial = new BABYLON.StandardMaterial(
                "planetTerrainMat",
                this.scene
            );
            this.terrainMaterial.diffuseColor = new BABYLON.Color3(0.1, 0.6, 0.1);
            this.terrainMaterial.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
            this.terrainMaterial.backFaceCulling = false;
        }

        const halfX = Math.floor(this.chunkCountX / 2);
        const halfZ = Math.floor(this.chunkCountZ / 2);

        this.chunks.length = 0;

        for (let ix = 0; ix < this.chunkCountX; ix++) {
            for (let iz = 0; iz < this.chunkCountZ; iz++) {
                const gridX = ix - halfX;
                const gridZ = iz - halfZ;

                const origin = new BABYLON.Vector3(
                    gridX * baseMetrics.baseChunkWidth,
                    -this.radius,
                    gridZ * baseMetrics.baseChunkDepth
                );

                // LOD 0 by default (will be updated by streaming)
                const lodForChunk = 0;
                const lodDims = this._computeLodDimensions(lodForChunk);

                const terrain = new MarchingCubesTerrain(this.scene, {
                    dimX: lodDims.dimX,
                    dimY: lodDims.dimY,
                    dimZ: lodDims.dimZ,
                    cellSize: lodDims.cellSize,
                    isoLevel: this.isoLevel,
                    radius: this.radius,
                    origin,
                    material: this.terrainMaterial,
                    deferBuild: true,
                    useWorker: this.useWorker
                });

                this.chunks.push({
                    terrain,
                    gridX,
                    gridZ,
                    lodLevel: lodForChunk,
                    visible: true
                });

                // Schedule initial build for this chunk
                this.buildQueue.push({
                    type: "lod",
                    chunk: terrain,
                    origin,
                    lodLevel: lodForChunk
                });
            }
        }

        // Capture the total number of jobs ONCE for the initial build
        this.totalBuildJobs = this.buildQueue.length;
        this.completedBuildJobs = 0;
    }

    /**
     * Compute the base world-space size of a chunk and base grid dimensions,
     * from the planet radius and the requested resolution.
     */
    _computeBaseChunkMetrics() {
        const baseDimX = this.baseChunkResolution;
        const baseDimZ = this.baseChunkResolution;
        const verticalSpan = this.baseDimY * this.cellSize;

        // Use a portion of the planet surface for chunks – essentially tiling the sphere
        const circumference = 2 * Math.PI * this.radius;
        const tileFraction = 1 / this.chunkCountX;
        const tileWidth = circumference * tileFraction;

        const baseChunkWidth = tileWidth;
        const baseChunkDepth = tileWidth;
        const baseChunkHeight = verticalSpan;

        return {
            baseDimX,
            baseDimZ,
            baseChunkWidth,
            baseChunkDepth,
            baseChunkHeight
        };
    }

    /**
     * Compute resolution and cell size for a given LOD level.
     * Higher LOD = finer resolution (smaller cell size).
     */
    _computeLodDimensions(lodLevel) {
        const clamped = Math.max(0, Math.min(5, Math.round(lodLevel)));

        const factor = 1 << (5 - clamped);
        const dimX = Math.floor(this.baseChunkResolution / factor);
        const dimZ = Math.floor(this.baseChunkResolution / factor);
        const dimY = this.baseDimY;

        const cellSize = this.cellSize * factor;

        return { dimX, dimY, dimZ, cellSize };
    }

    /**
     * Given a world-space distance from the planet center, choose a LOD level.
     * High near the player (5), low far away (0).
     */
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
     * Called from main.js every frame with player/camera position.
     * Decides which chunks are visible and at which LOD.
     */
    updateStreaming(focusPosition) {
        if (!this.chunks || this.chunks.length === 0) return;
        if (!focusPosition) {
            return;
        }

        this.lastCameraPosition = focusPosition.clone();

        // Update LOD and visibility for each chunk
        this._updateChunksForFocus();

        // Rebuild up to N chunks per frame to avoid hitches
        this._processBuildQueue(1);
    }

    /**
     * Update each chunk's LOD and visibility based on the current focus position.
     */
    _updateChunksForFocus() {
        if (!this.lastCameraPosition) return;

        const focus = this.lastCameraPosition;
        const baseMetrics = this._computeBaseChunkMetrics();

        const stats = {
            counts: [0, 0, 0, 0, 0, 0],
            nearLod: 0,
            nearestVisibleChunkDistance: Infinity,
            nearestDimX: 0,
            nearestDimZ: 0,
            maxUsedLod: 0
        };

        for (const c of this.chunks) {
            const origin = c.terrain.origin;

            const chunkCenter = new BABYLON.Vector3(
                origin.x + baseMetrics.baseChunkWidth * 0.5,
                0,
                origin.z + baseMetrics.baseChunkDepth * 0.5
            );

            const dist = BABYLON.Vector3.Distance(
                new BABYLON.Vector3(focus.x, 0, focus.z),
                chunkCenter
            );

            const worldCenter = new BABYLON.Vector3(
                origin.x + baseMetrics.baseChunkWidth * 0.5,
                0,
                origin.z + baseMetrics.baseChunkDepth * 0.5
            );

            const rFocus = focus.length();
            const rChunk = worldCenter.length();
            const hemisphereVisible = BABYLON.Vector3.Dot(
                focus.normalize(),
                worldCenter.normalize()
            ) > 0;

            const withinView = this._isWithinViewDistance(dist);

            const visible = hemisphereVisible && withinView;
            c.visible = visible;

            if (c.terrain.mesh) {
                c.terrain.mesh.setEnabled(visible);
            }

            if (!visible) {
                continue;
            }

            const chunkDist = BABYLON.Vector3.Distance(focus, worldCenter);

            const desiredLod = this._lodForDistance(chunkDist);
            stats.counts[desiredLod]++;
            stats.maxUsedLod = Math.max(stats.maxUsedLod, desiredLod);

            if (chunkDist < stats.nearestVisibleChunkDistance) {
                stats.nearestVisibleChunkDistance = chunkDist;
                stats.nearLod = desiredLod;

                const lodDims = this._computeLodDimensions(desiredLod);
                stats.nearestDimX = lodDims.dimX;
                stats.nearestDimZ = lodDims.dimZ;
            }

            if (desiredLod === c.lodLevel) {
                continue;
            }

            c.lodLevel = desiredLod;

            // Schedule a rebuild of just this chunk at its current origin
            this.buildQueue.push({
                type: "lod",
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

            // Default to LOD job if type is missing (backward compatible)
            const jobType = job.type || "lod";
            const lodLevel =
                typeof job.lodLevel === "number" ? job.lodLevel : 0;

            // --------- Mesh-only jobs from carving ----------
            if (jobType === "carveMesh") {
                // Field has already been modified via carveSphere with
                // deferRebuild:true – we only need to rebuild the mesh.
                job.chunk.rebuildMeshOnly();
                this._tagChunkCollider(job.chunk, lodLevel);
                this._onChunkBuilt();
                count++;
                continue;
            }

            // --------- Full LOD rebuild jobs ----------
            const lodDims = this._computeLodDimensions(lodLevel);

            const maybePromise = job.chunk.rebuildWithSettings({
                origin: job.origin,
                dimX: lodDims.dimX,
                dimY: lodDims.dimY,
                dimZ: lodDims.dimZ,
                cellSize: lodDims.cellSize
            });

            // If worker is used, rebuildWithSettings returns a Promise.
            // We reapply carves only after the new field/mesh is ready.
            if (maybePromise && typeof maybePromise.then === "function") {
                maybePromise
                    .then(() => {
                        this._applyRelevantCarvesToChunk(job.chunk);
                        this._tagChunkCollider(job.chunk, lodLevel);
                        this._onChunkBuilt();
                    })
                    .catch((err) => {
                        console.error("Chunk rebuild failed:", err);
                    });
            } else {
                // Synchronous path
                this._applyRelevantCarvesToChunk(job.chunk);
                this._tagChunkCollider(job.chunk, lodLevel);
                this._onChunkBuilt();
            }

            count++;
        }
    }

    /**
     * Tag a chunk's mesh as a terrain collider or visual-only based on LOD.
     * We keep physics only on chunks with lodLevel >= colliderLodThreshold
     * (high-detail, near the player) to match the GDVoxelTerrain pattern.
     */
    _tagChunkCollider(terrain, lodLevel) {
        if (!terrain || !terrain.mesh) return;

        const mesh = terrain.mesh;
        mesh.metadata = mesh.metadata || {};
        mesh.metadata.isTerrain = true;

        const isCollider = lodLevel >= this.colliderLodThreshold;
        mesh.metadata.isTerrainCollider = isCollider;

        // We always allow picking, but only collider chunks participate
        // in collision checks / player ground rays.
        mesh.isPickable = true;
        mesh.checkCollisions = isCollider;
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

        return dx * dx + dy * dy + dz * dz <= radius * radius;
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

    _onChunkBuilt() {
        // Called whenever a chunk's mesh has finished rebuilding.
        // You can hook debug counters / UI here later if you want.
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
     * (player or camera).
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
            baseDimY: this.baseDimY,
            lodCap: this.lodLevel,
            lodStats: this.lastLodStats,
            nearestChunk: null
        };

        if (!focusPosition) {
            return info;
        }

        const focus = focusPosition;
        const baseMetrics = this._computeBaseChunkMetrics();

        let bestDist = Infinity;

        for (const c of this.chunks) {
            if (!c.visible || !c.terrain || !c.terrain.origin) continue;

            const origin = c.terrain.origin;

            const chunkCenter = new BABYLON.Vector3(
                origin.x + baseMetrics.baseChunkWidth * 0.5,
                0,
                origin.z + baseMetrics.baseChunkDepth * 0.5
            );

            const dist = BABYLON.Vector3.Distance(
                new BABYLON.Vector3(focus.x, 0, focus.z),
                chunkCenter
            );

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
