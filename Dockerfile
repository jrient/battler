FROM node:22-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src

ENV PORT=8787
ENV NODE_ENV=production
EXPOSE 8787

CMD ["npx", "tsx", "src/server/index.ts"]
