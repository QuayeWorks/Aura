/* global BABYLON */
import { MarchingCubesTerrain } from "./MarchingCubesTerrain.js";
import { PlanetQuadtreeNode } from "./PlanetQuadtreeNode.js";
import { resolveBiomeSettings, DEFAULT_BIOME_SETTINGS } from "./biomeSettings.js";
import { TerrainScheduler } from "./TerrainScheduler.js";
import { ColliderQueue } from "./ColliderQueue.js";

export class ChunkedPlanetTerrain {
    constructor(scene, options = {}) {
        const nextDebugId = (ChunkedPlanetTerrain._nextDebugId ?? 1);
        this._debugId = (typeof crypto !== "undefined" && crypto.randomUUID)
            ? crypto.randomUUID()
            : nextDebugId;
        if (!crypto?.randomUUID) {
            ChunkedPlanetTerrain._nextDebugId = nextDebugId + 1;
        }

        this.scene = scene;
        this.maxBuildDistance = options.maxBuildDistance ?? 33400;
        this.seed = options.seed ?? 1337;

        // Legacy grid options kept for compatibility with callers / HUD
        this.chunkCountX = options.chunkCountX ?? 3;
        this.chunkCountZ = options.chunkCountZ ?? 3;

        this.baseChunkResolution = options.baseChunkResolution ?? 128;

        // Vertical resolution parameters
        this.cellSize = options.cellSize ?? 1.0;
        this.isoLevel = options.isoLevel ?? 0.0;
        this.radius = options.radius ?? 18.0;
        this.biomeSettings = resolveBiomeSettings(options.biomeSettings || DEFAULT_BIOME_SETTINGS);
        this.biomeRevision = 0;

        const neededY = Math.ceil((this.radius * 2) / this.cellSize) + 4;
        this.baseDimY = options.dimY ?? neededY;

        this.lodLevel = options.lodLevel ?? 5;

        this.colliderLodThreshold = options.colliderLodThreshold ?? 4;
        this.colliderEnableDistance =
            options.colliderEnableDistance ?? this.radius * 0.12;

        // Shared terrain material across all leaves
        this.material = new BABYLON.StandardMaterial("terrainSharedMat", this.scene);
        this.material.diffuseColor = new BABYLON.Color3(0.2, 0.9, 0.35);
        this.material.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
        this.material.backFaceCulling = false;
        this.material.twoSidedLighting = true;

        this.meshPool = [];
        this.terrainPool = [];
        this.carveHistory = [];
        this.carveRevision = 0; // increments when carve history changes

        this.buildBudgetMs = options.buildBudgetMs ?? 6; // ms budget per frame
        this.maxConcurrentBuilds = options.maxConcurrentBuilds ?? 2;
        this.buildStabilityFrames = options.buildStabilityFrames ?? 8;
        this.updatedCollidersPerSecond = options.updatedCollidersPerSecond ?? 30;

        this.scheduler = new TerrainScheduler({
            maxConcurrentBuilds: this.maxConcurrentBuilds,
            buildBudgetMs: this.buildBudgetMs,
            getPriority: (job) => {
                const lodWeight = job.lodLevel ?? 0;
                const dist = Number.isFinite(job.surfaceDist) ? job.surfaceDist : 0;
                const surfaceDistanceWeight = Math.max(0, 100000 - dist);
                const visibleBonus = job.wasVisibleLastFrame ? 5000 : 0;
                return (lodWeight * 100000) + surfaceDistanceWeight + visibleBonus;
            }
        });

        this.colliderQueue = new ColliderQueue({
            updatedCollidersPerSecond: this.updatedCollidersPerSecond
        });


        // Cached world-space chunk metrics
        this.chunkWorldSizeX = 0;
        this.chunkWorldSizeZ = 0;
        this.chunkWorldSizeY = 0;
        this.chunkOverlap = 0;
        this.worldSpan = 0;

        // Initial build tracking
        this.initialBuildTotal = 0;
        this.initialBuildCompleted = 0;
        this.initialBuildDone = false;
        this.onInitialBuildDone = null;

        this.lastCameraPosition = null;
        this._lastFocusData = null;
        this._streamRevision = 0;
        
        this.initialCoarseLod = 1; // Progressive LOD: always show LOD 1 first

        const baseStreamingDistance =
            options.streamingBaseDistance ??
            this.maxBuildDistance ??
            (this.radius ? this.radius * 1.0 : 10000);

        this.lodRingRadii = {
            r0: options.lodRingRadii?.r0 ?? baseStreamingDistance * 0.05,
            r1: options.lodRingRadii?.r1 ?? baseStreamingDistance * 0.15,
            r2: options.lodRingRadii?.r2 ?? baseStreamingDistance * 0.45,
            r3: options.lodRingRadii?.r3 ?? baseStreamingDistance * 0.9,
            rcull: options.lodRingRadii?.rcull ?? baseStreamingDistance * 1.0
        };

        this.lodRingHysteresis =
            options.lodRingHysteresis ?? baseStreamingDistance * 0.01;
        this.cullHysteresis =
            options.cullHysteresis ?? baseStreamingDistance * 0.02;
        this.depthCullHysteresis =
            options.depthCullHysteresis ?? baseStreamingDistance * 0.01;
        this.skirtDepthScale = options.skirtDepthScale ?? 0.4;

        this.lastLodStats = {
            totalVisible: 0,
            culledByDistance: 0,
            culledByDepth: 0,
            culledByHorizon: 0,
            perLod: [0, 0, 0, 0, 0, 0],
            maxLodInUse: 0
        };

        this.lastBuildStats = {
            avgBuildMs: 0,
            samples: 0
        };
        this._buildDurationSamples = [];
        this._buildDropSamples = [];

        this.lodUpdateCounter = 0;
        this.lodChangeCooldownFrames =
            options.lodChangeCooldownFrames ?? 30;
        this.horizonCullMargin = options.horizonCullMargin ?? 0.02;

        // Quadtree state
        this.rootNode = null;
        this.activeLeaves = [];
        this.activeTerrainMeshes = new Set();
        this._collisionMeshes = new Set();
        this._activeCollisionMeshes = new Set();
        this._loggedTerrainMeshes = new WeakSet();
        this._activeLeafSet = new Set();
        this._collisionWarmup = {
            enabled: false,
            forcedCount: 0,
            timeSincePlayStartMs: null
        };

        // Build the initial quadtree (replaces the old fixed grid)
        this._initializeQuadtree();
    }

    _lodFactorFor(level) {
        switch (level) {
            case 5: return 1;
            case 4: return 2;
            case 3: return 4;
            case 2: return 8;
            case 1: return 16;
            case 0: return 32;
            default: return 32;
        }
    }
    _lodForDistance(dist) {
        const { r0, r1, r2, r3 } = this.lodRingRadii;

        let desiredLevel;
        if (dist < r0) {
            desiredLevel = 5;
        } else if (dist < r1) {
            desiredLevel = 4;
        } else if (dist < r2) {
            desiredLevel = 3;
        } else if (dist < r3) {
            desiredLevel = 2;
        } else {
            desiredLevel = 1;
        }

        return Math.min(desiredLevel, this.lodLevel);
    }


    _isWithinViewDistance(dist) {
        const maxDist = this.maxBuildDistance || (this.radius ? this.radius * 2.0 : 1000);
        return dist <= maxDist;
    }


    _computeBaseChunkMetrics() {
        const diameter = this.radius * 2.0;
        const marginFactor = 1.1;
        const worldSpan = diameter * marginFactor;

        // Maintain previous cell sizing logic so voxel density matches
        const chunkWorldSizeX = worldSpan / this.chunkCountX;
        const chunkWorldSizeZ = worldSpan / this.chunkCountZ;

        const baseDimX = this.baseChunkResolution;
        const baseDimZ = this.baseChunkResolution;

        const cellSize = chunkWorldSizeX / (baseDimX - 1);

        const baseDimY = Math.round(worldSpan / cellSize) + 1;
        const chunkWorldSizeY = (baseDimY - 1) * cellSize;

        this.cellSize = cellSize;
        this.baseDimY = baseDimY;
        this.chunkWorldSizeX = chunkWorldSizeX;
        this.chunkWorldSizeZ = chunkWorldSizeZ;
        this.chunkWorldSizeY = chunkWorldSizeY;
        this.worldSpan = worldSpan;

        return {
            baseChunkWidth: chunkWorldSizeX,
            baseChunkDepth: chunkWorldSizeZ,
            baseChunkHeight: chunkWorldSizeY,
            baseDimX,
            baseDimY,
            baseDimZ,
            cellSize,
            worldSpan
        };
    }

    _getNodePatchSizes(node) {
        const width = node.bounds.maxX - node.bounds.minX;
        const depth = node.bounds.maxZ - node.bounds.minZ;
        const heightRatio = this.chunkWorldSizeY / this.chunkWorldSizeX;
        const height = width * heightRatio;
        return { width, depth, height };
    }

    _computeLodDimensions(lodLevel, node) {
        const { width, depth, height } = this._getNodePatchSizes(node);

        const factor = this._lodFactorFor(lodLevel);
        const dimX = Math.max(6, Math.floor(this.baseChunkResolution / factor));
        const dimZ = dimX;

        const cellSize = width / (dimX - 1);

        const dimYFloat = height / cellSize;
        const dimY = Math.max(6, Math.round(dimYFloat) + 1);

        return {
            dimX,
            dimY,
            dimZ,
            cellSize,
            chunkWidth: width,
            chunkDepth: depth,
            chunkHeight: (dimY - 1) * cellSize
        };
    }

    _tagColliderForTerrain(terrain, lodLevel, options = {}) {
        if (!terrain || !terrain.mesh) return;

        const mesh = terrain.mesh;
        mesh.metadata = mesh.metadata || {};
        mesh.metadata.isTerrain = true;

        const focusPos = this.lastCameraPosition;
        let surfaceDist = options.surfaceDist ?? null;
        const warmupEnabled = options.warmupEnabled ?? this._collisionWarmup?.enabled;

        let nearEnough = true;
        if (focusPos) {
            const center = terrain.origin
                ? terrain.origin.add(new BABYLON.Vector3(
                    (terrain.dimX - 1) * terrain.cellSize * 0.5,
                    (terrain.dimY - 1) * terrain.cellSize * 0.5,
                    (terrain.dimZ - 1) * terrain.cellSize * 0.5
                ))
                : BABYLON.Vector3.Zero();

            const distToFocus = BABYLON.Vector3.Distance(center, focusPos);
            nearEnough = distToFocus <= this.colliderEnableDistance;

            if (surfaceDist == null && distToFocus < Infinity) {
                surfaceDist = this._surfaceDistanceForMesh(
                    mesh,
                    focusPos,
                    this._lastFocusData?.focusDir ?? null
                );
            }
        }

        const nearRing = Number.isFinite(surfaceDist)
            ? surfaceDist <= this.lodRingRadii.r1
            : false;
        const warmupRing = warmupEnabled && Number.isFinite(surfaceDist)
            ? surfaceDist <= this.lodRingRadii.r2
            : false;

        const allowCollider = this.initialBuildDone
            ? lodLevel >= this.colliderLodThreshold
            : true;
        const isCollider = nearRing || warmupRing || (nearEnough && allowCollider);

        const forcedByWarmup = warmupRing && !nearRing && !(nearEnough && allowCollider);
        if (forcedByWarmup) {
            this._collisionWarmup.forcedCount += 1;
        }

        mesh.metadata.isTerrainCollider = isCollider;
        mesh.isPickable = true;
        this._setMeshCollisionActive(mesh, isCollider);
    }

    _registerKnownTerrainMesh(mesh, node = null) {
        if (!mesh) return;
        this._collisionMeshes ??= new Set();
        this._collisionMeshes.add(mesh);
        mesh.metadata = mesh.metadata || {};
        mesh.metadata.isTerrain = true;
        mesh.metadata.isTerrainChunk = true;
        if (node) {
            mesh.metadata.terrainNode = node;
        }
        console.log("[MESHREG-ADD] added", mesh.name, "known size:", this._collisionMeshes.size);
    }

    _registerActiveTerrainMesh(mesh, node = null) {
        if (!mesh) return;
        this._registerKnownTerrainMesh(mesh, node);
        mesh.metadata = mesh.metadata || {};
        mesh.metadata.isTerrainChunk = true;
        this._collisionMeshes ??= new Set();
        this._collisionMeshes.add(mesh);
        console.log(
            "[TERRAIN-MESH]",
            mesh.name,
            "enabled:",
            mesh.isEnabled?.(),
            "collisions:",
            mesh.checkCollisions,
            "metadata:",
            mesh.metadata
        );

        this.activeTerrainMeshes.add(mesh);
        if (mesh.checkCollisions && mesh.isEnabled?.()) {
            this._activeCollisionMeshes.add(mesh);
        } else {
            this._activeCollisionMeshes.delete(mesh);
        }
        if (!this._loggedTerrainMeshes.has(mesh)) {
            console.log(
                "[Terrain] chunk mesh created:",
                mesh.name,
                "collisions:",
                mesh.checkCollisions,
                "enabled:",
                mesh.isEnabled?.()
            );
            this._loggedTerrainMeshes.add(mesh);
        }
    }

    _unregisterActiveTerrainMesh(mesh) {
        if (!mesh) return;
        this.activeTerrainMeshes.delete(mesh);
        this._activeCollisionMeshes.delete(mesh);
    }

    _setMeshCollisionActive(mesh, isActive) {
        if (!mesh) return;
        mesh.metadata = mesh.metadata || {};
        mesh.metadata.isTerrainCollider = !!isActive;
        mesh.checkCollisions = !!isActive;
        if (isActive && mesh.isEnabled?.()) {
            this._activeCollisionMeshes.add(mesh);
        } else {
            this._activeCollisionMeshes.delete(mesh);
        }
    }

    _releaseNodeTerrain(node) {
        if (!node || !node.terrain) return;
        const terrain = node.terrain;
        if (terrain.mesh) {
            this._unregisterActiveTerrainMesh(terrain.mesh);
            terrain.mesh.setEnabled(false);
            this._setMeshCollisionActive(terrain.mesh, false);
            this.meshPool.push(terrain.mesh);
        }
        this.terrainPool.push(terrain);
        node.terrain = null;
    }

    _disposeQuadtree() {
        const all = this.activeLeaves || [];
        for (const leaf of all) {
            this._releaseNodeTerrain(leaf);
        }
        this.rootNode = null;
        this.activeLeaves = [];
        this._activeLeafSet = new Set();
        this.scheduler.queue.length = 0;
        this.scheduler.queuedKeys.clear();
    }

    _createRootNode() {
        const baseMetrics = this._computeBaseChunkMetrics();
        const halfSpan = baseMetrics.worldSpan * 0.5;
        const halfHeight = this.chunkWorldSizeY * 0.5;

        return new PlanetQuadtreeNode(0, {
            minX: -halfSpan,
            maxX: halfSpan,
            minY: -halfHeight,
            maxY: halfHeight,
            minZ: -halfSpan,
            maxZ: halfSpan
        });
    }

    _initializeQuadtree() {
        this._disposeQuadtree();

        PlanetQuadtreeNode._nextId = 1;

        this.chunkOverlap = this.cellSize;

        // Create a fresh root node; no children yet
        this.rootNode = this._createRootNode();
        this.activeLeaves = [this.rootNode];
        this._activeLeafSet = new Set(this.activeLeaves);

        // Reset build bookkeeping
        this.scheduler.queue.length = 0;
        this.scheduler.queuedKeys.clear();

        // Initial build tracking – nothing queued yet
        this.initialBuildTotal = 0;
        this.initialBuildCompleted = 0;
        this.initialBuildDone = false;
    }


    _onChunkBuilt() {
        // If we have no baseline batch, or we've already finished, ignore.
        if (this.initialBuildDone || this.initialBuildTotal === 0) {
            return;
        }

        this.initialBuildCompleted++;

        // First condition: we've finished the initial batch of jobs.
        if (this.initialBuildCompleted < this.initialBuildTotal) {
            return;
        }

        // Second condition: the terrain near the camera is detailed enough.
        let nearLod = 0;
        const focus = this.lastCameraPosition;
        if (focus && typeof this.getDebugInfo === "function") {
            const dbg = this.getDebugInfo(focus);
            if (dbg && dbg.nearestChunk && typeof dbg.nearestChunk.lodLevel === "number") {
                nearLod = dbg.nearestChunk.lodLevel;
            }
        }

        const requiredLod = Math.min(2, this.lodLevel); // require at least LOD 4 (or max available)
        if (nearLod < requiredLod) {
            // We've finished the first batch, but detail isn't high enough yet.
            // More rebuild jobs will call _onChunkBuilt() again as LOD increases.
            return;
        }

        // Both conditions satisfied → initial build is truly done.
        this.initialBuildDone = true;
        if (typeof this.onInitialBuildDone === "function") {
            this.onInitialBuildDone();
        }
    }


    getInitialBuildProgress() {
        if (this.initialBuildTotal === 0) return 0;

        const countProgress = this.initialBuildCompleted / this.initialBuildTotal;

        // LOD-based progress: 0..1 based on nearest chunk's lod vs max lod
        let lodProgress = 0;
        const focus = this.lastCameraPosition;
        if (focus && typeof this.getDebugInfo === "function") {
            const dbg = this.getDebugInfo(focus);
            if (dbg && dbg.nearestChunk && typeof dbg.nearestChunk.lodLevel === "number") {
                const nearLod = dbg.nearestChunk.lodLevel;
                lodProgress = nearLod / Math.max(1, this.lodLevel);
            }
        }

        // Blend: 70% job count, 30% LOD refinement
        const blended = 0.7 * countProgress + 0.3 * lodProgress;
        return Math.max(0, Math.min(1, blended));
    }


    _getNodeSurfaceDirection(node) {
        if (!node) return null;

        const b = node.bounds;
        if (!b) return null;

        const corners = [
            [b.minX, b.minY, b.minZ],
            [b.minX, b.minY, b.maxZ],
            [b.minX, b.maxY, b.minZ],
            [b.minX, b.maxY, b.maxZ],
            [b.maxX, b.minY, b.minZ],
            [b.maxX, b.minY, b.maxZ],
            [b.maxX, b.maxY, b.minZ],
            [b.maxX, b.maxY, b.maxZ]
        ];

        const sum = new BABYLON.Vector3(0, 0, 0);
        let count = 0;

        for (const [x, y, z] of corners) {
            const v = new BABYLON.Vector3(x, y, z);
            const lenSq = v.lengthSquared();
            if (lenSq < 1e-6) continue;
            const invLen = 1 / Math.sqrt(lenSq);
            sum.addInPlace(v.scale(invLen));
            count++;
        }

        if (count === 0) {
            const fallback = node.getCenterWorldPosition();
            const lenSq = fallback.lengthSquared();
            if (lenSq < 1e-6) return null;
            return fallback.scale(1 / Math.sqrt(lenSq));
        }

        const sumLenSq = sum.lengthSquared();
        if (sumLenSq < 1e-6) return null;
        return sum.scale(1 / Math.sqrt(sumLenSq));
    }

    _isChunkAboveHorizon(node, focusPos) {
        if (!focusPos) return true;

        const lenFocus = focusPos.focusRadius ?? 0;
        if (lenFocus <= this.radius || !Number.isFinite(lenFocus)) {
            return true;
        }

        const nFocus = focusPos.focusDir;
        if (!nFocus) return true;
        const nSurface = this._getNodeSurfaceDirection(node);

        if (!nSurface) return true;

        const dot = BABYLON.Vector3.Dot(nSurface, nFocus);
        const horizonDot = (this.radius / lenFocus) - this.horizonCullMargin;

        return dot >= horizonDot;
    }

    _surfaceDistanceForNode(focusDirection, node) {
        let surfaceDir = this._getNodeSurfaceDirection(node);
        if (!surfaceDir || !focusDirection || focusDirection.lengthSquared() < 1e-6) {
            if (!focusDirection || focusDirection.lengthSquared() < 1e-6) {
                return Infinity;
            }
            surfaceDir = focusDirection.clone();
        }

        const dot = BABYLON.Vector3.Dot(surfaceDir, focusDirection);
        const clampedDot = Math.max(-1, Math.min(1, dot));
        const angle = Math.acos(clampedDot);
        return this.radius * angle;
    }

    _computeFocusData(focusPosition) {
        if (!focusPosition) return null;
        const focusRadius = focusPosition.length();
        if (focusRadius < 1e-6 || !Number.isFinite(focusRadius)) return null;
        const focusDir = focusPosition.scale(1 / focusRadius);
        const surfaceFocusPos = focusDir.scale(this.radius);
        return {
            focusDir,
            surfaceFocusPos,
            focusRadius
        };
    }

    _nodeProjectionRange(node, direction) {
        const b = node.bounds;
        const corners = [
            [b.minX, b.minY, b.minZ],
            [b.minX, b.minY, b.maxZ],
            [b.minX, b.maxY, b.minZ],
            [b.minX, b.maxY, b.maxZ],
            [b.maxX, b.minY, b.minZ],
            [b.maxX, b.minY, b.maxZ],
            [b.maxX, b.maxY, b.minZ],
            [b.maxX, b.maxY, b.maxZ]
        ];

        let minProj = Infinity;
        let maxProj = -Infinity;
        for (const [x, y, z] of corners) {
            const proj = x * direction.x + y * direction.y + z * direction.z;
            if (proj < minProj) minProj = proj;
            if (proj > maxProj) maxProj = proj;
        }

        return { minProj, maxProj };
    }

    _nodeRadialRange(node) {
        const b = node.bounds;
        const corners = [
            [b.minX, b.minY, b.minZ],
            [b.minX, b.minY, b.maxZ],
            [b.minX, b.maxY, b.minZ],
            [b.minX, b.maxY, b.maxZ],
            [b.maxX, b.minY, b.minZ],
            [b.maxX, b.minY, b.maxZ],
            [b.maxX, b.maxY, b.minZ],
            [b.maxX, b.maxY, b.maxZ]
        ];

        let minR = Infinity;
        let maxR = -Infinity;
        for (const [x, y, z] of corners) {
            const r = Math.sqrt(x * x + y * y + z * z);
            if (r < minR) minR = r;
            if (r > maxR) maxR = r;
        }

        return { minR, maxR };
    }

    _withinDepthCap(node, maxDepth) {
        if (!node) return true;

        const margin = this.depthCullHysteresis;
        const allowedMin = this.radius - maxDepth;
        const { maxR } = this._nodeRadialRange(node);

        if (node.isDepthCulled) {
            if (maxR > allowedMin + margin) {
                node.isDepthCulled = false;
            }
        } else {
            if (maxR < allowedMin - margin) {
                node.isDepthCulled = true;
            }
        }

        return !node.isDepthCulled;
    }

    _wouldBeDepthCulled(node, maxDepth) {
        if (!node) return false;
        const margin = this.depthCullHysteresis;
        const allowedMin = this.radius - maxDepth;
        const { maxR } = this._nodeRadialRange(node);
        let depthCulled = !!node.isDepthCulled;
        if (depthCulled) {
            if (maxR > allowedMin + margin) {
                depthCulled = false;
            }
        } else {
            if (maxR < allowedMin - margin) {
                depthCulled = true;
            }
        }
        return depthCulled;
    }

    _wouldBeCulledByDistance(node, surfaceDist) {
        if (!node) return false;
        const { rcull } = this.lodRingRadii;
        const margin = this.cullHysteresis;
        let culled = !!node.isCulled;
        if (culled) {
            if (surfaceDist < rcull - margin) {
                culled = false;
            }
        } else {
            if (surfaceDist > rcull + margin) {
                culled = true;
            }
        }
        return culled;
    }

    _recordDroppedBuild(reason) {
        const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        this._buildDropSamples.push({ t: now, reason });
        const cutoff = now - 5000;
        while (this._buildDropSamples.length > 0 && this._buildDropSamples[0].t < cutoff) {
            this._buildDropSamples.shift();
        }
    }

    _withinCullRing(node, surfaceDist) {
        const { rcull } = this.lodRingRadii;
        const margin = this.cullHysteresis;

        if (node.isCulled) {
            if (surfaceDist < rcull - margin) {
                node.isCulled = false;
            }
        } else {
            if (surfaceDist > rcull + margin) {
                node.isCulled = true;
            }
        }

        return !node.isCulled;
    }

    _updateStableLod(node, surfaceDist) {
        const desired = this._lodForDistance(surfaceDist);
        if (node.stableLod == null) {
            node.stableLod = desired;
            node.lastStableSurfaceDist = surfaceDist;
            return node.stableLod;
        }

        if (desired === node.stableLod) {
            node.lastStableSurfaceDist = surfaceDist;
            return node.stableLod;
        }

        const { r0, r1, r2, r3 } = this.lodRingRadii;
        const hysteresis = this.lodRingHysteresis;
        const boundaries = {
            5: r0,
            4: r1,
            3: r2,
            2: r3,
            1: r3,
            0: r3
        };

        const framesSinceChange =
            this.lodUpdateCounter - (node.lastLodChangeFrame ?? 0);
        const canChangeLod =
            framesSinceChange >= this.lodChangeCooldownFrames;

        if (!canChangeLod) {
            return node.stableLod;
        }

        if (desired > node.stableLod) {
            const boundary = boundaries[node.stableLod + 1] ?? r0;
            if (surfaceDist < boundary - hysteresis) {
                node.stableLod = desired;
                node.lastLodChangeFrame = this.lodUpdateCounter;
            }
        } else {
            const boundary = boundaries[node.stableLod] ?? r3;
            if (surfaceDist > boundary + hysteresis) {
                node.stableLod = desired;
                node.lastLodChangeFrame = this.lodUpdateCounter;
            }
        }

        node.lastStableSurfaceDist = surfaceDist;
        return node.stableLod;
    }

    _deactivateNode(node) {
        if (!node) return;
        node._wantedBuildKey = null;
        node._inRenderSet = false;
        node._visibleFrames = 0;

        if (node.terrain && node.terrain.mesh) {
            node.terrain.mesh.setEnabled(false);
            this._setMeshCollisionActive(node.terrain.mesh, false);
            this._unregisterActiveTerrainMesh(node.terrain.mesh);
        }

        if (!node.isLeaf()) {
            node.mergeChildren(this._releaseNodeTerrain.bind(this));
        }
    }

    _ensureTerrainForNode(node) {
        if (node.terrain) return;

        const lodDims = this._computeLodDimensions(node.level, node);
        const pooledTerrain = this.terrainPool.pop();
        const pooledMesh = this.meshPool.pop();

        if (pooledTerrain) {
            // Reset key parameters; actual geometry comes from rebuildWithSettings
            pooledTerrain.radius = this.radius;
            pooledTerrain.isoLevel = this.isoLevel;
            pooledTerrain.useWorker = true;
            pooledTerrain.material = this.material;
            pooledTerrain.mesh = pooledMesh ?? pooledTerrain.mesh;
            pooledTerrain.biomeSettings = this.biomeSettings;
            node.terrain = pooledTerrain;
        } else {
            node.terrain = new MarchingCubesTerrain(this.scene, {
                dimX: lodDims.dimX,
                dimY: lodDims.dimY,
                dimZ: lodDims.dimZ,
                cellSize: lodDims.cellSize,
                isoLevel: this.isoLevel,
                radius: this.radius,
                origin: new BABYLON.Vector3(node.bounds.minX, node.bounds.minY, node.bounds.minZ),
                mesh: pooledMesh ?? null,
                material: this.material,
                biomeSettings: this.biomeSettings,
                deferBuild: true,
                useWorker: true
            });
        }

        this._registerKnownTerrainMesh(node.terrain?.mesh, node);
        node.lastBuiltLod = null;
    }

    _jobKey(node, lodLevel, revisionKey = "0:0") {
        const id = (node && node.id != null) ? node.id : "noid";
        return `${id}|lod:${lodLevel}|rev:${revisionKey}`;
    }

    _scheduleNodeRebuild(node, lodLevel, options = {}) {
        if (!node) return;

        const force = !!options.force;
        const ignoreCulling = !!options.ignoreCulling;
        const revisionKey = `${this.carveRevision}:${this.biomeRevision}`;

        if (!ignoreCulling && (node.isCulled || node.isDepthCulled || node.isHorizonCulled)) {
            console.warn("LEAK build scheduled for culled node", {
                nodeId: node.id,
                lodLevel,
                isCulled: node.isCulled,
                isDepthCulled: node.isDepthCulled,
                isHorizonCulled: node.isHorizonCulled
            });
            this._recordDroppedBuild("culled");
            return;
        }

        let surfaceDist = null;
        if (!ignoreCulling && this._lastFocusData?.focusDir) {
            const focusDir = this._lastFocusData.focusDir;
            surfaceDist = this._surfaceDistanceForNode(focusDir, node);
            if (surfaceDist > this.lodRingRadii.rcull + 1) {
                console.warn("LEAK build outside Rcull", {
                    nodeId: node.id,
                    lodLevel,
                    surfaceDist
                });
                this._recordDroppedBuild("rcull");
                return;
            }
        }

        // Skip if already built for this revision & LOD (unless forced)
        if (!force && node.lastBuiltLod === lodLevel && node.lastBuiltRevision === revisionKey) return;

        const jobKey = this._jobKey(node, lodLevel, revisionKey);

        const streamRevision = this._streamRevision ?? 0;
        const buildKey = `${node.id}|lod:${lodLevel}|rev:${streamRevision}`;
        node._wantedBuildKey = buildKey;

        this.scheduler.enqueue({
            node,
            lodLevel,
            revisionKey,
            buildKey,
            force,
            surfaceDist,
            ignoreCulling,
            jobKey,
            wasVisibleLastFrame: node._wasVisibleLastFrame
        });
    }

    _updateQuadtree(focusData) {
        if (!this.rootNode) return;
        if (!focusData) return;

        const stats = {
            totalVisible: 0,
            totalLeafCandidates: 0,
            totalLeafVisible: 0,
            culledByDistance: 0,
            culledByDepth: 0,
            culledByHorizon: 0,
            perLod: [0, 0, 0, 0, 0, 0],
            maxLodInUse: 0
        };

        const focusDir = focusData.focusDir;
        if (!focusDir) return;

        const maxSurfaceLodDist = this.lodRingRadii.r3;
        const maxDepth = maxSurfaceLodDist * 0.5;

        const previousLeaves = this.activeLeaves || [];
        for (const node of previousLeaves) {
            node._wasVisibleLastFrame = node._inRenderSet;
            node._inRenderSet = false;
        }

        const stack = [this.rootNode];
        const newLeaves = [];

        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;

            const surfaceDist = this._surfaceDistanceForNode(focusDir, node);
            if (node.isLeaf()) {
                stats.totalLeafCandidates++;
            }

            if (!this._withinDepthCap(node, maxDepth)) {
                stats.culledByDepth++;
                this._deactivateNode(node);
                continue;
            }

            if (!this._isChunkAboveHorizon(node, focusData)) {
                node.isHorizonCulled = true;
                stats.culledByHorizon++;
                this._deactivateNode(node);
                continue;
            }
            node.isHorizonCulled = false;

            if (!this._withinCullRing(node, surfaceDist)) {
                stats.culledByDistance++;
                this._deactivateNode(node);
                continue;
            }

            const desiredLod = this._updateStableLod(node, surfaceDist);

            const belowDesired =
                node.level < desiredLod && node.level < this.lodLevel;
            if (belowDesired && node.isLeaf()) {
                this._releaseNodeTerrain(node);
                node.subdivide();
                stack.push(...node.children);
                continue;
            }

            const aboveDesired = node.level > desiredLod && !node.isLeaf();
            if (aboveDesired) {
                node.mergeChildren(this._releaseNodeTerrain.bind(this));
            }

            if (!node.isLeaf()) {
                stack.push(...node.children);
                continue;
            }

            // Leaf that should be visible
            newLeaves.push(node);
            stats.totalVisible++;
            stats.totalLeafVisible++;
            if (node.level >= 0 && node.level < stats.perLod.length) {
                stats.perLod[node.level]++;
                if (node.level > stats.maxLodInUse) {
                    stats.maxLodInUse = node.level;
                }
            }

            node._inRenderSet = true;
            node._visibleFrames = node._wasVisibleLastFrame ? (node._visibleFrames + 1) : 1;

            // Ensure mesh is enabled if already built
            if (node.terrain && node.terrain.mesh) {
                const mesh = node.terrain.mesh;
                const inRenderSet = true;
                if (inRenderSet && node.terrain?.mesh && !mesh.isEnabled?.()) {
                    console.warn("RenderSet mesh disabled leak", node.id);
                }
                mesh.setEnabled(true);
                this._registerActiveTerrainMesh(mesh, node);
            }
        }

        this.activeLeaves = newLeaves;
        this._activeLeafSet = new Set(newLeaves);
        this.lastLodStats = stats;

        for (const node of previousLeaves) {
            if (!node._inRenderSet) {
                node._visibleFrames = 0;
            }
        }

        this._updateSkirtEdges(newLeaves);

        // Queue builds for any leaves that need them (progressive refinement)
        for (const leaf of newLeaves) {
            this._ensureTerrainForNode(leaf);
        
            const desiredLod = leaf.stableLod ?? leaf.level; // stabilized target
            const built = (leaf.lastBuiltLod ?? null);   // null means never built
            const stableForBuild = leaf._visibleFrames >= this.buildStabilityFrames;
        
            // First time this leaf becomes visible: build LOD 1 first (fast), then refine.
            if (built === null) {
                const coarse = Math.min(this.initialCoarseLod ?? 1, desiredLod);
        
                this._scheduleNodeRebuild(leaf, coarse, {});
        
                if (desiredLod > coarse && stableForBuild) {
                    this._scheduleNodeRebuild(leaf, desiredLod, {});
                }
        
                continue;
            }
        
            // Already built: only upgrade progressively (no downgrades here)
            if (desiredLod > built && stableForBuild) {
                this._scheduleNodeRebuild(leaf, desiredLod, {});
            }
        
            // If desiredLod < built: do nothing (stickiness). Downgrades should happen via eviction/memory policy later.
        }


        // Track the total amount of work queued for the "initial build" phase.
        //
        // The previous logic only captured the queue length the first time we
        // enqueued work, which meant any follow-up jobs scheduled while the
        // loader was still visible were ignored. That caused onInitialBuildDone
        // to fire early, dismissing the loading overlay before all chunks were
        // built. By updating the total to include newly queued jobs until the
        // initial build is marked complete, the loading bar now reflects the
        // full workload and the game waits appropriately.
        if (!this.initialBuildDone && this.scheduler.getQueueLength() > 0) {
            const pendingJobs = this.scheduler.getQueueLength() + this.initialBuildCompleted;
            if (pendingJobs > this.initialBuildTotal) {
                this.initialBuildTotal = pendingJobs;
            }
        }
    }

    _updateSkirtEdges(leaves) {
        if (!Array.isArray(leaves) || leaves.length === 0) return;
        const epsilon = Math.max(this.cellSize ?? 1, 1) * 0.5;
        const rangesOverlap = (aMin, aMax, bMin, bMax) => aMin <= bMax + epsilon && aMax + epsilon >= bMin;

        for (const leaf of leaves) {
            leaf.skirtEdges = { north: false, south: false, east: false, west: false };
        }

        for (let i = 0; i < leaves.length; i++) {
            const node = leaves[i];
            const b = node.bounds;
            for (let j = 0; j < leaves.length; j++) {
                if (i === j) continue;
                const other = leaves[j];
                if (other.level >= node.level) continue;
                const o = other.bounds;

                if (Math.abs(b.maxX - o.minX) <= epsilon && rangesOverlap(b.minZ, b.maxZ, o.minZ, o.maxZ)) {
                    node.skirtEdges.east = true;
                }
                if (Math.abs(b.minX - o.maxX) <= epsilon && rangesOverlap(b.minZ, b.maxZ, o.minZ, o.maxZ)) {
                    node.skirtEdges.west = true;
                }
                if (Math.abs(b.maxZ - o.minZ) <= epsilon && rangesOverlap(b.minX, b.maxX, o.minX, o.maxX)) {
                    node.skirtEdges.north = true;
                }
                if (Math.abs(b.minZ - o.maxZ) <= epsilon && rangesOverlap(b.minX, b.maxX, o.minX, o.maxX)) {
                    node.skirtEdges.south = true;
                }
            }
        }
    }

    _syncRenderSetMeshes() {
        if (!this._activeLeafSet || this._activeLeafSet.size === 0) return;
        const meshes = Array.from(this.activeTerrainMeshes);
        for (const mesh of meshes) {
            const node = mesh?.metadata?.terrainNode;
            if (!node || !this._activeLeafSet.has(node)) {
                mesh.setEnabled(false);
                this._setMeshCollisionActive(mesh, false);
                this._unregisterActiveTerrainMesh(mesh);
            }
        }
    }

    _updateColliderQueue() {
        const focusData = this._lastFocusData;
        if (!focusData || !focusData.focusDir) return;
        const { r1, r2 } = this.lodRingRadii;

        for (const mesh of this.activeTerrainMeshes) {
            if (!mesh || !mesh.isEnabled?.()) continue;
            const surfaceDist = this._surfaceDistanceForMesh(mesh, this.lastCameraPosition, focusData.focusDir);
            if (!Number.isFinite(surfaceDist)) continue;

            if (surfaceDist <= r1) {
                this.colliderQueue.request(mesh, true, 3);
            } else if (surfaceDist <= r2) {
                this.colliderQueue.request(mesh, true, 2);
            } else {
                this.colliderQueue.request(mesh, false, 1);
            }
        }

        this.colliderQueue.process({
            applyUpdate: (mesh, isActive) => {
                this._setMeshCollisionActive(mesh, isActive);
            }
        });
    }


    _processBuildQueue(maxPerFrame = 1) {
        // Legacy signature kept; internally we use a time budget.
        this._processBuildQueueBudgeted(this.buildBudgetMs);
    }

    _processBuildQueueBudgeted(budgetMs = this.buildBudgetMs) {
        const maxDepth = this.lodRingRadii.r3 * 0.5;
        this.scheduler.process({
            budgetMs,
            canRunJob: (job) => {
                const node = job.node;
                if (!node) return { ok: false, reason: "missingNode" };
                if (!job.ignoreCulling && (node.isCulled || node.isDepthCulled || node.isHorizonCulled)) {
                    this._recordDroppedBuild("culled");
                    return { ok: false, reason: "culled" };
                }
                if (!job.ignoreCulling && !this._withinDepthCap(node, maxDepth)) {
                    console.warn("LEAK build outside depth cap", { nodeId: node.id, lodLevel: job.lodLevel });
                    this._recordDroppedBuild("depth");
                    return { ok: false, reason: "depth" };
                }
                if (!job.ignoreCulling && this._lastFocusData && !this._isChunkAboveHorizon(node, this._lastFocusData)) {
                    console.warn("LEAK build below horizon", { nodeId: node.id, lodLevel: job.lodLevel });
                    node.isHorizonCulled = true;
                    this._recordDroppedBuild("horizon");
                    return { ok: false, reason: "horizon" };
                }
                if (!job.ignoreCulling && this._lastFocusData?.focusDir) {
                    const focusDir = this._lastFocusData.focusDir;
                    const surfaceDist = this._surfaceDistanceForNode(focusDir, node);
                    if (surfaceDist > this.lodRingRadii.rcull + 1) {
                        console.warn("LEAK build outside Rcull", { nodeId: node.id, lodLevel: job.lodLevel, surfaceDist });
                        this._recordDroppedBuild("rcull");
                        return { ok: false, reason: "rcull" };
                    }
                }
                return { ok: true };
            },
            runJob: (job) => {
                const node = job.node;
                const revisionKey = job.revisionKey ?? `${this.carveRevision}:${this.biomeRevision}`;

                this._ensureTerrainForNode(node);

                if (!job.force && node.lastBuiltLod === job.lodLevel && node.lastBuiltRevision === revisionKey) {
                    return null;
                }

                const jobStartMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
                const lodDims = this._computeLodDimensions(job.lodLevel, node);
                const skirtEdges = node.skirtEdges ?? {};
                const skirtDepth = lodDims.cellSize * this.skirtDepthScale;

                return node.terrain.rebuildWithSettings({
                    origin: new BABYLON.Vector3(node.bounds.minX, node.bounds.minY, node.bounds.minZ),
                    dimX: lodDims.dimX,
                    dimY: lodDims.dimY,
                    dimZ: lodDims.dimZ,
                    cellSize: lodDims.cellSize,
                    carves: this._collectCarvesForNode(node),
                    biomeSettings: this.biomeSettings,
                    buildKey: job.buildKey ?? null,
                    skirt: {
                        enabled: !!(skirtEdges.north || skirtEdges.south || skirtEdges.east || skirtEdges.west),
                        edges: skirtEdges,
                        depth: skirtDepth
                    },
                    shouldApplyResult: (result) => {
                        if (node._wantedBuildKey !== result.buildKey) {
                            this._recordDroppedBuild("staleResult");
                            return false;
                        }
                        return true;
                    }
                }).then((result) => {
                    if (result?.applied === false) {
                        return null;
                    }
                    node.lastBuiltLod = job.lodLevel;
                    node.lastBuiltRevision = revisionKey;
                    this._registerActiveTerrainMesh(node.terrain?.mesh, node);
                    this._onChunkBuilt();
                    const endMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
                    this._recordBuildDuration(endMs - jobStartMs);
                    return result;
                }).catch((err) => {
                    console.error("Chunk rebuild failed:", err);
                });
            }
        });
    }

    _recordBuildDuration(ms) {
        if (!Number.isFinite(ms)) return;
        const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        this._buildDurationSamples.push({ t: now, ms });
        const cutoff = now - 5000;
        while (this._buildDurationSamples.length > 0 && this._buildDurationSamples[0].t < cutoff) {
            this._buildDurationSamples.shift();
        }
        const nextSamples = Math.min(120, (this.lastBuildStats.samples ?? 0) + 1);
        const prevAvg = this.lastBuildStats.avgBuildMs ?? 0;
        const nextAvg = prevAvg + (ms - prevAvg) / nextSamples;
        this.lastBuildStats = {
            avgBuildMs: nextAvg,
            samples: nextSamples
        };
    }


    _collectCarvesForNode(node) {
        if (!this.carveHistory || this.carveHistory.length === 0 || !node) return [];

        const out = [];
        const b = node.bounds;

        for (const op of this.carveHistory) {
            const px = op.position.x;
            const py = op.position.y;
            const pz = op.position.z;
            const r = op.radius;

            const cx = Math.max(b.minX, Math.min(px, b.maxX));
            const cy = Math.max(b.minY, Math.min(py, b.maxY));
            const cz = Math.max(b.minZ, Math.min(pz, b.maxZ));

            const dx = px - cx;
            const dy = py - cy;
            const dz = pz - cz;

            if ((dx * dx + dy * dy + dz * dz) > (r * r)) continue;

            out.push({
                position: { x: px, y: py, z: pz },
                radius: r
            });
        }

        return out;
    }


    _nodeIntersectsSphere(node, center, radius) {
        const minX = node.bounds.minX;
        const maxX = node.bounds.maxX;
        const minY = node.bounds.minY;
        const maxY = node.bounds.maxY;
        const minZ = node.bounds.minZ;
        const maxZ = node.bounds.maxZ;

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
    _applyRelevantCarvesToNode(node) {
        // Carves are applied in the mesh worker via settings.carves.
        // Intentionally a no-op.
    }
// -------------------------------------------------
    // Public API used by main.js
    // -------------------------------------------------

    setOnInitialBuildDone(cb) {
        this.onInitialBuildDone = cb;
        if (this.initialBuildDone && typeof cb === "function") {
            cb();
        }
    }

    setLodLevel(level) {
        const clamped = Math.max(0, Math.min(5, Math.round(level)));
        if (clamped === this.lodLevel) return;
        this.lodLevel = clamped;

        this.scheduler.queue.length = 0;
        this.scheduler.queuedKeys.clear();
        this._initializeQuadtree();
    }

    updateAtPosition(focusPosition) {
        this.lodUpdateCounter++;
        const nowMs = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        this.scheduler.setLimits({
            maxConcurrentBuilds: this.maxConcurrentBuilds,
            buildBudgetMs: this.buildBudgetMs
        });
        if (this._collisionWarmup) {
            this._collisionWarmup.forcedCount = 0;
        }
        const lastFocus = this.lastCameraPosition;
        if (focusPosition) {
            this.lastCameraPosition = focusPosition.clone
                ? focusPosition.clone()
                : new BABYLON.Vector3(
                    focusPosition.x,
                    focusPosition.y,
                    focusPosition.z
                );
            this._lastFocusData = this._computeFocusData(this.lastCameraPosition);
            if (!lastFocus || BABYLON.Vector3.Distance(lastFocus, this.lastCameraPosition) > this.lodRingHysteresis) {
                this._streamRevision = (this._streamRevision ?? 0) + 1;
            }
        } else {
            this._lastFocusData = null;
        }

        if (this._lastFocusData) {
            this._updateQuadtree(this._lastFocusData);
        }

        if ((this.lastLodStats.totalVisible ?? 0) === 0) {
            for (const mesh of this.activeTerrainMeshes) {
                if (!mesh) continue;
                mesh.setEnabled(false);
                this._setMeshCollisionActive(mesh, false);
            }
            this.activeTerrainMeshes.clear();
            this._activeCollisionMeshes.clear();
        }

        this._syncRenderSetMeshes();
        this._updateColliderQueue();
        this._processBuildQueue();
    }

    updateStreaming(focusPosition) {
        this.updateAtPosition(focusPosition);
    }

    carveSphere(worldPos, radius) {
        const pos = worldPos.clone ? worldPos.clone() : worldPos;

        this.carveHistory.push({
            position: pos,
            radius
        });

        // Bump revision so rebuilds at the same LOD are not deduped away.
        this.carveRevision++;

        const intersectingLeaves = [];
        const stack = [this.rootNode];
        const activeSet = this._activeLeafSet ?? new Set(this.activeLeaves);
        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;
            if (!this._nodeIntersectsSphere(node, pos, radius)) {
                continue;
            }
            if (node.isLeaf()) {
                if (activeSet.has(node) && !node.isCulled && !node.isDepthCulled && !node.isHorizonCulled) {
                    intersectingLeaves.push(node);
                }
            } else {
                stack.push(...node.children);
            }
        }

        // Schedule full worker rebuilds (no main-thread mesh-only rebuilds)
        for (const leaf of intersectingLeaves) {
            const lod = (typeof leaf.lastBuiltLod === "number") ? leaf.lastBuiltLod : leaf.level;
            this._scheduleNodeRebuild(leaf, lod, { force: true });
        }
    }

    setCarveHistory(carves = []) {
        this.carveHistory = Array.isArray(carves) ? carves.map((c) => ({
            position: { x: c.position.x, y: c.position.y, z: c.position.z },
            radius: c.radius
        })) : [];
        this.carveRevision++;
        this._forceRebuildActiveChunks();
    }

    getCarveHistory() {
        return this.carveHistory || [];
    }

    setBiomeSettings(partialSettings) {
        this.biomeSettings = resolveBiomeSettings({
            ...this.biomeSettings,
            ...(partialSettings || {})
        });

        this.biomeRevision++;
        this._forceRebuildActiveChunks();
    }

    cycleBiomeDebugMode() {
        const modes = ["off", "biome", "height", "slope", "isolateSand", "isolateSnow"];
        const current = this.biomeSettings?.debugMode || "off";
        const idx = modes.indexOf(current);
        const next = modes[(idx + 1) % modes.length];
        this.setBiomeSettings({ debugMode: next });
        return next;
    }

    setBiomeDebugMode(mode) {
        const modes = ["off", "biome", "height", "slope", "isolateSand", "isolateSnow"];
        if (!modes.includes(mode)) return this.biomeSettings?.debugMode || "off";
        this.setBiomeSettings({ debugMode: mode });
        return mode;
    }

    _forceRebuildActiveChunks() {
        for (const leaf of this.activeLeaves) {
            this._ensureTerrainForNode(leaf);
            this._scheduleNodeRebuild(leaf, leaf.level, { force: true });
        }

        if (!this.initialBuildDone && this.scheduler.getQueueLength() > 0) {
            const pendingJobs = this.scheduler.getQueueLength() + this.initialBuildCompleted;
            if (pendingJobs > this.initialBuildTotal) {
                this.initialBuildTotal = pendingJobs;
            }
        }
    }

    _collectLeavesAtLevel(targetLevel, node, out) {
        if (!node) return;
        if (node.level === targetLevel) {
            out.push(node);
            return;
        }
        if (node.level < targetLevel) {
            if (node.isLeaf()) node.subdivide();
            for (const child of node.children) {
                this._collectLeavesAtLevel(targetLevel, child, out);
            }
        }
    }

    buildGlobalCoarseLod1() {
        if (!this.rootNode) return;
        const leaves = [];
        this._collectLeavesAtLevel(1, this.rootNode, leaves);
        for (const node of leaves) {
            node.isCulled = false;
            node.isDepthCulled = false;
            node.isHorizonCulled = false;
            this._ensureTerrainForNode(node);
            this._scheduleNodeRebuild(node, 1, { force: true, ignoreCulling: true });
        }

        if (!this.initialBuildDone && this.scheduler.getQueueLength() > 0) {
            const pendingJobs = this.scheduler.getQueueLength() + this.initialBuildCompleted;
            if (pendingJobs > this.initialBuildTotal) {
                this.initialBuildTotal = pendingJobs;
            }
        }
    }

    getLodStats() {
        return this.lastLodStats;
    }

    setCollisionWarmupState({ enabled, timeSincePlayStartMs } = {}) {
        if (!this._collisionWarmup) {
            this._collisionWarmup = {
                enabled: !!enabled,
                forcedCount: 0,
                timeSincePlayStartMs: timeSincePlayStartMs ?? null
            };
            return;
        }
        this._collisionWarmup.enabled = !!enabled;
        this._collisionWarmup.timeSincePlayStartMs = timeSincePlayStartMs ?? null;
    }

    _surfaceDistanceForMesh(mesh, focusPos, focusDirOverride = null) {
        const focusDir = focusDirOverride
            ? focusDirOverride
            : (focusPos ? focusPos.clone() : null);
        if (!focusDir || focusDir.lengthSquared() <= 0) return Infinity;
        if (!focusDirOverride) {
            focusDir.normalize();
        }
        const node = mesh?.metadata?.terrainNode;
        if (node) {
            return this._surfaceDistanceForNode(focusDir, node);
        }
        const boundingCenter = mesh?.getBoundingInfo?.().boundingSphere?.centerWorld;
        const center = boundingCenter ?? mesh?.position ?? null;
        if (!center) return Infinity;
        const dir = center.clone();
        if (dir.lengthSquared() < 1e-6) return Infinity;
        dir.normalize();
        const dot = BABYLON.Vector3.Dot(dir, focusDir);
        const clamped = Math.max(-1, Math.min(1, dot));
        const angle = Math.acos(clamped);
        return this.radius * angle;
    }

    getActiveCollisionMeshCountNear(focusPos, maxSurfaceDist) {
        if (!focusPos || !Number.isFinite(maxSurfaceDist)) return 0;
        let count = 0;
        for (const mesh of this._activeCollisionMeshes) {
            if (!mesh || !mesh.isEnabled?.() || !mesh.checkCollisions) continue;
            const surfaceDist = this._surfaceDistanceForMesh(mesh, focusPos);
            if (surfaceDist <= maxSurfaceDist) count += 1;
        }
        return count;
    }

    getStreamingStats() {
        const enabledMeshes = [];
        for (const mesh of this.activeTerrainMeshes) {
            if (mesh && mesh.isEnabled?.()) enabledMeshes.push(mesh);
        }
        let enabledCollidable = 0;
        for (const mesh of this._activeCollisionMeshes) {
            if (mesh && mesh.isEnabled?.()) enabledCollidable++;
        }

        const focusPos = this.lastCameraPosition;
        const focusData = this._lastFocusData;

        const rcull = this.lodRingRadii.rcull;
        const maxDepth = this.lodRingRadii.r3 * 0.5;
        const allowedMin = this.radius - maxDepth;
        const depthMargin = this.depthCullHysteresis;

        const getMeshCenter = (mesh) => {
            const boundingCenter = mesh?.getBoundingInfo?.().boundingSphere?.centerWorld;
            return boundingCenter ?? mesh?.position ?? null;
        };

        const surfaceDistanceForMesh = (mesh) => this._surfaceDistanceForMesh(
            mesh,
            focusPos,
            focusData?.focusDir ?? null
        );

        const meshBelowHorizon = (mesh) => {
            if (!focusData) return false;
            const node = mesh?.metadata?.terrainNode;
            if (node) {
                return !this._isChunkAboveHorizon(node, focusData);
            }
            const center = getMeshCenter(mesh);
            if (!center) return false;
            const lenFocus = focusData.focusRadius ?? 0;
            if (lenFocus <= this.radius || !Number.isFinite(lenFocus)) return false;
            const toFocus = focusData.focusDir;
            if (!toFocus) return false;
            const nSurface = center.clone();
            if (nSurface.lengthSquared() < 1e-6) return false;
            nSurface.normalize();
            const dot = BABYLON.Vector3.Dot(nSurface, toFocus);
            const horizonDot = (this.radius / lenFocus) - this.horizonCullMargin;
            return dot < horizonDot;
        };

        const meshTooDeep = (mesh) => {
            const node = mesh?.metadata?.terrainNode;
            if (node) {
                return this._wouldBeDepthCulled(node, maxDepth);
            }
            const center = getMeshCenter(mesh);
            if (!center) return false;
            const radiusWorld = mesh?.getBoundingInfo?.().boundingSphere?.radiusWorld ?? 0;
            const maxR = center.length() + radiusWorld;
            return maxR < allowedMin - depthMargin;
        };

        let enabledOutsideRcull = 0;
        let collidableOutsideRcull = 0;
        let enabledBelowHorizon = 0;
        let enabledTooDeep = 0;
        let perLodOutsideRcull = 0;
        let enabledInR1 = 0;
        let enabledInR2 = 0;
        let enabledInR3 = 0;
        let collidersInR1 = 0;
        let collidersInR2 = 0;
        let collidersInR3 = 0;

        for (const mesh of enabledMeshes) {
            const surfaceDist = surfaceDistanceForMesh(mesh);
            if (surfaceDist > rcull) {
                enabledOutsideRcull++;
            }
            if (meshBelowHorizon(mesh)) {
                enabledBelowHorizon++;
            }
            if (meshTooDeep(mesh)) {
                enabledTooDeep++;
            }
            if (surfaceDist <= this.lodRingRadii.r1) {
                enabledInR1++;
            } else if (surfaceDist <= this.lodRingRadii.r2) {
                enabledInR2++;
            } else if (surfaceDist <= this.lodRingRadii.r3) {
                enabledInR3++;
            }
        }

        for (const mesh of this._activeCollisionMeshes) {
            if (!mesh || !mesh.isEnabled?.()) continue;
            const surfaceDist = surfaceDistanceForMesh(mesh);
            if (surfaceDist > rcull) {
                collidableOutsideRcull++;
            }
            if (surfaceDist <= this.lodRingRadii.r1) {
                collidersInR1++;
            } else if (surfaceDist <= this.lodRingRadii.r2) {
                collidersInR2++;
            } else if (surfaceDist <= this.lodRingRadii.r3) {
                collidersInR3++;
            }
        }

        if (focusData?.focusDir) {
            const focusDir = focusData.focusDir;
            for (const node of this.activeLeaves || []) {
                if (!node) continue;
                const surfaceDist = this._surfaceDistanceForNode(focusDir, node);
                if (surfaceDist > rcull) {
                    perLodOutsideRcull++;
                }
            }
        }

        let buildJobsQueuedOutsideRcull = 0;
        let buildJobsQueuedBelowHorizon = 0;
        let buildJobsQueuedTooDeep = 0;
        if (focusData?.focusDir) {
            const focusDir = focusData.focusDir;
            for (const job of this.scheduler.queue) {
                const node = job?.node;
                if (!node) continue;
                const surfaceDist = this._surfaceDistanceForNode(focusDir, node);
                if (surfaceDist > rcull) {
                    buildJobsQueuedOutsideRcull++;
                }
                if (!this._isChunkAboveHorizon(node, focusData)) {
                    buildJobsQueuedBelowHorizon++;
                }
                if (this._wouldBeDepthCulled(node, maxDepth)) {
                    buildJobsQueuedTooDeep++;
                }
            }
        }

        const now = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        const cutoff = now - 1000;
        let sum = 0;
        let count = 0;
        for (const sample of this._buildDurationSamples) {
            if (sample.t >= cutoff) {
                sum += sample.ms;
                count++;
            }
        }

        let buildJobsDroppedOutsideRcull = 0;
        let buildJobsDroppedBelowHorizon = 0;
        let buildJobsDroppedTooDeep = 0;
        let buildJobsDroppedCulled = 0;
        let buildJobsDroppedStaleResult = 0;
        let buildJobsDroppedStaleJob = 0;
        for (const sample of this._buildDropSamples) {
            if (sample.t < cutoff) continue;
            if (sample.reason === "rcull") buildJobsDroppedOutsideRcull++;
            if (sample.reason === "horizon") buildJobsDroppedBelowHorizon++;
            if (sample.reason === "depth") buildJobsDroppedTooDeep++;
            if (sample.reason === "culled") buildJobsDroppedCulled++;
            if (sample.reason === "staleResult") buildJobsDroppedStaleResult++;
        }
        for (const sample of this.scheduler.getDropSamples()) {
            if (sample.t < cutoff) continue;
            if (sample.reason === "staleJob") buildJobsDroppedStaleJob++;
        }

        const dotSamples = [];
        if (focusData?.focusDir) {
            for (const node of (this.activeLeaves || []).slice(0, 6)) {
                const nodeDir = this._getNodeSurfaceDirection(node);
                if (!nodeDir) continue;
                dotSamples.push(BABYLON.Vector3.Dot(focusData.focusDir, nodeDir));
            }
        }
        const dotSampleMin = dotSamples.length ? Math.min(...dotSamples) : null;
        const dotSampleMax = dotSamples.length ? Math.max(...dotSamples) : null;

        return {
            enabledMeshes: enabledMeshes.length,
            enabledCollidableMeshes: enabledCollidable,
            focusRadius: focusData?.focusRadius ?? null,
            focusSurfaceRadius: focusData?.surfaceFocusPos?.length() ?? null,
            dotSampleMin,
            dotSampleMax,
            collisionsWarmupEnabled: this._collisionWarmup?.enabled ?? false,
            collidersForcedCount: this._collisionWarmup?.forcedCount ?? 0,
            timeSincePlayStart: this._collisionWarmup?.timeSincePlayStartMs ?? null,
            colliderQueueLength: this.colliderQueue.getQueueLength(),
            collidersProcessedPerSecond: this.colliderQueue.getProcessedPerSecond(),
            enabledMeshesR1: enabledInR1,
            enabledMeshesR2: enabledInR2,
            enabledMeshesR3: enabledInR3,
            enabledCollidersR1: collidersInR1,
            enabledCollidersR2: collidersInR2,
            enabledCollidersR3: collidersInR3,
            enabledOutsideRcull,
            collidableOutsideRcull,
            enabledBelowHorizon,
            enabledTooDeep,
            perLodOutsideRcull,
            buildJobsQueuedOutsideRcull,
            buildJobsQueuedBelowHorizon,
            buildJobsQueuedTooDeep,
            buildJobsDroppedOutsideRcull,
            buildJobsDroppedBelowHorizon,
            buildJobsDroppedTooDeep,
            buildJobsDroppedCulled,
            buildJobsDroppedStaleResult,
            buildJobsDroppedStaleJob,
            renderSetCount: this.lastLodStats.totalVisible ?? 0,
            totalLeafCandidates: this.lastLodStats.totalLeafCandidates ?? 0,
            totalLeafVisible: this.lastLodStats.totalLeafVisible ?? 0,
            culledCount: this.lastLodStats.culledByDistance ?? 0,
            depthCulledCount: this.lastLodStats.culledByDepth ?? 0,
            horizonCulledCount: this.lastLodStats.culledByHorizon ?? 0,
            perLodCounts: [...(this.lastLodStats.perLod || [])],
            maxLodInUse: this.lastLodStats.maxLodInUse ?? 0,
            buildQueueLength: this.scheduler.getQueueLength(),
            activeBuilds: this.scheduler.activeBuilds,
            avgBuildMsLastSecond: count > 0 ? sum / count : 0
        };
    }

    getSurfaceDirectionSamples(sampleCount = 6) {
        const samples = [];
        if (!this.activeLeaves || this.activeLeaves.length === 0) return samples;

        for (const node of this.activeLeaves.slice(0, sampleCount)) {
            const start = node.getCenterWorldPosition();
            const dir = this._getNodeSurfaceDirection(node);
            if (!dir) continue;
            const end = dir.scale(this.radius);
            samples.push({ start, end });
        }

        return samples;
    }

    getDebugInfo(focusPosition) {
        const info = {
            chunkCountX: this.chunkCountX,
            chunkCountZ: this.chunkCountZ,
            baseChunkResolution: this.baseChunkResolution,
            lodCap: this.lodLevel,
            lodStats: this.lastLodStats,
            nearestLeaf: null,
            nearestChunk: null,
            maxLodInUse: this.lastLodStats.maxLodInUse,
            chunkWorldSizeX: this.chunkWorldSizeX,
            chunkWorldSizeZ: this.chunkWorldSizeZ,
            worldSpan: this.worldSpan,
            buildQueueLength: this.scheduler.getQueueLength(),
            avgBuildMs: this.lastBuildStats.avgBuildMs,
            streamingRadii: { ...this.lodRingRadii }
        };

        if (!focusPosition || !this.activeLeaves.length) {
            return info;
        }
        
        const planetCenter = BABYLON.Vector3.Zero();
        const toFocus = focusPosition.subtract(planetCenter);
        const lenFocus = toFocus.length();

        let bestDist = Infinity;
        for (const node of this.activeLeaves) {
            const center = node.getCenterWorldPosition();
            let toChunk = center.subtract(planetCenter);
            let lenChunk = toChunk.length();

            // Same root-node special case
            if (lenChunk < 1e-3 && lenFocus > 1e-3) {
                toChunk = toFocus.clone();
                lenChunk = lenFocus;
            }

            let surfaceDist = BABYLON.Vector3.Distance(focusPosition, center);
            if (lenChunk > 1e-3 && lenFocus > 1e-3) {
                const dot =
                    BABYLON.Vector3.Dot(toChunk, toFocus) /
                    (lenChunk * lenFocus);
                const clamped = Math.max(-1, Math.min(1, dot));
                const angle = Math.acos(clamped);
                surfaceDist = this.radius * angle;
            }

            if (surfaceDist < bestDist) {
                bestDist = surfaceDist;
                const lodDims = this._computeLodDimensions(node.level, node);
                const nearestInfo = {
                    lodLevel: node.level,
                    dimX: lodDims.dimX,
                    dimZ: lodDims.dimZ,
                    distance: surfaceDist
                };
                info.nearestLeaf = nearestInfo;
                info.nearestChunk = nearestInfo; // HUD compatibility
            }
        }

        return info;
    }

    getVisibleNodes() {
        return (this.activeLeaves || []).map((node) => ({
            id: node.id,
            level: node.level,
            bounds: node.bounds,
            center: node.getCenterWorldPosition(),
            visibleLod: node.lastBuiltLod ?? node.level
        }));
    }

    getActiveCollisionMeshes() {
        return Array.from(this._activeCollisionMeshes).filter(
            (mesh) => mesh && !mesh.isDisposed?.() && mesh.isEnabled?.() && mesh.checkCollisions
        );
    }

    getKnownCollisionMeshes() {
        return Array.from(this._collisionMeshes).filter(
            (mesh) => mesh && !mesh.isDisposed?.()
        );
    }

    getCollisionMeshes() {
        return this.getActiveCollisionMeshes();
    }
}
