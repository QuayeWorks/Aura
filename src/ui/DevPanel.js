// src/ui/DevPanel.js
// Toggleable developer telemetry panel (DOM-based, hidden by default).

export class DevPanel {
    constructor() {
        this.visible = false;
        this.root = document.getElementById("hud-root") || this._ensureRoot();

        this.panel = document.createElement("div");
        this.panel.id = "dev-panel";
        this.panel.classList.add("hud-hidden");

        const header = document.createElement("div");
        header.className = "dev-panel-header";
        header.textContent = "Dev Panel";

        this.body = document.createElement("div");
        this.body.className = "dev-panel-body";
        this.body.textContent = "Hidden";

        this.panel.appendChild(header);
        this.panel.appendChild(this.body);
        this.root.appendChild(this.panel);

        this.lastUpdate = 0;
        this.toggleGuard = null;

    }

    _ensureRoot() {
        const root = document.createElement("div");
        root.id = "hud-root";
        document.body.appendChild(root);
        return root;
    }

    setVisible(isVisible) {
        this.visible = !!isVisible;
        this.panel.classList.toggle("hud-hidden", !this.visible);
    }

    setToggleGuard(cb) {
        this.toggleGuard = cb;
    }

    update(data = {}) {
        if (!this.visible) return;
        const now = performance.now();
        if (now - this.lastUpdate < 120) return; // ~8 Hz
        this.lastUpdate = now;

        const lines = [];

        if (data.player) {
            const p = data.player;
            lines.push(
                `Player   x:${p.x.toFixed(1)}  y:${p.y.toFixed(1)}  z:${p.z.toFixed(1)}  r:${p.r.toFixed(1)}`
            );
        }

        if (data.chunk) {
            const c = data.chunk;
            lines.push(
                `Chunks   ${c.count}  baseRes:${c.baseRes}  sizeX:${c.sizeX}`
            );
            if (c.perLod) {
                lines.push(`LOD load [${c.perLod.join("  ")}]${c.nearStr ? "  " + c.nearStr : ""}`);
            }
            if (c.streaming) {
                const s = c.streaming;
                lines.push(
                    `Stream   vis:${s.visible}  culled:${s.culled}  depth:${s.culledDepth}`
                );
                lines.push(
                    `Rings    Rcull:${s.rcull.toFixed(0)}  Rmax:${s.r3.toFixed(0)}  queue:${s.queue}  avgBuild:${s.avgBuildMs.toFixed(1)}ms`
                );
            }
        }

        if (data.streamingStats) {
            const s = data.streamingStats;
            lines.push(
                `Stream2  focus:${s.focusMode ?? "-"}  renderSet:${s.renderSetCount ?? 0}  culled:${s.culledCount ?? 0}  depth:${s.depthCulledCount ?? 0}`
            );
            if (s.totalLeafCandidates != null || s.totalLeafVisible != null) {
                lines.push(
                    `Leaves   candidates:${s.totalLeafCandidates ?? 0}  visible:${s.totalLeafVisible ?? 0}`
                );
            }
            lines.push(
                `Meshes   enabled:${s.enabledMeshes ?? 0}  collidable:${s.enabledCollidableMeshes ?? 0}  maxLOD:${s.maxLodInUse ?? 0}`
            );
            if (Array.isArray(s.perLodCounts)) {
                const lodParts = s.perLodCounts.map((val, idx) => `${idx}:${val ?? 0}`);
                lines.push(`LOD set  [${lodParts.join("  ")}]`);
            }
            if (s.ringRadii) {
                const r = s.ringRadii;
                lines.push(
                    `Rings    r0:${(r.r0 ?? 0).toFixed(0)}  r1:${(r.r1 ?? 0).toFixed(0)}  r2:${(r.r2 ?? 0).toFixed(0)}  r3:${(r.r3 ?? 0).toFixed(0)}  rcull:${(r.rcull ?? 0).toFixed(0)}`
                );
            }
            lines.push(
                `Builds   queue:${s.buildQueueLength ?? 0}  active:${s.activeBuilds ?? 0}  avg:${(s.avgBuildMsLastSecond ?? 0).toFixed(1)}ms`
            );
            if (s.streamingAcceptance) {
                const pass = (value) => (value ? "PASS" : "FAIL");
                lines.push("STREAMING ACCEPTANCE");
                lines.push(
                    `HardCull ${pass(s.streamingAcceptance.hardCull)}  enabledOutside:${s.enabledOutsideRcull ?? 0}  collidableOutside:${s.collidableOutsideRcull ?? 0}`
                );
                lines.push(
                    `Horizon  ${pass(s.streamingAcceptance.horizon)}  enabledBelow:${s.enabledBelowHorizon ?? 0}  jobsBelow:${s.buildJobsQueuedBelowHorizon ?? 0}`
                );
                lines.push(
                    `Depth    ${pass(s.streamingAcceptance.depth)}  enabledTooDeep:${s.enabledTooDeep ?? 0}  jobsTooDeep:${s.buildJobsQueuedTooDeep ?? 0}`
                );
                lines.push(
                    `RingLOD  ${pass(s.streamingAcceptance.ringLod)}  perLodOutside:${s.perLodOutsideRcull ?? 0}  moved:${(s.movedDistance ?? 0).toFixed(1)}  highLod:${s.highLodCount ?? 0}  +:${s.highLodIncreased ? "yes" : "no"}`
                );
            }
        }

        if (data.time) {
            lines.push(`Time     ${data.time}`);
        }

        if (data.sun) {
            lines.push(
                `Sun      alt:${data.sun.alt}  pos:(${data.sun.pos})`
            );
        }

        if (data.moon) {
            lines.push(
                `Moon     alt:${data.moon.alt}  pos:(${data.moon.pos})`
            );
        }

        if (!lines.length) {
            lines.push("No telemetry.");
        }

        this.body.textContent = lines.join("\n");
    }
}
