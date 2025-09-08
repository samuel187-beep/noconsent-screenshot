# Dockerfile
# Playwright + Chromium passend zur Lib-Version
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

WORKDIR /app

# Nur package-Dateien zuerst (bessere Cache-Layer)
COPY package*.json ./

# Wenn ein lockfile existiert -> npm ci, sonst npm install
# Danach: passenden Browser mit allen System-Dependencies einbetten
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev ; \
    else \
      npm install --omit=dev ; \
    fi \
 && npx playwright install --with-deps chromium

# App-Code
COPY . .

# Env/Port
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

# Start
CMD ["node", "server.js"]

