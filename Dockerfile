# Use Node.js LTS version
FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install ALL dependencies (including devDependencies for ts-node, typescript)
# We need these to run the TypeScript server
RUN npm ci

# Copy all application files
COPY . .

# Build the client TypeScript
RUN npm run build

# Expose the port (platform sets PORT env var)
EXPOSE 3000

# Start the unified server
CMD ["node", "--max-old-space-size=4096", "./node_modules/.bin/ts-node", "--transpile-only", "--project", "server/tsconfig.json", "server/unified-server.ts"]

