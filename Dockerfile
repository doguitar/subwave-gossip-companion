FROM node:22-alpine

WORKDIR /app

# Dependencies change less often than application source.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# All runtime code, prompts, and skills share one cacheable application layer.
COPY . .

ENV NODE_ENV=production \
    GOSSIP_BASE_DIR=/workspace \
    GOSSIP_PROMPT_PATH=/workspace/prompt.md \
    GOSSIP_HOST=0.0.0.0 \
    GOSSIP_PORT=8080

VOLUME ["/workspace"]
EXPOSE 8080

ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
CMD ["node", "src/cli.js", "serve", "--base-dir", "/workspace"]

