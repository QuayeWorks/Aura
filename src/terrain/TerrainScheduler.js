export class TerrainScheduler {
    constructor({
        maxConcurrentBuilds = 2,
        buildBudgetMs = 6,
        now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()),
        getPriority = null
    } = {}) {
        this.maxConcurrentBuilds = maxConcurrentBuilds;
        this.buildBudgetMs = buildBudgetMs;
        this._now = now;
        this._getPriority = getPriority;

        this.queue = [];
        this.queuedKeys = new Set();
        this.inFlightKeys = new Set();
        this.activeBuilds = 0;

        this._dropSamples = [];
    }

    setLimits({ maxConcurrentBuilds, buildBudgetMs } = {}) {
        if (Number.isFinite(maxConcurrentBuilds)) this.maxConcurrentBuilds = maxConcurrentBuilds;
        if (Number.isFinite(buildBudgetMs)) this.buildBudgetMs = buildBudgetMs;
    }

    getQueueLength() {
        return this.queue.length;
    }

    getStaleDropsLastSecond() {
        const now = this._now();
        const cutoff = now - 1000;
        let count = 0;
        for (const sample of this._dropSamples) {
            if (sample.t >= cutoff && sample.reason === "staleJob") count++;
        }
        return count;
    }

    getDropSamples() {
        return [...this._dropSamples];
    }

    dropLowPriority(maxQueueLength) {
        if (!Number.isFinite(maxQueueLength) || maxQueueLength < 0) return 0;
        if (this.queue.length <= maxQueueLength) return 0;

        this.queue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
        const kept = this.queue.slice(0, maxQueueLength);
        const dropped = this.queue.slice(maxQueueLength);

        this.queue = kept;
        this.queuedKeys = new Set(kept.map((job) => job.jobKey));

        for (const job of dropped) {
            if (job?.jobKey) {
                this._recordDrop("queueCap");
            }
        }

        return dropped.length;
    }

    _recordDrop(reason) {
        const now = this._now();
        this._dropSamples.push({ t: now, reason });
        const cutoff = now - 5000;
        while (this._dropSamples.length > 0 && this._dropSamples[0].t < cutoff) {
            this._dropSamples.shift();
        }
    }

    _computePriority(job) {
        if (typeof this._getPriority === "function") return this._getPriority(job);
        const lodWeight = job.lodLevel ?? 0;
        const dist = Number.isFinite(job.surfaceDist) ? job.surfaceDist : 0;
        const surfaceDistanceWeight = Math.max(0, 100000 - dist);
        const visibleBonus = job.wasVisibleLastFrame ? 5000 : 0;
        return (lodWeight * 100000) + surfaceDistanceWeight + visibleBonus;
    }

    enqueue(job) {
        if (!job || !job.jobKey) return false;
        if (this.queuedKeys.has(job.jobKey) || this.inFlightKeys.has(job.jobKey)) return false;

        job.priority = this._computePriority(job);
        this.queue.push(job);
        this.queuedKeys.add(job.jobKey);
        return true;
    }

    process({
        budgetMs = this.buildBudgetMs,
        canRunJob,
        runJob
    } = {}) {
        const start = this._now();
        const now = () => this._now();

        if (this.activeBuilds >= this.maxConcurrentBuilds) return;

        while (this.queue.length > 0) {
            if (now() - start >= budgetMs) return;
            if (this.activeBuilds >= this.maxConcurrentBuilds) return;

            this.queue.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
            const job = this.queue.shift();
            if (!job) continue;

            this.queuedKeys.delete(job.jobKey);

            if (job.node && job.buildKey && job.node._wantedBuildKey !== job.buildKey) {
                this._recordDrop("staleJob");
                continue;
            }

            if (typeof canRunJob === "function") {
                const verdict = canRunJob(job);
                if (verdict && verdict.ok === false) {
                    this._recordDrop(verdict.reason ?? "rejected");
                    continue;
                }
            }

            if (this.inFlightKeys.has(job.jobKey)) continue;
            this.inFlightKeys.add(job.jobKey);
            this.activeBuilds++;

            const finalize = () => {
                this.inFlightKeys.delete(job.jobKey);
                this.activeBuilds = Math.max(0, this.activeBuilds - 1);
            };

            try {
                const result = runJob?.(job);
                if (result && typeof result.then === "function") {
                    result.then(finalize).catch((err) => {
                        console.error("TerrainScheduler job failed:", err);
                        finalize();
                    });
                } else {
                    finalize();
                }
            } catch (err) {
                console.error("TerrainScheduler job exception:", err);
                finalize();
            }
        }
    }
}
