# syntax=docker/dockerfile:1
# Niaro's optional web search backend: SearXNG with JSON answers turned on and
# no bot limiter, for the "search" compose profile. Niaro reaches it at
# http://searxng:8080; add it in administration, Providers, Search backends.
# See docs/guides/deployment.md, "Optional web search".
FROM searxng/searxng:2026.10.19-81371861f@sha256:5ed0323b5f5f8701264ef65e239a2bd83cb57098f2b971fa30bf79c06eeae271

COPY --chown=searxng:searxng settings.yml /etc/searxng/settings.yml
COPY --chmod=755 start.sh /usr/local/searxng/start.sh
# Unprivileged, so the read-only container skips the root-only certificate update.
USER searxng
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/searxng/start.sh"]
