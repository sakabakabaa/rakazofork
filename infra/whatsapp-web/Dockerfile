FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN apk add --no-cache git && npm install --omit=dev --ignore-scripts
COPY server.js ./
RUN mkdir -p /data/auth && chown -R node:node /data
USER node
EXPOSE 3030
CMD ["node", "server.js"]
