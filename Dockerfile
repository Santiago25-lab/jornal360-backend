# Jornal 360 · Backend. Railway usa este archivo automáticamente.
FROM node:22-alpine
WORKDIR /app

# Se instalan todas las dependencias (incluidas las de compilación) sin NODE_ENV=production.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

ENV NODE_ENV=production
EXPOSE 3001
CMD ["node", "dist/main.js"]
