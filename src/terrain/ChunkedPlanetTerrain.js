/* global BABYLON */
import { MarchingCubesTerrain } from "./MarchingCubesTerrain.js";
import { PlanetQuadtreeNode } from "./PlanetQuadtreeNode.js";

export class ChunkedPlanetTerrain {
    constructor(scene, options = {}) {
        this.scene = scene;
        this.maxBuildDistance = 34000;

        // Legacy grid options kept for compatibility with callers / HUD
        this.chunkCountX = options.chunkCountX ?? 3;
        this.chunkCountZ = options.chunkCountZ ?? 3;

        this.baseChunkResolution = options.baseChunkResolution ?? 128;

        // Vertical resolution parameters
        this.cellSize = options.cellSize ?? 1.0;
        this.isoLevel = options.isoLevel ?? 0.0;
        this.radius = options.radius ?? 18.0;

        const neededY = Math.ceil((this.radius * 2) / this.cellSize) + 4;
        this.baseDimY = options.dimY ?? neededY;

        this.lodLevel = options.lodLevel ?? 5;

        this.colliderLodThreshold = options.colliderLodThreshold ?? 5;
        this.colliderEnableDistance =
            options.colliderEnableDistance ?? this.radius * 0.12;

        // Shared terrain material across all leaves
        this.material = new BABYLON.StandardMaterial("terrainSharedMat", this.scene);
        this.material.diffuseColor = new BABYLON.Color3(0.2, 0.9, 0.35);
        this.material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        this.material.backFaceCulling = true;

        this.meshPool = [];
        this.terrainPool = [];
        this.buildQueue = [];
        this.carveHistory = [];

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

        this.lastLodStats = {
            totalVisible: 0,
            perLod: [0, 0, 0, 0, 0, 0],
            maxLodInUse: 0
        };

        this.lodUpdateCounter = 0;
        this.lodChangeCooldownFrames =
            options.lodChangeCooldownFrames ?? 30;

        // Quadtree state
        this.rootNode = null;
        this.activeLeaves = [];

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
        // dist here is *surface distance along the planet*, in world units.
    _lodForDistance(dist) {
        // Approximate size of a base chunk at the equator.
        // For your settings this is ~23,700 units.
        const baseSize =
            this.maxBuildDistance ||
            (this.radius ? this.radius * 2.0 : 10000);

        let desiredLevel;

        // Tight high-detail ring around the player.
        if (dist < baseSize * 0.05) {          // closest area
            desiredLevel = 5;
        } else if (dist < baseSize * 0.15) {    // still quite near
            desiredLevel = 4;
        } else if (dist < baseSize * 0.45) {    // within ~one base chunk
            desiredLevel = 3;
        } else if (dist < baseSize * 0.9) {    // mid-distance
            desiredLevel = 2;
        } else if (dist < baseSize * 1.0) {    // far but still on-screen
            desiredLevel = 1;
        } else {
            desiredLevel = 0;                  // horizon / far side
        }

        // Never request more detail than the global max LOD.
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
    }

    _releaseNodeTerrain(node) {
        if (!node || !node.terrain) return;
        const terrain = node.terrain;
        if (terrain.mesh) {
            terrain.mesh.setEnabled(false);
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

        this.chunkOverlap = this.cellSize;

        // Create a fresh root node; no children yet
        this.rootNode = this._createRootNode();
        this.activeLeaves = [this.rootNode];

        // Reset build bookkeeping
        this.buildQueue.length = 0;

        // Initial build tracking – nothing queued yet
        this.initialBuildTotal = 0;
        this.initialBuildCompleted = 0;
        this.initialBuildDone = false;
    }


    _onChunkBuilt() {
        // If we've already fired the callback, don't do anything.
        if (this.initialBuildDone) {
            return;
        }

        const stats = this.lastLodStats;
        const targetLod = Math.min(3, this.lodLevel); // require LOD >= 3
        const total = stats.totalVisible;

        if (!total) {
            return;
        }

        let highLodCount = 0;
        for (let l = targetLod; l < stats.perLod.length; l++) {
            highLodCount += stats.perLod[l];
        }

        // Only when *all* visible chunks are LOD >= 3 do we finish.
        if (highLodCount === total) {
            this.initialBuildDone = true;
            if (typeof this.onInitialBuildDone === "function") {
                this.onInitialBuildDone();
            }
        }
    }



    getInitialBuildProgress() {
        const stats = this.lastLodStats;
        const targetLod = Math.min(3, this.lodLevel); // we care about LOD >= 3
        const total = stats.totalVisible;

        if (!total) return 0;

        let highLodCount = 0;
        for (let l = targetLod; l < stats.perLod.length; l++) {
            highLodCount += stats.perLod[l];
        }

        // Fraction of visible chunks that are at LOD >= 3
        return highLodCount / total;
    }



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

        return dot >= 0;
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
                deferBuild: true,
                useWorker: true
            });
        }

        node.lastBuiltLod = null;
    }

    _scheduleNodeRebuild(node, lodLevel, meshOnly = false) {
        this.buildQueue.push({
            node,
            lodLevel,
            meshOnly
        });
    }

    _updateQuadtree(focusPosition) {
        if (!this.rootNode) return;

        const stats = {
            totalVisible: 0,
            perLod: [0, 0, 0, 0, 0, 0],
            maxLodInUse: 0
        };

        const stack = [this.rootNode];
        const newLeaves = [];

        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;

            const center = node.getCenterWorldPosition();

            // Straight-line distance (for view culling)
            const centerDist = BABYLON.Vector3.Distance(focusPosition, center);
            const onNearSide = this._isChunkOnNearHemisphere(
                center,
                focusPosition
            );
            const withinView = this._isWithinViewDistance(centerDist);

            if (!onNearSide || !withinView) {
                if (node.terrain && node.terrain.mesh) {
                    node.terrain.mesh.setEnabled(false);
                }
                // No further refinement when not visible
                continue;
            }

            // --- Surface distance along the sphere (arc length) ---
            let surfaceDist = centerDist;
            const planetCenter = BABYLON.Vector3.Zero();
            const toChunk = center.subtract(planetCenter);
            const toFocus = focusPosition.subtract(planetCenter);
            const lenChunk = toChunk.length();
            const lenFocus = toFocus.length();

            if (lenChunk > 1e-3 && lenFocus > 1e-3) {
                const dot =
                    BABYLON.Vector3.Dot(toChunk, toFocus) /
                    (lenChunk * lenFocus);
                const clampedDot = Math.max(-1, Math.min(1, dot));
                const angle = Math.acos(clampedDot); // radians
                surfaceDist = this.radius * angle;
            }

            const desiredLod = this._lodForDistance(surfaceDist);
            const framesSinceChange =
                this.lodUpdateCounter - (node.lastLodChangeFrame ?? 0);
            const canChangeLod =
                framesSinceChange >= this.lodChangeCooldownFrames;

            const belowDesired =
                node.level < desiredLod && node.level < this.lodLevel;
            if (belowDesired && node.isLeaf() && canChangeLod) {
                // Subdivide and reuse the parent terrain later if possible
                this._releaseNodeTerrain(node);
                node.subdivide();
                node.lastLodChangeFrame = this.lodUpdateCounter;
                stack.push(...node.children);
                continue;
            }

            const aboveDesired = node.level > desiredLod && !node.isLeaf();
            if (aboveDesired && canChangeLod) {
                node.mergeChildren(this._releaseNodeTerrain.bind(this));
                node.lastLodChangeFrame = this.lodUpdateCounter;
            }

            if (!node.isLeaf()) {
                stack.push(...node.children);
                continue;
            }

            // Leaf that should be visible
            newLeaves.push(node);
            stats.totalVisible++;
            if (node.level >= 0 && node.level < stats.perLod.length) {
                stats.perLod[node.level]++;
                if (node.level > stats.maxLodInUse) {
                    stats.maxLodInUse = node.level;
                }
            }

            // Ensure mesh is enabled if already built
            if (node.terrain && node.terrain.mesh) {
                node.terrain.mesh.setEnabled(true);
            }
        }

        this.activeLeaves = newLeaves;
        this.lastLodStats = stats;

        // Queue builds for any leaves that need them
        for (const leaf of newLeaves) {
            this._ensureTerrainForNode(leaf);
            const targetLod = leaf.level;
            if (leaf.lastBuiltLod !== targetLod) {
                this._scheduleNodeRebuild(leaf, targetLod, false);
            }
        }

        if (
            !this.initialBuildDone &&
            this.initialBuildTotal === 0 &&
            this.buildQueue.length > 0
        ) {
            this.initialBuildTotal = this.buildQueue.length;
            this.initialBuildCompleted = 0;
        }
    }


    _processBuildQueue(maxPerFrame = 1) {
        let count = 0;
        while (count < maxPerFrame && this.buildQueue.length > 0) {
            const job = this.buildQueue.shift();
            if (!job || !job.node) {
                continue;
            }

            const node = job.node;

            this._ensureTerrainForNode(node);

            if (job.meshOnly) {
                node.terrain.rebuildMeshOnly();
                this._tagColliderForTerrain(node.terrain, job.lodLevel);
                this._onChunkBuilt();
                count++;
                continue;
            }

            const lodDims = this._computeLodDimensions(job.lodLevel, node);
            const maybePromise = node.terrain.rebuildWithSettings({
                origin: new BABYLON.Vector3(node.bounds.minX, node.bounds.minY, node.bounds.minZ),
                dimX: lodDims.dimX,
                dimY: lodDims.dimY,
                dimZ: lodDims.dimZ,
                cellSize: lodDims.cellSize
            });

            const finish = () => {
                node.lastBuiltLod = job.lodLevel;
                this._applyRelevantCarvesToNode(node);
                this._tagColliderForTerrain(node.terrain, job.lodLevel);
                this._onChunkBuilt();
            };

            if (maybePromise && typeof maybePromise.then === "function") {
                maybePromise.then(finish).catch((err) => {
                    console.error("Chunk rebuild failed:", err);
                });
            } else {
                finish();
            }

            count++;
        }
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
        if (!this.carveHistory.length || !node || !node.terrain) return;

        let touched = false;
        for (const op of this.carveHistory) {
            if (!this._nodeIntersectsSphere(node, op.position, op.radius)) {
                continue;
            }
            node.terrain.carveSphere(op.position, op.radius, { deferRebuild: true });
            touched = true;
        }

        if (touched) {
            node.terrain.rebuildMeshOnly();
        }
    }

    // -------------------------------------------------
    // Public API used by main.js
    // -------------------------------------------------

    setLodLevel(level) {
        const clamped = Math.max(0, Math.min(5, Math.round(level)));
        if (clamped === this.lodLevel) return;
        this.lodLevel = clamped;

        this.buildQueue = [];
        this._initializeQuadtree();
    }

    updateStreaming(focusPosition) {
        this.lodUpdateCounter++;
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
        this.carveHistory.push({
            position: worldPos.clone ? worldPos.clone() : worldPos,
            radius
        });

        const intersectingLeaves = [];
        const stack = [this.rootNode];
        while (stack.length > 0) {
            const node = stack.pop();
            if (!node) continue;
            if (!this._nodeIntersectsSphere(node, worldPos, radius)) {
                continue;
            }
            if (node.isLeaf()) {
                intersectingLeaves.push(node);
            } else {
                stack.push(...node.children);
            }
        }

        for (const leaf of intersectingLeaves) {
            this._ensureTerrainForNode(leaf);
            leaf.terrain.carveSphere(worldPos, radius, { deferRebuild: true });
            this.buildQueue.push({
                node: leaf,
                lodLevel: leaf.level,
                meshOnly: true
            });
        }
    }

    getLodStats() {
        return this.lastLodStats;
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
            worldSpan: this.worldSpan
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
}
