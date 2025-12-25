// src/gameplay/Inventory.js
// Minimal player inventory and currency store for settlements/vendors.

export class Inventory {
    constructor({ startingTokens = 50 } = {}) {
        this.tokens = startingTokens;
        this.items = [];
    }

    addTokens(amount) {
        const delta = Number.isFinite(amount) ? amount : 0;
        this.tokens = Math.max(0, this.tokens + delta);
        return this.tokens;
    }

    spendTokens(amount) {
        const cost = Number.isFinite(amount) ? amount : 0;
        if (this.tokens < cost) return false;
        this.tokens -= cost;
        return true;
    }

    addItem(name, count = 1) {
        if (!name) return;
        const existing = this.items.find((it) => it.name === name);
        if (existing) {
            existing.count += count;
        } else {
            this.items.push({ name, count });
        }
    }

    removeItem(name, count = 1) {
        if (!name) return false;
        const idx = this.items.findIndex((it) => it.name === name);
        if (idx === -1) return false;
        const item = this.items[idx];
        if (item.count <= count) {
            this.items.splice(idx, 1);
        } else {
            item.count -= count;
        }
        return true;
    }

    hasItem(name, count = 1) {
        const it = this.items.find((i) => i.name === name);
        return !!(it && it.count >= count);
    }

    toSnapshot() {
        return {
            tokens: this.tokens,
            items: this.items.map((it) => ({ name: it.name, count: it.count }))
        };
    }

    applySnapshot(snapshot = {}) {
        if (typeof snapshot.tokens === "number") {
            this.tokens = snapshot.tokens;
        }
        if (Array.isArray(snapshot.items)) {
            this.items = snapshot.items.map((it) => ({ name: it.name, count: it.count }));
        }
    }
}
