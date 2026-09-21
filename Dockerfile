FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY skills ./skills
COPY prompt.md ./prompt.md
COPY docker-entrypoint.sh ./docker-entrypoint.sh
COPY .env.example ./

ENV NODE_ENV=production \
    GOSSIP_BASE_DIR=/workspace \
    GOSSIP_PROMPT_PATH=/workspace/prompt.md \
    GOSSIP_HOST=0.0.0.0 \
    GOSSIP_PORT=8080

RUN mkdir -p /workspace/data /workspace/logs
VOLUME ["/workspace"]
EXPOSE 8080

ENTRYPOINT ["/app/docker-entrypoint.sh"]

CMD ["node", "src/cli.js", "serve", "--base-dir", "/workspace"]
