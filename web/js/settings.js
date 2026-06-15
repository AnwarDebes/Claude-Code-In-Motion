// The settings panel: provider, model, API key, base URL, approval mode,
// effort, theme, and the mascot toggle. Saves to the local config via the API.

const MODEL_SUGGESTIONS = {
  anthropic: ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5", "claude-fable-5"],
  openai: ["gpt-4.1", "gpt-4o", "gpt-4o-mini", "o3", "o4-mini"],
  gemini: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  openrouter: ["anthropic/claude-opus-4-8", "openai/gpt-4.1", "google/gemini-2.5-pro", "meta-llama/llama-3.1-70b-instruct"],
  ollama: ["llama3.1", "qwen2.5-coder", "deepseek-r1", "mistral", "gemma2"],
  custom: [],
};

const KEY_HELP = {
  anthropic: "console.anthropic.com",
  openai: "platform.openai.com/api-keys",
  gemini: "aistudio.google.com/apikey",
  openrouter: "openrouter.ai/keys",
  ollama: "No key needed - just run Ollama locally.",
  custom: "Whatever your endpoint expects.",
};

export class Settings {
  constructor(overlay, { onSaved } = {}) {
    this.overlay = overlay;
    this.onSaved = onSaved || (() => {});
    this.providers = {};
    this._build();
  }

  _build() {
    this.overlay.innerHTML = `
      <div class="modal">
        <div class="modal-head">
          <h2>Settings</h2>
          <button class="icon-btn close" title="Close">✕</button>
        </div>
        <div class="modal-body">
          <label class="field">
            <span>Provider</span>
            <select id="s-provider"></select>
          </label>
          <label class="field">
            <span>Model</span>
            <input id="s-model" list="s-model-list" autocomplete="off" spellcheck="false" />
            <datalist id="s-model-list"></datalist>
          </label>
          <label class="field" id="s-key-field">
            <span>API key</span>
            <input id="s-key" type="password" autocomplete="off" placeholder="" />
            <small id="s-key-help"></small>
          </label>
          <label class="field" id="s-baseurl-field" hidden>
            <span>Base URL</span>
            <input id="s-baseurl" autocomplete="off" spellcheck="false" placeholder="https://…/v1" />
          </label>
          <div class="field-row">
            <label class="field">
              <span>Approvals</span>
              <select id="s-approval">
                <option value="default">Ask before edits & commands</option>
                <option value="yolo">Auto-approve everything</option>
              </select>
            </label>
            <label class="field">
              <span>Effort (Claude)</span>
              <select id="s-effort">
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="xhigh">xhigh</option>
                <option value="max">max</option>
              </select>
            </label>
          </div>
          <div class="field-row">
            <label class="field">
              <span>Theme</span>
              <select id="s-theme">
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
            </label>
            <label class="field checkbox">
              <input id="s-mascot" type="checkbox" />
              <span>Show the mascot</span>
            </label>
          </div>
          <p class="hint" id="s-pathhint"></p>
        </div>
        <div class="modal-foot">
          <button class="btn ghost close">Cancel</button>
          <button class="btn primary" id="s-save">Save</button>
        </div>
      </div>`;

    this.$ = (sel) => this.overlay.querySelector(sel);
    this.overlay.querySelectorAll(".close").forEach((b) => b.addEventListener("click", () => this.close()));
    this.overlay.addEventListener("click", (e) => { if (e.target === this.overlay) this.close(); });
    this.$("#s-provider").addEventListener("change", () => this._onProvider());
    this.$("#s-save").addEventListener("click", () => this._save());
  }

  open(state) {
    this.config = state.config;
    this.providers = state.providers;
    const provSel = this.$("#s-provider");
    provSel.innerHTML = Object.entries(this.providers)
      .map(([k, v]) => `<option value="${k}">${v.label}</option>`).join("");
    provSel.value = this.config.provider;
    this.$("#s-model").value = this.config.model || "";
    this.$("#s-approval").value = this.config.approvalMode || "default";
    this.$("#s-effort").value = this.config.effort || "high";
    this.$("#s-theme").value = this.config.theme || "dark";
    this.$("#s-mascot").checked = this.config.mascot !== false;
    this._onProvider(true);
    this.$("#s-pathhint").textContent = `Saved on this machine in ${this.config.configPath}`;
    this.overlay.classList.add("show");
    setTimeout(() => this.$("#s-key").focus(), 50);
  }

  close() {
    this.overlay.classList.remove("show");
  }

  _onProvider(initial) {
    const p = this.$("#s-provider").value;
    const list = MODEL_SUGGESTIONS[p] || [];
    this.$("#s-model-list").innerHTML = list.map((m) => `<option value="${m}"></option>`).join("");
    if (!initial) {
      this.$("#s-model").value = list[0] || this.providers[p]?.defaultModel || "";
    }
    // key field
    const needsKey = this.providers[p]?.needsKey;
    this.$("#s-key-field").hidden = !needsKey;
    this.$("#s-key").value = "";
    const has = this.config.hasKey && this.config.hasKey[p];
    this.$("#s-key").placeholder = has ? "A key is already configured. Leave blank to keep it." : "Paste your key";
    this.$("#s-key-help").textContent = "Get one at " + (KEY_HELP[p] || "");
    // base url field for ollama / custom
    const showBase = p === "ollama" || p === "custom";
    this.$("#s-baseurl-field").hidden = !showBase;
    if (showBase) this.$("#s-baseurl").value = (this.config.baseUrls && this.config.baseUrls[p]) || "";
  }

  async _save() {
    const p = this.$("#s-provider").value;
    const body = {
      provider: p,
      model: this.$("#s-model").value.trim(),
      approvalMode: this.$("#s-approval").value,
      effort: this.$("#s-effort").value,
      theme: this.$("#s-theme").value,
      mascot: this.$("#s-mascot").checked,
      keys: {},
      baseUrls: {},
    };
    const keyVal = this.$("#s-key").value.trim();
    if (keyVal) body.keys[p] = keyVal;
    if (p === "ollama" || p === "custom") body.baseUrls[p] = this.$("#s-baseurl").value.trim();
    try {
      const res = await fetch("/api/config", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      this.onSaved(data.config);
      this.close();
    } catch (e) {
      alert("Could not save settings: " + e.message);
    }
  }
}
