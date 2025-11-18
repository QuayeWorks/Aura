// src/terrain/ChunkedPlanetTerrain.js
import { MarchingCubesTerrain } from "./MarchingCubesTerrain.js";

export class ChunkedPlanetTerrain {
    constructor(scene, options = {}) {
        this.scene = scene;

        // How many chunks along X/Z
        this.chunkCountX = options.chunkCountX ?? 3;
        this.chunkCountZ = options.chunkCountZ ?? 3;

        // Base resolution of a chunk (cells along X/Z at highest LOD)
        this.baseChunkResolution = options.baseChunkResolution ?? 32;

        // Vertical resolution
        this.baseDimY = options.dimY ?? 32;

        this.cellSize = options.cellSize ?? 1.0;
        this.isoLevel = options.isoLevel ?? 0.0;
        this.radius = options.radius ?? 18.0;

        // Noise parameters forwarded to MarchingCubesTerrain
        this.enableNoise   = options.enableNoise   ?? true;
        this.continentFreq = options.continentFreq ?? 0.6;
        this.continentAmp  = options.continentAmp  ?? 0.12;
        this.mountainFreq  = options.mountainFreq  ?? 3.0;
        this.mountainAmp   = options.mountainAmp   ?? 0.04;

        // Global LOD level: 2 = high, 1 = medium, 0 = low
        this.lodLevel = 2;

        // Shared material for all chunks
        this.material = new BABYLON.StandardMaterial("planetTerrainMat", this.scene);
        this.material.diffuseColor = new BABYLON.Color3(0.2, 0.9, 0.35);
        this.material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        this.material.backFaceCulling = false;

        // All chunks (entries: { ix, iz, lodLevel, terrain, center })
        this.chunks = [];

        // Persisted carve operations
        this.carveHistory = [];

        // Cached per-chunk size (for reference)
        this.chunkWorldSizeX = 0;
        this.chunkWorldSizeZ = 0;

        // Last camera position (for gravity/orientation helpers etc.)
        this._lastCameraPos = null;

        // Build initial grid
        this._rebuildChunks();
    }

    // ---------------------------------------------------------------------
    // LOD parameter helper
    // ---------------------------------------------------------------------

    _computeLodParams(lodLevel) {
        const clamped = Math.max(0, Math.min(2, Math.round(lodLevel)));
        const lodFactor = clamped === 2 ? 1 : (clamped === 1 ? 2 : 4);

        const dimX = Math.max(6, Math.floor(this.baseChunkResolution / lodFactor));
        const dimZ = dimX;
        const dimY = this.baseDimY;

        const cellSizeLod = this.cellSize * lodFactor;

        const chunkWidth  = (dimX - 1) * cellSizeLod;
        const chunkDepth  = (dimZ - 1) * cellSizeLod;
        const chunkHeight = (dimY - 1) * cellSizeLod;

        return {
            lodLevel: clamped,
            lodFactor,
            dimX,
            dimY,
            dimZ,
            cellSizeLod,
            chunkWidth,
            chunkDepth,
            chunkHeight
        };
    }

    // ---------------------------------------------------------------------
    // Chunk management
    // ---------------------------------------------------------------------

    _disposeChunks() {
        for (const entry of this.chunks) {
            if (entry.terrain && entry.terrain.mesh) {
                entry.terrain.mesh.dispose();
            }
        }
        this.chunks = [];
    }

    _createChunkEntry(ix, iz, lodParams) {
        const {
            dimX,
            dimY,
            dimZ,
            cellSizeLod,
            chunkWidth,
            chunkDepth,
            chunkHeight
        } = lodParams;

        // Total size of grid in X/Z
        const totalWidth  = this.chunkCountX * chunkWidth;
        const totalDepth  = this.chunkCountZ * chunkDepth;

        // Origin so that grid is centered at world origin
        const originX = -totalWidth * 0.5 + ix * chunkWidth;
        const originZ = -totalDepth * 0.5 + iz * chunkDepth;
        const originY = -chunkHeight * 0.5;

        const origin = new BABYLON.Vector3(originX, originY, originZ);

        const terrain = new MarchingCubesTerrain(this.scene, {
            dimX,
            dimY,
            dimZ,
            cellSize: cellSizeLod,
            isoLevel: this.isoLevel,
            radius: this.radius,
            origin,
            material: this.material,
            enableNoise: this.enableNoise,
            continentFreq: this.continentFreq,
            continentAmp: this.continentAmp,
            mountainFreq: this.mountainFreq,
            mountainAmp: this.mountainAmp
        });

        // Ensure shared material
        if (terrain.mesh) {
            terrain.mesh.material = this.material;
        }

        // Replay previous carves on this chunk
        for (const op of this.carveHistory) {
            terrain.carveSphere(op.position, op.radius);
        }

        const center = origin.add(new BABYLON.Vector3(
            chunkWidth * 0.5,
            chunkHeight * 0.5,
            chunkDepth * 0.5
        ));

        return {
            ix,
            iz,
            lodLevel: lodParams.lodLevel,
            terrain,
            center
        };
    }

    _rebuildChunks() {
        this._disposeChunks();

        const lodParams = this._computeLodParams(this.lodLevel);
        const { chunkWidth, chunkDepth } = lodParams;

        this.chunkWorldSizeX = chunkWidth;
        this.chunkWorldSizeZ = chunkDepth;

        for (let ix = 0; ix < this.chunkCountX; ix++) {
            for (let iz = 0; iz < this.chunkCountZ; iz++) {
                const entry = this._createChunkEntry(ix, iz, lodParams);
                this.chunks.push(entry);
            }
        }
    }

    // ---------------------------------------------------------------------
    // Public API
    // ---------------------------------------------------------------------

    // LOD: 0 (low), 1 (medium), 2 (high) – rebuilds entire grid
    setLodLevel(level) {
        const clamped = Math.max(0, Math.min(2, Math.round(level)));
        if (clamped === this.lodLevel) {
            return;
        }
        this.lodLevel = clamped;
        this._rebuildChunks();
    }

    // Called from main render loop; static grid for now
    updateStreaming(cameraPosition) {
        this._lastCameraPos = cameraPosition
            ? (cameraPosition.clone ? cameraPosition.clone() : cameraPosition)
            : null;
        // No streaming / LOD rings yet – just a hook.
    }

    // Shared material (if you ever want to tweak uniforms externally)
    get materialRef() {
        return this.material;
    }

    // Gravity direction (toward origin)
    getGravityDirection(worldPos) {
        if (!worldPos) {
            return new BABYLON.Vector3(0, -1, 0);
        }
        const dir = worldPos.clone();
        if (dir.lengthSquared() === 0) {
            return new BABYLON.Vector3(0, -1, 0);
        }
        return dir.normalize().scale(-1);
    }

    // "Up" direction (away from origin)
    getSurfaceUp(worldPos) {
        if (!worldPos) {
            return new BABYLON.Vector3(0, 1, 0);
        }
        const dir = worldPos.clone();
        if (dir.lengthSquared() === 0) {
            return new BABYLON.Vector3(0, 1, 0);
        }
        return dir.normalize();
    }

    // Destruction API – persists across LOD changes / rebuilds
    carveSphere(worldPos, radius) {
        const posCopy = worldPos.clone ? worldPos.clone() : worldPos;
        this.carveHistory.push({
            position: posCopy,
            radius
        });

        for (const entry of this.chunks) {
            entry.terrain.carveSphere(posCopy, radius);
        }
    }

    // Optional: runtime config update (if you still use it)
    updateConfig({
        chunkCountX,
        chunkCountZ,
        baseChunkResolution,
        dimY,
        cellSize,
        isoLevel
    } = {}) {
        if (chunkCountX !== undefined) {
            this.chunkCountX = Math.max(1, Math.round(chunkCountX));
        }
        if (chunkCountZ !== undefined) {
            this.chunkCountZ = Math.max(1, Math.round(chunkCountZ));
        }
        if (baseChunkResolution !== undefined) {
            this.baseChunkResolution = Math.max(6, Math.round(baseChunkResolution));
        }
        if (dimY !== undefined) {
            this.baseDimY = Math.max(8, Math.round(dimY));
        }
        if (cellSize !== undefined) {
            this.cellSize = Math.max(0.1, cellSize);
        }
        if (isoLevel !== undefined) {
            this.isoLevel = isoLevel;
        }

        this._rebuildChunks();
    }
}
