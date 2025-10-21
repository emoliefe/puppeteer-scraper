FROM node:20

# Install Puppeteer dependencies and curl
RUN apt-get update && apt-get install -y \
  curl \
  libx11-xcb1 \
  libxss1 \
  libgtk-3-0 \
  libgbm-dev \
  libasound2 \
  fonts-liberation \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .

# Expose port
EXPOSE 3000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
