// src/terrain/PlanetQuadtreeTerrain.js
// Spherical quadtree planet surface with adaptive patch LOD.
// First-pass "safe" version: always keeps some patches visible so you never
// get an empty scene. We can tighten culling later once it's stable.

export class PlanetQuadtreeTerrain {
    /**
     * @param {BABYLON.Scene} scene
     * @param {object} options
     *   - radius: planet radius in world units
     *   - patchResolution: vertices per edge of a patch (e.g. 33)
     *   - maxLevel: maximum quadtree depth
     */
    constructor(scene, options = {}) {
        this.scene = scene;

        this.radius = options.radius ?? 32400;
        this.patchResolution = options.patchResolution ?? 33;
        this.maxLevel = options.maxLevel ?? 6;

        // Controls how aggressively we refine; 0..5 from Settings
        this.lodErrorScale = options.lodErrorScale ?? 1.0;

        // Shared material
        this.material = new BABYLON.StandardMaterial("planetQuadMat", this.scene);
        this.material.diffuseColor = new BABYLON.Color3(0.2, 0.9, 0.35);
        this.material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        this.material.backFaceCulling = false;

        // 6 cube faces → roots of quadtree
        this.roots = [];

        // Stats for HUD
        this.lastStats = {
            totalPatches: 0,
            activePatches: 0,
            perLevel: []
        };

        // Simple initial-build flags for loading UI
        this.initialBuildTotal = 6;
        this.initialBuildCompleted = 0;
        this.initialBuildDone = false;
        this.onInitialBuildDone = null;

        // Build root patches
        for (let face = 0; face < 6; face++) {
            const root = this._createNode(face, -1, 1, -1, 1, 0);
            this.roots.push(root);
        }

        this._rebuildStats();
        this.initialBuildCompleted = this.initialBuildTotal;
        this.initialBuildDone = true;
    }

    // -------------------- Public API for main.js --------------------

    getInitialBuildProgress() {
        if (this.initialBuildTotal === 0) return 1;
        return this.initialBuildCompleted / this.initialBuildTotal;
    }

    /**
     * Call every frame with player or camera position.
     */
    updateStreaming(focusPosition) {
        if (!focusPosition) return;

        const focus = focusPosition.clone
            ? focusPosition.clone()
            : new BABYLON.Vector3(focusPosition.x, focusPosition.y, focusPosition.z);

        for (const root of this.roots) {
            this._updateNodeLOD(root, focus);
        }

        this._rebuildStats();
    }

    /**
     * Return debug info in a shape that main.js HUD understands.
     */
    getDebugInfo(focusPosition) {
        const stats = this.lastStats;
        const info = {
            chunkCountX: -1,
            chunkCountZ: -1,
            baseChunkResolution: this.patchResolution,
            lodCap: this.maxLevel,
            lodStats: {
                totalVisible: stats.activePatches,
                perLod: stats.perLevel,
                maxLodInUse: stats.perLevel.length - 1
            },
            nearestChunk: null
        };

        if (!focusPosition) return info;

        let bestNode = null;
        let bestDist = Infinity;

        for (const root of this.roots) {
            this._findNearestLeaf(root, focusPosition, (node, dist) => {
                if (dist < bestDist) {
                    bestDist = dist;
                    bestNode = node;
                }
            });
        }

        if (bestNode) {
            info.nearestChunk = {
                lodLevel: bestNode.level,
                dimX: this.patchResolution,
                dimZ: this.patchResolution,
                distance: bestDist
            };
        }

        return info;
    }

    /**
     * Settings slider hook: 0 (low) .. 5 (high).
     */
    setLodQuality(level) {
        const v = Math.max(0, Math.min(5, Math.round(level)));
        // 0 → 0.6, 5 → 1.6
        this.lodErrorScale = 0.6 + v * 0.2;
    }

    // -------------------- Quadtree core --------------------

    _createNode(face, u0, u1, v0, v1, level) {
        const node = {
            face,
            u0, u1, v0, v1,
            level,
            children: null,
            mesh: null,
            center: null,
            boundRadius: 0
        };

        this._buildNodeGeometry(node);
        return node;
    }

    _buildNodeGeometry(node) {
        const rs = this.patchResolution;
        const positions = [];
        const normals = [];
        const indices = [];

        const u0 = node.u0;
        const u1 = node.u1;
        const v0 = node.v0;
        const v1 = node.v1;

        const du = (u1 - u0) / (rs - 1);
        const dv = (v1 - v0) / (rs - 1);

        let minPos = new BABYLON.Vector3(
            Number.POSITIVE_INFINITY,
            Number.POSITIVE_INFINITY,
            Number.POSITIVE_INFINITY
        );
        let maxPos = new BABYLON.Vector3(
            Number.NEGATIVE_INFINITY,
            Number.NEGATIVE_INFINITY,
            Number.NEGATIVE_INFINITY
        );

        for (let j = 0; j < rs; j++) {
            const v = v0 + dv * j;
            for (let i = 0; i < rs; i++) {
                const u = u0 + du * i;

                // Cube → sphere direction
                const dir = this._cubeToSphere(node.face, u, v);

                // Height along that direction
                const height = this._sampleHeight(dir);
                const worldPos = dir.scale(this.radius + height);

                positions.push(worldPos.x, worldPos.y, worldPos.z);

                const normal = worldPos.normalize();
                normals.push(normal.x, normal.y, normal.z);

                // AABB for this patch
                minPos.x = Math.min(minPos.x, worldPos.x);
                minPos.y = Math.min(minPos.y, worldPos.y);
                minPos.z = Math.min(minPos.z, worldPos.z);
                maxPos.x = Math.max(maxPos.x, worldPos.x);
                maxPos.y = Math.max(maxPos.y, worldPos.y);
                maxPos.z = Math.max(maxPos.z, worldPos.z);
            }
        }

        // Triangles
        for (let j = 0; j < rs - 1; j++) {
            for (let i = 0; i < rs - 1; i++) {
                const i0 = j * rs + i;
                const i1 = i0 + 1;
                const i2 = i0 + rs;
                const i3 = i2 + 1;

                indices.push(i0, i2, i1);
                indices.push(i1, i2, i3);
            }
        }

        let mesh = node.mesh;
        if (!mesh) {
            mesh = new BABYLON.Mesh(
                `patch_l${node.level}_f${node.face}`,
                this.scene
            );
            mesh.checkCollisions = true;
            mesh.material = this.material;
            node.mesh = mesh;
        }

        const vertexData = new BABYLON.VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;
        vertexData.applyToMesh(mesh, true);

        // Approx bounding sphere
        const center = minPos.add(maxPos).scale(0.5);
        const radius = center.subtract(maxPos).length();

        node.center = center;
        node.boundRadius = radius;

        mesh.setEnabled(true);
        mesh.isVisible = true;
    }

    _disposeNode(node) {
        if (node.mesh) {
            node.mesh.dispose();
            node.mesh = null;
        }
        if (node.children) {
            for (const c of node.children) this._disposeNode(c);
            node.children = null;
        }
    }

    _subdivide(node) {
        if (node.level >= this.maxLevel) return;
        if (node.children) return;

        const { u0, u1, v0, v1 } = node;
        const umid = (u0 + u1) * 0.5;
        const vmid = (v0 + v1) * 0.5;
        const level = node.level + 1;

        node.children = [
            this._createNode(node.face, u0,  umid, v0,  vmid, level),
            this._createNode(node.face, umid, u1,  v0,  vmid, level),
            this._createNode(node.face, u0,  umid, vmid, v1,  level),
            this._createNode(node.face, umid, u1,  vmid, v1,  level)
        ];

        if (node.mesh) {
            node.mesh.isVisible = false;
        }
    }

    _merge(node) {
        if (!node.children) return;

        for (const child of node.children) {
            this._disposeNode(child);
        }
        node.children = null;

        if (!node.mesh) {
            this._buildNodeGeometry(node);
        } else {
            node.mesh.isVisible = true;
            node.mesh.setEnabled(true);
        }
    }

    _updateNodeLOD(node, focus) {
        if (!node.center) return;

        const dist = BABYLON.Vector3.Distance(focus, node.center);

        // Simple geometric "screen error"
        const geomError = node.boundRadius / Math.max(dist, 1.0);
        const error = geomError * this.lodErrorScale;

        // Desired behavior:
        //  - Always show something: roots never disappear.
        //  - Refine when close and error high.
        //  - Optionally coarsen when far & over-refined.
        const wantSubdivide =
            error > 0.15 &&
            node.level < this.maxLevel &&
            dist < this.radius * 0.5;    // only refine within 50% of radius

        const wantMerge =
            error < 0.03 &&
            node.level > 0;              // never merge roots away

        if (wantSubdivide) {
            this._subdivide(node);
        } else if (wantMerge) {
            this._merge(node);
        }

        if (node.children) {
            if (node.mesh) node.mesh.isVisible = false;
            for (const child of node.children) {
                this._updateNodeLOD(child, focus);
            }
        } else {
            if (node.mesh) {
                node.mesh.setEnabled(true);
                node.mesh.isVisible = true;
            }
        }
    }

    _hideSubtree(node) {
        if (node.mesh) node.mesh.isVisible = false;
        if (node.children) {
            for (const child of node.children) this._hideSubtree(child);
        }
    }

    _findNearestLeaf(node, focusPosition, callback) {
        if (node.children) {
            for (const child of node.children) {
                this._findNearestLeaf(child, focusPosition, callback);
            }
        } else if (node.mesh && node.mesh.isVisible) {
            const dist = BABYLON.Vector3.Distance(focusPosition, node.center);
            callback(node, dist);
        }
    }

    _rebuildStats() {
        const perLevel = [];
        let total = 0;

        const visit = (node) => {
            if (node.children) {
                for (const child of node.children) visit(child);
            } else if (node.mesh && node.mesh.isVisible) {
                const lvl = node.level;
                perLevel[lvl] = (perLevel[lvl] || 0) + 1;
                total++;
            }
        };

        for (const root of this.roots) visit(root);

        this.lastStats = {
            totalPatches: total,
            activePatches: total,
            perLevel
        };
    }

    // -------------------- Geometry helpers --------------------

    _cubeToSphere(face, u, v) {
        // (u,v) ∈ [-1,1] on a cube face → normalized direction
        let x, y, z;
        switch (face) {
            case 0: // +X
                x = 1;  y = v;  z = -u;
                break;
            case 1: // -X
                x = -1; y = v;  z = u;
                break;
            case 2: // +Y
                x = u;  y = 1;  z = -v;
                break;
            case 3: // -Y
                x = u;  y = -1; z = v;
                break;
            case 4: // +Z
                x = u;  y = v;  z = 1;
                break;
            case 5: // -Z
            default:
                x = -u; y = v;  z = -1;
                break;
        }
        const vec = new BABYLON.Vector3(x, y, z);
        return vec.normalize();
    }

    _sampleHeight(dir) {
        // Simple analytic noise-ish height; replace with real noise later.
        // dir is unit vector on sphere.

        const k = 0.00015 * this.radius;

        const nx = Math.sin(dir.x * k * 3.17);
        const ny = Math.sin(dir.y * k * 2.11);
        const nz = Math.sin(dir.z * k * 4.03);
        const base = (nx + ny + nz) / 3.0;

        const ridges = Math.abs(Math.sin((dir.x + dir.y + dir.z) * k * 5.0));

        const height =
            base * (0.03 * this.radius * 0.02) +
            ridges * (0.015 * this.radius * 0.02);

        return height;
    }
}
