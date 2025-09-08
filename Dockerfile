# Dockerfile
# Nutze die aktuelle Playwright-Version 1.55.0 (passt zu deinem Fehler)
FROM mcr.microsoft.com/playwright:v1.55.0-jammy

# Arbeitsverzeichnis
WORKDIR /app

# Nur package-Dateien zuerst kopieren (schlankere Layer, bessere Caches)
COPY package*.json ./

# Dependencies installieren und Browser-Binaries einbetten
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium

# App-Code kopieren
COPY . .

# Port-Konfiguration (Render gibt PORT als Env mit)
ENV NODE_ENV=production
ENV PORT=10000
EXPOSE 10000

# Start-Kommando
CMD ["node", "server.js"]
