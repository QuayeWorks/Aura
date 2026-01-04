# Expressive FastPitch Feasibility and Modification Plan

## Repository note
- The current repository does not contain a FastPitch implementation (no `model.py` or TTS code is present). The following recommendations assume the standard NVIDIA FastPitch code structure (PyTorch with `FastPitch` module, `pitch_predictor`, `duration_predictor`, `ConvAttention` + MAS alignment) and describe concrete insertion points to adapt that codebase.

## 1) Viability assessment
- **FastPitch as a base**: FastPitch can be extended to deliver expressive, "anime/manga narration" style prosody on a single-speaker ~20h dataset while retaining fast autoregressive-free inference. Key benefits are parallel generation, explicit pitch/duration control, and compatibility with reference-style embeddings. The main limitation is that FastPitch alone cannot synthesize novel emotive timbre; it needs external style conditioning and richer pitch/duration stochasticity. With the modifications below, it remains viable. Switching to VITS/StyleTTS2/diffusion TTS would provide higher naturalness for extreme expressivity but with slower or more complex inference/training.

## 2) Minimum modifications

### A) Style tokens/tags in text
- **Code changes**
  - Add special tokens (e.g., `<shout>`, `<whisper>`, `<inner>`, `<calm>`, `<angry>`, `<battle>`, `<comedy>`) to the tokenizer/vocabulary (e.g., `text_to_sequence` helper in `text/__init__.py` or equivalent). Map each token to an integer ID and extend the embedding table in `FastPitch` to accommodate them.
  - In `FastPitch.forward`, concatenate a learned style embedding vector to the encoder output. Implementation: add `self.style_embed = nn.Embedding(num_style_tokens, d_model)` and, after encoder outputs `enc_out` of shape `[B, T, d_model]`, add `enc_out = enc_out + style_embed[:, None, :]` where `style_embed` is selected from the token present at the start of the text sequence.
- **Tensor shapes**: style embedding `[B, d_model]`; broadcast to `[B, T, d_model]` and added to encoder output.
- **Inference selection**: prepend a style token to the text sequence to choose the style; during text processing detect the first token as style and strip it from phoneme text before alignment.
- **Training with ConvAttention+MAS**: include style token in input so MAS sees the correct text length; mask out the style token from alignment (zero duration) to keep attention lengths consistent.

### B) Reference prosody encoder
- **Code changes**
  - Add a reference encoder module (e.g., in `model.py` or `modules/ref_encoder.py`) that ingests a reference mel `[B, n_mel, T_ref]` and outputs a style vector `[B, d_style]` using a stack of 2D convs + GRU + linear (similar to GST-Tacotron).
  - Add a projection `style_to_model = nn.Linear(d_style, d_model)` and inject into encoder output: `enc_out = enc_out + style_to_model(style_vec)[:, None, :]` (broadcast).
  - Optionally fuse with style tokens by summing or concatenating then linear projecting.
- **Inference selection**: when a reference audio is provided, compute `style_vec` from its mel; if absent, fall back to style token embedding or a neutral default.
- **Training**: sample a reference clip from the same utterance (teacher-forced) so gradients encourage style reconstruction. Ensure reference audio is excluded from MAS alignment and only conditions the encoder.

### C) Predictor upgrades
- **Duration distribution sampling**: replace deterministic duration predictor output with a log-normal distribution head. Code: in `duration_predictor.forward`, output `mu, log_sigma` (both `[B, T_enc, 1]`); during inference sample `dur = torch.exp(mu + sigma * torch.randn_like(mu))` then round/clamp. Train with negative log-likelihood loss vs. ground-truth durations.
- **Pitch contour smoothing loss**: add a total-variation or delta-L1 loss on predicted pitch `[B, T_dec]` to encourage smooth contours, especially for whispered/inner styles.
- **Shapes**: unchanged input shapes; duration head outputs two channels; pitch smoothing operates on `[B, T]` vector.

### D) Training sampling strategy
- **Upsample rare/emotive tags**: in the dataloader (e.g., `datasets/tts.py`), add a sampler that increases probability for clips labeled with rare style tags (shout/whisper/battle/comedy). Implement class-aware sampling or loss re-weighting (e.g., per-style loss weight).
- **Style mixing**: occasionally drop style conditioning (token or reference) to teach robustness; implement with a dropout probability in the batch collate function.

## 3) Speed impact and bottlenecks (2 × 1080 Ti)
- FastPitch’s parallel decoder and ConvAttention keep inference fast. Adding style token embeddings and reference encoder are lightweight. Biggest bottlenecks: reference encoder convolution/GRU over mel frames (~1–2 ms per reference), and duration sampling adds negligible cost. Training bottlenecks: larger batch sizes constrained by 11 GB VRAM; MAS alignment memory during long sentences is the main limiter. Use gradient accumulation and mixed precision (AMP) to fit batch sizes of 16–24 on 2 GPUs.

## 4) Recommended plans
- **Minimal viable expressive FastPitch (fastest)**: implement style tokens (A) + rare-style sampler (D). Keep deterministic duration/pitch. Style selection via text prefix. Minimal new modules and preserves FastPitch speed.
- **Best quality expressive FastPitch (still FastPitch)**: implement style tokens (A) + reference encoder fusion (B) + duration distribution head and pitch smoothing (C) + sampler (D). This preserves parallel inference; reference encoder cost is minimal. Use token fallback when no reference is provided.
- **When to switch architectures**: if target requires fully natural whispered/breathy timbre shifts, heavy co-articulation, or unseen emotional nuances beyond the dataset, FastPitch’s source–filter decoder may sound buzzy. Models like VITS/StyleTTS2 with stochastic decoders or diffusion TTS capture richer spectral detail and prosodic variance at the cost of speed and complexity. If demos reveal FastPitch artifacts in whispered or extreme shouting styles even after conditioning, consider migrating to VITS (for one-shot expressive synthesis) or StyleTTS2 (strong prosody transfer) despite slower inference.
