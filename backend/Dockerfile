FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npx nest build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache curl tini
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
RUN mkdir -p /app/data/files
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
