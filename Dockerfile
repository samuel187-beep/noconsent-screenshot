FROM mcr.microsoft.com/playwright:v1.47.2-jammy
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --production
COPY server.js ./
EXPOSE 8080
CMD [ "npm", "start" ]
