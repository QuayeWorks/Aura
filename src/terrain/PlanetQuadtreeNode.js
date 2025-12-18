/* global BABYLON */

/**
 * Quadtree node representing a square patch on the planet surface.
 * Nodes subdivide in X/Z only (Y span stays constant for now) so we can
 * adaptively refine near the focus position while keeping the gameplay API
 * unchanged.
 */
export class PlanetQuadtreeNode {
    constructor(level, bounds, parent = null) {
        this.level = level;
        this.bounds = bounds; // { minX, maxX, minY, maxY, minZ, maxZ }
        this.parent = parent;
        this.children = [];

        // Terrain + build state
        this.terrain = null;                 // MarchingCubesTerrain instance when leaf
        this.lastBuiltLod = null;             // LOD actually built on GPU
        this.currentLod = null;               // LOD currently considered "active"
        this.targetLod = null;                // LOD streaming system wants
        this.isBuilding = false;              // Prevent duplicate rebuilds

        // Stability / anti-thrash
        this.lastLodChangeFrame = 0;
        this.lastStableSurfaceDist = Infinity;
        this.stableLod = null;

        // Lifetime tracking (LRU / residency)
        this.lastTouchedFrame = 0;
    }


    isLeaf() {
        return this.children.length === 0;
    }

    getCenterWorldPosition() {
        const cx = (this.bounds.minX + this.bounds.maxX) * 0.5;
        const cy = (this.bounds.minY + this.bounds.maxY) * 0.5;
        const cz = (this.bounds.minZ + this.bounds.maxZ) * 0.5;
        return new BABYLON.Vector3(cx, cy, cz);
    }

    subdivide() {
        if (!this.isLeaf()) {
            return this.children;
        }

        const midX = (this.bounds.minX + this.bounds.maxX) * 0.5;
        const midZ = (this.bounds.minZ + this.bounds.maxZ) * 0.5;

        const minY = this.bounds.minY;
        const maxY = this.bounds.maxY;
        const nextLevel = this.level + 1;

        this.children = [
            new PlanetQuadtreeNode(nextLevel, {
                minX: this.bounds.minX,
                maxX: midX,
                minY,
                maxY,
                minZ: this.bounds.minZ,
                maxZ: midZ
            }, this),
            new PlanetQuadtreeNode(nextLevel, {
                minX: midX,
                maxX: this.bounds.maxX,
                minY,
                maxY,
                minZ: this.bounds.minZ,
                maxZ: midZ
            }, this),
            new PlanetQuadtreeNode(nextLevel, {
                minX: this.bounds.minX,
                maxX: midX,
                minY,
                maxY,
                minZ: midZ,
                maxZ: this.bounds.maxZ
            }, this),
            new PlanetQuadtreeNode(nextLevel, {
                minX: midX,
                maxX: this.bounds.maxX,
                minY,
                maxY,
                minZ: midZ,
                maxZ: this.bounds.maxZ
            }, this)
        ];

        return this.children;
    }

    mergeChildren(onReleaseTerrain) {
        if (this.isLeaf()) return;

        for (const child of this.children) {
            if (child.terrain) {
                onReleaseTerrain?.(child);
            }

            // Fully reset child state
            child.terrain = null;
            child.children = [];
            child.isBuilding = false;
            child.lastBuiltLod = null;
            child.currentLod = null;
            child.targetLod = null;
            child.stableLod = null;
        }

        this.children = [];
    }

}
