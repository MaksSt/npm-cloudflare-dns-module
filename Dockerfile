FROM node:24-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV PORT=8080 DATA_DIR=/data NPM_URL=http://npm:81 NPM_SQLITE_PATH=/npm-data/database.sqlite
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8080/__cf/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
