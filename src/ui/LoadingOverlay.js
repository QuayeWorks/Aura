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

        panel.appendChild(text);
        panel.appendChild(bar);
        panel.appendChild(subtext);
        root.appendChild(panel);
        document.body.appendChild(root);
    }

    const textEl = root.querySelector(".loading-text");
    const fillEl = root.querySelector(".loading-bar .fill");
    const subTextEl = root.querySelector(".loading-subtext");

    function show() {
        root.classList.remove("hidden", "fade-out");
        root.classList.add("visible");
    }

    function hide() {
        root.classList.remove("visible", "fade-out");
        root.classList.add("hidden");
    }

    function setProgress(value) {
        const pct = Math.round(clamp01(value) * 100);
        if (fillEl) {
            fillEl.style.width = `${pct}%`;
        }
        if (textEl) {
            textEl.textContent = `Loading world… ${pct}%`;
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

    return {
        show,
        hide,
        setProgress,
        setMessage,
        setStreamingMessage,
        fadeOut
    };
}
