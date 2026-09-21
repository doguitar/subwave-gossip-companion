FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY src ./src
COPY skills ./skills
COPY prompt.md ./prompt.md
COPY .env.example ./

ENV NODE_ENV=production \
    GOSSIP_BASE_DIR=/workspace \
    GOSSIP_PROMPT_PATH=/app/prompt.md \
    GOSSIP_HOST=0.0.0.0 \
    GOSSIP_PORT=8787

RUN mkdir -p /workspace/data /workspace/logs
VOLUME ["/workspace"]
EXPOSE 8787

CMD ["node", "src/cli.js", "serve", "--base-dir", "/workspace"]
