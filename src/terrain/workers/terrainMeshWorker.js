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

function getColorForWorldPos(x, y, z, radius) {
  const dist = Math.sqrt(x * x + y * y + z * z);
  const h = dist - radius;

  const ny = dist > 1e-6 ? (y / dist) : 0;

  const seaLevel = 220;
  const beachWidth = 40;

  // Below water
  if (h < seaLevel - beachWidth) {
    return [0.05, 0.18, 0.40]; // deep water tint
  }

  // Beach band
  if (h < seaLevel + beachWidth) {
    const t = (h - (seaLevel - beachWidth)) / (2 * beachWidth);
    const shallow = [0.15, 0.45, 0.75];
    const sand = [0.96, 0.88, 0.60];
    return [
      shallow[0] + (sand[0] - shallow[0]) * t,
      shallow[1] + (sand[1] - shallow[1]) * t,
      shallow[2] + (sand[2] - shallow[2]) * t
    ];
  }

  const aboveSea = h - (seaLevel + beachWidth);

  const n = hashNoise(
    Math.floor(x * 0.02),
    Math.floor(y * 0.02),
    Math.floor(z * 0.02)
  );
  const grassJitter = 0.03 * n;

  if (aboveSea < 250) {
    const t = aboveSea / 250;
    const grassLow  = [0.20, 0.75 + grassJitter, 0.32];
    const grassHigh = [0.14, 0.58, 0.26];
    return [
      grassLow[0] + (grassHigh[0] - grassLow[0]) * t,
      grassLow[1] + (grassHigh[1] - grassLow[1]) * t,
      grassLow[2] + (grassHigh[2] - grassLow[2]) * t
    ];
  }

  if (aboveSea < 700) {
    const t = (aboveSea - 250) / (700 - 250);
    const rockBrown = [0.45, 0.40, 0.35];
    const rockGrey  = [0.65, 0.65, 0.68];
    return [
      rockBrown[0] + (rockGrey[0] - rockBrown[0]) * t,
      rockBrown[1] + (rockGrey[1] - rockBrown[1]) * t,
      rockBrown[2] + (rockGrey[2] - rockBrown[2]) * t
    ];
  }

  const snowBase = [0.80, 0.82, 0.87];
  const snowPure = [1.0, 1.0, 1.0];

  const heightT = Math.min(1, (aboveSea - 700) / 900);
  const latT = Math.min(1, Math.abs(ny));

  const snowMix = [
    snowBase[0] + (snowPure[0] - snowBase[0]) * heightT,
    snowBase[1] + (snowPure[1] - snowBase[1]) * heightT,
    snowBase[2] + (snowPure[2] - snowBase[2]) * heightT
  ];

  const t = latT * 0.5;
  return [
    snowMix[0] + (snowPure[0] - snowMix[0]) * t,
    snowMix[1] + (snowPure[1] - snowMix[1]) * t,
    snowMix[2] + (snowPure[2] - snowMix[2]) * t
  ];
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
            const c0 = getColorForWorldPos(p0x, p0y, p0z, radius);
            const c1 = getColorForWorldPos(p1x, p1y, p1z, radius);
            const c2 = getColorForWorldPos(p2x, p2y, p2z, radius);

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
