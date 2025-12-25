// src/save/SaveSystem.js
// Lightweight localStorage-backed save system with versioned payloads.

export class SaveSystem {
    constructor({ key = "auraion_save_v1", maxCarves = 2000, maxPerRegion = 120, regionSize = null } = {}) {
        this.key = key;
        this.maxCarves = maxCarves;
        this.maxPerRegion = maxPerRegion;
        this.regionSize = regionSize;
    }

    hasSave() {
        try {
            return !!localStorage.getItem(this.key);
        } catch (e) {
            console.warn("SaveSystem.hasSave failed", e);
            return false;
        }
    }

    save(snapshot) {
        if (!snapshot) return;
        const payload = {
            version: 1,
            timestamp: Date.now(),
            ...snapshot
        };
        try {
            localStorage.setItem(this.key, JSON.stringify(payload));
        } catch (e) {
            console.warn("SaveSystem.save failed", e);
        }
    }

    load() {
        try {
            const raw = localStorage.getItem(this.key);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== 1) return null;
            return parsed;
        } catch (e) {
            console.warn("SaveSystem.load failed", e);
            return null;
        }
    }

    clear() {
        try {
            localStorage.removeItem(this.key);
        } catch (e) {
            console.warn("SaveSystem.clear failed", e);
        }
    }

    filterCarves(carveList, options = {}) {
        if (!Array.isArray(carveList) || carveList.length === 0) return [];
        const maxTotal = options.maxCarves ?? this.maxCarves;
        const maxPerRegion = options.maxPerRegion ?? this.maxPerRegion;
        const regionSize = options.regionSize ?? this.regionSize;

        const result = [];
        const perRegion = new Map();

        const keyFor = (pos) => {
            const size = regionSize && regionSize > 0 ? regionSize : 5000;
            const rx = Math.floor(pos.x / size);
            const ry = Math.floor(pos.y / size);
            const rz = Math.floor(pos.z / size);
            return `${rx}|${ry}|${rz}`;
        };

        for (let i = carveList.length - 1; i >= 0; i--) {
            const op = carveList[i];
            if (!op || !op.position) continue;
            const key = keyFor(op.position);
            const count = perRegion.get(key) ?? 0;
            if (count >= maxPerRegion) continue;

            result.push({
                position: { x: op.position.x, y: op.position.y, z: op.position.z },
                radius: op.radius
            });
            perRegion.set(key, count + 1);
            if (result.length >= maxTotal) break;
        }

        return result.reverse();
    }
}
