# Playwright + Chromium passend zu ^1.55.0
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Nur package-Dateien für Cache-Layer
COPY package*.json ./

# Prod-Install und Browser-Dependencies
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
 && npx playwright install --with-deps chromium

# App-Code
COPY . .

ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

CMD ["node", "server.js"]
