# Build a partir da raiz do repositório (no Easypanel, Build Path = /).
FROM node:22-alpine

RUN apk add --no-cache ffmpeg

WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/saude || exit 1

CMD ["node", "src/servidor.mjs"]
