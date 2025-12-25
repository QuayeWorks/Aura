// src/terrain/workers/terrainMeshWorker.js
// Worker does: SDF field + subtractive sphere carves + marching cubes + normals + colors.
// No BABYLON here.

import { edgeTable, triTable } from "./mcTables.js";

// Corner index -> (dx, dy, dz)
const CORNER_OFFSETS = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];

// Edge index -> [cornerA, cornerB]
const EDGE_CORNER_PAIRS = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== "buildMesh") return;

  const {
    id,
    version,
    dimX, dimY, dimZ,
    cellSize,
    radius,
    isoLevel,
    origin,     // {x,y,z}
    carves,     // [{ position:{x,y,z}, radius }]
    biomeSettings, // biome config (optional)
    wantColors  // boolean
  } = msg;

  try {
    // 1) Build procedural field
    const field = buildField(dimX, dimY, dimZ, cellSize, radius, origin);

    // 2) Apply subtractive sphere carves (persistent history)
    if (Array.isArray(carves) && carves.length) {
      applySubtractiveSphereCarves(field, dimX, dimY, dimZ, cellSize, origin, isoLevel, carves);
    }

    // 3) Marching cubes → unshared triangles (matches your current main-thread approach)
    const result = marchingCubesUnshared(
      field, dimX, dimY, dimZ,
      cellSize, isoLevel, origin,
      radius,
      wantColors !== false
    );

    self.postMessage(
      { type: "meshDone", id, version, ...result },
      [
        result.positions.buffer,
        result.normals.buffer,
        result.indices.buffer,
        result.colors.buffer
      ]
    );
  } catch (err) {
    self.postMessage({
      type: "meshError",
      id,
      version,
      message: err && err.message ? err.message : String(err)
    });
  }
};

// ---------------------- FIELD (from your terrainFieldWorker.js) ----------------------

function hash3(ix, iy, iz) {
  let h = ix * 374761393 + iy * 668265263 + iz * 2147483647;
  h = (h ^ (h >> 13)) >>> 0;
  return (h & 0xfffffff) / 0xfffffff; // 0..1
}

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function valueNoise3(x, y, z) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fade(fx), uy = fade(fy), uz = fade(fz);
  const lerp = (a, b, t) => a + (b - a) * t;

  const v000 = hash3(ix, iy, iz);
  const v100 = hash3(ix + 1, iy, iz);
  const v010 = hash3(ix, iy + 1, iz);
  const v110 = hash3(ix + 1, iy + 1, iz);
  const v001 = hash3(ix, iy, iz + 1);
  const v101 = hash3(ix + 1, iy, iz + 1);
  const v011 = hash3(ix, iy + 1, iz + 1);
  const v111 = hash3(ix + 1, iy + 1, iz + 1);

  const x00 = lerp(v000, v100, ux);
  const x10 = lerp(v010, v110, ux);
  const x01 = lerp(v001, v101, ux);
  const x11 = lerp(v011, v111, ux);

  const y0 = lerp(x00, x10, uy);
  const y1 = lerp(x01, x11, uy);

  return lerp(y0, y1, uz);
}

function fbmNoise3(x, y, z, baseFreq, octaves, lacunarity, gain) {
  let amp = 1.0, freq = baseFreq, sum = 0.0, norm = 0.0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise3(x * freq, y * freq, z * freq);
    const v = n * 2.0 - 1.0;
    sum += v * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? (sum / norm) : sum;
}

function ridgedFbm3(x, y, z, baseFreq, octaves, lacunarity, gain) {
  let amp = 1.0, freq = baseFreq, sum = 0.0, norm = 0.0;
  for (let i = 0; i < octaves; i++) {
    const n = valueNoise3(x * freq, y * freq, z * freq);
    const v = 1.0 - Math.abs(2.0 * n - 1.0);
    sum += v * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? (sum / norm) : sum;
}

function sampleSdf(px, py, pz, R) {
  const distSq = px * px + py * py + pz * pz;
  const dist = Math.sqrt(distSq);
  if (dist < 1e-6) return dist - R;

  const warp1 = fbmNoise3(px, py, pz, 0.00035 / 3.0, 3, 2.0, 0.5);
  const warp2 = fbmNoise3(px + 10000.0, py - 7000.0, pz + 3000.0, 0.0008 / 3.0, 2, 2.0, 0.5);

  const warpStrength1 = 800.0 * 3.0;
  const warpStrength2 = 300.0 * 3.0;

  const wx = px + warp1 * warpStrength1 + warp2 * warpStrength2;
  const wy = py + warp1 * warpStrength1 * 0.6 + warp2 * warpStrength2 * 0.4;
  const wz = pz + warp1 * warpStrength1 + warp2 * warpStrength2 * 0.2;

  const continents = fbmNoise3(wx, wy, wz, 0.00045 / 3.0, 4, 2.0, 0.5);
  const continentHeight = continents * (600.0 * 3.0);

  let ridges = ridgedFbm3(wx + 5000.0, wy - 2000.0, wz + 1000.0, 0.0018 / 3.0, 4, 2.1, 0.5);
  const contMask = Math.max(0, (continents - 0.2) / 0.8);
  ridges *= contMask;
  ridges = Math.max(0, ridges - 0.3) / 0.7;
  ridges = ridges * ridges;

  const mountainHeight = ridges * (1200.0 * 3.0);

  const valleysNoise = fbmNoise3(wx - 7000.0, wy + 3000.0, wz - 2000.0, 0.00025 / 3.0, 3, 2.0, 0.5);
  const valleyDepth = valleysNoise * (400.0 * 3.0);

  const effectiveRadius = R + continentHeight + mountainHeight + valleyDepth;
  let d = dist - effectiveRadius;

  const innerSurface = R - 180.0;
  if (dist < innerSurface) {
    const caves = fbmNoise3(px * 1.5, py * 1.5, pz * 1.5, 0.009 / 3.0, 3, 2.0, 0.5);
    if (caves > 0.25) d += (caves - 0.25) * (90.0 * 3.0);
  }

  return d;
}

function buildField(dimX, dimY, dimZ, cellSize, radius, origin) {
  const total = dimX * dimY * dimZ;
  const field = new Float32Array(total);

  let idx = 0;
  const ox = origin.x, oy = origin.y, oz = origin.z;

  for (let z = 0; z < dimZ; z++) {
    const wz = oz + z * cellSize;
    for (let y = 0; y < dimY; y++) {
      const wy = oy + y * cellSize;
      for (let x = 0; x < dimX; x++) {
        const wx = ox + x * cellSize;
        field[idx++] = sampleSdf(wx, wy, wz, radius);
      }
    }
  }

  return field;
}

// ---------------------- CARVES (subtractive spheres) ----------------------

function index3(x, y, z, dimX, dimY) {
  return x + dimX * (y + dimY * z);
}

function applySubtractiveSphereCarves(field, dimX, dimY, dimZ, cellSize, origin, isoLevel, carves) {
  const ox = origin.x, oy = origin.y, oz = origin.z;

  for (const op of carves) {
    const cx = op.position.x, cy = op.position.y, cz = op.position.z;
    const r = op.radius;
    const r2 = r * r;

    const minX = Math.max(0, Math.floor((cx - r - ox) / cellSize));
    const maxX = Math.min(dimX - 1, Math.ceil((cx + r - ox) / cellSize));
    const minY = Math.max(0, Math.floor((cy - r - oy) / cellSize));
    const maxY = Math.min(dimY - 1, Math.ceil((cy + r - oy) / cellSize));
    const minZ = Math.max(0, Math.floor((cz - r - oz) / cellSize));
    const maxZ = Math.min(dimZ - 1, Math.ceil((cz + r - oz) / cellSize));

    for (let z = minZ; z <= maxZ; z++) {
      const wz = oz + z * cellSize;
      const dz = wz - cz;
      for (let y = minY; y <= maxY; y++) {
        const wy = oy + y * cellSize;
        const dy = wy - cy;
        for (let x = minX; x <= maxX; x++) {
          const wx = ox + x * cellSize;
          const dx = wx - cx;

          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 <= r2) {
            const idx = index3(x, y, z, dimX, dimY);
            if (field[idx] < isoLevel) field[idx] = isoLevel + 0.01;
          }
        }
      }
    }
  }
}

// ---------------------- COLORS (ported from your _getColorForWorldPos) ----------------------

// Small deterministic noise [-1,1] used for grass jitter
function hashNoise(x, y, z) {
  const a = 1103515245, b = 12345, c = 3141592653;
  let n = (x * a) ^ (y * b) ^ (z * c);
  n = (n << 13) ^ n;
  return 1.0 - (((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0);
}

function getColorForWorldPos(x, y, z, radius, biomeSettings) {
  const dist = Math.sqrt(x * x + y * y + z * z);
  const h = dist - radius;


  const upx = dist > 1e-6 ? (x / dist) : 0;
  const upy = dist > 1e-6 ? (y / dist) : 1;
  const upz = dist > 1e-6 ? (z / dist) : 0;

  const ny = upy;

  // --- Biome settings ---
  const bs = biomeSettings || {};
  const u = (typeof bs.unitsPerMeter === "number") ? bs.unitsPerMeter : 1.0;

  const seaLevel = (typeof bs.seaLevelMeters === "number" ? bs.seaLevelMeters : 220) * u;
  const beachWidth = (typeof bs.beachWidthMeters === "number" ? bs.beachWidthMeters : 40) * u;
  const shallowWaterDepth = (typeof bs.shallowWaterDepthMeters === "number" ? bs.shallowWaterDepthMeters : 80) * u;

  const sandMax = (typeof bs.sandMaxMeters === "number" ? bs.sandMaxMeters : 250) * u;
  const grassMax = (typeof bs.grassMaxMeters === "number" ? bs.grassMaxMeters : 250) * u;
  const rockMax = (typeof bs.rockMaxMeters === "number" ? bs.rockMaxMeters : 700) * u;
  const snowStart = (typeof bs.snowStartMeters === "number" ? bs.snowStartMeters : 700) * u;
  const snowFull = (typeof bs.snowFullMeters === "number" ? bs.snowFullMeters : 1600) * u;

  const slopeRockStart = (typeof bs.slopeRockStart === "number" ? bs.slopeRockStart : 0.35);
  const slopeRockFull  = (typeof bs.slopeRockFull === "number" ? bs.slopeRockFull  : 0.75);

  const slopeEps = (typeof bs.slopeEpsMeters === "number" ? bs.slopeEpsMeters : 25) * u;
  const debugMode = (typeof bs.debugMode === "string" ? bs.debugMode : "off");

  // --- LOD-independent slope: sample SDF gradient at a fixed world-space step ---
  const slope = computeSlopeFromSdf(x, y, z, radius, slopeEps, upx, upy, upz);

// --- Debug visualizations (optional) ---
if (debugMode === "height") {
  // Height above sea level heatmap
  const v = Math.max(-1, Math.min(1, (h - seaLevel) / (snowFull - seaLevel)));
  const t = (v + 1) * 0.5;
  return [t, 0.2 + 0.6 * (1 - t), 1 - t];
}
if (debugMode === "slope") {
  const t = Math.max(0, Math.min(1, slope));
  return [t, t, t];
}

// --- Water / beach ---
// Deep water
if (h < seaLevel - shallowWaterDepth) {
  return [0.03, 0.12, 0.28];
}
// Shallow water band (brighter)
if (h < seaLevel - beachWidth) {
  const t = (h - (seaLevel - shallowWaterDepth)) / (shallowWaterDepth - beachWidth);
  return [
    0.03 + (0.06 - 0.03) * t,
    0.12 + (0.20 - 0.12) * t,
    0.28 + (0.40 - 0.28) * t
  ];
}
// Beach/sand band
if (h < seaLevel + beachWidth) {
  const t = (h - (seaLevel - beachWidth)) / (2 * beachWidth);
  const sandWet = [0.62, 0.56, 0.42];
  const sandDry = [0.88, 0.83, 0.64];
  const c = [
    sandWet[0] + (sandDry[0] - sandWet[0]) * t,
    sandWet[1] + (sandDry[1] - sandWet[1]) * t,
    sandWet[2] + (sandDry[2] - sandWet[2]) * t
  ];
  if (debugMode === "isolateSand") return c;
  if (debugMode === "biome") return c;
  return c;
}

const aboveSea = h - seaLevel;

// --- Base biome colors ---
const grass = [0.18, 0.55, 0.22];
const grassDry = [0.38, 0.62, 0.25];
const rock = [0.55, 0.55, 0.58];
const rockDark = [0.40, 0.38, 0.36];
const snow = [0.95, 0.97, 1.0];

// Height-driven base: grass -> dry grass -> rock -> snow
let base;
if (aboveSea < grassMax) {
  const t = Math.max(0, Math.min(1, aboveSea / grassMax));
  base = [
    grass[0] + (grassDry[0] - grass[0]) * t,
    grass[1] + (grassDry[1] - grass[1]) * t,
    grass[2] + (grassDry[2] - grass[2]) * t
  ];
} else if (aboveSea < rockMax) {
  const t = Math.max(0, Math.min(1, (aboveSea - grassMax) / Math.max(1e-6, (rockMax - grassMax))));
  base = [
    grassDry[0] + (rockDark[0] - grassDry[0]) * t,
    grassDry[1] + (rockDark[1] - grassDry[1]) * t,
    grassDry[2] + (rockDark[2] - grassDry[2]) * t
  ];
} else {
  const t = Math.max(0, Math.min(1, (aboveSea - snowStart) / Math.max(1e-6, (snowFull - snowStart))));
  base = [
    rock[0] + (snow[0] - rock[0]) * t,
    rock[1] + (snow[1] - rock[1]) * t,
    rock[2] + (snow[2] - rock[2]) * t
  ];
}

// Snow latitude bias (more snow toward poles) - subtle
const latT = Math.min(1, Math.abs(ny));
const snowLatMix = 0.35 * latT;

// If above snowStart, blend further toward snow at high lat
if (aboveSea > snowStart) {
  base = [
    base[0] + (snow[0] - base[0]) * snowLatMix,
    base[1] + (snow[1] - base[1]) * snowLatMix,
    base[2] + (snow[2] - base[2]) * snowLatMix
  ];
}

// --- Slope-aware blending (LOD-independent via SDF gradient) ---
// Steeper => more rock, less grass/sand
const slopeT = Math.max(0, Math.min(1, (slope - slopeRockStart) / Math.max(1e-6, (slopeRockFull - slopeRockStart))));
const rockMix = [
  base[0] + (rock[0] - base[0]) * slopeT,
  base[1] + (rock[1] - base[1]) * slopeT,
  base[2] + (rock[2] - base[2]) * slopeT
];

// Slight darkening on steep slopes (readability)
const shade = 1.0 - 0.12 * slopeT;
const finalC = [rockMix[0] * shade, rockMix[1] * shade, rockMix[2] * shade];

if (debugMode === "isolateSnow") {
  if (aboveSea >= snowStart) return snow;
  return [0.07, 0.07, 0.07];
}
if (debugMode === "biome") return finalC;

return finalC;
}
// ---------------------- MARCHING CUBES (unshared triangles) ----------------------

function lerp(a, b, t) { return a + (b - a) * t; }

function marchingCubesUnshared(field, dimX, dimY, dimZ, cellSize, isoLevel, origin, radius, wantColors) {
  const positions = [];
  const normals = [];
  const indices = [];
  const colors = [];

  const ox = origin.x, oy = origin.y, oz = origin.z;

  // edge vertex positions per cube (12 edges, each [x,y,z])
  const vertList = new Float32Array(12 * 3);

  let vertCount = 0;

  for (let z = 0; z < dimZ - 1; z++) {
    for (let y = 0; y < dimY - 1; y++) {
      for (let x = 0; x < dimX - 1; x++) {
        // Corner values + positions
        const cv = new Float32Array(8);
        const cp = new Float32Array(8 * 3);

        for (let i = 0; i < 8; i++) {
          const dx = CORNER_OFFSETS[i][0];
          const dy = CORNER_OFFSETS[i][1];
          const dz = CORNER_OFFSETS[i][2];

          const gx = x + dx;
          const gy = y + dy;
          const gz = z + dz;

          cv[i] = field[index3(gx, gy, gz, dimX, dimY)];

          cp[i * 3 + 0] = ox + gx * cellSize;
          cp[i * 3 + 1] = oy + gy * cellSize;
          cp[i * 3 + 2] = oz + gz * cellSize;
        }

        // cubeIndex
        let cubeIndex = 0;
        if (cv[0] < isoLevel) cubeIndex |= 1;
        if (cv[1] < isoLevel) cubeIndex |= 2;
        if (cv[2] < isoLevel) cubeIndex |= 4;
        if (cv[3] < isoLevel) cubeIndex |= 8;
        if (cv[4] < isoLevel) cubeIndex |= 16;
        if (cv[5] < isoLevel) cubeIndex |= 32;
        if (cv[6] < isoLevel) cubeIndex |= 64;
        if (cv[7] < isoLevel) cubeIndex |= 128;

        const edgeMask = edgeTable[cubeIndex];
        if (!edgeMask) continue;

        // interpolate edges
        for (let e = 0; e < 12; e++) {
          if (!(edgeMask & (1 << e))) continue;

          const aIdx = EDGE_CORNER_PAIRS[e][0];
          const bIdx = EDGE_CORNER_PAIRS[e][1];

          const va = cv[aIdx];
          const vb = cv[bIdx];

          const ax = cp[aIdx * 3 + 0], ay = cp[aIdx * 3 + 1], az = cp[aIdx * 3 + 2];
          const bx = cp[bIdx * 3 + 0], by = cp[bIdx * 3 + 1], bz = cp[bIdx * 3 + 2];

          const t = Math.abs(vb - va) < 1e-6 ? 0.5 : (isoLevel - va) / (vb - va);

          vertList[e * 3 + 0] = lerp(ax, bx, t);
          vertList[e * 3 + 1] = lerp(ay, by, t);
          vertList[e * 3 + 2] = lerp(az, bz, t);
        }

        const triRow = triTable[cubeIndex];
        for (let i = 0; i < 16; i += 3) {
          const e0 = triRow[i];
          const e1 = triRow[i + 1];
          const e2 = triRow[i + 2];
          if (e0 === -1 || e1 === -1 || e2 === -1) break;

          const p0x = vertList[e0 * 3 + 0], p0y = vertList[e0 * 3 + 1], p0z = vertList[e0 * 3 + 2];
          const p1x = vertList[e1 * 3 + 0], p1y = vertList[e1 * 3 + 1], p1z = vertList[e1 * 3 + 2];
          const p2x = vertList[e2 * 3 + 0], p2y = vertList[e2 * 3 + 1], p2z = vertList[e2 * 3 + 2];

          // Positions
          positions.push(
            p0x, p0y, p0z,
            p1x, p1y, p1z,
            p2x, p2y, p2z
          );

          // Flat normals (matches your current "unshared vertices" output)
          const ux = p1x - p0x, uy = p1y - p0y, uz = p1z - p0z;
          const vx = p2x - p0x, vy = p2y - p0y, vz = p2z - p0z;

          let nx = uy * vz - uz * vy;
          let ny = uz * vx - ux * vz;
          let nz = ux * vy - uy * vx;

          const nl = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
          nx /= nl; ny /= nl; nz /= nl;

          normals.push(
            nx, ny, nz,
            nx, ny, nz,
            nx, ny, nz
          );

          // Indices
          const base = vertCount;
          indices.push(base, base + 1, base + 2);
          vertCount += 3;

          // Colors
          if (wantColors) {
            const c0 = getColorForWorldPos(p0x, p0y, p0z, radius, biomeSettings);
            const c1 = getColorForWorldPos(p1x, p1y, p1z, radius, biomeSettings);
            const c2 = getColorForWorldPos(p2x, p2y, p2z, radius, biomeSettings);

            colors.push(c0[0], c0[1], c0[2], 1.0);
            colors.push(c1[0], c1[1], c1[2], 1.0);
            colors.push(c2[0], c2[1], c2[2], 1.0);
          } else {
            colors.push(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1);
          }
        }
      }
    }
  }

  // Typed arrays (transferable)
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    indices: new Uint32Array(indices),
    colors: new Float32Array(colors),
  };
}
