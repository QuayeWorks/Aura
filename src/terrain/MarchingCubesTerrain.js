/* global BABYLON */
// src/terrain/MarchingCubesTerrain.js

// --- Optional Web Worker for SDF field generation (CPU offload) ---
let FIELD_WORKER = null;
let FIELD_JOB_ID = 0;
const FIELD_JOB_PROMISES = new Map();

function ensureFieldWorker() {
    if (typeof Worker === "undefined") return null;
    if (FIELD_WORKER) return FIELD_WORKER;

    // Worker lives next to this file
    FIELD_WORKER = new Worker(
        new URL("./terrainFieldWorker.js", import.meta.url),
        { type: "module" }
    );

    FIELD_WORKER.onmessage = (e) => {
        const msg = e.data;
        if (!msg || typeof msg.id === "undefined") return;

        const entry = FIELD_JOB_PROMISES.get(msg.id);
        if (!entry) return;
        FIELD_JOB_PROMISES.delete(msg.id);

        if (msg.type === "fieldDone" && msg.field) {
            entry.resolve(msg.field);
        } else if (msg.type === "fieldError") {
            console.error("terrainFieldWorker error:", msg.message);
            entry.reject(new Error(msg.message || "Worker field error"));
        }
    };

    FIELD_WORKER.onerror = (err) => {
        console.error("terrainFieldWorker fatal error:", err);
        // Fail all pending jobs
        for (const [, entry] of FIELD_JOB_PROMISES) {
            entry.reject(err);
        }
        FIELD_JOB_PROMISES.clear();
    };

    return FIELD_WORKER;
}

function buildFieldAsync(dimX, dimY, dimZ, cellSize, radius, origin) {
    const worker = ensureFieldWorker();
    if (!worker) {
        return Promise.reject(new Error("Web Worker not available"));
    }

    const id = ++FIELD_JOB_ID;

    return new Promise((resolve, reject) => {
        FIELD_JOB_PROMISES.set(id, { resolve, reject });

        worker.postMessage({
            type: "buildField",
            id,
            dimX,
            dimY,
            dimZ,
            cellSize,
            radius,
            origin: { x: origin.x, y: origin.y, z: origin.z }
        });
    });
}

// --- Marching Cubes lookup tables (standard) -----------------------------
//marching cubes table data
const edgeTable = [
0x0  , 0x109, 0x203, 0x30a, 0x406, 0x50f, 0x605, 0x70c,
0x80c, 0x905, 0xa0f, 0xb06, 0xc0a, 0xd03, 0xe09, 0xf00,
0x190, 0x99 , 0x393, 0x29a, 0x596, 0x49f, 0x795, 0x69c,
0x99c, 0x895, 0xb9f, 0xa96, 0xd9a, 0xc93, 0xf99, 0xe90,
0x230, 0x339, 0x33 , 0x13a, 0x636, 0x73f, 0x435, 0x53c,
0xa3c, 0xb35, 0x83f, 0x936, 0xe3a, 0xf33, 0xc39, 0xd30,
0x3a0, 0x2a9, 0x1a3, 0xaa , 0x7a6, 0x6af, 0x5a5, 0x4ac,
0xbac, 0xaa5, 0x9af, 0x8a6, 0xfaa, 0xea3, 0xda9, 0xca0,
0x460, 0x569, 0x663, 0x76a, 0x66 , 0x16f, 0x265, 0x36c,
0xc6c, 0xd65, 0xe6f, 0xf66, 0x86a, 0x963, 0xa69, 0xb60,
0x5f0, 0x4f9, 0x7f3, 0x6fa, 0x1f6, 0xff , 0x3f5, 0x2fc,
0xdfc, 0xcf5, 0xfff, 0xef6, 0x9fa, 0x8f3, 0xbf9, 0xaf0,
0x650, 0x759, 0x453, 0x55a, 0x256, 0x35f, 0x55 , 0x15c,
0xe5c, 0xf55, 0xc5f, 0xd56, 0xa5a, 0xb53, 0x859, 0x950,
0x7c0, 0x6c9, 0x5c3, 0x4ca, 0x3c6, 0x2cf, 0x1c5, 0xcc ,
0xfcc, 0xec5, 0xdcf, 0xcc6, 0xbca, 0xac3, 0x9c9, 0x8c0,
0x8c0, 0x9c9, 0xac3, 0xbca, 0xcc6, 0xdcf, 0xec5, 0xfcc,
0xcc , 0x1c5, 0x2cf, 0x3c6, 0x4ca, 0x5c3, 0x6c9, 0x7c0,
0x950, 0x859, 0xb53, 0xa5a, 0xd56, 0xc5f, 0xf55, 0xe5c,
0x15c, 0x55 , 0x35f, 0x256, 0x55a, 0x453, 0x759, 0x650,
0xaf0, 0xbf9, 0x8f3, 0x9fa, 0xef6, 0xfff, 0xcf5, 0xdfc,
0x2fc, 0x3f5, 0xff , 0x1f6, 0x6fa, 0x7f3, 0x4f9, 0x5f0,
0xb60, 0xa69, 0x963, 0x86a, 0xf66, 0xe6f, 0xd65, 0xc6c,
0x36c, 0x265, 0x16f, 0x66 , 0x76a, 0x663, 0x569, 0x460,
0xca0, 0xda9, 0xea3, 0xfaa, 0x8a6, 0x9af, 0xaa5, 0xbac,
0x4ac, 0x5a5, 0x6af, 0x7a6, 0xaa , 0x1a3, 0x2a9, 0x3a0,
0xd30, 0xc39, 0xf33, 0xe3a, 0x936, 0x83f, 0xb35, 0xa3c,
0x53c, 0x435, 0x73f, 0x636, 0x13a, 0x33 , 0x339, 0x230,
0xe90, 0xf99, 0xc93, 0xd9a, 0xa96, 0xb9f, 0x895, 0x99c,
0x69c, 0x795, 0x49f, 0x596, 0x29a, 0x393, 0x99 , 0x190,
0xf00, 0xe09, 0xd03, 0xc0a, 0xb06, 0xa0f, 0x905, 0x80c,
0x70c, 0x605, 0x50f, 0x406, 0x30a, 0x203, 0x109, 0x0   ];

const triTable = [
[-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 8, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 1, 9, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 8, 3, 9, 8, 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 2, 10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 8, 3, 1, 2, 10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[9, 2, 10, 0, 2, 9, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[2, 8, 3, 2, 10, 8, 10, 9, 8, -1, -1, -1, -1, -1, -1, -1],
[3, 11, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 11, 2, 8, 11, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 9, 0, 2, 3, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 11, 2, 1, 9, 11, 9, 8, 11, -1, -1, -1, -1, -1, -1, -1],
[3, 10, 1, 11, 10, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 10, 1, 0, 8, 10, 8, 11, 10, -1, -1, -1, -1, -1, -1, -1],
[3, 9, 0, 3, 11, 9, 11, 10, 9, -1, -1, -1, -1, -1, -1, -1],
[9, 8, 10, 10, 8, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[4, 7, 8, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[4, 3, 0, 7, 3, 4, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 1, 9, 8, 4, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[4, 1, 9, 4, 7, 1, 7, 3, 1, -1, -1, -1, -1, -1, -1, -1],
[1, 2, 10, 8, 4, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[3, 4, 7, 3, 0, 4, 1, 2, 10, -1, -1, -1, -1, -1, -1, -1],
[9, 2, 10, 9, 0, 2, 8, 4, 7, -1, -1, -1, -1, -1, -1, -1],
[2, 10, 9, 2, 9, 7, 2, 7, 3, 7, 9, 4, -1, -1, -1, -1],
[8, 4, 7, 3, 11, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[11, 4, 7, 11, 2, 4, 2, 0, 4, -1, -1, -1, -1, -1, -1, -1],
[9, 0, 1, 8, 4, 7, 2, 3, 11, -1, -1, -1, -1, -1, -1, -1],
[4, 7, 11, 9, 4, 11, 9, 11, 2, 9, 2, 1, -1, -1, -1, -1],
[3, 10, 1, 3, 11, 10, 7, 8, 4, -1, -1, -1, -1, -1, -1, -1],
[1, 11, 10, 1, 4, 11, 1, 0, 4, 7, 11, 4, -1, -1, -1, -1],
[4, 7, 8, 9, 0, 11, 9, 11, 10, 11, 0, 3, -1, -1, -1, -1],
[4, 7, 11, 4, 11, 9, 9, 11, 10, -1, -1, -1, -1, -1, -1, -1],
[9, 5, 4, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[9, 5, 4, 0, 8, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 5, 4, 1, 5, 0, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[8, 5, 4, 8, 3, 5, 3, 1, 5, -1, -1, -1, -1, -1, -1, -1],
[1, 2, 10, 9, 5, 4, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[3, 0, 8, 1, 2, 10, 4, 9, 5, -1, -1, -1, -1, -1, -1, -1],
[5, 2, 10, 5, 4, 2, 4, 0, 2, -1, -1, -1, -1, -1, -1, -1],
[2, 10, 5, 3, 2, 5, 3, 5, 4, 3, 4, 8, -1, -1, -1, -1],
[9, 5, 4, 2, 3, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 11, 2, 0, 8, 11, 4, 9, 5, -1, -1, -1, -1, -1, -1, -1],
[0, 5, 4, 0, 1, 5, 2, 3, 11, -1, -1, -1, -1, -1, -1, -1],
[2, 1, 5, 2, 5, 8, 2, 8, 11, 4, 8, 5, -1, -1, -1, -1],
[10, 3, 11, 10, 1, 3, 9, 5, 4, -1, -1, -1, -1, -1, -1, -1],
[4, 9, 5, 0, 8, 1, 8, 10, 1, 8, 11, 10, -1, -1, -1, -1],
[5, 4, 0, 5, 0, 11, 5, 11, 10, 11, 0, 3, -1, -1, -1, -1],
[5, 4, 8, 5, 8, 10, 10, 8, 11, -1, -1, -1, -1, -1, -1, -1],
[9, 7, 8, 5, 7, 9, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[9, 3, 0, 9, 5, 3, 5, 7, 3, -1, -1, -1, -1, -1, -1, -1],
[0, 7, 8, 0, 1, 7, 1, 5, 7, -1, -1, -1, -1, -1, -1, -1],
[1, 5, 3, 3, 5, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[9, 7, 8, 9, 5, 7, 10, 1, 2, -1, -1, -1, -1, -1, -1, -1],
[10, 1, 2, 9, 5, 0, 5, 3, 0, 5, 7, 3, -1, -1, -1, -1],
[8, 0, 2, 8, 2, 5, 8, 5, 7, 10, 5, 2, -1, -1, -1, -1],
[2, 10, 5, 2, 5, 3, 3, 5, 7, -1, -1, -1, -1, -1, -1, -1],
[7, 9, 5, 7, 8, 9, 3, 11, 2, -1, -1, -1, -1, -1, -1, -1],
[9, 5, 7, 9, 7, 2, 9, 2, 0, 2, 7, 11, -1, -1, -1, -1],
[2, 3, 11, 0, 1, 8, 1, 7, 8, 1, 5, 7, -1, -1, -1, -1],
[11, 2, 1, 11, 1, 7, 7, 1, 5, -1, -1, -1, -1, -1, -1, -1],
[9, 5, 8, 8, 5, 7, 10, 1, 3, 10, 3, 11, -1, -1, -1, -1],
[5, 7, 0, 5, 0, 9, 7, 11, 0, 1, 0, 10, 11, 10, 0, -1],
[11, 10, 0, 11, 0, 3, 10, 5, 0, 8, 0, 7, 5, 7, 0, -1],
[11, 10, 5, 7, 11, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[10, 6, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 8, 3, 5, 10, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[9, 0, 1, 5, 10, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 8, 3, 1, 9, 8, 5, 10, 6, -1, -1, -1, -1, -1, -1, -1],
[1, 6, 5, 2, 6, 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 6, 5, 1, 2, 6, 3, 0, 8, -1, -1, -1, -1, -1, -1, -1],
[9, 6, 5, 9, 0, 6, 0, 2, 6, -1, -1, -1, -1, -1, -1, -1],
[5, 9, 8, 5, 8, 2, 5, 2, 6, 3, 2, 8, -1, -1, -1, -1],
[2, 3, 11, 10, 6, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[11, 0, 8, 11, 2, 0, 10, 6, 5, -1, -1, -1, -1, -1, -1, -1],
[0, 1, 9, 2, 3, 11, 5, 10, 6, -1, -1, -1, -1, -1, -1, -1],
[5, 10, 6, 1, 9, 2, 9, 11, 2, 9, 8, 11, -1, -1, -1, -1],
[6, 3, 11, 6, 5, 3, 5, 1, 3, -1, -1, -1, -1, -1, -1, -1],
[0, 8, 11, 0, 11, 5, 0, 5, 1, 5, 11, 6, -1, -1, -1, -1],
[3, 11, 6, 0, 3, 6, 0, 6, 5, 0, 5, 9, -1, -1, -1, -1],
[6, 5, 9, 6, 9, 11, 11, 9, 8, -1, -1, -1, -1, -1, -1, -1],
[5, 10, 6, 4, 7, 8, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[4, 3, 0, 4, 7, 3, 6, 5, 10, -1, -1, -1, -1, -1, -1, -1],
[1, 9, 0, 5, 10, 6, 8, 4, 7, -1, -1, -1, -1, -1, -1, -1],
[10, 6, 5, 1, 9, 7, 1, 7, 3, 7, 9, 4, -1, -1, -1, -1],
[6, 1, 2, 6, 5, 1, 4, 7, 8, -1, -1, -1, -1, -1, -1, -1],
[1, 2, 5, 5, 2, 6, 3, 0, 4, 3, 4, 7, -1, -1, -1, -1],
[8, 4, 7, 9, 0, 5, 0, 6, 5, 0, 2, 6, -1, -1, -1, -1],
[7, 3, 9, 7, 9, 4, 3, 2, 9, 5, 9, 6, 2, 6, 9, -1],
[3, 11, 2, 7, 8, 4, 10, 6, 5, -1, -1, -1, -1, -1, -1, -1],
[5, 10, 6, 4, 7, 2, 4, 2, 0, 2, 7, 11, -1, -1, -1, -1],
[0, 1, 9, 4, 7, 8, 2, 3, 11, 5, 10, 6, -1, -1, -1, -1],
[9, 2, 1, 9, 11, 2, 9, 4, 11, 7, 11, 4, 5, 10, 6, -1],
[8, 4, 7, 3, 11, 5, 3, 5, 1, 5, 11, 6, -1, -1, -1, -1],
[5, 1, 11, 5, 11, 6, 1, 0, 11, 7, 11, 4, 0, 4, 11, -1],
[0, 5, 9, 0, 6, 5, 0, 3, 6, 11, 6, 3, 8, 4, 7, -1],
[6, 5, 9, 6, 9, 11, 4, 7, 9, 7, 11, 9, -1, -1, -1, -1],
[10, 4, 9, 6, 4, 10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[4, 10, 6, 4, 9, 10, 0, 8, 3, -1, -1, -1, -1, -1, -1, -1],
[10, 0, 1, 10, 6, 0, 6, 4, 0, -1, -1, -1, -1, -1, -1, -1],
[8, 3, 1, 8, 1, 6, 8, 6, 4, 6, 1, 10, -1, -1, -1, -1],
[1, 4, 9, 1, 2, 4, 2, 6, 4, -1, -1, -1, -1, -1, -1, -1],
[3, 0, 8, 1, 2, 9, 2, 4, 9, 2, 6, 4, -1, -1, -1, -1],
[0, 2, 4, 4, 2, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[8, 3, 2, 8, 2, 4, 4, 2, 6, -1, -1, -1, -1, -1, -1, -1],
[10, 4, 9, 10, 6, 4, 11, 2, 3, -1, -1, -1, -1, -1, -1, -1],
[0, 8, 2, 2, 8, 11, 4, 9, 10, 4, 10, 6, -1, -1, -1, -1],
[3, 11, 2, 0, 1, 6, 0, 6, 4, 6, 1, 10, -1, -1, -1, -1],
[6, 4, 1, 6, 1, 10, 4, 8, 1, 2, 1, 11, 8, 11, 1, -1],
[9, 6, 4, 9, 3, 6, 9, 1, 3, 11, 6, 3, -1, -1, -1, -1],
[8, 11, 1, 8, 1, 0, 11, 6, 1, 9, 1, 4, 6, 4, 1, -1],
[3, 11, 6, 3, 6, 0, 0, 6, 4, -1, -1, -1, -1, -1, -1, -1],
[6, 4, 8, 11, 6, 8, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[7, 10, 6, 7, 8, 10, 8, 9, 10, -1, -1, -1, -1, -1, -1, -1],
[0, 7, 3, 0, 10, 7, 0, 9, 10, 6, 7, 10, -1, -1, -1, -1],
[10, 6, 7, 1, 10, 7, 1, 7, 8, 1, 8, 0, -1, -1, -1, -1],
[10, 6, 7, 10, 7, 1, 1, 7, 3, -1, -1, -1, -1, -1, -1, -1],
[1, 2, 6, 1, 6, 8, 1, 8, 9, 8, 6, 7, -1, -1, -1, -1],
[2, 6, 9, 2, 9, 1, 6, 7, 9, 0, 9, 3, 7, 3, 9, -1],
[7, 8, 0, 7, 0, 6, 6, 0, 2, -1, -1, -1, -1, -1, -1, -1],
[7, 3, 2, 6, 7, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[2, 3, 11, 10, 6, 8, 10, 8, 9, 8, 6, 7, -1, -1, -1, -1],
[2, 0, 7, 2, 7, 11, 0, 9, 7, 6, 7, 10, 9, 10, 7, -1],
[1, 8, 0, 1, 7, 8, 1, 10, 7, 6, 7, 10, 2, 3, 11, -1],
[11, 2, 1, 11, 1, 7, 10, 6, 1, 6, 7, 1, -1, -1, -1, -1],
[8, 9, 6, 8, 6, 7, 9, 1, 6, 11, 6, 3, 1, 3, 6, -1],
[0, 9, 1, 11, 6, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[7, 8, 0, 7, 0, 6, 3, 11, 0, 11, 6, 0, -1, -1, -1, -1],
[7, 11, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[7, 6, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[3, 0, 8, 11, 7, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 1, 9, 11, 7, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[8, 1, 9, 8, 3, 1, 11, 7, 6, -1, -1, -1, -1, -1, -1, -1],
[10, 1, 2, 6, 11, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 2, 10, 3, 0, 8, 6, 11, 7, -1, -1, -1, -1, -1, -1, -1],
[2, 9, 0, 2, 10, 9, 6, 11, 7, -1, -1, -1, -1, -1, -1, -1],
[6, 11, 7, 2, 10, 3, 10, 8, 3, 10, 9, 8, -1, -1, -1, -1],
[7, 2, 3, 6, 2, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[7, 0, 8, 7, 6, 0, 6, 2, 0, -1, -1, -1, -1, -1, -1, -1],
[2, 7, 6, 2, 3, 7, 0, 1, 9, -1, -1, -1, -1, -1, -1, -1],
[1, 6, 2, 1, 8, 6, 1, 9, 8, 8, 7, 6, -1, -1, -1, -1],
[10, 7, 6, 10, 1, 7, 1, 3, 7, -1, -1, -1, -1, -1, -1, -1],
[10, 7, 6, 1, 7, 10, 1, 8, 7, 1, 0, 8, -1, -1, -1, -1],
[0, 3, 7, 0, 7, 10, 0, 10, 9, 6, 10, 7, -1, -1, -1, -1],
[7, 6, 10, 7, 10, 8, 8, 10, 9, -1, -1, -1, -1, -1, -1, -1],
[6, 8, 4, 11, 8, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[3, 6, 11, 3, 0, 6, 0, 4, 6, -1, -1, -1, -1, -1, -1, -1],
[8, 6, 11, 8, 4, 6, 9, 0, 1, -1, -1, -1, -1, -1, -1, -1],
[9, 4, 6, 9, 6, 3, 9, 3, 1, 11, 3, 6, -1, -1, -1, -1],
[6, 8, 4, 6, 11, 8, 2, 10, 1, -1, -1, -1, -1, -1, -1, -1],
[1, 2, 10, 3, 0, 11, 0, 6, 11, 0, 4, 6, -1, -1, -1, -1],
[4, 11, 8, 4, 6, 11, 0, 2, 9, 2, 10, 9, -1, -1, -1, -1],
[10, 9, 3, 10, 3, 2, 9, 4, 3, 11, 3, 6, 4, 6, 3, -1],
[8, 2, 3, 8, 4, 2, 4, 6, 2, -1, -1, -1, -1, -1, -1, -1],
[0, 4, 2, 4, 6, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 9, 0, 2, 3, 4, 2, 4, 6, 4, 3, 8, -1, -1, -1, -1],
[1, 9, 4, 1, 4, 2, 2, 4, 6, -1, -1, -1, -1, -1, -1, -1],
[8, 1, 3, 8, 6, 1, 8, 4, 6, 6, 10, 1, -1, -1, -1, -1],
[10, 1, 0, 10, 0, 6, 6, 0, 4, -1, -1, -1, -1, -1, -1, -1],
[4, 6, 3, 4, 3, 8, 6, 10, 3, 0, 3, 9, 10, 9, 3, -1],
[10, 9, 4, 6, 10, 4, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[4, 9, 5, 7, 6, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 8, 3, 4, 9, 5, 11, 7, 6, -1, -1, -1, -1, -1, -1, -1],
[5, 0, 1, 5, 4, 0, 7, 6, 11, -1, -1, -1, -1, -1, -1, -1],
[11, 7, 6, 8, 3, 4, 3, 5, 4, 3, 1, 5, -1, -1, -1, -1],
[9, 5, 4, 10, 1, 2, 7, 6, 11, -1, -1, -1, -1, -1, -1, -1],
[6, 11, 7, 1, 2, 10, 0, 8, 3, 4, 9, 5, -1, -1, -1, -1],
[7, 6, 11, 5, 4, 10, 4, 2, 10, 4, 0, 2, -1, -1, -1, -1],
[3, 4, 8, 3, 5, 4, 3, 2, 5, 10, 5, 2, 11, 7, 6, -1],
[7, 2, 3, 7, 6, 2, 5, 4, 9, -1, -1, -1, -1, -1, -1, -1],
[9, 5, 4, 0, 8, 6, 0, 6, 2, 6, 8, 7, -1, -1, -1, -1],
[3, 6, 2, 3, 7, 6, 1, 5, 0, 5, 4, 0, -1, -1, -1, -1],
[6, 2, 8, 6, 8, 7, 2, 1, 8, 4, 8, 5, 1, 5, 8, -1],
[9, 5, 4, 10, 1, 6, 1, 7, 6, 1, 3, 7, -1, -1, -1, -1],
[1, 6, 10, 1, 7, 6, 1, 0, 7, 8, 7, 0, 9, 5, 4, -1],
[4, 0, 10, 4, 10, 5, 0, 3, 10, 6, 10, 7, 3, 7, 10, -1],
[7, 6, 10, 7, 10, 8, 5, 4, 10, 4, 8, 10, -1, -1, -1, -1],
[6, 9, 5, 6, 11, 9, 11, 8, 9, -1, -1, -1, -1, -1, -1, -1],
[3, 6, 11, 0, 6, 3, 0, 5, 6, 0, 9, 5, -1, -1, -1, -1],
[0, 11, 8, 0, 5, 11, 0, 1, 5, 5, 6, 11, -1, -1, -1, -1],
[6, 11, 3, 6, 3, 5, 5, 3, 1, -1, -1, -1, -1, -1, -1, -1],
[1, 2, 10, 9, 5, 11, 9, 11, 8, 11, 5, 6, -1, -1, -1, -1],
[0, 11, 3, 0, 6, 11, 0, 9, 6, 5, 6, 9, 1, 2, 10, -1],
[11, 8, 5, 11, 5, 6, 8, 0, 5, 10, 5, 2, 0, 2, 5, -1],
[6, 11, 3, 6, 3, 5, 2, 10, 3, 10, 5, 3, -1, -1, -1, -1],
[5, 8, 9, 5, 2, 8, 5, 6, 2, 3, 8, 2, -1, -1, -1, -1],
[9, 5, 6, 9, 6, 0, 0, 6, 2, -1, -1, -1, -1, -1, -1, -1],
[1, 5, 8, 1, 8, 0, 5, 6, 8, 3, 8, 2, 6, 2, 8, -1],
[1, 5, 6, 2, 1, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 3, 6, 1, 6, 10, 3, 8, 6, 5, 6, 9, 8, 9, 6, -1],
[10, 1, 0, 10, 0, 6, 9, 5, 0, 5, 6, 0, -1, -1, -1, -1],
[0, 3, 8, 5, 6, 10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[10, 5, 6, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[11, 5, 10, 7, 5, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[11, 5, 10, 11, 7, 5, 8, 3, 0, -1, -1, -1, -1, -1, -1, -1],
[5, 11, 7, 5, 10, 11, 1, 9, 0, -1, -1, -1, -1, -1, -1, -1],
[10, 7, 5, 10, 11, 7, 9, 8, 1, 8, 3, 1, -1, -1, -1, -1],
[11, 1, 2, 11, 7, 1, 7, 5, 1, -1, -1, -1, -1, -1, -1, -1],
[0, 8, 3, 1, 2, 7, 1, 7, 5, 7, 2, 11, -1, -1, -1, -1],
[9, 7, 5, 9, 2, 7, 9, 0, 2, 2, 11, 7, -1, -1, -1, -1],
[7, 5, 2, 7, 2, 11, 5, 9, 2, 3, 2, 8, 9, 8, 2, -1],
[2, 5, 10, 2, 3, 5, 3, 7, 5, -1, -1, -1, -1, -1, -1, -1],
[8, 2, 0, 8, 5, 2, 8, 7, 5, 10, 2, 5, -1, -1, -1, -1],
[9, 0, 1, 5, 10, 3, 5, 3, 7, 3, 10, 2, -1, -1, -1, -1],
[9, 8, 2, 9, 2, 1, 8, 7, 2, 10, 2, 5, 7, 5, 2, -1],
[1, 3, 5, 3, 7, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 8, 7, 0, 7, 1, 1, 7, 5, -1, -1, -1, -1, -1, -1, -1],
[9, 0, 3, 9, 3, 5, 5, 3, 7, -1, -1, -1, -1, -1, -1, -1],
[9, 8, 7, 5, 9, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[5, 8, 4, 5, 10, 8, 10, 11, 8, -1, -1, -1, -1, -1, -1, -1],
[5, 0, 4, 5, 11, 0, 5, 10, 11, 11, 3, 0, -1, -1, -1, -1],
[0, 1, 9, 8, 4, 10, 8, 10, 11, 10, 4, 5, -1, -1, -1, -1],
[10, 11, 4, 10, 4, 5, 11, 3, 4, 9, 4, 1, 3, 1, 4, -1],
[2, 5, 1, 2, 8, 5, 2, 11, 8, 4, 5, 8, -1, -1, -1, -1],
[0, 4, 11, 0, 11, 3, 4, 5, 11, 2, 11, 1, 5, 1, 11, -1],
[0, 2, 5, 0, 5, 9, 2, 11, 5, 4, 5, 8, 11, 8, 5, -1],
[9, 4, 5, 2, 11, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[2, 5, 10, 3, 5, 2, 3, 4, 5, 3, 8, 4, -1, -1, -1, -1],
[5, 10, 2, 5, 2, 4, 4, 2, 0, -1, -1, -1, -1, -1, -1, -1],
[3, 10, 2, 3, 5, 10, 3, 8, 5, 4, 5, 8, 0, 1, 9, -1],
[5, 10, 2, 5, 2, 4, 1, 9, 2, 9, 4, 2, -1, -1, -1, -1],
[8, 4, 5, 8, 5, 3, 3, 5, 1, -1, -1, -1, -1, -1, -1, -1],
[0, 4, 5, 1, 0, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[8, 4, 5, 8, 5, 3, 9, 0, 5, 0, 3, 5, -1, -1, -1, -1],
[9, 4, 5, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[4, 11, 7, 4, 9, 11, 9, 10, 11, -1, -1, -1, -1, -1, -1, -1],
[0, 8, 3, 4, 9, 7, 9, 11, 7, 9, 10, 11, -1, -1, -1, -1],
[1, 10, 11, 1, 11, 4, 1, 4, 0, 7, 4, 11, -1, -1, -1, -1],
[3, 1, 4, 3, 4, 8, 1, 10, 4, 7, 4, 11, 10, 11, 4, -1],
[4, 11, 7, 9, 11, 4, 9, 2, 11, 9, 1, 2, -1, -1, -1, -1],
[9, 7, 4, 9, 11, 7, 9, 1, 11, 2, 11, 1, 0, 8, 3, -1],
[11, 7, 4, 11, 4, 2, 2, 4, 0, -1, -1, -1, -1, -1, -1, -1],
[11, 7, 4, 11, 4, 2, 8, 3, 4, 3, 2, 4, -1, -1, -1, -1],
[2, 9, 10, 2, 7, 9, 2, 3, 7, 7, 4, 9, -1, -1, -1, -1],
[9, 10, 7, 9, 7, 4, 10, 2, 7, 8, 7, 0, 2, 0, 7, -1],
[3, 7, 10, 3, 10, 2, 7, 4, 10, 1, 10, 0, 4, 0, 10, -1],
[1, 10, 2, 8, 7, 4, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[4, 9, 1, 4, 1, 7, 7, 1, 3, -1, -1, -1, -1, -1, -1, -1],
[4, 9, 1, 4, 1, 7, 0, 8, 1, 8, 7, 1, -1, -1, -1, -1],
[4, 0, 3, 7, 4, 3, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[4, 8, 7, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[9, 10, 8, 10, 11, 8, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[3, 0, 9, 3, 9, 11, 11, 9, 10, -1, -1, -1, -1, -1, -1, -1],
[0, 1, 10, 0, 10, 8, 8, 10, 11, -1, -1, -1, -1, -1, -1, -1],
[3, 1, 10, 11, 3, 10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 2, 11, 1, 11, 9, 9, 11, 8, -1, -1, -1, -1, -1, -1, -1],
[3, 0, 9, 3, 9, 11, 1, 2, 9, 2, 11, 9, -1, -1, -1, -1],
[0, 2, 11, 8, 0, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[3, 2, 11, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[2, 3, 8, 2, 8, 10, 10, 8, 9, -1, -1, -1, -1, -1, -1, -1],
[9, 10, 2, 0, 9, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[2, 3, 8, 2, 8, 10, 0, 1, 8, 1, 10, 8, -1, -1, -1, -1],
[1, 10, 2, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[1, 3, 8, 9, 1, 8, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 9, 1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[0, 3, 8, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1],
[-1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1]
];


// Corner index -> (dx, dy, dz) within a cube
const CORNER_OFFSETS = [
    [0, 0, 0], // 0
    [1, 0, 0], // 1
    [1, 1, 0], // 2
    [0, 1, 0], // 3
    [0, 0, 1], // 4
    [1, 0, 1], // 5
    [1, 1, 1], // 6
    [0, 1, 1], // 7
];

// Edge index -> [cornerA, cornerB]
const EDGE_CORNER_PAIRS = [
    [0, 1], // 0
    [1, 2], // 1
    [2, 3], // 2
    [3, 0], // 3
    [4, 5], // 4
    [5, 6], // 5
    [6, 7], // 6
    [7, 4], // 7
    [0, 4], // 8
    [1, 5], // 9
    [2, 6], // 10
    [3, 7], // 11
];

export class MarchingCubesTerrain {
    constructor(scene, options = {}) {
        this.scene = scene;

        // Grid resolution – tweak these if perf is bad / mesh too coarse
        this.dimX = options.dimX ?? 32;
        this.dimY = options.dimY ?? 32;
        this.dimZ = options.dimZ ?? 32;

        this.cellSize = options.cellSize ?? 1.0;
        this.isoLevel = options.isoLevel ?? 0.0;

        // Approximate radius of the planet (in world units)
        this.radius = options.radius ?? 18.0;
        // Center the volume around the origin
        // but allow an explicit world-space origin via options.origin.
        this.origin = options.origin || new BABYLON.Vector3(
            -((this.dimX - 1) * this.cellSize) * 0.5,
            -((this.dimY - 1) * this.cellSize) * 0.5,
            -((this.dimZ - 1) * this.cellSize) * 0.5
        );

        // Optional mesh/material reuse (for chunk pooling)
        this.mesh = options.mesh ?? null;
		this.colliderMesh = null; // NEW: second mesh for physics
		
        this.material = options.material ?? null;

        // Scalar field samples at each grid vertex
        this.field = new Float32Array(this.dimX * this.dimY * this.dimZ);

        // If true, caller will build field/mesh later via rebuildWithSettings()
        this.deferBuild = !!options.deferBuild;

        // Optional: offload SDF generation to Web Worker
        // (used by ChunkedPlanetTerrain for smoother streaming)
        this.useWorker = !!options.useWorker;

        if (!this.deferBuild) {
            if (this.useWorker && typeof Worker !== "undefined") {
                // Fire-and-forget async build for standalone usage
                buildFieldAsync(
                    this.dimX,
                    this.dimY,
                    this.dimZ,
                    this.cellSize,
                    this.radius,
                    this.origin
                )
                    .then((field) => {
                        this.field = field;
                        this._buildMesh();
                    })
                    .catch((err) => {
                        console.error("Worker build failed, falling back:", err);
                        this._buildInitialField();
                        this._buildMesh();
                    });
            } else {
                this._buildInitialField();
                this._buildMesh();
            }
        }
    }

    // Index helper into 1D field array
    _index(x, y, z) {
        return x + this.dimX * (y + this.dimY * z);
    }

	// ====== NEW TERRAIN SDF GENERATION ======
    // ====== NEW TERRAIN SDF USING BUILT-IN HASH NOISE ======
    // ====== SMOOTH PLANET TERRAIN SDF (no blocky hash steps) ======
    // ====== STRONGER, SMOOTH PLANET TERRAIN SDF ======

	    // ---- 3D value noise + FBM helpers (no external libs needed) ----
    // Very small deterministic fake-noise (fast, stable, no import required)
    _hashNoise(x, y, z) {
        // large prime constants
        const a = 1103515245, b = 12345, c = 3141592653;
        let n = x * a ^ y * b ^ z * c;
        n = (n << 13) ^ n;
        return (1.0 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824.0);
    }

    // Hash integer lattice coord -> [0,1]
    _hash3(ix, iy, iz) {
        // Use unsigned 32-bit arithmetic for stability
        let h = ix * 374761393 + iy * 668265263 + iz * 2147483647;
        h = (h ^ (h >> 13)) >>> 0;
        return (h & 0xfffffff) / 0xfffffff; // 0..1
    }

    // Smoothstep used by Perlin-style fade
    _fade(t) {
        return t * t * t * (t * (t * 6 - 15) + 10);
    }

    // Trilinear interpolated value-noise in [0,1]
    _valueNoise3(x, y, z) {
        const ix = Math.floor(x);
        const iy = Math.floor(y);
        const iz = Math.floor(z);

        const fx = x - ix;
        const fy = y - iy;
        const fz = z - iz;

        const ux = this._fade(fx);
        const uy = this._fade(fy);
        const uz = this._fade(fz);

        const v000 = this._hash3(ix,     iy,     iz);
        const v100 = this._hash3(ix + 1, iy,     iz);
        const v010 = this._hash3(ix,     iy + 1, iz);
        const v110 = this._hash3(ix + 1, iy + 1, iz);
        const v001 = this._hash3(ix,     iy,     iz + 1);
        const v101 = this._hash3(ix + 1, iy,     iz + 1);
        const v011 = this._hash3(ix,     iy + 1, iz + 1);
        const v111 = this._hash3(ix + 1, iy + 1, iz + 1);

        const lerp = (a, b, t) => a + (b - a) * t;

        const x00 = lerp(v000, v100, ux);
        const x10 = lerp(v010, v110, ux);
        const x01 = lerp(v001, v101, ux);
        const x11 = lerp(v011, v111, ux);

        const y0 = lerp(x00, x10, uy);
        const y1 = lerp(x01, x11, uy);

        return lerp(y0, y1, uz); // 0..1
    }

    // Fractal Brownian Motion: sum of octaves, result ~[-1,1]
    _fbmNoise3(x, y, z, baseFreq, octaves, lacunarity, gain) {
        let amp = 1.0;
        let freq = baseFreq;
        let sum = 0.0;
        let norm = 0.0;

        for (let i = 0; i < octaves; i++) {
            const n = this._valueNoise3(x * freq, y * freq, z * freq); // 0..1
            const v = n * 2.0 - 1.0; // -> [-1,1]
            sum += v * amp;
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        if (norm > 0) sum /= norm;
        return sum; // approx [-1,1]
    }

    // Ridged multifractal FBM: sharp peaks, in [0,1]
    _ridgedFbm3(x, y, z, baseFreq, octaves, lacunarity, gain) {
        let amp = 1.0;
        let freq = baseFreq;
        let sum = 0.0;
        let norm = 0.0;

        for (let i = 0; i < octaves; i++) {
            const n = this._valueNoise3(x * freq, y * freq, z * freq); // 0..1
            // Convert to ridges: 1 - |2n-1|
            const v = 1.0 - Math.abs(2.0 * n - 1.0); // 0..1
            sum += v * amp;
            norm += amp;
            amp *= gain;
            freq *= lacunarity;
        }
        if (norm > 0) sum /= norm;
        return sum; // [0,1]
    }

    // ====== DOMAIN-WARPED FRACTAL PLANET TERRAIN FOR RADIUS ≈ 3600 ======
    // ====== DOMAIN-WARPED FRACTAL PLANET TERRAIN FOR RADIUS ≈ 10800 ======
    _sampleSdf(pos) {
        const p = pos;
        const R = this.radius;  // e.g. 10800

        // Distance from planet center
        const distSq = p.x * p.x + p.y * p.y + p.z * p.z;
        const dist = Math.sqrt(distSq);
        if (dist < 1e-6) {
            return dist - R;
        }

        // -------- 1) DOMAIN WARP --------
        // Scales chosen for planet radius ~10800 (3x bigger than before).
        const warp1 = this._fbmNoise3(
            p.x, p.y, p.z,
            0.00035 / 3.0,   // was 0.00035
            3,
            2.0,
            0.5
        ); // [-1,1]

        const warp2 = this._fbmNoise3(
            p.x + 10000.0,
            p.y - 7000.0,
            p.z + 3000.0,
            0.0008 / 3.0,    // was 0.0008
            2,
            2.0,
            0.5
        ); // [-1,1]

        const warpStrength1 = 800.0 * 3.0;  // 2400
        const warpStrength2 = 300.0 * 3.0;  // 900

        const wx = p.x + warp1 * warpStrength1 + warp2 * warpStrength2;
        const wy = p.y + warp1 * warpStrength1 * 0.6 + warp2 * warpStrength2 * 0.4;
        const wz = p.z + warp1 * warpStrength1 + warp2 * warpStrength2 * 0.2;

        // -------- 2) CONTINENTS --------
        const continents = this._fbmNoise3(
            wx, wy, wz,
            0.00045 / 3.0,   // was 0.00045
            4,
            2.0,
            0.5
        ); // [-1,1]

        const continentHeight = continents * (600.0 * 3.0);  // +/- 1800m

        // -------- 3) RIDGED MOUNTAIN CHAINS --------
        let ridges = this._ridgedFbm3(
            wx + 5000.0,
            wy - 2000.0,
            wz + 1000.0,
            0.0018 / 3.0,    // was 0.0018
            4,
            2.1,
            0.5
        ); // [0,1]

        const contMask = Math.max(0, (continents - 0.2) / 0.8); // 0..1
        ridges *= contMask;

        ridges = Math.max(0, ridges - 0.3) / 0.7;
        ridges = ridges * ridges;

        const mountainHeight = ridges * (1200.0 * 3.0);       // up to ~3.6 km

        // -------- 4) MACRO VALLEYS / BASINS --------
        const valleysNoise = this._fbmNoise3(
            wx - 7000.0,
            wy + 3000.0,
            wz - 2000.0,
            0.00025 / 3.0,   // was 0.00025
            3,
            2.0,
            0.5
        ); // [-1,1]
        const valleyDepth = valleysNoise * (400.0 * 3.0);     // +/- 1.2 km

        // -------- 5) EFFECTIVE TERRAIN RADIUS --------
        const effectiveRadius = R + continentHeight + mountainHeight + valleyDepth;

        let d = dist - effectiveRadius;

        // -------- 6) CAVES (INSIDE THE PLANET) --------
        const innerSurface = R - 180.0; // scaled from 60 for bigger planet
        if (dist < innerSurface) {
            const caves = this._fbmNoise3(
                p.x * 1.5,
                p.y * 1.5,
                p.z * 1.5,
                0.009 / 3.0,   // was 0.009
                3,
                2.0,
                0.5
            ); // [-1,1]

            if (caves > 0.25) {
                d += (caves - 0.25) * (90.0 * 3.0); // carve bigger voids
            }
        }

        return d;
    }



    _buildInitialField() {
        for (let z = 0; z < this.dimZ; z++) {
            for (let y = 0; y < this.dimY; y++) {
                for (let x = 0; x < this.dimX; x++) {
                    const worldPos = this.origin.add(
                        new BABYLON.Vector3(
                            x * this.cellSize,
                            y * this.cellSize,
                            z * this.cellSize
                        )
                    );
                    const v = this._sampleSdf(worldPos);
                    this.field[this._index(x, y, z)] = v;
                }
            }
        }
    }

    // Public: carve out a ball of emptiness at worldPos
    // options.deferRebuild === true  => only change field, caller will rebuild mesh
    carveSphere(worldPos, radius, options = {}) {
        const deferRebuild = !!options.deferRebuild;
        const r2 = radius * radius;

        // Compute the bounds of the sphere in local grid coordinates
        const minX = Math.max(
            0,
            Math.floor((worldPos.x - radius - this.origin.x) / this.cellSize)
        );
        const maxX = Math.min(
            this.dimX - 1,
            Math.ceil((worldPos.x + radius - this.origin.x) / this.cellSize)
        );

        const minY = Math.max(
            0,
            Math.floor((worldPos.y - radius - this.origin.y) / this.cellSize)
        );
        const maxY = Math.min(
            this.dimY - 1,
            Math.ceil((worldPos.y + radius - this.origin.y) / this.cellSize)
        );

        const minZ = Math.max(
            0,
            Math.floor((worldPos.z - radius - this.origin.z) / this.cellSize)
        );
        const maxZ = Math.min(
            this.dimZ - 1,
            Math.ceil((worldPos.z + radius - this.origin.z) / this.cellSize)
        );

        for (let z = minZ; z <= maxZ; z++) {
            for (let y = minY; y <= maxY; y++) {
                for (let x = minX; x <= maxX; x++) {
                    const idx = this._index(x, y, z);
                    const pos = this.origin.add(
                        new BABYLON.Vector3(
                            x * this.cellSize,
                            y * this.cellSize,
                            z * this.cellSize
                        )
                    );

                    const d2 = BABYLON.Vector3.DistanceSquared(pos, worldPos);

                    // If we’re inside the carving sphere, push field to positive (empty)
                    if (d2 <= r2 && this.field[idx] < this.isoLevel) {
                        this.field[idx] = this.isoLevel + 0.01;
                    }
                }
            }
        }

        if (!deferRebuild) {
            this._buildMesh();
        }
    }

    // Rebuild mesh from current field without touching the field
    rebuildMeshOnly() {
        this._buildMesh();
    }


    /**
     * Compute terrain color at a given world-space position.
     * Handles:
     * - surface grass/sand
     * - underground brown → dark brown → glowing core
     * - mountains: rock → snow
     */
    // NEW HEIGHT–BIOME–DEPTH COLORING WITH SEA LEVEL & BEACHES
    // HEIGHT–BASED COLORING WITH CONFORMING WATER & SNOW
    _getColorForWorldPos(worldPos) {
        const R = this.radius;
        const dist = worldPos.length();
        const h = dist - R; // height above base radius (can be negative)

        // Sea level, relative to R
        const seaLevel = 220;      // meters above base radius
        const beachWidth = 40;     // +/- around sea level for beaches

        // Unit direction for latitude effects (snow at poles)
        let nx = 0, ny = 1, nz = 0;
        if (dist > 1e-6) {
            nx = worldPos.x / dist;
            ny = worldPos.y / dist;
            nz = worldPos.z / dist;
        }

        // -------- UNDERGROUND: soil / rock / magma --------
        if (h < 0) {
            const depth = -h;

            if (depth < 30) {
                return new BABYLON.Color3(0.45, 0.30, 0.15);
            }

            if (depth < 250) {
                const t = (depth - 30) / (250 - 30);
                const a = new BABYLON.Color3(0.35, 0.22, 0.10);
                const b = new BABYLON.Color3(0.18, 0.10, 0.05);
                return BABYLON.Color3.Lerp(a, b, t);
            }

            const maxDepth = 1500;
            const clamped = Math.min(depth, maxDepth);
            const t = (clamped - 250) / (maxDepth - 250);
            const rock = new BABYLON.Color3(0.18, 0.10, 0.05);
            const lava = new BABYLON.Color3(1.0, 0.4, 0.05);
            return BABYLON.Color3.Lerp(rock, lava, t);
        }

        // -------- DEEP WATER (terrain well below sea level) --------
        if (h < seaLevel - beachWidth) {
            // Darker bluish seafloor
            return new BABYLON.Color3(0.02, 0.12, 0.25);
        }

        // -------- SHALLOW WATER + BEACH RING --------
        if (h <= seaLevel + beachWidth) {
            // Blend from shallow water to sand across the band
            const t = (h - (seaLevel - beachWidth)) / (2 * beachWidth); // 0..1
            const shallow = new BABYLON.Color3(0.15, 0.45, 0.75);       // shallow water tint
            const sand    = new BABYLON.Color3(0.96, 0.88, 0.60);       // beach sand
            return BABYLON.Color3.Lerp(shallow, sand, t);
        }

        // From this point on we're above the beach band.
        const aboveSea = h - (seaLevel + beachWidth); // 0 at top of beach

        // Small fake noise for grass variation
        const n = this._hashNoise(
            Math.floor(worldPos.x * 0.02),
            Math.floor(worldPos.y * 0.02),
            Math.floor(worldPos.z * 0.02)
        ); // [-1, 1]
        const grassJitter = 0.03 * n;

        // -------- LOWLANDS: 0–250m above beaches (grasslands) --------
        if (aboveSea < 250) {
            const t = aboveSea / 250; // 0..1
            const grassLow  = new BABYLON.Color3(0.20, 0.75 + grassJitter, 0.32);
            const grassHigh = new BABYLON.Color3(0.14, 0.58, 0.26);
            return BABYLON.Color3.Lerp(grassLow, grassHigh, t);
        }

        // -------- MID ALTITUDE: 250–700m above beaches (rocky hills) --------
        if (aboveSea < 700) {
            const t = (aboveSea - 250) / (700 - 250); // 0..1
            const rockBrown = new BABYLON.Color3(0.45, 0.40, 0.35);
            const rockGrey  = new BABYLON.Color3(0.65, 0.65, 0.68);
            return BABYLON.Color3.Lerp(rockBrown, rockGrey, t);
        }

        // -------- HIGH ALTITUDE: >700m above beaches (snow / ice) --------
        const snowBase = new BABYLON.Color3(0.80, 0.82, 0.87);
        const snowPure = new BABYLON.Color3(1.0, 1.0, 1.0);

        // Height factor: start snow ~700m above beaches, full by ~1600m
        const heightT = Math.min(1, (aboveSea - 700) / 900);

        // Latitude factor: more snow toward poles
        const latT = Math.min(1, Math.abs(ny));

        const snowMix = BABYLON.Color3.Lerp(snowBase, snowPure, heightT);
        return BABYLON.Color3.Lerp(snowMix, snowPure, latT * 0.5);
    }


    _buildMesh() {
        const positions = [];
        const normals = [];
        const indices = [];
        const colors = []; // <--- NEW

        const worldPos = (gx, gy, gz) =>
            this.origin.add(
                new BABYLON.Vector3(
                    gx * this.cellSize,
                    gy * this.cellSize,
                    gz * this.cellSize
                )
            );

        const vertList = new Array(12);

        // March over all cubes in the grid
        for (let z = 0; z < this.dimZ - 1; z++) {
            for (let y = 0; y < this.dimY - 1; y++) {
                for (let x = 0; x < this.dimX - 1; x++) {
                    const cornerValues = new Array(8);
                    const cornerPositions = new Array(8);

                    // Sample the 8 corners of this cube
                    for (let i = 0; i < 8; i++) {
                        const [dx, dy, dz] = CORNER_OFFSETS[i];
                        const gx = x + dx;
                        const gy = y + dy;
                        const gz = z + dz;

                        const idx = this._index(gx, gy, gz);
                        const v = this.field[idx];

                        cornerValues[i] = v;
                        cornerPositions[i] = worldPos(gx, gy, gz);
                    }

                    // Determine cube index
                    let cubeIndex = 0;
                    if (cornerValues[0] < this.isoLevel) cubeIndex |= 1;
                    if (cornerValues[1] < this.isoLevel) cubeIndex |= 2;
                    if (cornerValues[2] < this.isoLevel) cubeIndex |= 4;
                    if (cornerValues[3] < this.isoLevel) cubeIndex |= 8;
                    if (cornerValues[4] < this.isoLevel) cubeIndex |= 16;
                    if (cornerValues[5] < this.isoLevel) cubeIndex |= 32;
                    if (cornerValues[6] < this.isoLevel) cubeIndex |= 64;
                    if (cornerValues[7] < this.isoLevel) cubeIndex |= 128;

                    const edgeMask = edgeTable[cubeIndex];
                    if (!edgeMask) continue;

                    // Interpolate along edges where the surface cuts
                    for (let e = 0; e < 12; e++) {
                        if (!(edgeMask & (1 << e))) continue;

                        const [aIdx, bIdx] = EDGE_CORNER_PAIRS[e];
                        const va = cornerValues[aIdx];
                        const vb = cornerValues[bIdx];
                        const pa = cornerPositions[aIdx];
                        const pb = cornerPositions[bIdx];

                        const t =
                            Math.abs(vb - va) < 1e-6
                                ? 0.5
                                : (this.isoLevel - va) / (vb - va);

                        vertList[e] = BABYLON.Vector3.Lerp(pa, pb, t);
                    }

                    // Build triangles from triTable
                    const triRow = triTable[cubeIndex];
                    for (let i = 0; i < 16; i += 3) {
                        const e0 = triRow[i];
                        const e1 = triRow[i + 1];
                        const e2 = triRow[i + 2];

                        // end of this configuration
                        if (e0 === -1 || e1 === -1 || e2 === -1) break;

                        const p0 = vertList[e0];
                        const p1 = vertList[e1];
                        const p2 = vertList[e2];

                        if (!p0 || !p1 || !p2) continue;

                        const baseIndex = positions.length / 3;

                        // Positions
                        positions.push(
                            p0.x, p0.y, p0.z,
                            p1.x, p1.y, p1.z,
                            p2.x, p2.y, p2.z
                        );

                        // Indices
                        indices.push(baseIndex, baseIndex + 1, baseIndex + 2);

                        // Colors per vertex
                        const c0 = this._getColorForWorldPos(p0);
                        const c1 = this._getColorForWorldPos(p1);
                        const c2 = this._getColorForWorldPos(p2);

                        colors.push(c0.r, c0.g, c0.b, 1.0);
                        colors.push(c1.r, c1.g, c1.b, 1.0);
                        colors.push(c2.r, c2.g, c2.b, 1.0);
                    }
                }
            }
        }

        // If this chunk is empty, disable its mesh and bail
        if (positions.length === 0 || indices.length === 0) {
            if (this.mesh) {
                this.mesh.setEnabled(false);
            }
            return;
        }

        // Compute normals
        BABYLON.VertexData.ComputeNormals(positions, indices, normals);

        const vertexData = new BABYLON.VertexData();
        vertexData.positions = positions;
        vertexData.indices = indices;
        vertexData.normals = normals;

        if (colors.length > 0) {
            vertexData.colors = colors; // <--- NEW
        }

        if (!this.mesh) {
            this.mesh = new BABYLON.Mesh("marchingCubesTerrain", this.scene);

            if (!this.material) {
                this.material = new BABYLON.StandardMaterial(
                    "terrainMat",
                    this.scene
                );
                this.material.diffuseColor = new BABYLON.Color3(1, 1, 1);
                this.material.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
                this.material.backFaceCulling = false;
            }

            this.mesh.material = this.material;
        } else {
            this.mesh.setEnabled(true);
        }

        // IMPORTANT: enable vertex color usage
        if (this.mesh.material) {
            this.mesh.material.useVertexColors = true;
        }

		// Mark terrain chunks as pickable ground for player raycasts
		this.mesh.isPickable = true;
		this.mesh.checkCollisions = true; // optional but nice
		this.mesh.metadata = this.mesh.metadata || {};
		this.mesh.metadata.isVoxelTerrain = true; // <-- voxel chunk tag

		this.mesh.metadata.isTerrain = true;


        vertexData.applyToMesh(this.mesh, true);
    }


    // Rebuild with possibly new resolution / cellSize / origin (used for LOD + streaming)
    // If this.useWorker is true, this may return a Promise that resolves
    // when the worker has finished building the field + mesh.
    rebuildWithSettings(settings) {
        // Update core parameters
        if (settings.dimX && settings.dimY && settings.dimZ) {
            this.dimX = settings.dimX;
            this.dimY = settings.dimY;
            this.dimZ = settings.dimZ;
        }

        if (settings.cellSize) {
            this.cellSize = settings.cellSize;
        }

        if (settings.origin) {
            this.origin = settings.origin.clone
                ? settings.origin.clone()
                : new BABYLON.Vector3(
                      settings.origin.x,
                      settings.origin.y,
                      settings.origin.z
                  );
        }

        // Recreate field for new resolution
        this.field = new Float32Array(this.dimX * this.dimY * this.dimZ);

        if (this.useWorker && typeof Worker !== "undefined") {
            // Async path: build field in worker, then build mesh on main thread
            return buildFieldAsync(
                this.dimX,
                this.dimY,
                this.dimZ,
                this.cellSize,
                this.radius,
                this.origin
            )
                .then((field) => {
                    this.field = field;
                    this._buildMesh();
                })
                .catch((err) => {
                    console.error("Worker rebuild failed, falling back:", err);
                    this._buildInitialField();
                    this._buildMesh();
                });
        } else {
            // Synchronous CPU path
            this._buildInitialField();
            this._buildMesh();
            return null;
        }
    }


    // Rebuild this chunk at a new world-space origin (used by streaming).
    // Keeps the same resolution, cellSize, radius, mesh and material.
    // Convenience: only move origin, keep current resolution
    rebuildAtOrigin(newOrigin) {
        this.rebuildWithSettings({ origin: newOrigin });
    }

	
    /**
     * TEMPORARY COLLIDER MESH BUILDER
     * -------------------------------
     * Right now we simply reuse the visual mesh as the collider mesh.
     * This keeps behavior stable while we build out the real collider
     * generation pipeline in later steps.
     *
     * Later:
     *  - we will generate a lower-poly collider mesh
     *  - physics LOD will be independent of render LOD
     *  - player will walk on this collider instead of the render mesh
     */
    rebuildColliderFromField() {
        // No render mesh? No collider.
        if (!this.mesh) {
            this.colliderMesh = null;
            return;
        }

        // For now, collider = render mesh.
        this.colliderMesh = this.mesh;

        // Make sure collider metadata is set correctly.
        this.colliderMesh.metadata = this.colliderMesh.metadata || {};
        this.colliderMesh.metadata.isTerrainCollider = true;

        // Collision picking only matters for visual mesh,
        // colliderMesh will not be visible anyway.
        this.colliderMesh.checkCollisions = true;
        // We leave isPickable inherited from mesh; collider itself is invisible.
    }



	    /**
     * Build a simplified collider mesh from the existing scalar field.
     * For now, this reuses Marching Cubes at a lower resolution.
     * Later we can swap this for a lower-poly approximation.
     */
    _buildColliderMesh(dimX, dimY, dimZ, cellSize) {
        // TEMP: use the same marching cubes routine but WITHOUT colors
        // and with fewer vertices.
        const positions = [];
        const indices = [];
        const normals = [];

        const iso = this.isoLevel;

        const mcTables = window.mcTables;
        if (!mcTables) {
            console.error("MarchingCubes tables not found for collider mesh.");
            return;
        }

        const edges = mcTables.edges;
        const triTable = mcTables.triTableRaw;

        const interpolate = (p1, p2, val1, val2) => {
            const alpha = (iso - val1) / (val2 - val1);
            return p1 + (p2 - p1) * alpha;
        };

        const offsetField = (x, y, z) => this._index(x, y, z);

        // basic marching cubes loop but WITHOUT colors
        for (let x = 0; x < dimX - 1; x++) {
            for (let y = 0; y < dimY - 1; y++) {
                for (let z = 0; z < dimZ - 1; z++) {
                    const f0 = this.field[offsetField(x, y, z)];
                    const f1 = this.field[offsetField(x + 1, y, z)];
                    const f2 = this.field[offsetField(x, y + 1, z)];
                    const f3 = this.field[offsetField(x + 1, y + 1, z)];
                    const f4 = this.field[offsetField(x, y, z + 1)];
                    const f5 = this.field[offsetField(x + 1, y, z + 1)];
                    const f6 = this.field[offsetField(x, y + 1, z + 1)];
                    const f7 = this.field[offsetField(x + 1, y + 1, z + 1)];

                    let cubeIndex = 0;
                    if (f0 < iso) cubeIndex |= 1;
                    if (f1 < iso) cubeIndex |= 2;
                    if (f3 < iso) cubeIndex |= 8;
                    if (f2 < iso) cubeIndex |= 4;
                    if (f4 < iso) cubeIndex |= 16;
                    if (f5 < iso) cubeIndex |= 32;
                    if (f7 < iso) cubeIndex |= 128;
                    if (f6 < iso) cubeIndex |= 64;

                    if (cubeIndex === 0 || cubeIndex === 255) continue;

                    const baseX = x * cellSize;
                    const baseY = y * cellSize;
                    const baseZ = z * cellSize;

                    const corners = [
                        new BABYLON.Vector3(baseX, baseY, baseZ),
                        new BABYLON.Vector3(baseX + cellSize, baseY, baseZ),
                        new BABYLON.Vector3(baseX, baseY + cellSize, baseZ),
                        new BABYLON.Vector3(baseX + cellSize, baseY + cellSize, baseZ),
                        new BABYLON.Vector3(baseX, baseY, baseZ + cellSize),
                        new BABYLON.Vector3(baseX + cellSize, baseY, baseZ + cellSize),
                        new BABYLON.Vector3(baseX, baseY + cellSize, baseZ + cellSize),
                        new BABYLON.Vector3(baseX + cellSize, baseY + cellSize, baseZ + cellSize),
                    ];

                    const vertList = new Array(12);

                    for (let e = 0; e < 12; e++) {
                        const edgePair = edges[e];
                        if (edgePair === undefined) continue;
                        const i0 = edgePair[0];
                        const i1 = edgePair[1];
                        const p0 = corners[i0];
                        const p1 = corners[i1];

                        const val0 = [f0, f1, f2, f3, f4, f5, f6, f7][i0];
                        const val1 = [f0, f1, f2, f3, f4, f5, f6, f7][i1];

                        const ix = interpolate(p0.x, p1.x, val0, val1);
                        const iy = interpolate(p0.y, p1.y, val0, val1);
                        const iz = interpolate(p0.z, p1.z, val0, val1);

                        vertList[e] = new BABYLON.Vector3(ix, iy, iz);
                    }

                    const triRow = triTable[cubeIndex];
                    for (let t = 0; t < triRow.length; t += 3) {
                        if (triRow[t] < 0) break;
                        const a = vertList[triRow[t]];
                        const b = vertList[triRow[t + 1]];
                        const c = vertList[triRow[t + 2]];
                        if (!a || !b || !c) continue;

                        const idx = positions.length / 3;

                        positions.push(a.x, a.y, a.z);
                        positions.push(b.x, b.y, b.z);
                        positions.push(c.x, c.y, c.z);

                        indices.push(idx, idx + 1, idx + 2);
                    }
                }
            }
        }

        // build or update collider mesh
        if (!this.colliderMesh) {
            this.colliderMesh = new BABYLON.Mesh("terrainCollider", this.scene);
            this.colliderMesh.checkCollisions = true;
            this.colliderMesh.isPickable = false;
            this.colliderMesh.isVisible = false; // invisible
        }

        const colliderData = new BABYLON.VertexData();
        colliderData.positions = positions;
        colliderData.indices = indices;
        BABYLON.VertexData.ComputeNormals(positions, indices, normals);
        colliderData.normals = normals;

        colliderData.applyToMesh(this.colliderMesh);

        this.colliderMesh.position = this.origin;
        this.colliderMesh.metadata = this.colliderMesh.metadata || {};
        this.colliderMesh.metadata.isTerrainCollider = true;
    }

}
