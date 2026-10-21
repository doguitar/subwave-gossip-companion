FROM node:22-alpine

WORKDIR /app

# Dependencies change less often than application source.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# All runtime code, prompts, and skills share one cacheable application layer.
COPY . .

ENV NODE_ENV=production \
    GOSSIP_BASE_DIR=/workspace \
    GOSSIP_HOST=0.0.0.0 \
    GOSSIP_PORT=8080

VOLUME ["/workspace"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GOSSIP_PORT||'8080')+'/health').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
# One serve per workspace. Do not run a second container on the same workspace.
CMD ["node", "src/cli.js", "serve", "--base-dir", "/workspace"]

