FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN command -v flock >/dev/null
COPY --chown=node:node app-dist/ ./app-dist/
COPY --chown=node:node server-render/production.mjs ./server-render/production.mjs
COPY ops/production/entrypoint.sh /usr/local/bin/artel-entrypoint
RUN chmod 0555 /usr/local/bin/artel-entrypoint
USER node
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/artel-entrypoint"]
CMD ["node", "server-render/production.mjs"]
