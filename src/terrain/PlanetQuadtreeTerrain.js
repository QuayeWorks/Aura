// src/terrain/PlanetQuadtreeTerrain.js
// Spherical quadtree planet surface with adaptive patch LOD.
// This is a heightmap-style surface terrain (no volumetric carving yet).
// Designed to pair with the main menu / HUD you already have.

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

        // Controls how aggressively we refine; adjusted by Settings slider.
        this.lodErrorScale = options.lodErrorScale ?? 1.0;

        // Shared material
        this.material = new BABYLON.StandardMaterial("planetQuadMat", this.scene);
        this.material.diffuseColor = new BABYLON.Color3(0.2, 0.9, 0.35);
        this.material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
        this.material.backFaceCulling = false;

        // Root nodes for the 6 faces of a cube
        this.roots = [];

        // Stats for HUD
        this.lastStats = {
            totalPatches: 0,
            activePatches: 0,
            perLevel: []
        };

        // Initial build tracking for loading bar (simple, planet builds fast)
        this.initialBuildDone = false;
        this.initialBuildTotal = 6;   // 6 faces
        this.initialBuildCompleted = 0;
        this.onInitialBuildDone = null;

        // Build roots
        for (let face = 0; face < 6; face++) {
            const root = this._createNode(face, -1, 1, -1, 1, 0);
            this.roots.push(root);
        }
        this._rebuildStats();
        this.initialBuildCompleted = this.initialBuildTotal;
        this.initialBuildDone = true;
    }

    // -------------- Public API for main.js ------------------

    getInitialBuildProgress() {
        if (this.initialBuildTotal === 0) return 1;
        return this.initialBuildCompleted / this.initialBuildTotal;
    }

    /**
     * Call every frame with camera or player position.
     */
    updateStreaming(focusPosition) {
        if (!focusPosition) return;

        const camPos = focusPosition.clone
            ? focusPosition.clone()
            : new BABYLON.Vector3(focusPosition.x, focusPosition.y, focusPosition.z);

        // Planet center is origin
        const planetCenter = BABYLON.Vector3.Zero();
        const toCam = camPos.subtract(planetCenter);
        const camDist = toCam.length();

        // Skip if camera is at the center (should not happen)
        if (camDist < 1e-3) return;

        // Only activate patches within a maximum viewing distance
        // (~12% of radius, similar to your old system but a bit looser)
        const maxViewDist = this.radius * 0.12;

        for (const root of this.roots) {
            this._updateNodeLOD(root, camPos, maxViewDist);
        }

        this._rebuildStats();
    }

    /**
     * Returns LOD / patch info for HUD (similar shape to old ChunkedPlanetTerrain).
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

        if (!focusPosition) {
            return info;
        }

        // Find nearest active patch
        let best = null;
        let bestDist = Infinity;

        for (const root of this.roots) {
            this._findNearestLeaf(root, focusPosition, (node, dist) => {
                if (dist < bestDist) {
                    bestDist = dist;
                    best = { node, dist };
                }
            });
        }

        if (best && best.node) {
            const n = best.node;
            info.nearestChunk = {
                lodLevel: n.level,
                dimX: this.patchResolution,
                dimZ: this.patchResolution,
                distance: best.dist
            };
        }

        return info;
    }

    // -------------- Node + LOD management -------------------

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
        // Build a grid patch on this cube face and project to sphere
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

                const p = this._cubeToSphere(node.face, u, v);
                const height = this._sampleHeight(p);
                const worldPos = p.scale(this.radius + height);

                positions.push(worldPos.x, worldPos.y, worldPos.z);

                const normal = worldPos.normalize();
                normals.push(normal.x, normal.y, normal.z);

                // track bounding box
                minPos.x = Math.min(minPos.x, worldPos.x);
                minPos.y = Math.min(minPos.y, worldPos.y);
                minPos.z = Math.min(minPos.z, worldPos.z);
                maxPos.x = Math.max(maxPos.x, worldPos.x);
                maxPos.y = Math.max(maxPos.y, worldPos.y);
                maxPos.z = Math.max(maxPos.z, worldPos.z);
            }
        }

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
            mesh = new BABYLON.Mesh("patch_l" + node.level + "_f" + node.face, this.scene);
            mesh.checkCollisions = true;
            mesh.material = this.material;
            node.mesh = mesh;
        }

        const vertexData = new BABYLON.VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;
        vertexData.applyToMesh(mesh, true);

        // bounding sphere for LOD decisions
        const center = minPos.add(maxPos).scale(0.5);
        const radius = center.subtract(maxPos).length();

        node.center = center;
        node.boundRadius = radius;

        mesh.isVisible = true;
    }

    _destroyNodeGeometry(node) {
        if (node.mesh) {
            node.mesh.dispose();
            node.mesh = null;
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
            this._disposeSubtree(child);
        }
        node.children = null;

        if (!node.mesh) {
            this._buildNodeGeometry(node);
        } else {
            node.mesh.isVisible = true;
        }
    }

    _disposeSubtree(node) {
        if (node.children) {
            for (const child of node.children) {
                this._disposeSubtree(child);
            }
            node.children = null;
        }
        if (node.mesh) {
            node.mesh.dispose();
            node.mesh = null;
        }
    }

    _updateNodeLOD(node, camPos, maxViewDist) {
        if (!node.center) return;

        const center = node.center;
        const dist = BABYLON.Vector3.Distance(camPos, center);

        // Backface / far culling relative to camera and max view distance
        const planetCenter = BABYLON.Vector3.Zero();
        const toCenter = center.subtract(planetCenter).normalize();
        const toCam = camPos.subtract(planetCenter).normalize();
        const dot = BABYLON.Vector3.Dot(toCenter, toCam);

        if (dot < -0.2 || dist > maxViewDist) {
            // Too far or on far side: hide node & subtree
            if (node.mesh) node.mesh.isVisible = false;
            if (node.children) {
                for (const child of node.children) {
                    this._hideSubtree(child);
                }
            }
            return;
        }

        // LOD decision: bigger patches close to camera subdivide
        const geomError = node.boundRadius / Math.max(dist, 1.0);
        const error = geomError * this.lodErrorScale;

        const wantSubdivide = (error > 0.15 && node.level < this.maxLevel);

        if (wantSubdivide) {
            this._subdivide(node);
        } else {
            // Coarsen if children exist but we don't need that much detail
            if (node.children && error < 0.05) {
                this._merge(node);
            }
        }

        if (node.children) {
            if (node.mesh) node.mesh.isVisible = false;
            for (const child of node.children) {
                this._updateNodeLOD(child, camPos, maxViewDist);
            }
        } else {
            if (node.mesh) node.mesh.isVisible = true;
        }
    }

    _hideSubtree(node) {
        if (node.mesh) node.mesh.isVisible = false;
        if (node.children) {
            for (const child of node.children) {
                this._hideSubtree(child);
            }
        }
    }

    _findNearestLeaf(node, focusPosition, callback) {
        if (node.children) {
            for (const child of node.children) {
                this._findNearestLeaf(child, focusPosition, callback);
            }
        } else if (node.mesh && node.mesh.isVisible) {
            const center = node.center;
            const dist = BABYLON.Vector3.Distance(focusPosition, center);
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
                const level = node.level;
                perLevel[level] = (perLevel[level] || 0) + 1;
                total++;
            }
        };

        for (const r of this.roots) visit(r);

        this.lastStats = {
            totalPatches: total,
            activePatches: total,
            perLevel
        };
    }

    // -------------- Quality control (for Settings UI) -----

    /**
     * Adjust how aggressively LOD refines.
     * level 0 = lowest quality, 5 = highest.
     */
    setLodQuality(level) {
        const v = Math.max(0, Math.min(5, Math.round(level)));
        // 0 -> 0.6, 5 -> 1.6
        this.lodErrorScale = 0.6 + v * 0.2;
    }

    // -------------- Geometry helpers -----------------------

    _cubeToSphere(face, u, v) {
        // Map (u,v) in [-1,1] onto one face of a cube, then normalize to sphere.
        let x, y, z;
        switch (face) {
            case 0: // +X
                x = 1; y = v; z = -u;
                break;
            case 1: // -X
                x = -1; y = v; z = u;
                break;
            case 2: // +Y
                x = u; y = 1; z = -v;
                break;
            case 3: // -Y
                x = u; y = -1; z = v;
                break;
            case 4: // +Z
                x = u; y = v; z = 1;
                break;
            case 5: // -Z
            default:
                x = -u; y = v; z = -1;
                break;
        }

        const vec = new BABYLON.Vector3(x, y, z);
        return vec.normalize();
    }

    _sampleHeight(dir) {
        // Simple analytic height function for now.
        // You can replace this with real noise later (Perlin, simplex, etc).
        const k = 0.00015 * this.radius;
        const nx = Math.sin(dir.x * k * 3.17);
        const ny = Math.sin(dir.y * k * 2.11);
        const nz = Math.sin(dir.z * k * 4.03);
        const base = (nx + ny + nz) / 3.0;

        // small additional warping
        const ridges = Math.abs(Math.sin((dir.x + dir.y + dir.z) * k * 5.0));

        const height =
            base * 0.03 * this.radius * 0.02 +
            ridges * 0.015 * this.radius * 0.02;

        return height;
    }
}
