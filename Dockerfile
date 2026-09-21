FROM node:22-alpine

WORKDIR /app

# Dependencies change less often than application source.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Runtime assets are split from source so prompt/skill edits reuse source-independent layers.
COPY prompt.md ./prompt.md
COPY skills ./skills
COPY --chmod=755 docker-entrypoint.sh ./docker-entrypoint.sh
COPY src ./src

ENV NODE_ENV=production \
    GOSSIP_BASE_DIR=/workspace \
    GOSSIP_PROMPT_PATH=/workspace/prompt.md \
    GOSSIP_HOST=0.0.0.0 \
    GOSSIP_PORT=8080

VOLUME ["/workspace"]
EXPOSE 8080

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "src/cli.js", "serve", "--base-dir", "/workspace"]

