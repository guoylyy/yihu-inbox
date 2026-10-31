FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY yh-app.json ./
COPY src ./src
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "src/server.js"]
