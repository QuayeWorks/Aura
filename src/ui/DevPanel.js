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
        const pushLine = (text, className = "") => {
            lines.push({ text, className });
        };
        const escapeHtml = (value) => String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");

        if (data.player) {
            const p = data.player;
            pushLine(
                `Player   x:${p.x.toFixed(1)}  y:${p.y.toFixed(1)}  z:${p.z.toFixed(1)}  r:${p.r.toFixed(1)}`
            );
        }

        if (data.chunk) {
            const c = data.chunk;
            pushLine(
                `Chunks   ${c.count}  baseRes:${c.baseRes}  sizeX:${c.sizeX}`
            );
            if (c.perLod) {
                pushLine(`LOD load [${c.perLod.join("  ")}]${c.nearStr ? "  " + c.nearStr : ""}`);
            }
            if (c.streaming) {
                const s = c.streaming;
                pushLine(
                    `Stream   vis:${s.visible}  culled:${s.culled}  depth:${s.culledDepth}`
                );
                pushLine(
                    `Rings    Rcull:${s.rcull.toFixed(0)}  Rmax:${s.r3.toFixed(0)}  queue:${s.queue}  avgBuild:${s.avgBuildMs.toFixed(1)}ms`
                );
            }
        }

        if (data.streamingStats) {
            const s = data.streamingStats;
            if (s.streamingGoNoGo) {
                const goStatus = s.streamingGoNoGo.go ? "GO" : "NO-GO";
                const maxLeafBudget = s.streamingGoNoGo.maxLeafBudget ?? 0;
                const staleDrops = s.streamingGoNoGo.staleDropsLastSecond ?? 0;
                const line = `STREAMING: ${goStatus}  enabledOut:${s.enabledOutsideRcull ?? 0}  collidableOut:${s.collidableOutsideRcull ?? 0}  belowH:${s.enabledBelowHorizon ?? 0}  tooDeep:${s.enabledTooDeep ?? 0}  leaves:${s.totalLeafVisible ?? 0}/${maxLeafBudget}  staleDrops/s:${staleDrops}`;
                pushLine(line, s.streamingGoNoGo.go ? "dev-panel-go" : "dev-panel-no-go");
            }
            pushLine(
                `Stream2  focus:${s.focusMode ?? "-"}  renderSet:${s.renderSetCount ?? 0}  culled:${s.culledCount ?? 0}  depth:${s.depthCulledCount ?? 0}`
            );
            if (s.totalLeafCandidates != null || s.totalLeafVisible != null) {
                pushLine(
                    `Leaves   candidates:${s.totalLeafCandidates ?? 0}  visible:${s.totalLeafVisible ?? 0}`
                );
            }
            pushLine(
                `Meshes   enabled:${s.enabledMeshes ?? 0}  collidable:${s.enabledCollidableMeshes ?? 0}  maxLOD:${s.maxLodInUse ?? 0}`
            );
            if (Array.isArray(s.perLodCounts)) {
                const lodParts = s.perLodCounts.map((val, idx) => `${idx}:${val ?? 0}`);
                pushLine(`LOD set  [${lodParts.join("  ")}]`);
            }
            if (s.ringRadii) {
                const r = s.ringRadii;
                pushLine(
                    `Rings    r0:${(r.r0 ?? 0).toFixed(0)}  r1:${(r.r1 ?? 0).toFixed(0)}  r2:${(r.r2 ?? 0).toFixed(0)}  r3:${(r.r3 ?? 0).toFixed(0)}  rcull:${(r.rcull ?? 0).toFixed(0)}`
                );
            }
            pushLine(
                `Builds   queue:${s.buildQueueLength ?? 0}  active:${s.activeBuilds ?? 0}  avg:${(s.avgBuildMsLastSecond ?? 0).toFixed(1)}ms`
            );
            if (s.streamingAcceptance) {
                const pass = (value) => (value ? "PASS" : "FAIL");
                pushLine("STREAMING ACCEPTANCE");
                pushLine(
                    `HardCull ${pass(s.streamingAcceptance.hardCull)}  enabledOutside:${s.enabledOutsideRcull ?? 0}  collidableOutside:${s.collidableOutsideRcull ?? 0}`
                );
                pushLine(
                    `Horizon  ${pass(s.streamingAcceptance.horizon)}  enabledBelow:${s.enabledBelowHorizon ?? 0}  jobsBelow:${s.buildJobsQueuedBelowHorizon ?? 0}`
                );
                pushLine(
                    `Depth    ${pass(s.streamingAcceptance.depth)}  enabledTooDeep:${s.enabledTooDeep ?? 0}  jobsTooDeep:${s.buildJobsQueuedTooDeep ?? 0}`
                );
                pushLine(
                    `RingLOD  ${pass(s.streamingAcceptance.ringLod)}  perLodOutside:${s.perLodOutsideRcull ?? 0}  moved:${(s.movedDistance ?? 0).toFixed(1)}  highLod:${s.highLodCount ?? 0}  +:${s.highLodIncreased ? "yes" : "no"}`
                );
            }
        }

        if (data.time) {
            pushLine(`Time     ${data.time}`);
        }

        if (data.sun) {
            pushLine(
                `Sun      alt:${data.sun.alt}  pos:(${data.sun.pos})`
            );
        }

        if (data.moon) {
            pushLine(
                `Moon     alt:${data.moon.alt}  pos:(${data.moon.pos})`
            );
        }

        if (!lines.length) {
            pushLine("No telemetry.");
        }

        this.body.innerHTML = lines.map((entry) => {
            const text = escapeHtml(entry.text);
            if (entry.className) {
                return `<span class="${entry.className}">${text}</span>`;
            }
            return text;
        }).join("<br>");
    }
}
