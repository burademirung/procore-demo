# Self-host the Node target (the Cloudflare Worker is the primary deploy; this is for VMs/k8s).
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --legacy-peer-deps && npm cache clean --force
COPY --from=build /app/dist ./dist
EXPOSE 8788
# Drop root for runtime.
USER node
CMD ["node", "dist/node/index.js"]
