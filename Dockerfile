# Production Dockerfile for OpenSea NFT Trading Bot
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json tsconfig.json ./
RUN npm ci

# Copy source code and config
COPY src/ ./src/
COPY config/ ./config/

# Build TypeScript
RUN npm run build

# Production runtime stage
FROM node:20-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Install only production dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy compiled artifacts from builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/config ./config

# Expose port for health-check dashboard
EXPOSE 3000

# Start trading bot
CMD ["node", "dist/index.js"]
