FROM ghcr.io/puppeteer/puppeteer:latest
WORKDIR /app
COPY package.json ./
RUN npm i --omit=dev
COPY server.js ./
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
