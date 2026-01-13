export class ColliderQueue {
    constructor({
        updatedCollidersPerSecond = 30,
        now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now())
    } = {}) {
        this.updatedCollidersPerSecond = updatedCollidersPerSecond;
        this._now = now;
        this.queue = [];
        this.pending = new Map();
        this._accumulator = 0;
        this._lastUpdate = this._now();
        this._processedSamples = [];
    }

    setRate(updatedCollidersPerSecond) {
        if (Number.isFinite(updatedCollidersPerSecond)) {
            this.updatedCollidersPerSecond = updatedCollidersPerSecond;
        }
    }

    getQueueLength() {
        return this.queue.length;
    }

    getProcessedPerSecond() {
        const now = this._now();
        const cutoff = now - 1000;
        let count = 0;
        for (const sample of this._processedSamples) {
            if (sample.t >= cutoff) count += sample.count;
        }
        return count;
    }

    request(mesh, desiredState, priority = 0) {
        if (!mesh) return;
        const current = this.pending.get(mesh);
        if (current && current.desiredState === desiredState && current.priority >= priority) {
            return;
        }
        const entry = { mesh, desiredState: !!desiredState, priority };
        this.pending.set(mesh, entry);
        this.queue.push(entry);
    }

    process({ applyUpdate } = {}) {
        const now = this._now();
        const dtSeconds = Math.max(0, (now - this._lastUpdate) / 1000);
        this._lastUpdate = now;

        this._accumulator += dtSeconds * this.updatedCollidersPerSecond;
        const budget = Math.floor(this._accumulator);
        if (budget <= 0) return;
        this._accumulator -= budget;

        this.queue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        let processed = 0;

        while (this.queue.length > 0 && processed < budget) {
            const entry = this.queue.shift();
            if (!entry || !entry.mesh) continue;
            const pendingEntry = this.pending.get(entry.mesh);
            if (!pendingEntry || pendingEntry !== entry) continue;
            this.pending.delete(entry.mesh);

            applyUpdate?.(entry.mesh, entry.desiredState);
            processed++;
        }

        if (processed > 0) {
            this._processedSamples.push({ t: now, count: processed });
            const cutoff = now - 5000;
            while (this._processedSamples.length > 0 && this._processedSamples[0].t < cutoff) {
                this._processedSamples.shift();
            }
        }
    }
}
