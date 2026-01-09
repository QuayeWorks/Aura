/* global BABYLON */
import { MarchingCubesTerrain } from "./MarchingCubesTerrain.js";
import { PlanetQuadtreeNode } from "./PlanetQuadtreeNode.js";
import { resolveBiomeSettings, DEFAULT_BIOME_SETTINGS } from "./biomeSettings.js";

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

        this.colliderLodThreshold = options.colliderLodThreshold ?? 5;
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
        this.buildQueue = [];
        this.carveHistory = [];
        this.carveRevision = 0; // increments when carve history changes

        // Build de-dupe / in-flight tracking
        this.queuedJobKeys = new Set();
        this.inFlightJobKeys = new Set();

        this.buildBudgetMs = options.buildBudgetMs ?? 6; // ms budget per frame
        this.maxConcurrentBuilds = options.maxConcurrentBuilds ?? 2;
        this.activeBuilds = 0;


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

    _tagColliderForTerrain(terrain, lodLevel) {
        if (!terrain || !terrain.mesh) return;

        const mesh = terrain.mesh;
        mesh.metadata = mesh.metadata || {};
        mesh.metadata.isTerrain = true;

        let nearEnough = true;
        if (this.lastCameraPosition) {
            const center = terrain.origin
                ? terrain.origin.add(new BABYLON.Vector3(
                    (terrain.dimX - 1) * terrain.cellSize * 0.5,
                    (terrain.dimY - 1) * terrain.cellSize * 0.5,
                    (terrain.dimZ - 1) * terrain.cellSize * 0.5
                ))
                : BABYLON.Vector3.Zero();

            const distToFocus = BABYLON.Vector3.Distance(
                center,
                this.lastCameraPosition
            );

            nearEnough = distToFocus <= this.colliderEnableDistance;
        }

        const isCollider = nearEnough && lodLevel >= this.colliderLodThreshold;

        mesh.metadata.isTerrainCollider = isCollider;
        mesh.isPickable = true;
        mesh.checkCollisions = isCollider;

        if (isCollider) {
            this._activeCollisionMeshes.add(mesh);
        } else {
            this._activeCollisionMeshes.delete(mesh);
        }
    }

    _registerActiveTerrainMesh(mesh, node = null) {
        if (!mesh) return;
        mesh.metadata = mesh.metadata || {};
        mesh.metadata.isTerrain = true;
        if (node) {
            mesh.metadata.terrainNode = node;
        }

        this.activeTerrainMeshes.add(mesh);
        this._collisionMeshes.add(mesh);
        if (mesh.checkCollisions) {
            this._activeCollisionMeshes.add(mesh);
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
        mesh.checkCollisions = !!isActive;
        if (isActive) {
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
        this.buildQueue = [];
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
        this.buildQueue.length = 0;

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

        const requiredLod = Math.min(0, this.lodLevel); // require at least LOD 0 (or max available)
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

        const planetCenter = BABYLON.Vector3.Zero();
        const toFocus = focusPos.subtract(planetCenter);

        const lenSqFocus = toFocus.lengthSquared();
        if (lenSqFocus < 1e-6) {
            return true;
        }

        const lenFocus = Math.sqrt(lenSqFocus);
        if (lenFocus <= this.radius) {
            return true;
        }
        const invLenFocus = 1 / lenFocus;
        const nFocus = toFocus.scale(invLenFocus);
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

        node.lastBuiltLod = null;
    }

    _jobKey(node, lodLevel, revisionKey = "0:0") {
        const id = (node && node.id != null) ? node.id : "noid";
        return `${id}|lod:${lodLevel}|rev:${revisionKey}`;
    }

    _scheduleNodeRebuild(node, lodLevel, options = {}) {
        if (!node) return;

        const force = !!options.force;
        const revisionKey = `${this.carveRevision}:${this.biomeRevision}`;

        if (node.isCulled || node.isDepthCulled || node.isHorizonCulled) {
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
        if (this.lastCameraPosition) {
            const focusDir = this.lastCameraPosition.clone();
            if (focusDir.lengthSquared() > 0) focusDir.normalize();
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

        const key = this._jobKey(node, lodLevel, revisionKey);

        // If queued or currently building, skip.
        if (this.queuedJobKeys.has(key) || this.inFlightJobKeys.has(key)) return;

        const streamRevision = this._streamRevision ?? 0;
        const buildKey = `${node.id}|lod:${lodLevel}|rev:${streamRevision}`;
        node._wantedBuildKey = buildKey;

        this.queuedJobKeys.add(key);
        this.buildQueue.push({ node, lodLevel, revisionKey, buildKey, force, surfaceDist });
    }

    _updateQuadtree(focusPosition) {
        if (!this.rootNode) return;

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

        const focusDir = focusPosition.clone();
        if (focusDir.lengthSquared() > 0) {
            focusDir.normalize();
        }

        const maxSurfaceLodDist = this.lodRingRadii.r3;
        const maxDepth = maxSurfaceLodDist * 0.5;

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

            if (!this._isChunkAboveHorizon(node, focusPosition)) {
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

            // Ensure mesh is enabled if already built
            if (node.terrain && node.terrain.mesh) {
                node.terrain.mesh.setEnabled(true);
                this._tagColliderForTerrain(node.terrain, node.lastBuiltLod ?? node.level);
                this._registerActiveTerrainMesh(node.terrain.mesh, node);
            }

            if (node.terrain?.mesh) {
                const mesh = node.terrain.mesh;
                const collisionCullDist = this.lodRingRadii.rcull + this.cullHysteresis;
                if (surfaceDist > collisionCullDist) {
                    mesh.checkCollisions = false;
                    this._activeCollisionMeshes.delete(mesh);
                }
            }
        }

        this.activeLeaves = newLeaves;
        this._activeLeafSet = new Set(newLeaves);
        this.lastLodStats = stats;

        // Queue builds for any leaves that need them (progressive refinement)
        for (const leaf of newLeaves) {
            this._ensureTerrainForNode(leaf);
        
            const desiredLod = leaf.level;               // leaf.level is your stabilized target
            const built = (leaf.lastBuiltLod ?? null);   // null means never built
        
            // First time this leaf becomes visible: build LOD 1 first (fast), then refine.
            if (built === null) {
                const coarse = Math.min(this.initialCoarseLod ?? 1, desiredLod);
        
                this._scheduleNodeRebuild(leaf, coarse, {});
        
                if (desiredLod > coarse) {
                    this._scheduleNodeRebuild(leaf, desiredLod, {});
                }
        
                continue;
            }
        
            // Already built: only upgrade progressively (no downgrades here)
            if (desiredLod > built) {
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
        if (!this.initialBuildDone && this.buildQueue.length > 0) {
            const pendingJobs = this.buildQueue.length + this.initialBuildCompleted;
            if (pendingJobs > this.initialBuildTotal) {
                this.initialBuildTotal = pendingJobs;
            }
        }
    }


    _processBuildQueue(maxPerFrame = 1) {
        // Legacy signature kept; internally we use a time budget.
        this._processBuildQueueBudgeted(this.buildBudgetMs);
    }

    _processBuildQueueBudgeted(budgetMs = this.buildBudgetMs) {
        const start = (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        const nowMs = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
        const maxDepth = this.lodRingRadii.r3 * 0.5;

        // Respect async concurrency limit
        if (this.activeBuilds >= this.maxConcurrentBuilds) return;

        while (this.buildQueue.length > 0) {
            if (nowMs() - start >= budgetMs) return;
            if (this.activeBuilds >= this.maxConcurrentBuilds) return;

            const job = this.buildQueue.shift();
            if (!job || !job.node) continue;

            const node = job.node;
            if (node.isCulled || node.isDepthCulled || node.isHorizonCulled) {
                const revisionKey = job.revisionKey ?? `${this.carveRevision}:${this.biomeRevision}`;
                const key = this._jobKey(node, job.lodLevel, revisionKey);
                this.queuedJobKeys.delete(key);
                this._recordDroppedBuild("culled");
                continue;
            }
            if (!this._withinDepthCap(node, maxDepth)) {
                console.warn("LEAK build outside depth cap", { nodeId: node.id, lodLevel: job.lodLevel });
                const revisionKey = job.revisionKey ?? `${this.carveRevision}:${this.biomeRevision}`;
                const key = this._jobKey(node, job.lodLevel, revisionKey);
                this.queuedJobKeys.delete(key);
                this._recordDroppedBuild("depth");
                continue;
            }
            if (this.lastCameraPosition && !this._isChunkAboveHorizon(node, this.lastCameraPosition)) {
                console.warn("LEAK build below horizon", { nodeId: node.id, lodLevel: job.lodLevel });
                node.isHorizonCulled = true;
                const revisionKey = job.revisionKey ?? `${this.carveRevision}:${this.biomeRevision}`;
                const key = this._jobKey(node, job.lodLevel, revisionKey);
                this.queuedJobKeys.delete(key);
                this._recordDroppedBuild("horizon");
                continue;
            }
            if (this.lastCameraPosition) {
                const focusDir = this.lastCameraPosition.clone();
                if (focusDir.lengthSquared() > 0) focusDir.normalize();
                const surfaceDist = this._surfaceDistanceForNode(focusDir, node);
                if (surfaceDist > this.lodRingRadii.rcull + 1) {
                    console.warn("LEAK build outside Rcull", { nodeId: node.id, lodLevel: job.lodLevel, surfaceDist });
                    const revisionKey = job.revisionKey ?? `${this.carveRevision}:${this.biomeRevision}`;
                    const key = this._jobKey(node, job.lodLevel, revisionKey);
                    this.queuedJobKeys.delete(key);
                    this._recordDroppedBuild("rcull");
                    continue;
                }
            }
            const revisionKey = job.revisionKey ?? `${this.carveRevision}:${this.biomeRevision}`;
            const key = this._jobKey(node, job.lodLevel, revisionKey);

            // This job is no longer queued
            this.queuedJobKeys.delete(key);

            // Ensure terrain instance exists
            this._ensureTerrainForNode(node);

            // If already built for this revision & LOD (unless forced), skip
            if (!job.force && node.lastBuiltLod === job.lodLevel && node.lastBuiltRevision === revisionKey) {
                continue;
            }

            // Prevent duplicates while in-flight
            if (this.inFlightJobKeys.has(key)) continue;
            this.inFlightJobKeys.add(key);

            this.activeBuilds++;

            const jobStartMs = nowMs();
            const finishOk = (result) => {
                if (result?.applied === false) {
                    this.inFlightJobKeys.delete(key);
                    this.activeBuilds = Math.max(0, this.activeBuilds - 1);
                    return;
                }

                node.lastBuiltLod = job.lodLevel;
                node.lastBuiltRevision = revisionKey;

                this._tagColliderForTerrain(node.terrain, job.lodLevel);
                this._registerActiveTerrainMesh(node.terrain?.mesh, node);
                this._onChunkBuilt();
                this._recordBuildDuration(nowMs() - jobStartMs);

                this.inFlightJobKeys.delete(key);
                this.activeBuilds = Math.max(0, this.activeBuilds - 1);
            };

            const finishErr = (err) => {
                console.error("Chunk rebuild failed:", err);
                this.inFlightJobKeys.delete(key);
                this.activeBuilds = Math.max(0, this.activeBuilds - 1);
            };

            const lodDims = this._computeLodDimensions(job.lodLevel, node);

            let maybePromise;
            try {
                maybePromise = node.terrain.rebuildWithSettings({
                    origin: new BABYLON.Vector3(node.bounds.minX, node.bounds.minY, node.bounds.minZ),
                    dimX: lodDims.dimX,
                    dimY: lodDims.dimY,
                    dimZ: lodDims.dimZ,
                    cellSize: lodDims.cellSize,
                    carves: this._collectCarvesForNode(node),
                    biomeSettings: this.biomeSettings,
                    buildKey: job.buildKey ?? null,
                    shouldApplyResult: (result) => {
                        if (node._wantedBuildKey !== result.buildKey) {
                            this._recordDroppedBuild("staleResult");
                            return false;
                        }
                        return true;
                    }
                });
            } catch (e) {
                finishErr(e);
                continue;
            }

            if (maybePromise && typeof maybePromise.then === "function") {
                maybePromise.then(finishOk).catch(finishErr);
            } else {
                finishOk(maybePromise);
            }
        }
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

        this.buildQueue = [];
        this._initializeQuadtree();
    }

    updateStreaming(focusPosition) {
        this.lodUpdateCounter++;
        this._streamRevision = (this._streamRevision ?? 0) + 1;
        if (focusPosition) {
            this.lastCameraPosition = focusPosition.clone
                ? focusPosition.clone()
                : new BABYLON.Vector3(
                      focusPosition.x,
                      focusPosition.y,
                      focusPosition.z
                  );
        }

        if (this.lastCameraPosition) {
            this._updateQuadtree(this.lastCameraPosition);
        }

        this._processBuildQueue();
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

        if (!this.initialBuildDone && this.buildQueue.length > 0) {
            const pendingJobs = this.buildQueue.length + this.initialBuildCompleted;
            if (pendingJobs > this.initialBuildTotal) {
                this.initialBuildTotal = pendingJobs;
            }
        }
    }

    getLodStats() {
        return this.lastLodStats;
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
        const focusDir = focusPos ? focusPos.clone() : null;
        if (focusDir && focusDir.lengthSquared() > 0) {
            focusDir.normalize();
        }

        const rcull = this.lodRingRadii.rcull;
        const maxDepth = this.lodRingRadii.r3 * 0.5;
        const allowedMin = this.radius - maxDepth;
        const depthMargin = this.depthCullHysteresis;

        const getMeshCenter = (mesh) => {
            const boundingCenter = mesh?.getBoundingInfo?.().boundingSphere?.centerWorld;
            return boundingCenter ?? mesh?.position ?? null;
        };

        const surfaceDistanceForMesh = (mesh) => {
            if (!focusDir) return Infinity;
            const node = mesh?.metadata?.terrainNode;
            if (node) {
                return this._surfaceDistanceForNode(focusDir, node);
            }
            const center = getMeshCenter(mesh);
            if (!center) return Infinity;
            const dir = center.clone();
            if (dir.lengthSquared() < 1e-6) return Infinity;
            dir.normalize();
            const dot = BABYLON.Vector3.Dot(dir, focusDir);
            const clamped = Math.max(-1, Math.min(1, dot));
            const angle = Math.acos(clamped);
            return this.radius * angle;
        };

        const meshBelowHorizon = (mesh) => {
            if (!focusPos) return false;
            const node = mesh?.metadata?.terrainNode;
            if (node) {
                return !this._isChunkAboveHorizon(node, focusPos);
            }
            const center = getMeshCenter(mesh);
            if (!center) return false;
            const toFocus = focusPos.clone();
            const lenFocusSq = toFocus.lengthSquared();
            if (lenFocusSq < 1e-6) return false;
            const lenFocus = Math.sqrt(lenFocusSq);
            if (lenFocus <= this.radius) return false;
            toFocus.scaleInPlace(1 / lenFocus);
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
        }

        for (const mesh of this._activeCollisionMeshes) {
            if (!mesh || !mesh.isEnabled?.()) continue;
            const surfaceDist = surfaceDistanceForMesh(mesh);
            if (surfaceDist > rcull) {
                collidableOutsideRcull++;
            }
        }

        if (focusDir) {
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
        if (focusDir && focusPos) {
            for (const job of this.buildQueue) {
                const node = job?.node;
                if (!node) continue;
                const surfaceDist = this._surfaceDistanceForNode(focusDir, node);
                if (surfaceDist > rcull) {
                    buildJobsQueuedOutsideRcull++;
                }
                if (!this._isChunkAboveHorizon(node, focusPos)) {
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
        for (const sample of this._buildDropSamples) {
            if (sample.t < cutoff) continue;
            if (sample.reason === "rcull") buildJobsDroppedOutsideRcull++;
            if (sample.reason === "horizon") buildJobsDroppedBelowHorizon++;
            if (sample.reason === "depth") buildJobsDroppedTooDeep++;
            if (sample.reason === "culled") buildJobsDroppedCulled++;
            if (sample.reason === "staleResult") buildJobsDroppedStaleResult++;
        }

        return {
            enabledMeshes: enabledMeshes.length,
            enabledCollidableMeshes: enabledCollidable,
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
            renderSetCount: this.lastLodStats.totalVisible ?? 0,
            totalLeafCandidates: this.lastLodStats.totalLeafCandidates ?? 0,
            totalLeafVisible: this.lastLodStats.totalLeafVisible ?? 0,
            culledCount: this.lastLodStats.culledByDistance ?? 0,
            depthCulledCount: this.lastLodStats.culledByDepth ?? 0,
            horizonCulledCount: this.lastLodStats.culledByHorizon ?? 0,
            perLodCounts: [...(this.lastLodStats.perLod || [])],
            maxLodInUse: this.lastLodStats.maxLodInUse ?? 0,
            buildQueueLength: this.buildQueue.length,
            activeBuilds: this.activeBuilds,
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
            buildQueueLength: this.buildQueue.length,
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
        const meshes = [];
        for (const mesh of this._activeCollisionMeshes) {
            if (!mesh || !mesh.isEnabled?.()) continue;
            meshes.push(mesh);
        }
        return meshes;
    }

    getKnownCollisionMeshes() {
        const meshes = [];
        for (const mesh of this._collisionMeshes) {
            if (!mesh || mesh.isDisposed?.()) continue;
            meshes.push(mesh);
        }
        return meshes;
    }

    getCollisionMeshes() {
        return this.getActiveCollisionMeshes();
    }
}
