FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production VIO_DB_PATH=/app/data/vio.db PORT=3000
COPY package.json ./
# Einzige externe Bibliothek: GramJS für „Telegram als dein Konto“
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server ./server
COPY scripts ./scripts
COPY public ./public
RUN node scripts/build-icons.js
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 3000
HEALTHCHECK CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["npm", "start"]
