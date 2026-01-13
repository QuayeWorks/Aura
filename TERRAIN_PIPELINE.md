# Terrain Pipeline (Aura)

This document describes the terrain streaming guarantees that mirror the GDVoxelTerrain behavior without porting engine code.

## Overview

Aura’s terrain streaming is driven by two authoritative controllers:

1. **TerrainScheduler** (builds/LODs/culling).
2. **ColliderQueue** (collider enable/disable rate control).

Both live in `src/terrain` and are orchestrated by `ChunkedPlanetTerrain`.

## 1) TerrainScheduler (single build authority)

- All build jobs flow through `TerrainScheduler`.
- Priority formula:

```
priority = (lodWeight * 100000) + surfaceDistanceWeight + visibleBonus
```

- **Caps enforced**:
  - `maxConcurrentBuilds`
  - `buildBudgetMs` per frame
- Jobs are dropped when:
  - The node is culled/depth culled/horizon culled.
  - The node’s requested build key changed (stale job).
- Worker results are applied only if the `buildKey` matches the node’s `_wantedBuildKey`.

### LOD stability
- Each leaf node tracks visible frames.
- LOD upgrades only happen when the node is stable for `buildStabilityFrames`.
- Newly visible leaves build **LOD1 first**, then refine only after the stability window.

## 2) ColliderQueue (updated_colliders_per_second)

- Colliders update independently from render meshes.
- Each frame, render meshes are classified by surface distance:
  - **r1**: collisions **must** be enabled.
  - **r2**: enable as budget allows.
  - **outside r2**: collisions disabled.
- Updates are rate-limited by `updatedCollidersPerSecond`.
- The queue reports `collidersProcessedPerSecond` and length for diagnostics.

## 3) Streaming focus & culling

- **LOADING**: focus is the spawn surface direction (`u * planetRadius`).
- **PLAYING**: focus is the player’s surface direction.
- Geodesic distance is computed as `radius * acos(dot(uP, uN))`.
- Outside `Rcull`: not built, not enabled, not collidable.

## 4) LOD boundary stitching (skirts)

- Each chunk builds optional “skirts” along edges adjacent to coarser LOD neighbors.
- Skirts duplicate boundary vertices and extrude inward along the vertex normal.
- This reduces cracks and visual pops without Transvoxel complexity.

## 5) PlanetWorld (shared world queries)

- `src/world/PlanetWorld.js` provides:
  - `getUpVector(pos)`
  - `getGravityVector(pos)`
  - `getSurfaceRadiusAtDirection(u)`
- Player and enemy systems use PlanetWorld so gravity + up vectors remain consistent.

## 6) Loader guarantees

- Stage 1 builds a coarse (LOD1) ring around the spawn surface focus immediately.
- Stage 2 waits for:
  - `enabledMeshes >= N`
  - `enabledCollidableMeshes >= M`
- Force Spawn keeps gravity disabled until colliders are confirmed near the player.

## Debug / Dev Panel

The dev panel reports:
- Scheduler queue length
- Collider queue length + colliders/sec
- Enabled meshes/colliders in r1/r2/r3
- Stale job drops and stale result drops

These metrics should remain stable in PLAYING:
- `renderSetCount > 0`
- `enabledMeshes > 0`
- `enabledCollidableMeshes > 0`
- `buildQueueLength` stays bounded
