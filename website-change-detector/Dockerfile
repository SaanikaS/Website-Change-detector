FROM mcr.microsoft.com/playwright:v1.50.1-noble
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV NODE_ENV=production DATA_DIR=/data CHROMIUM_NO_SANDBOX=1
VOLUME /data
EXPOSE 3000
CMD ["node", "src/index.js"]
