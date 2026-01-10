// src/ui/LoadingOverlay.js
// Simple DOM loading overlay with a timed progress bar.

function clamp01(value) {
    return Math.min(1, Math.max(0, value));
}

export function createLoadingOverlay() {
    let root = document.getElementById("loading-overlay");
    if (!root) {
        root = document.createElement("div");
        root.id = "loading-overlay";
        root.className = "loading-overlay hidden";

        const panel = document.createElement("div");
        panel.className = "loading-panel";

        const text = document.createElement("div");
        text.className = "loading-text";
        text.textContent = "Loading world…";

        const bar = document.createElement("div");
        bar.className = "loading-bar";
        const fill = document.createElement("div");
        fill.className = "fill";
        bar.appendChild(fill);

        const subtext = document.createElement("div");
        subtext.className = "loading-subtext";
        subtext.textContent = "";

        const forceSpawnWrap = document.createElement("div");
        forceSpawnWrap.className = "force-spawn-wrap";
        forceSpawnWrap.style.display = "none";

        const forceBtn = document.createElement("button");
        forceBtn.className = "force-spawn-btn";
        forceBtn.type = "button";
        forceBtn.textContent = "Force Spawn";

        const forceSubtext = document.createElement("div");
        forceSubtext.className = "force-spawn-subtext";
        forceSubtext.textContent = "Use if terrain streaming stalls";

        const retryBtn = document.createElement("button");
        retryBtn.className = "retry-spawn-btn";
        retryBtn.type = "button";
        retryBtn.textContent = "Retry Spawn Check";

        forceSpawnWrap.appendChild(forceBtn);
        forceSpawnWrap.appendChild(forceSubtext);
        forceSpawnWrap.appendChild(retryBtn);

        panel.appendChild(text);
        panel.appendChild(bar);
        panel.appendChild(subtext);
        panel.appendChild(forceSpawnWrap);
        root.appendChild(panel);
        document.body.appendChild(root);
    }

    const textEl = root.querySelector(".loading-text");
    const fillEl = root.querySelector(".loading-bar .fill");
    const subTextEl = root.querySelector(".loading-subtext");
    const forceWrapEl = root.querySelector(".force-spawn-wrap");
    const forceBtnEl = root.querySelector(".force-spawn-btn");
    const retryBtnEl = root.querySelector(".retry-spawn-btn");

    const overlayState = {
        onForceSpawn: null,
        onRetrySpawnCheck: null
    };

    if (forceBtnEl) {
        forceBtnEl.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            overlayState.onForceSpawn?.();
        });
    }

    if (retryBtnEl) {
        retryBtnEl.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            overlayState.onRetrySpawnCheck?.();
        });
    }

    function show() {
        root.classList.remove("hidden", "fade-out");
        root.classList.add("visible");
    }

    function hide() {
        root.classList.remove("visible", "fade-out");
        root.classList.add("hidden");
    }

    function setProgress(value) {
        const clamped = clamp01(value);
        const pct = Math.round(clamped * 100);
        if (fillEl) {
            fillEl.style.width = `${pct}%`;
        }
        if (textEl) {
            textEl.textContent = `Loading world… ${pct}%`;
        }
        if (forceWrapEl) {
            forceWrapEl.style.display = clamped >= 0.9 ? "flex" : "none";
        }
    }

    function setMessage(message) {
        if (textEl) textEl.textContent = message;
    }

    function setStreamingMessage(message) {
        if (!subTextEl) return;
        subTextEl.textContent = message || "";
        subTextEl.classList.toggle("visible", !!message);
    }

    function fadeOut() {
        root.classList.add("fade-out");
        setTimeout(() => hide(), 450);
    }

    return Object.assign(overlayState, {
        show,
        hide,
        setProgress,
        setMessage,
        setStreamingMessage,
        fadeOut
    });
}
