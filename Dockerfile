# syntax=docker/dockerfile:1
# One image for the whole server: app API, web app, administration, Mastra
# runtime and local metadata. Local data lives in one volume at /data; optional
# attachment objects live in the separately configured private S3 service. Without a server
# profile the server builds its own from the environment (NIARO_PUBLIC_URL and
# friends); a profile mounted read-only at /config/server.json (or at
# $NIARO_CONFIG) is used instead when present. Built-in plugins ship in
# /app/plugins; the operator's own and edited ones live in /data/identity/plugins
# (docs/guides/plugins.md). See docs/guides/deployment.md.
ARG NODE_IMAGE=node:22.23.3-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392

# --- build: full install from the lockfile, web bundle, runtime selection ----
FROM ${NODE_IMAGE} AS build
WORKDIR /src
ENV CI=1
# The repository pins pnpm in package.json (packageManager).
RUN npm install --global --no-fund --no-audit pnpm@12.4.2
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server-admin/package.json apps/server-admin/package.json
COPY apps/server-agent/package.json apps/server-agent/package.json
RUN --mount=type=cache,id=niaro-pnpm-store,target=/pnpm-store \
    pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY . .
RUN npm run admin:build \
 && node scripts/docker/runtime-deps.mjs /runtime \
 && mkdir -p /runtime/scripts/docker \
 && cp -r apps packages plugins dist-admin package.json /runtime/ \
 && rm -rf /runtime/apps/mobile /runtime/apps/server-admin/web \
           /runtime/apps/server-admin/vite.config.ts \
 && cp scripts/backup.mjs scripts/restore.mjs scripts/backup-common.mjs scripts/storage-check.ts scripts/storage-bootstrap.ts /runtime/scripts/ \
 && cp scripts/docker/healthcheck.mjs /runtime/scripts/docker/ \
 && cp scripts/docker/tsconfig.runtime.json /runtime/tsconfig.json

# --- voice: speech detection for chat voice (whisper.cpp VAD + Silero) -------
# Chat voice cuts silence locally before it sends speech to the catalog's
# speech-to-text model. Same pinned revision and checksum as voice:install.
FROM ${NODE_IMAGE} AS voice
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git cmake g++ make \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /voice
RUN git clone --depth 1 --branch v1.9.4 https://github.com/ggml-org/whisper.cpp.git src \
 && test "$(git -C src rev-parse HEAD)" = 927cfce34f31707e17f2bff35c349632fb9e2c3a \
 && cmake -S src -B src/build -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF \
      -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON \
 && cmake --build src/build --target whisper-vad-speech-segments -j "$(nproc)" \
 && mkdir -p out/whisper.cpp/build/bin out/models \
 && cp src/build/bin/whisper-vad-speech-segments out/whisper.cpp/build/bin/ \
 && curl --fail --location --retry 2 --output out/models/ggml-silero-v6.2.0.bin \
      https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin \
 && echo "2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987  out/models/ggml-silero-v6.2.0.bin" | sha256sum -c -

# --- runtime: production dependencies only, non-root ------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NIARO_DATA=/data \
    NIARO_LISTEN_HOST=0.0.0.0 \
    NIARO_LOG=1
WORKDIR /app
# Meeting recordings (browser WebM, call videos) are probed and split with ffmpeg.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*
# Application files stay owned by root and read-only for the server user.
COPY --from=build /runtime /app
COPY --from=voice /voice/out /app/voice
COPY --chmod=755 scripts/docker/niaro /usr/local/bin/niaro
RUN mkdir -p /data /config \
 && chown node:node /data \
 && chmod 700 /data
USER node
EXPOSE 8793
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["niaro", "healthcheck"]
ENTRYPOINT ["niaro"]
CMD ["start"]
